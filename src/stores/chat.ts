import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { nanoid } from "nanoid";
import type { Conversation, Message } from "@/types";

const STORAGE_KEY = "desktop-agent-conversations";

export const useChatStore = defineStore("chat", () => {
  const conversations = ref<Conversation[]>([]);
  const activeConversationId = ref<string | null>(null);
  const isStreaming = ref(false);
  const streamingMessageId = ref<string | null>(null);

  const activeConversation = computed(() =>
    conversations.value.find((c) => c.id === activeConversationId.value)
  );

  const sortedConversations = computed(() =>
    [...conversations.value]
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.updatedAt - a.updatedAt;
      })
  );

  function load() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        conversations.value = JSON.parse(stored);
      }
    } catch (e) {
      console.error("Failed to load conversations:", e);
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.value));
    } catch (e) {
      console.error("Failed to save conversations:", e);
    }
  }

  function createConversation(title = "新对话"): Conversation {
    const conv: Conversation = {
      id: nanoid(),
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    conversations.value.unshift(conv);
    activeConversationId.value = conv.id;
    save();
    return conv;
  }

  function deleteConversation(id: string) {
    const idx = conversations.value.findIndex((c) => c.id === id);
    if (idx !== -1) {
      conversations.value.splice(idx, 1);
      if (activeConversationId.value === id) {
        activeConversationId.value = conversations.value[0]?.id ?? null;
      }
      save();
    }
  }

  function renameConversation(id: string, title: string) {
    const conv = conversations.value.find((c) => c.id === id);
    if (conv) {
      conv.title = title;
      save();
    }
  }

  function setSystemPrompt(id: string, prompt: string) {
    const conv = conversations.value.find((c) => c.id === id);
    if (conv) {
      conv.systemPrompt = prompt;
      save();
    }
  }

  function addMessage(conversationId: string, message: Partial<Message>): Message {
    const conv = conversations.value.find((c) => c.id === conversationId);
    if (!conv) throw new Error("Conversation not found");

    const msg: Message = {
      id: nanoid(),
      role: message.role ?? "user",
      content: message.content ?? "",
      timestamp: Date.now(),
      ...message,
    };
    conv.messages.push(msg);
    conv.updatedAt = Date.now();

    // 自动生成标题
    if (conv.title === "新对话" && msg.role === "user" && conv.messages.length === 1) {
      conv.title = msg.content.slice(0, 30) || "新对话";
    }

    save();
    return msg;
  }

  function updateMessage(conversationId: string, messageId: string, updates: Partial<Message>) {
    const conv = conversations.value.find((c) => c.id === conversationId);
    if (!conv) return;
    const msg = conv.messages.find((m) => m.id === messageId);
    if (msg) {
      Object.assign(msg, updates);
      conv.updatedAt = Date.now();
      save();
    }
  }

  function deleteMessage(conversationId: string, messageId: string) {
    const conv = conversations.value.find((c) => c.id === conversationId);
    if (!conv) return;
    const idx = conv.messages.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      conv.messages.splice(idx, 1);
      save();
    }
  }

  function startStreaming(conversationId: string): Message {
    const msg = addMessage(conversationId, {
      role: "assistant",
      content: "",
      isStreaming: true,
    });
    isStreaming.value = true;
    streamingMessageId.value = msg.id;
    return msg;
  }

  function appendStreamChunk(conversationId: string, chunk: string) {
    if (!streamingMessageId.value) return;
    const conv = conversations.value.find((c) => c.id === conversationId);
    if (!conv) return;
    const msg = conv.messages.find((m) => m.id === streamingMessageId.value);
    if (msg) {
      msg.content += chunk;
    }
  }

  function stopStreaming(conversationId: string) {
    if (!streamingMessageId.value) return;
    const conv = conversations.value.find((c) => c.id === conversationId);
    if (conv) {
      const msg = conv.messages.find((m) => m.id === streamingMessageId.value);
      if (msg) {
        msg.isStreaming = false;
        conv.updatedAt = Date.now();
        save();
      }
    }
    isStreaming.value = false;
    streamingMessageId.value = null;
  }

  function searchConversations(query: string): Conversation[] {
    const q = query.toLowerCase();
    return conversations.value.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q))
    );
  }

  function exportConversation(id: string, format: "markdown" | "json" | "txt" | "pdf"): string {
    const conv = conversations.value.find((c) => c.id === id);
    if (!conv) return "";

    if (format === "json") {
      return JSON.stringify(conv, null, 2);
    }

    if (format === "txt") {
      return conv.messages
        .map((m) => `[${m.role}] ${m.content}`)
        .join("\n\n");
    }

    if (format === "markdown") {
      return `# ${conv.title}\n\n${conv.messages
        .map((m) => `## ${m.role === "user" ? "用户" : "助手"}\n\n${m.content}`)
        .join("\n\n")}`;
    }

    return "";
  }

  return {
    conversations,
    activeConversationId,
    activeConversation,
    sortedConversations,
    isStreaming,
    streamingMessageId,
    load,
    save,
    createConversation,
    deleteConversation,
    renameConversation,
    setSystemPrompt,
    addMessage,
    updateMessage,
    deleteMessage,
    startStreaming,
    appendStreamChunk,
    stopStreaming,
    searchConversations,
    exportConversation,
  };
});
