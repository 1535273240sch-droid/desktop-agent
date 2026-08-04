// tools/functionCalling.ts - function calling 引擎
// 原生 function calling 支持 + 降级到 JSON 意图解析 + 自动检测 API 是否支持

import type { ToolCall, Message } from "@/types";
import {
  TaskApiClient,
  type ChatCompletionMessage,
  type FunctionTool,
  type StreamChunk,
} from "@/services/api/taskApi";
import { toolRegistry, type ToolCategory } from "./registry";
import { executeToolsParallel, type ExecutionResult, type ProgressCallback } from "./executor";

// ========================= 类型定义 =========================

export interface FunctionCallingOptions {
  /** 工具类别过滤（默认全部） */
  categories?: ToolCategory[];
  /** 流式 chunk 回调 */
  onChunk?: (chunk: StreamChunk) => void;
  /** 工具执行进度回调 */
  onProgress?: ProgressCallback;
  /** 工具执行前的拦截器（可拒绝执行） */
  beforeExecute?: (toolCalls: ToolCall[]) => Promise<ToolCall[]>;
  /** 中止信号 */
  signal?: AbortSignal;
  /** 最大轮次（默认 10，防止死循环） */
  maxRounds?: number;
}

export interface FunctionCallingResult {
  /** 最终回复文本 */
  text: string;
  /** 累计的 tool 调用记录 */
  toolCalls: ToolCall[];
  /** 累计的工具执行结果 */
  results: ExecutionResult[];
  /** 是否因达到轮次上限而停止 */
  stoppedByRoundLimit: boolean;
  /** 总轮次 */
  rounds: number;
}

// ========================= 引擎 =========================

/**
 * Function Calling 引擎
 *
 * 流程：
 * 1. 收集可用工具 → 转为 FunctionTool[]
 * 2. 自动检测 API 是否支持原生 function calling
 * 3. 进入循环：
 *    a. 发送对话（含工具定义）
 *    b. 接收模型回复：若包含 tool_calls → 执行工具 → 把结果作为 tool 消息回灌 → 继续
 *    c. 若无 tool_calls → 返回最终文本
 * 4. 达到 maxRounds 仍未结束 → 返回当前累计文本
 */
export class FunctionCallingEngine {
  /** 任务 API 客户端（公开以便外部比较实例） */
  readonly client: TaskApiClient;
  /** 是否支持原生 function calling 的缓存 */
  private supportsFcCache: boolean | null = null;

  constructor(client: TaskApiClient) {
    this.client = client;
  }

  /** 显式设置是否支持原生 FC（手动覆盖自动检测） */
  setSupportsNativeFc(supports: boolean) {
    this.supportsFcCache = supports;
  }

  /** 检测 API 是否支持原生 function calling */
  async detectSupport(): Promise<boolean> {
    if (this.supportsFcCache !== null) return this.supportsFcCache;
    this.supportsFcCache = await this.client.detectFunctionCallingSupport();
    return this.supportsFcCache;
  }

  /**
   * 执行完整的 function calling 循环
   * @param messages 初始消息列表
   * @param options 选项
   */
  async run(
    messages: ChatCompletionMessage[],
    options?: FunctionCallingOptions,
  ): Promise<FunctionCallingResult> {
    const maxRounds = options?.maxRounds ?? 10;
    const tools = toolRegistry.toFunctionTools(options?.categories);
    const supportsFc = await this.detectSupport();

    let currentMessages = [...messages];
    const allToolCalls: ToolCall[] = [];
    const allResults: ExecutionResult[] = [];
    let lastText = "";
    let stoppedByRoundLimit = false;
    let rounds = 0;

    for (let round = 0; round < maxRounds; round++) {
      rounds++;
      if (options?.signal?.aborted) {
        break;
      }

      // 调用模型
      const { text, toolCalls, finishReason } = await this.client.chatWithTools(
        currentMessages,
        tools,
        options?.onChunk,
        options?.signal,
      );
      lastText = text;

      // 把 assistant 回复追加到上下文
      const assistantMsg: ChatCompletionMessage = {
        role: "assistant",
        content: text,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      currentMessages.push(assistantMsg);

      // 没有工具调用 → 完成
      if (toolCalls.length === 0 || finishReason === "stop") {
        break;
      }

      // 拦截器：可在执行前修改/拒绝工具调用
      const toExecute = options?.beforeExecute
        ? await options.beforeExecute(toolCalls)
        : toolCalls;
      if (toExecute.length === 0) {
        // 全部被拦截，继续对话
        currentMessages.push({
          role: "tool",
          content: JSON.stringify({ skipped: true, reason: "blocked by interceptor" }),
          tool_call_id: toolCalls[0]?.id,
          name: toolCalls[0]?.name,
        });
        continue;
      }

      // 并行执行工具
      const results = await executeToolsParallel(toExecute, options?.onProgress);
      allToolCalls.push(...toExecute);
      allResults.push(...results);

      // 把工具结果作为 tool 消息回灌
      for (let i = 0; i < toExecute.length; i++) {
        const tc = toExecute[i];
        const r = results[i];
        currentMessages.push({
          role: "tool",
          content: JSON.stringify({
            success: r.success,
            output: r.output,
            error: r.error,
          }),
          tool_call_id: tc.id,
          name: tc.name,
        });
      }

      // 最后一轮：达到上限
      if (round === maxRounds - 1) {
        stoppedByRoundLimit = true;
      }
    }

    return {
      text: lastText,
      toolCalls: allToolCalls,
      results: allResults,
      stoppedByRoundLimit,
      rounds,
    };
  }

  /**
   * 单轮降级解析：在不使用原生 function calling 时，
   * 通过 JSON 意图解析从模型回复中提取工具调用
   */
  async parseIntentOnly(
    messages: ChatCompletionMessage[],
    options?: FunctionCallingOptions,
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const tools = toolRegistry.toFunctionTools(options?.categories);
    // 强制使用降级路径
    const prev = this.supportsFcCache;
    this.supportsFcCache = false;
    try {
      const result = await this.client.chatWithTools(
        messages,
        tools,
        options?.onChunk,
        options?.signal,
      );
      return { text: result.text, toolCalls: result.toolCalls };
    } finally {
      this.supportsFcCache = prev;
    }
  }
}

// ========================= 默认引擎 =========================

let _defaultEngine: FunctionCallingEngine | null = null;

export function getDefaultFunctionCallingEngine(client?: TaskApiClient): FunctionCallingEngine {
  if (!_defaultEngine || (client && _defaultEngine.client !== client)) {
    if (!client) {
      throw new Error("FunctionCallingEngine not initialized: client required on first call");
    }
    _defaultEngine = new FunctionCallingEngine(client);
  }
  return _defaultEngine;
}

export function resetDefaultFunctionCallingEngine() {
  _defaultEngine = null;
}

// ========================= 便捷入口 =========================

/**
 * 一键式 function calling 入口
 * @param client 任务 API 客户端
 * @param messages 初始消息
 * @param options 选项
 */
export async function runFunctionCalling(
  client: TaskApiClient,
  messages: ChatCompletionMessage[],
  options?: FunctionCallingOptions,
): Promise<FunctionCallingResult> {
  const engine = new FunctionCallingEngine(client);
  return engine.run(messages, options);
}

// ========================= 工具消息构造工具 =========================

/** 把 Message[]（应用层）转为 ChatCompletionMessage[]（API 层） */
export function toApiMessages(messages: Message[]): ChatCompletionMessage[] {
  return messages.map((m) => {
    const api: ChatCompletionMessage = {
      role: m.role as ChatCompletionMessage["role"],
      content: m.content,
    };
    if (m.toolCalls && m.toolCalls.length > 0) {
      api.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }
    return api;
  });
}

/** 把 ExecutionResult 转换为 tool 角色消息（用于回灌上下文） */
export function resultsToToolMessages(
  results: ExecutionResult[],
): ChatCompletionMessage[] {
  return results.map((r) => ({
    role: "tool" as const,
    content: JSON.stringify({
      success: r.success,
      output: r.output,
      error: r.error,
    }),
    tool_call_id: r.toolCallId,
    name: r.name,
  }));
}
