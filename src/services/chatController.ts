// chatController.ts - 核心聊天流程控制器
// 监听 chat:send 事件 → 调用 Task API + Function Calling → 流式渲染回复到聊天界面
// 集成：语音自动播报、任务规划、子Agent派生、记忆提取

import type { Message, ToolCall } from "@/types";
import type { ChatCompletionMessage } from "@/services/api/taskApi";
import { TaskApiClient } from "@/services/api/taskApi";
import {
  FunctionCallingEngine,
  toApiMessages,
} from "@/services/tools/functionCalling";
import { toolRegistry, initToolRegistry } from "@/services/tools/registry";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";
import { useVoiceStore } from "@/stores/voice";
import { runExtractionAfterTurn } from "@/services/memory/extractor";

// ========================= 单例控制器 =========================

class ChatController {
  private client: TaskApiClient | null = null;
  private engine: FunctionCallingEngine | null = null;
  private abortController: AbortController | null = null;
  private initialized = false;
  private registryReady = false;

  /** 初始化：创建 API 客户端 + Function Calling 引擎 + 工具注册 */
  async init(): Promise<void> {
    if (this.initialized) return;
    const settings = useSettingsStore();
    const cfg = settings.settings.apiKeys.task;
    if (!cfg.baseUrl || !cfg.apiKey) {
      // 未配置 API，等待用户配置后再初始化
      return;
    }
    this.client = new TaskApiClient(cfg, settings.settings.rateLimits.task);
    this.engine = new FunctionCallingEngine(this.client);
    // 工具注册（懒初始化，首次调用时加载）
    if (!this.registryReady) {
      try {
        await initToolRegistry();
        this.registryReady = true;
      } catch (e) {
        console.warn("[chatController] tool registry init failed:", e);
      }
    }
    this.initialized = true;
  }

  /** 配置变更后重置客户端 */
  reset(): void {
    this.client = null;
    this.engine = null;
    this.initialized = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  /** 是否就绪 */
  isReady(): boolean {
    return this.initialized && this.client !== null && this.engine !== null;
  }

  // ============== 主流程：发送消息并获取 AI 回复 ==============

  /**
   * 发送消息并驱动 AI 流式回复
   * 流程：
   * 1. 初始化（若未就绪）
   * 2. 创建空的 assistant 流式消息
   * 3. 构造上下文：system + 历史 + 当前用户消息
   * 4. 调用 FunctionCallingEngine.run（含工具调用循环）
   * 5. 流式 chunk 实时追加到 assistant 消息
   * 6. 工具调用结果作为单独的 tool 消息插入
   * 7. 完成后：自动播报 TTS + 提取记忆
   */
  async send(conversationId: string, userText: string, images: string[] = []): Promise<void> {
    const chat = useChatStore();
    const settings = useSettingsStore();

    await this.init();
    if (!this.isReady() || !this.engine || !this.client) {
      // 注入错误消息提示用户配置 API
      chat.addMessage(conversationId, {
        role: "assistant",
        content: "⚠️ 尚未配置任务 API。请打开 设置 → API 配置，填写 Base URL、API Key 和 Model 后再发送消息。",
        error: "api-not-configured",
      });
      return;
    }

    // 中止上一次请求（如有）
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // 创建 assistant 流式消息
    const assistantMsg = chat.startStreaming(conversationId);

    // 构造上下文
    const conv = chat.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const history = conv.messages.filter((m) => m.id !== assistantMsg.id);
    const apiMessages = this._buildContextMessages(history, settings.settings, images, userText);

    // 流式回调
    let lastChunkTime = 0;
    const onChunk = (chunk: { delta: string; toolCalls?: any[] }) => {
      if (chunk.delta) {
        chat.appendStreamChunk(conversationId, chunk.delta);
        // 节流保存（避免每个字符都写 localStorage）
        const now = Date.now();
        if (now - lastChunkTime > 500) {
          lastChunkTime = now;
          chat.save();
        }
      }
    };

    try {
      const result = await this.engine.run(apiMessages, {
        onChunk,
        signal,
        maxRounds: 10,
        onProgress: (update) => {
          // 工具执行进度：插入 tool 消息
          if (update.type === "start" && update.toolCall) {
            this._appendToolCall(conversationId, update.toolCall, "running");
          } else if (update.type === "success" && update.result && update.toolCall) {
            this._updateToolCall(conversationId, update.toolCall, "success", update.result.output);
          } else if (update.type === "error" && update.result && update.toolCall) {
            this._updateToolCall(conversationId, update.toolCall, "error", undefined, update.result.error);
          }
        },
      });

      // 标记流式结束
      chat.stopStreaming(conversationId);

      // 若有工具调用记录，附加到 assistant 消息
      if (result.toolCalls.length > 0) {
        chat.updateMessage(conversationId, assistantMsg.id, {
          toolCalls: result.toolCalls,
        });
      }

      // TTS 自动播报
      const voice = useVoiceStore();
      if (settings.settings.voice.ttsAutoPlay && result.text) {
        voice.speakAuto(result.text).catch(() => {/* TTS 失败不影响主流程 */});
      }

      // 自动提取记忆（runExtractionAfterTurn 内部会写入 memory store）
      try {
        await runExtractionAfterTurn(this.client, conv);
      } catch (e) {
        console.warn("[chatController] memory extraction failed:", e);
      }
    } catch (e: any) {
      chat.stopStreaming(conversationId);
      if (e?.name === "AbortError" || signal.aborted) {
        chat.updateMessage(conversationId, assistantMsg.id, {
          content: (chat.activeConversation?.messages.find((m) => m.id === assistantMsg.id)?.content ?? "") + "\n\n_（已中止）_",
          isStreaming: false,
        });
        return;
      }
      const errMsg = e?.message ?? String(e);
      chat.updateMessage(conversationId, assistantMsg.id, {
        content: `⚠️ 请求失败：${errMsg}`,
        error: errMsg,
        isStreaming: false,
      });
    } finally {
      this.abortController = null;
      chat.save();
    }
  }

  /** 中止当前请求 */
  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  // ============== 工具方法 ==============

  /** 构造对话上下文消息 */
  private _buildContextMessages(
    history: Message[],
    settings: any,
    images: string[],
    userText: string,
  ): ChatCompletionMessage[] {
    const messages: ChatCompletionMessage[] = [];

    // System prompt
    const sysPrompt = settings.apiKeys.task.systemPrompt || settings.systemPrompt ||
      `你是 ${settings.agentName || "小助"}，一个功能丰富的桌面智能助手。
你可以调用工具来：识图、生图、语音合成、操作桌面应用、执行沙箱代码、派生子Agent、读写文件。
请根据用户意图主动调用合适的工具完成任务。回复使用中文，简洁清晰。`;
    messages.push({ role: "system", content: sysPrompt });

    // Agent persona
    if (settings.agentPersona) {
      messages.push({ role: "system", content: `角色设定：${settings.agentPersona}` });
    }

    // 历史消息（截取最近 20 条避免上下文过长）
    const recent = history.slice(-20);
    for (const m of recent) {
      if (m.role === "tool") continue; // tool 消息由引擎内部处理
      const apiMsg: ChatCompletionMessage = {
        role: m.role as ChatCompletionMessage["role"],
        content: m.content,
      };
      // 用户消息带图片
      if (m.role === "user" && m.images && m.images.length > 0) {
        const content: any[] = [{ type: "text", text: m.content }];
        for (const img of m.images) {
          content.push({ type: "image_url", image_url: { url: img } });
        }
        apiMsg.content = content as any;
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        apiMsg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      messages.push(apiMsg);
    }

    // 当前用户消息（若历史中已包含则不重复添加）
    const lastMsg = recent[recent.length - 1];
    if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== userText) {
      if (images.length > 0) {
        const content: any[] = [{ type: "text", text: userText }];
        for (const img of images) {
          content.push({ type: "image_url", image_url: { url: img } });
        }
        messages.push({ role: "user", content: content as any });
      } else {
        messages.push({ role: "user", content: userText });
      }
    }

    return messages;
  }

  /** 追加工具调用记录到当前 assistant 消息 */
  private _appendToolCall(conversationId: string, toolCall: ToolCall, status: ToolCall["status"]) {
    const chat = useChatStore();
    const conv = chat.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const assistantMsg = conv.messages.find((m) => m.id === chat.streamingMessageId);
    if (!assistantMsg) return;
    const calls = assistantMsg.toolCalls ?? [];
    calls.push({ ...toolCall, status });
    chat.updateMessage(conversationId, assistantMsg.id, { toolCalls: calls });
  }

  /** 更新工具调用状态 */
  private _updateToolCall(
    conversationId: string,
    toolCall: ToolCall,
    status: ToolCall["status"],
    output?: any,
    error?: string,
  ) {
    const chat = useChatStore();
    const conv = chat.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const assistantMsg = conv.messages.find((m) => m.id === chat.streamingMessageId);
    if (!assistantMsg || !assistantMsg.toolCalls) return;
    const idx = assistantMsg.toolCalls.findIndex((tc) => tc.id === toolCall.id);
    if (idx >= 0) {
      const calls = [...assistantMsg.toolCalls];
      calls[idx] = {
        ...calls[idx],
        status,
        result: output,
        error,
        completedAt: Date.now(),
      };
      chat.updateMessage(conversationId, assistantMsg.id, { toolCalls: calls });
    }
  }
}

// ========================= 单例导出 =========================

export const chatController = new ChatController();

/** 启动聊天控制器：监听全局事件 */
export function startChatController(): () => void {
  const onChatSend = (e: Event) => {
    const detail = (e as CustomEvent).detail as {
      conversationId: string;
      payload: { text: string; files: any[]; images: string[] };
    };
    if (!detail) return;
    chatController.send(detail.conversationId, detail.payload.text, detail.payload.images).catch((err) => {
      console.error("[chatController] send failed:", err);
    });
  };

  const onChatRetry = (e: Event) => {
    const detail = (e as CustomEvent).detail as { conversationId: string };
    if (!detail) return;
    // 重试：取最后一条用户消息重新发送
    const chat = useChatStore();
    const conv = chat.conversations.find((c) => c.id === detail.conversationId);
    if (!conv) return;
    const lastUser = [...conv.messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      chatController.send(detail.conversationId, lastUser.content, lastUser.images ?? []).catch(console.error);
    }
  };

  const onApiConfigChanged = () => {
    chatController.reset();
  };

  window.addEventListener("chat:send", onChatSend);
  window.addEventListener("chat:retry", onChatRetry);
  window.addEventListener("api-config-changed", onApiConfigChanged);

  return () => {
    window.removeEventListener("chat:send", onChatSend);
    window.removeEventListener("chat:retry", onChatRetry);
    window.removeEventListener("api-config-changed", onApiConfigChanged);
  };
}
