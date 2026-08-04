// api/taskApi.ts - 任务API客户端
// OpenAI兼容格式 + 流式输出 + 模型列表(/v1/models) + function calling + 降级到JSON意图解析

import { invoke } from "@tauri-apps/api/core";
import type { TaskApiConfig, Message, ToolCall } from "@/types";
import { RateLimiter, type RateLimitConfig } from "./rateLimiter";

// ========================= 类型定义 =========================

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ModelInfo {
  id: string;
  object?: string;
  owned_by?: string;
}

export interface StreamChunk {
  delta: string;
  finishReason: string | null;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export type StreamCallback = (chunk: StreamChunk) => void;

export interface ChatOptions {
  messages: ChatCompletionMessage[];
  tools?: FunctionTool[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  signal?: AbortSignal;
  /** 是否启用JSON意图解析降级（默认 true） */
  enableFallbackParse?: boolean;
}

// ========================= 客户端 =========================

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxConcurrent: 3,
  requestsPerMinute: 60,
  retryAttempts: 5,
  retryBaseDelay: 1000,
  retryMaxDelay: 32000,
  queueMaxSize: 100,
};

export class TaskApiClient {
  private config: TaskApiConfig;
  private limiter: RateLimiter;
  /** 是否已确认API支持原生function calling；未确认时为 null */
  private supportsFcCache: boolean | null = null;

  constructor(config: TaskApiConfig, rateLimit?: RateLimitConfig) {
    this.config = config;
    this.limiter = new RateLimiter(rateLimit ?? DEFAULT_RATE_LIMIT);
  }

  updateConfig(config: Partial<TaskApiConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): TaskApiConfig {
    return this.config;
  }

  // ============== 模型列表 ==============

  /** GET /v1/models - 获取可用模型列表 */
  async listModels(): Promise<ModelInfo[]> {
    return this.limiter.run(() => this._listModels());
  }

  private async _listModels(): Promise<ModelInfo[]> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/v1/models`;
    const resp = await fetch(url, {
      method: "GET",
      headers: this._buildHeaders(),
    });
    if (resp.status === 429) {
      this.limiter.on429();
      throw new Error("rate limited (429)");
    }
    if (!resp.ok) {
      throw new Error(`list models failed: ${resp.status} ${await resp.text()}`);
    }
    const body = await resp.json();
    return body.data ?? [];
  }

  // ============== 非流式对话 ==============

  async chat(options: ChatOptions): Promise<ChatCompletionResponse> {
    return this.limiter.run(() => this._chat(options));
  }

  private async _chat(options: ChatOptions): Promise<ChatCompletionResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
    const body: Record<string, any> = {
      model: this.config.model,
      messages: options.messages,
      temperature: this.config.temperature,
      top_p: this.config.topP,
      max_tokens: this.config.maxTokens,
      stream: false,
      ...this.config.advancedParams,
    };
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.toolChoice) body.tool_choice = options.toolChoice;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: this._buildHeaders(),
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (resp.status === 429) {
      this.limiter.on429();
      throw new Error("rate limited (429)");
    }
    if (!resp.ok) {
      throw new Error(`chat failed: ${resp.status} ${await resp.text()}`);
    }
    return (await resp.json()) as ChatCompletionResponse;
  }

  // ============== 流式对话 (SSE) ==============

  /**
   * 流式对话：通过回调推送每个 chunk
   * @returns 完整的累计文本（结束时返回）
   */
  async chatStream(options: ChatOptions, onChunk: StreamCallback): Promise<string> {
    return this.limiter.run(() => this._chatStream(options, onChunk));
  }

  private async _chatStream(options: ChatOptions, onChunk: StreamCallback): Promise<string> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
    const body: Record<string, any> = {
      model: this.config.model,
      messages: options.messages,
      temperature: this.config.temperature,
      top_p: this.config.topP,
      max_tokens: this.config.maxTokens,
      stream: true,
      ...this.config.advancedParams,
    };
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.toolChoice) body.tool_choice = options.toolChoice;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: { ...this._buildHeaders(), Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (resp.status === 429) {
      this.limiter.on429();
      throw new Error("rate limited (429)");
    }
    if (!resp.ok) {
      throw new Error(`chat stream failed: ${resp.status} ${await resp.text()}`);
    }
    if (!resp.body) {
      throw new Error("no response body");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";
    let lastToolCalls: StreamChunk["toolCalls"];

    while (true) {
      if (options.signal?.aborted) {
        try { await reader.cancel(); } catch { /* noop */ }
        throw new DOMException("aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按行解析 SSE
      while (true) {
        const nlIdx = buffer.indexOf("\n");
        if (nlIdx === -1) break;
        const line = buffer.slice(0, nlIdx).replace(/\r$/, "");
        buffer = buffer.slice(nlIdx + 1);
        if (!line.trim()) continue;
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          return fullText;
        }
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta: string = choice.delta?.content ?? "";
          const finishReason: string | null = choice.finish_reason ?? null;
          const toolCalls = choice.delta?.tool_calls?.map((tc: any) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            },
          }));
          if (delta) fullText += delta;
          if (toolCalls) lastToolCalls = toolCalls;
          onChunk({
            delta,
            finishReason,
            toolCalls: toolCalls ?? lastToolCalls,
            usage: parsed.usage,
          });
        } catch (e) {
          console.warn("SSE parse error:", e, "| line:", data);
        }
      }
    }
    return fullText;
  }

  // ============== Function Calling ==============

  /**
   * 检测API是否支持原生function calling
   * 策略：发送一个最小请求，若响应中无错误且包含 tool_calls 字段则视为支持
   */
  async detectFunctionCallingSupport(): Promise<boolean> {
    if (this.supportsFcCache !== null) return this.supportsFcCache;
    try {
      const probeTool: FunctionTool = {
        type: "function",
        function: {
          name: "__probe__",
          description: "internal probe (do not call)",
          parameters: { type: "object", properties: {} },
        },
      };
      const resp = await this._chat({
        messages: [
          { role: "system", content: "You are a probe." },
          { role: "user", content: "ping" },
        ],
        tools: [probeTool],
        toolChoice: "none",
      });
      // 200 OK 且无报错视为支持
      this.supportsFcCache = !!resp.choices?.[0];
    } catch (e) {
      console.warn("function calling probe failed, fallback to JSON parse:", e);
      this.supportsFcCache = false;
    }
    return this.supportsFcCache;
  }

  /**
   * 完整的对话+工具调用流程：
   * 1. 若API支持 function calling → 用原生 tools 参数
   * 2. 否则降级到 JSON 意图解析（在 system prompt 末尾追加格式约束）
   */
  async chatWithTools(
    messages: ChatCompletionMessage[],
    tools: FunctionTool[],
    onChunk?: StreamCallback,
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    toolCalls: ToolCall[];
    finishReason: string | null;
  }> {
    const supportsFc = await this.detectFunctionCallingSupport();
    let text = "";
    let rawToolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    let finishReason: string | null = null;

    if (supportsFc) {
      // 原生 function calling
      text = await this.chatStream(
        { messages, tools, toolChoice: "auto", signal },
        (chunk) => {
          if (chunk.delta) text += chunk.delta; // _chatStream 已累计，这里不重复
          if (chunk.toolCalls) {
            // 累积 tool_calls（流式时按 index 分段）
            for (const tc of chunk.toolCalls) {
              const idx = rawToolCalls.findIndex((r) => r.id === tc.id && tc.id);
              if (idx >= 0) {
                rawToolCalls[idx].function.arguments += tc.function.arguments;
                rawToolCalls[idx].function.name =
                  tc.function.name || rawToolCalls[idx].function.name;
              } else {
                rawToolCalls.push({ ...tc });
              }
            }
          }
          if (chunk.finishReason) finishReason = chunk.finishReason;
          onChunk?.(chunk);
        },
      );
    } else {
      // 降级：JSON 意图解析
      const augmented = this._augmentForJsonFallback(messages, tools);
      text = await this.chatStream({ messages: augmented, signal }, (chunk) => {
        if (chunk.finishReason) finishReason = chunk.finishReason;
        onChunk?.(chunk);
      });
      rawToolCalls = this._parseJsonIntent(text, tools);
    }

    const toolCalls: ToolCall[] = rawToolCalls.map((tc) => ({
      id: tc.id || crypto.randomUUID(),
      name: tc.function.name,
      arguments: this._safeParseArgs(tc.function.arguments),
      status: "pending" as const,
    }));

    return { text, toolCalls, finishReason };
  }

  /** 降级模式：在 system prompt 末尾追加 JSON 输出约束 */
  private _augmentForJsonFallback(
    messages: ChatCompletionMessage[],
    tools: FunctionTool[],
  ): ChatCompletionMessage[] {
    const toolDesc = tools
      .map(
        (t) =>
          `- ${t.function.name}: ${t.function.description} | params: ${JSON.stringify(
            t.function.parameters,
          )}`,
      )
      .join("\n");
    const instruction = `\n\n[TOOL_USE_RULES]
You may call tools by emitting a JSON block at the END of your reply:
\`\`\`tool_calls
[
  { "name": "<tool_name>", "arguments": { ... } }
]
\`\`\`
Available tools:
${toolDesc}
If no tool is needed, do not emit the block. Reply in natural language only.`;

    return messages.map((m) => {
      if (m.role === "system") {
        return { ...m, content: (m.content as string) + instruction };
      }
      return m;
    });
  }

  /** 从回复文本中解析出 JSON 工具调用 */
  private _parseJsonIntent(
    text: string,
    tools: FunctionTool[],
  ): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
    const toolNames = new Set(tools.map((t) => t.function.name));
    // 优先匹配 ```tool_calls ... ``` 代码块
    const blockMatch = text.match(/```tool_calls\s*([\s\S]*?)```/);
    const candidate = blockMatch ? blockMatch[1] : text;
    // 尝试找到第一个 JSON 数组
    const jsonMatch = candidate.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!jsonMatch) return [];
    try {
      const arr = JSON.parse(jsonMatch[0]) as Array<{
        name?: string;
        arguments?: Record<string, any>;
      }>;
      const result: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [];
      for (const item of arr) {
        if (!item.name || !toolNames.has(item.name)) continue;
        result.push({
          id: crypto.randomUUID(),
          type: "function",
          function: {
            name: item.name,
            arguments: JSON.stringify(item.arguments ?? {}),
          },
        });
      }
      return result;
    } catch {
      return [];
    }
  }

  private _safeParseArgs(args: string): Record<string, any> {
    if (!args) return {};
    try {
      return JSON.parse(args);
    } catch {
      // 流式累积期间可能不完整，返回原始字符串包装
      return { __raw__: args };
    }
  }

  // ============== 工具方法 ==============

  private _buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.customHeaders,
    };
  }
}

// ========================= 默认导出 =========================

let _defaultClient: TaskApiClient | null = null;

export function getDefaultTaskClient(config?: TaskApiConfig): TaskApiClient {
  if (!_defaultClient || (config && _defaultClient.getConfig() !== config)) {
    if (!config) {
      throw new Error("TaskApiClient not initialized: config required on first call");
    }
    _defaultClient = new TaskApiClient(config);
  }
  return _defaultClient;
}

export function resetDefaultTaskClient() {
  _defaultClient = null;
}

// ========================= Tauri 桥接（可选） =========================

/**
 * 通过 Rust 后端调用 chat（带限流与重试的 Rust 实现）
 * 仅当希望走 Rust 端实现时使用；否则推荐使用上面的 fetch 直连版本
 */
export async function chatViaRust(
  config: TaskApiConfig,
  messages: ChatCompletionMessage[],
  tools?: FunctionTool[],
): Promise<ChatCompletionResponse> {
  return invoke<ChatCompletionResponse>("api_chat", {
    config,
    messages,
    tools,
  });
}

export async function listModelsViaRust(config: TaskApiConfig): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("api_list_models", { config });
}
