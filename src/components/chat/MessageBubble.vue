<template>
  <div class="message-bubble-wrap" :class="[`role-${message.role}`, { streaming: message.isStreaming }]">
    <!-- AI 头像 -->
    <div v-if="message.role === 'assistant'" class="avatar">
      <span class="avatar-icon">AI</span>
    </div>

    <div class="bubble-col">
      <!-- 思考过程折叠 -->
      <div v-if="thinkingSteps.length > 0" class="thinking-section">
        <button class="thinking-toggle" @click="thinkingExpanded = !thinkingExpanded">
          <span class="toggle-icon" :class="{ expanded: thinkingExpanded }">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
          <span class="thinking-label">
            {{ message.isStreaming && thinkingSteps.length ? "思考中..." : `思考过程 (${thinkingSteps.length})` }}
          </span>
          <span v-if="message.isStreaming" class="thinking-stream-dot" />
        </button>
        <transition name="expand">
          <div v-show="thinkingExpanded" class="thinking-body">
            <div v-for="(step, i) in thinkingSteps" :key="i" class="thinking-step">
              <span class="step-time">{{ formatTime(step.timestamp) }}</span>
              <span class="step-content">{{ step.content }}</span>
            </div>
          </div>
        </transition>
      </div>

      <!-- 工具调用卡片 -->
      <div v-if="toolCalls.length > 0" class="tool-calls-section">
        <ToolCallCard
          v-for="tc in toolCalls"
          :key="tc.id"
          :tool-call="tc"
          :default-expanded="tc.status === 'running' || tc.status === 'error' || tc.status === 'timeout'"
        />
      </div>

      <!-- 子 Agent 卡片 -->
      <SubAgentCard
        v-if="subAgent && message.subAgentId"
        :sub-agent="subAgent"
      />

      <!-- 错误卡片 -->
      <div v-if="message.error" class="error-card">
        <div class="error-header" @click="errorExpanded = !errorExpanded">
          <span class="error-icon">⚠</span>
          <span class="error-title">消息生成失败</span>
          <span class="error-expand" :class="{ expanded: errorExpanded }">详情</span>
        </div>
        <transition name="expand">
          <div v-show="errorExpanded" class="error-detail">{{ message.error }}</div>
        </transition>
        <div class="error-actions">
          <button class="error-btn retry" @click="$emit('retry', message.id)">重试</button>
        </div>
      </div>

      <!-- 消息主体 -->
      <div
        v-if="renderedContent || message.isStreaming"
        class="bubble glass-panel"
        :class="{ 'has-content': renderedContent }"
      >
        <div
          ref="contentRef"
          class="bubble-content markdown-body"
          @click="onContentClick"
          v-html="renderedContent"
        />
        <span v-if="message.isStreaming" class="streaming-cursor" />
      </div>

      <!-- 内联图片 -->
      <div v-if="images.length > 0" class="images-section">
        <div
          v-for="(img, i) in images"
          :key="i"
          class="image-item"
          @click="previewImage = img"
        >
          <img :src="img" :alt="`图片 ${i + 1}`" loading="lazy" />
        </div>
      </div>

      <!-- 附件文件 -->
      <div v-if="files.length > 0" class="files-section">
        <div v-for="(f, i) in files" :key="i" class="file-chip">
          <span class="file-icon">📎</span>
          <span class="file-name" :title="f.name">{{ f.name }}</span>
          <span class="file-size">{{ formatFileSize(f.size) }}</span>
        </div>
      </div>
    </div>

    <!-- 图片预览浮层 -->
    <teleport to="body">
      <transition name="fade">
        <div v-if="previewImage" class="image-lightbox" @click="previewImage = null">
          <img :src="previewImage" class="lightbox-img" @click.stop />
          <button class="lightbox-close" @click="previewImage = null">✕</button>
        </div>
      </transition>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { renderMarkdown } from "@/services/markdown/renderer";
import type { Message, SubAgent, ToolCall } from "@/types";
import ToolCallCard from "./ToolCallCard.vue";
import SubAgentCard from "./SubAgentCard.vue";

const props = defineProps<{
  message: Message;
  subAgent?: SubAgent;
}>();

defineEmits<{
  (e: "retry", messageId: string): void;
  (e: "copy", text: string): void;
}>();

const contentRef = ref<HTMLElement | null>(null);
const thinkingExpanded = ref(false);
const errorExpanded = ref(false);
const previewImage = ref<string | null>(null);

// ========== 计算属性 ==========
// 使用共享的 markdown 渲染器（含 LRU 缓存 + katex 懒加载 + hljs/core 按需注册）
const renderedContent = computed(() => {
  if (!props.message.content) return "";
  return renderMarkdown(props.message.content, contentRef.value);
});

// 内容变化后再次触发 katex 异步刷新（流式输出场景）
watch(
  () => props.message.content,
  () => {
    nextTick(() => {
      if (contentRef.value && contentRef.value.querySelector(".math-pending")) {
        // 触发 scheduleMathFlush（在 renderMarkdown 内部）
        renderMarkdown(props.message.content, contentRef.value);
      }
    });
  },
);

const thinkingSteps = computed(() => props.message.thinking ?? []);
const toolCalls = computed<ToolCall[]>(() => props.message.toolCalls ?? []);
const images = computed<string[]>(() => props.message.images ?? []);
const files = computed(() => props.message.files ?? []);

// ========== 事件处理 ==========
function onContentClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const copyBtn = target.closest('[data-action="copy-code"]') as HTMLElement | null;
  if (copyBtn) {
    e.preventDefault();
    const wrapper = copyBtn.closest(".code-block-wrapper");
    const codeEl = wrapper?.querySelector("code");
    if (codeEl) {
      const text = codeEl.textContent || "";
      navigator.clipboard.writeText(text).then(() => {
        const original = copyBtn.textContent;
        copyBtn.textContent = "已复制";
        setTimeout(() => {
          copyBtn.textContent = original;
        }, 1500);
      }).catch(() => {});
    }
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
</script>

<style scoped>
.message-bubble-wrap {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  max-width: 100%;
}

.message-bubble-wrap.role-user {
  flex-direction: row-reverse;
}

.bubble-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(720px, 80%);
}

.role-user .bubble-col {
  align-items: flex-end;
}

.role-assistant .bubble-col,
.role-tool .bubble-col,
.role-system .bubble-col {
  align-items: flex-start;
}

.avatar {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--theme-color), var(--theme-accent-muted));
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 2px 8px var(--glow-color);
}

/* 气泡主体 */
.bubble {
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  position: relative;
  word-break: break-word;
  line-height: 1.6;
  transition: box-shadow 0.2s var(--ease-ios);
}

.role-user .bubble {
  background: linear-gradient(135deg, var(--theme-color), var(--theme-accent-muted));
  color: #fff;
  border-bottom-right-radius: var(--radius-sm);
}

.role-assistant .bubble {
  border-bottom-left-radius: var(--radius-sm);
}

.bubble.has-content:empty {
  display: none;
}

/* Markdown 内容 */
.bubble-content {
  font-size: 14px;
}

.bubble-content :deep(p) {
  margin: 0 0 8px 0;
}
.bubble-content :deep(p:last-child) {
  margin-bottom: 0;
}
.bubble-content :deep(h1),
.bubble-content :deep(h2),
.bubble-content :deep(h3),
.bubble-content :deep(h4) {
  margin: 12px 0 6px;
  font-weight: 600;
  line-height: 1.3;
}
.bubble-content :deep(h1) { font-size: 1.4em; }
.bubble-content :deep(h2) { font-size: 1.25em; }
.bubble-content :deep(h3) { font-size: 1.1em; }
.bubble-content :deep(ul),
.bubble-content :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}
.bubble-content :deep(li) {
  margin: 2px 0;
}
.bubble-content :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--theme-accent-muted);
  background: rgba(0, 0, 0, 0.04);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.role-user .bubble-content :deep(blockquote) {
  background: rgba(255, 255, 255, 0.15);
  border-left-color: rgba(255, 255, 255, 0.6);
}
.bubble-content :deep(a) {
  color: var(--theme-color);
  text-decoration: none;
  border-bottom: 1px dashed currentColor;
}
.role-user .bubble-content :deep(a) {
  color: #fff;
  border-bottom-color: rgba(255, 255, 255, 0.7);
}
.bubble-content :deep(a:hover) {
  opacity: 0.8;
}
.bubble-content :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
  font-size: 13px;
}
.bubble-content :deep(th),
.bubble-content :deep(td) {
  border: 1px solid var(--border-DEFAULT);
  padding: 6px 10px;
  text-align: left;
}
.bubble-content :deep(th) {
  background: rgba(0, 0, 0, 0.06);
  font-weight: 600;
}
.bubble-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-DEFAULT);
  margin: 12px 0;
}
.bubble-content :deep(img) {
  max-width: 100%;
  border-radius: var(--radius-sm);
}

/* 链接卡片预览：单链接段落 */
.bubble-content :deep(p > a:only-child) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  border-bottom: none;
}
.bubble-content :deep(p > a:only-child)::before {
  content: "🔗";
}

/* 代码块 */
.bubble-content :deep(.code-block-wrapper) {
  margin: 8px 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: rgba(26, 24, 48, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.bubble-content :deep(.code-block-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.25);
  font-size: 11px;
}
.bubble-content :deep(.code-lang) {
  color: rgba(255, 255, 255, 0.55);
  font-family: var(--font-code);
  text-transform: lowercase;
}
.bubble-content :deep(.code-copy-btn) {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.7);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
  transition: all 0.15s;
}
.bubble-content :deep(.code-copy-btn:hover) {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.bubble-content :deep(.hljs) {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--font-code);
  font-size: 12.5px;
  line-height: 1.5;
  background: transparent;
  color: #e6e6e6;
}
.bubble-content :deep(code:not(.hljs code)) {
  background: rgba(0, 0, 0, 0.12);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-code);
  font-size: 0.9em;
}
.role-user .bubble-content :deep(code:not(.hljs code)) {
  background: rgba(255, 255, 255, 0.18);
}

/* 数学公式 */
.bubble-content :deep(.math-block) {
  margin: 8px 0;
  overflow-x: auto;
  padding: 4px 0;
}
.bubble-content :deep(.math-error) {
  color: #ef4444;
  font-family: var(--font-code);
  font-size: 0.9em;
}

/* 流式光标 */
.streaming-cursor {
  display: inline-block;
  width: 7px;
  height: 1.1em;
  background: var(--theme-color);
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 1s step-end infinite;
  border-radius: 1px;
}
@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

/* 思考过程 */
.thinking-section {
  width: 100%;
  background: var(--glass-bg);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.thinking-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
}
.toggle-icon {
  display: flex;
  transition: transform 0.2s var(--ease-ios);
  color: var(--text-muted);
}
.toggle-icon.expanded {
  transform: rotate(180deg);
}
.thinking-label {
  font-weight: 500;
}
.thinking-stream-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--theme-color);
  animation: pulse 1s ease-in-out infinite;
}
.thinking-body {
  padding: 6px 10px;
  border-top: 1px solid var(--border-subtle);
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.thinking-step {
  font-size: 12px;
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.step-time {
  color: var(--text-muted);
  font-family: var(--font-code);
  flex-shrink: 0;
}
.step-content {
  color: var(--text-primary);
  word-break: break-word;
}

/* 工具调用区 */
.tool-calls-section {
  width: 100%;
  display: flex;
  flex-direction: column;
}

/* 错误卡片 */
.error-card {
  width: 100%;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: var(--radius-md);
  padding: 8px 12px;
  font-size: 13px;
}
.error-header {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.error-icon {
  color: #ef4444;
}
.error-title {
  flex: 1;
  color: #dc2626;
  font-weight: 500;
}
.error-expand {
  font-size: 11px;
  color: var(--text-muted);
}
.error-expand.expanded::after {
  content: " ▲";
}
.error-expand:not(.expanded)::after {
  content: " ▼";
}
.error-detail {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(239, 68, 68, 0.2);
  font-size: 12px;
  color: #b91c1c;
  word-break: break-word;
  white-space: pre-wrap;
  font-family: var(--font-code);
}
.error-actions {
  margin-top: 6px;
  display: flex;
  gap: 6px;
}
.error-btn {
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(239, 68, 68, 0.4);
  background: transparent;
  color: #dc2626;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}
.error-btn:hover {
  background: rgba(239, 68, 68, 0.15);
}

/* 图片区 */
.images-section {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 100%;
}
.image-item {
  cursor: zoom-in;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  transition: transform 0.2s var(--ease-ios);
}
.image-item:hover {
  transform: scale(1.02);
}
.image-item img {
  display: block;
  max-width: 200px;
  max-height: 200px;
  object-fit: cover;
}

/* 附件区 */
.files-section {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--glass-bg);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  font-size: 12px;
  max-width: 240px;
}
.file-icon {
  flex-shrink: 0;
}
.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.file-size {
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
}

/* 图片预览浮层 */
.image-lightbox {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
}
.lightbox-img {
  max-width: 92vw;
  max-height: 92vh;
  object-fit: contain;
  border-radius: var(--radius-md);
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
}
.lightbox-close {
  position: absolute;
  top: 20px;
  right: 24px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.lightbox-close:hover {
  background: rgba(255, 255, 255, 0.25);
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}

.expand-enter-active,
.expand-leave-active {
  transition: opacity 0.2s var(--ease-ios), max-height 0.2s var(--ease-ios);
  overflow: hidden;
}
.expand-enter-from,
.expand-leave-to {
  opacity: 0;
  max-height: 0;
}
.expand-enter-to,
.expand-leave-from {
  max-height: 500px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s var(--ease-ios);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
