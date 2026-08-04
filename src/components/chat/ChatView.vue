<template>
  <div class="chat-view">
    <!-- 顶部：会话标签页 -->
    <TabBar />

    <!-- 中间：消息列表（含空状态） -->
    <div class="message-area">
      <MessageList
        ref="messageListRef"
        :messages="messages"
        @retry="onRetry"
        @edit="onEdit"
        @delete="onDelete"
      >
        <template #empty>
          <div class="empty-state">
            <div class="empty-logo">
              <div class="empty-avatar">AI</div>
            </div>
            <h2 class="empty-title">你好，我是你的智能助手</h2>
            <p class="empty-desc">
              我可以帮你撰写文案、编写代码、分析数据、操作桌面应用，<br />
              支持 Markdown、代码高亮、数学公式、工具调用与多 Agent 协作。
            </p>

            <div class="empty-features">
              <div class="feature-item">
                <span class="feature-icon">🎨</span>
                <div class="feature-body">
                  <span class="feature-title">富文本渲染</span>
                  <span class="feature-desc">Markdown / KaTeX / 代码高亮</span>
                </div>
              </div>
              <div class="feature-item">
                <span class="feature-icon">🛠</span>
                <div class="feature-body">
                  <span class="feature-title">工具调用</span>
                  <span class="feature-desc">文件、终端、浏览器自动化</span>
                </div>
              </div>
              <div class="feature-item">
                <span class="feature-icon">🤖</span>
                <div class="feature-body">
                  <span class="feature-title">多 Agent</span>
                  <span class="feature-desc">子任务拆分与协作</span>
                </div>
              </div>
              <div class="feature-item">
                <span class="feature-icon">🎙</span>
                <div class="feature-body">
                  <span class="feature-title">语音交互</span>
                  <span class="feature-desc">实时语音对话与控制</span>
                </div>
              </div>
            </div>

            <div class="empty-suggestions">
              <button
                v-for="s in suggestions"
                :key="s.title"
                class="suggest-item"
                @click="onSuggestion(s.text)"
              >
                <span class="suggest-icon">{{ s.icon }}</span>
                <div class="suggest-body">
                  <span class="suggest-title">{{ s.title }}</span>
                  <span class="suggest-text">{{ s.text }}</span>
                </div>
              </button>
            </div>

            <button class="empty-new-btn" @click="startNew">开启新对话</button>
          </div>
        </template>
      </MessageList>
    </div>

    <!-- 底部：输入栏 -->
    <InputBar
      ref="inputBarRef"
      :disabled="chat.isStreaming"
      @send="onSend"
      @voice="onVoice"
      @run-code="onRunCode"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useChatStore } from "@/stores/chat";
import type { Message, AttachedFile } from "@/types";
import TabBar from "./TabBar.vue";
import MessageList from "./MessageList.vue";
import InputBar from "./InputBar.vue";

const chat = useChatStore();

const inputBarRef = ref<InstanceType<typeof InputBar> | null>(null);
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null);

const activeConversation = computed(() => chat.activeConversation);
const messages = computed<Message[]>(() => activeConversation.value?.messages ?? []);

const suggestions = [
  { icon: "💡", title: "解释概念", text: "请用通俗易懂的方式解释什么是量子纠缠" },
  { icon: "📝", title: "撰写文案", text: "帮我写一段产品发布的宣传文案" },
  { icon: "💻", title: "编写代码", text: "用 Python 实现一个快速排序算法" },
  { icon: "🔍", title: "分析问题", text: "分析当前项目的代码结构并提出优化建议" },
];

// ========== 发送 ==========
interface SendPayload {
  text: string;
  files: AttachedFile[];
  images: string[];
}

function onSend(payload: SendPayload) {
  let convId = chat.activeConversationId;
  if (!convId || !activeConversation.value) {
    const conv = chat.createConversation();
    convId = conv.id;
  }

  chat.addMessage(convId!, {
    role: "user",
    content: payload.text,
    images: payload.images.length ? payload.images : undefined,
    files: payload.files.length ? payload.files : undefined,
  });

  // 通知上层/后端驱动 AI 流式回复
  window.dispatchEvent(
    new CustomEvent("chat:send", {
      detail: { conversationId: convId, payload },
    })
  );
}

// ========== 编辑重发 ==========
function onEdit(message: Message) {
  if (!activeConversation.value) return;
  inputBarRef.value?.setText(message.content);
  // 删除该消息及其后所有消息（典型 编辑重发 行为）
  const conv = activeConversation.value;
  const idx = conv.messages.findIndex((m) => m.id === message.id);
  if (idx >= 0) {
    conv.messages.splice(idx);
    conv.updatedAt = Date.now();
    chat.save();
  }
}

// ========== 删除 ==========
function onDelete(messageId: string) {
  if (!activeConversation.value) return;
  chat.deleteMessage(activeConversation.value.id, messageId);
}

// ========== 重试 ==========
function onRetry(messageId: string) {
  if (!activeConversation.value) return;
  const convId = activeConversation.value.id;
  chat.deleteMessage(convId, messageId);
  window.dispatchEvent(
    new CustomEvent("chat:retry", { detail: { conversationId: convId } })
  );
}

// ========== 建议/快捷 ==========
function onSuggestion(text: string) {
  onSend({ text, files: [], images: [] });
}

function startNew() {
  chat.createConversation();
  inputBarRef.value?.focus();
}

function onVoice() {
  window.dispatchEvent(new CustomEvent("toggle-voice-mode"));
}

function onRunCode() {
  inputBarRef.value?.setText("```python\n\n```");
}
</script>

<style scoped>
.chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.message-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* 空状态 */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  gap: 14px;
  overflow-y: auto;
}

.empty-logo {
  margin-bottom: 4px;
}

.empty-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--theme-color), var(--theme-accent-muted));
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 600;
  box-shadow: 0 8px 24px var(--glow-color);
}

.empty-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.empty-desc {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  max-width: 480px;
}

.empty-features {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  max-width: 520px;
  width: 100%;
  margin: 8px 0;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--glass-bg);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  text-align: left;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.feature-icon {
  font-size: 20px;
  flex-shrink: 0;
}

.feature-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.feature-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.feature-desc {
  font-size: 11px;
  color: var(--text-muted);
}

.empty-suggestions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  max-width: 560px;
  width: 100%;
}

.suggest-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--glass-bg);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  transition: all 0.18s var(--ease-ios);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.suggest-item:hover {
  background: var(--bg-hover);
  border-color: var(--theme-accent-muted);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px var(--glow-color);
}

.suggest-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.suggest-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.suggest-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}

.suggest-text {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-new-btn {
  margin-top: 4px;
  padding: 8px 24px;
  border-radius: var(--radius-lg);
  border: none;
  background: linear-gradient(135deg, var(--theme-color), var(--theme-accent-muted));
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  box-shadow: 0 4px 14px var(--glow-color);
  transition: transform 0.18s var(--ease-ios);
}

.empty-new-btn:hover {
  transform: translateY(-2px);
}
</style>
