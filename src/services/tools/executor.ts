// tools/executor.ts - 工具执行器
// 并行执行(上限5) + 30秒超时 + 结果自动注入上下文 + 失败重试+告知用户 + 多步编排

import { invoke } from "@tauri-apps/api/core";
import type { ToolCall } from "@/types";
import { toolRegistry, type RegisteredTool } from "./registry";

// ========================= 常量 =========================

/** 并行执行上限 */
const MAX_PARALLEL = 5;
/** 单工具超时（毫秒） */
const TOOL_TIMEOUT_MS = 30_000;
/** 失败重试次数 */
const MAX_RETRIES = 2;

// ========================= 类型定义 =========================

export interface ExecutionResult {
  toolCallId: string;
  name: string;
  success: boolean;
  output: any;
  error?: string;
  durationMs: number;
  /** 是否因超时失败 */
  timedOut?: boolean;
  /** 重试次数 */
  retries: number;
}

export type ProgressCallback = (update: {
  type: "start" | "success" | "error" | "retry" | "complete";
  toolCall?: ToolCall;
  result?: ExecutionResult;
  message?: string;
}) => void;

// ========================= 执行器 =========================

/**
 * 执行单个工具调用
 * - 优先使用工具自带的 handler
 * - 否则按工具类别路由到对应 Tauri 命令
 * - 30 秒超时 + 失败重试（最多 2 次）
 */
export async function executeTool(
  toolCall: ToolCall,
  onProgress?: ProgressCallback,
): Promise<ExecutionResult> {
  const tool = toolRegistry.get(toolCall.name);
  if (!tool) {
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      success: false,
      output: null,
      error: `unknown tool: ${toolCall.name}`,
      durationMs: 0,
      retries: 0,
    };
  }

  onProgress?.({ type: "start", toolCall });
  let lastError: string | undefined;
  let retries = 0;
  const started = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      retries = attempt;
      onProgress?.({
        type: "retry",
        toolCall,
        message: `retrying ${toolCall.name} (attempt ${attempt + 1})`,
      });
    }
    try {
      const output = await withTimeout(
        runTool(tool, toolCall.arguments),
        TOOL_TIMEOUT_MS,
        toolCall.name,
      );
      const result: ExecutionResult = {
        toolCallId: toolCall.id,
        name: toolCall.name,
        success: true,
        output,
        durationMs: Date.now() - started,
        retries,
      };
      onProgress?.({ type: "success", toolCall, result });
      return result;
    } catch (e: any) {
      lastError = e?.message ?? String(e);
      const isTimeout = e?.name === "TimeoutError";
      if (isTimeout) {
        // 超时不重试
        const result: ExecutionResult = {
          toolCallId: toolCall.id,
          name: toolCall.name,
          success: false,
          output: null,
          error: `timeout after ${TOOL_TIMEOUT_MS}ms`,
          durationMs: Date.now() - started,
          timedOut: true,
          retries,
        };
        onProgress?.({ type: "error", toolCall, result, message: result.error });
        return result;
      }
      // 可重试错误才继续
      if (attempt >= MAX_RETRIES) {
        const result: ExecutionResult = {
          toolCallId: toolCall.id,
          name: toolCall.name,
          success: false,
          output: null,
          error: lastError,
          durationMs: Date.now() - started,
          retries,
        };
        onProgress?.({
          type: "error",
          toolCall,
          result,
          message: `工具 ${toolCall.name} 执行失败：${lastError}。已通知用户。`,
        });
        notifyUser(toolCall.name, lastError ?? "未知错误");
        return result;
      }
    }
  }

  // 兜底
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    success: false,
    output: null,
    error: lastError,
    durationMs: Date.now() - started,
    retries,
  };
}

/**
 * 并行执行多个工具调用（上限 5）
 * - 超过上限时排队
 * - 任一失败不影响其他工具
 */
export async function executeToolsParallel(
  toolCalls: ToolCall[],
  onProgress?: ProgressCallback,
): Promise<ExecutionResult[]> {
  if (toolCalls.length === 0) return [];

  // 分批执行，每批 MAX_PARALLEL 个
  const results: ExecutionResult[] = [];
  for (let i = 0; i < toolCalls.length; i += MAX_PARALLEL) {
    const batch = toolCalls.slice(i, i + MAX_PARALLEL);
    const batchResults = await Promise.all(
      batch.map((tc) => executeTool(tc, onProgress)),
    );
    results.push(...batchResults);
  }
  onProgress?.({ type: "complete", message: `executed ${results.length} tools` });
  return results;
}

// ========================= 多步编排 =========================

/**
 * 多步编排：按顺序执行，每步结果注入到下一步的上下文
 * - 失败时可选终止或继续
 * - 返回每步结果
 */
export async function executeToolsSequential(
  toolCalls: ToolCall[],
  onProgress?: ProgressCallback,
  options?: { stopOnError?: boolean },
): Promise<ExecutionResult[]> {
  const stopOnError = options?.stopOnError ?? true;
  const results: ExecutionResult[] = [];
  const context: Record<string, any> = {};

  for (const tc of toolCalls) {
    // 注入前序结果作为上下文（按工具名引用）
    const args = injectContext(tc.arguments, context);
    const enriched: ToolCall = { ...tc, arguments: args };

    const result = await executeTool(enriched, onProgress);
    results.push(result);
    context[tc.name] = result.output;

    if (!result.success && stopOnError) {
      onProgress?.({
        type: "complete",
        message: `stopped at step "${tc.name}" due to error`,
      });
      break;
    }
  }
  onProgress?.({ type: "complete", message: `sequential execution done` });
  return results;
}

// ========================= 结果注入上下文 =========================

/**
 * 将执行结果自动注入消息上下文
 * 用于在 function calling 流程中把工具输出追加为 tool 角色消息
 */
export function resultsToContextMessages(
  results: ExecutionResult[],
): Array<{ role: "tool"; content: string; tool_call_id?: string; name: string }> {
  return results.map((r) => ({
    role: "tool" as const,
    name: r.name,
    tool_call_id: r.toolCallId,
    content: JSON.stringify({
      success: r.success,
      output: r.output,
      error: r.error,
    }),
  }));
}

/** 把前序工具结果以 ${prev.<toolName>} 形式替换参数中的占位符 */
function injectContext(
  args: Record<string, any>,
  context: Record<string, any>,
): Record<string, any> {
  const replaced: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      replaced[k] = v.replace(/\$\{prev\.([a-zA-Z0-9_.]+)\}/g, (_, path) => {
        return String(getByPath(context, path) ?? "");
      });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      replaced[k] = injectContext(v, context);
    } else {
      replaced[k] = v;
    }
  }
  return replaced;
}

function getByPath(obj: any, path: string): any {
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

// ========================= 工具运行路由 =========================

async function runTool(
  tool: RegisteredTool,
  args: Record<string, any>,
): Promise<any> {
  // 1. 自定义 handler 优先
  if (tool.handler) {
    return tool.handler(args);
  }

  // 2. 按类别路由到 Tauri 命令
  switch (tool.category) {
    case "file":
      return runFileTool(tool.name, args);
    case "sandbox":
      return runSandboxTool(tool.name, args);
    case "desktop":
      return runDesktopTool(tool.name, args);
    case "capability":
      return runCapabilityTool(tool.name, args);
    case "sub-agent":
      return runSubAgentTool(tool.name, args);
    case "plugin":
      // 插件工具必须有 handler，若走到这里说明注册异常
      throw new Error(`plugin tool "${tool.name}" has no handler`);
    default:
      throw new Error(`unsupported tool category: ${tool.category}`);
  }
}

function runFileTool(name: string, args: Record<string, any>): Promise<any> {
  switch (name) {
    case "file.read":
      return invoke("file_read", { path: args.path });
    case "file.write":
      return invoke("file_write", { path: args.path, content: args.content });
    case "file.search":
      return invoke("file_search", {
        root: args.root,
        pattern: args.pattern,
        maxResults: args.maxResults,
      });
    default:
      throw new Error(`unknown file tool: ${name}`);
  }
}

async function runSandboxTool(name: string, args: Record<string, any>): Promise<any> {
  // 沙箱配置使用默认值；真实使用时从 settings 读取
  const config = {
    enabled: true,
    memoryLimit: "2g",
    cpuLimit: "2",
    diskLimit: "10g",
    networkMode: "http-only",
    autoDestroy: true,
    timeout: 30000,
  };
  switch (name) {
    case "sandbox.run_python":
      return invoke("sandbox_execute", {
        name: "py",
        lang: "python",
        code: args.code,
        config,
      });
    case "sandbox.run_shell":
      return invoke("sandbox_execute", {
        name: "sh",
        lang: "shell",
        code: args.code,
        config,
      });
    case "sandbox.run_node":
      return invoke("sandbox_execute", {
        name: "js",
        lang: "node",
        code: args.code,
        config,
      });
    case "sandbox.pip_install":
      return invoke("sandbox_pip_install", {
        name: "py",
        packages: args.packages,
        autoConfirm: false,
      });
    default:
      throw new Error(`unknown sandbox tool: ${name}`);
  }
}

function runDesktopTool(name: string, args: Record<string, any>): Promise<any> {
  // 桌面操控统一走 mcp_call_tool
  const mcpName = name.replace("desktop.", "").replace("_", ".");
  // 映射到 nuphus-mcp 工具名（如 desktop.window_list → window.list）
  const mapping: Record<string, string> = {
    "desktop.window_list": "window.list",
    "desktop.window_focus": "window.focus",
    "desktop.screenshot": "vision.capture",
    "desktop.mouse_click": "input.mouse_click",
    "desktop.keyboard_type": "input.keyboard",
    "desktop.clipboard_read": "clipboard.read",
    "desktop.clipboard_write": "clipboard.write",
  };
  const toolName = mapping[name] ?? mcpName;
  return invoke("mcp_call_tool", { tool: toolName, args });
}

async function runCapabilityTool(name: string, args: Record<string, any>): Promise<any> {
  // 能力工具调用对应的 API 客户端，这里通过动态导入避免循环依赖
  switch (name) {
    case "capability.vision": {
      const { getDefaultStepClient } = await import("@/services/api/stepApi");
      // 配置由 settings store 注入；此处假定客户端已初始化
      const client = getDefaultStepClient();
      return client.recognizeImage(args.image, args.prompt);
    }
    case "capability.image_gen": {
      const { getDefaultStepClient } = await import("@/services/api/stepApi");
      return getDefaultStepClient().textToImage(args.prompt, {
        width: args.width,
        height: args.height,
      });
    }
    case "capability.image_edit": {
      const { getDefaultStepClient } = await import("@/services/api/stepApi");
      return getDefaultStepClient().imageToImage(args.prompt, args.referenceImage);
    }
    case "capability.tts": {
      const { getDefaultStepClient } = await import("@/services/api/stepApi");
      return getDefaultStepClient().tts({ text: args.text, voiceId: args.voiceId });
    }
    case "capability.asr": {
      const { getDefaultXiaomiClient } = await import("@/services/api/xiaomiApi");
      return getDefaultXiaomiClient().recognizeOnce(args.audio, {
        format: args.format ?? "pcm16",
        sampleRate: 16000,
      });
    }
    default:
      throw new Error(`unknown capability tool: ${name}`);
  }
}

function runSubAgentTool(name: string, args: Record<string, any>): Promise<any> {
  // 子Agent的具体实现在 chat store / agent store 中编排
  // 这里仅返回占位结构，由上层捕获并处理
  switch (name) {
    case "sub_agent.spawn":
      return Promise.resolve({
        agentId: crypto.randomUUID(),
        name: args.name,
        task: args.task,
        status: "running",
      });
    case "sub_agent.wait":
      return Promise.resolve({
        agentId: args.agentId,
        status: "completed",
        result: null,
      });
    default:
      throw new Error(`unknown sub-agent tool: ${name}`);
  }
}

// ========================= 工具函数 =========================

function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`tool "${toolName}" timed out after ${ms}ms`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 通知用户工具执行失败（通过系统通知） */
async function notifyUser(toolName: string, error: string) {
  try {
    // 优先使用 Tauri 通知；若不可用则降级到 console
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    await sendNotification({
      title: "工具执行失败",
      body: `${toolName}: ${error.slice(0, 200)}`,
    });
  } catch {
    console.error(`[tool executor] ${toolName} failed: ${error}`);
  }
}
