<template>
  <div
    class="input-bar glass-panel"
    :class="{ dragging }"
    @dragover.prevent
    @dragenter.prevent="onDragEnter"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <!-- 附件预览 -->
    <div v-if="files.length > 0 || images.length > 0" class="attachments">
      <div v-for="(img, i) in images" :key="`img-${i}`" class="attachment-chip image-chip">
        <img :src="img" class="chip-thumb" />
        <button class="chip-remove" @click="removeImage(i)">✕</button>
      </div>
      <div v-for="(f, i) in files" :key="`file-${i}`" class="attachment-chip file-chip">
        <span class="chip-icon">📎</span>
        <span class="chip-name" :title="f.name">{{ f.name }}</span>
        <span class="chip-size">{{ formatSize(f.size) }}</span>
        <button class="chip-remove" @click="removeFile(i)">✕</button>
      </div>
    </div>

    <!-- 快捷按钮栏 -->
    <div class="quick-actions">
      <button class="quick-btn" @click="triggerFileInput" title="上传文件">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        <span class="btn-label">文件</span>
      </button>
      <button
        class="quick-btn"
        :class="{ recording: voice.isRecording }"
        :title="voice.isRecording ? '正在录音，点击停止' : '语音输入'"
        @click="toggleRecording"
      >
        <svg v-if="!voice.isRecording" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
        <span v-else class="rec-pulse" />
        <span class="btn-label">{{ voice.isRecording ? '停止' : '语音' }}</span>
      </button>

      <!-- 实时转写提示 -->
      <transition name="fade">
        <span v-if="voice.isRecording && voice.asrTranscript" class="asr-preview" :title="voice.asrTranscript">
          {{ voice.asrTranscript }}
        </span>
      </transition>
      <button class="quick-btn" @click="$emit('run-code')" title="代码执行">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
        <span class="btn-label">代码</span>
      </button>

      <div class="spacer" />

      <!-- Token 估算 -->
      <span class="token-estimate" :class="{ warn: tokenCount > 4000 }">
        ~{{ tokenCount }} tokens
      </span>
    </div>

    <!-- 输入区 -->
    <div class="input-row">
      <textarea
        ref="textareaRef"
        v-model="text"
        class="input-textarea"
        :placeholder="placeholder"
        :disabled="disabled"
        rows="1"
        @keydown="onKeydown"
        @paste="onPaste"
        @input="autoResize"
      ></textarea>
      <button
        class="send-btn"
        :disabled="!canSend"
        @click="onSend"
        :title="disabled ? '生成中...' : '发送 (Enter)'"
      >
        <svg v-if="!disabled" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
        <span v-else class="send-spinner" />
      </button>
    </div>

    <!-- 拖拽提示 -->
    <transition name="fade">
      <div v-if="dragging" class="drag-overlay">
        <div class="drag-hint">
          <span class="drag-icon">📁</span>
          <span>松开以上传文件</span>
        </div>
      </div>
    </transition>

    <input
      ref="fileInputRef"
      type="file"
      multiple
      class="hidden-input"
      @change="onFileSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { AttachedFile } from "@/types";
import { useVoiceStore } from "@/stores/voice";

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    placeholder?: string;
  }>(),
  {
    disabled: false,
    placeholder: "输入消息... (Enter 发送, Shift+Enter 换行)",
  }
);

const emit = defineEmits<{
  (e: "send", payload: { text: string; files: AttachedFile[]; images: string[] }): void;
  (e: "voice"): void;
  (e: "run-code"): void;
}>();

const voice = useVoiceStore();

const text = ref("");
const files = ref<AttachedFile[]>([]);
const images = ref<string[]>([]);
const dragging = ref(false);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

// 录音结束后的转写文本自动追加到输入框
watch(() => voice.asrFinalText, (finalText) => {
  if (finalText && !voice.isRecording) {
    text.value = text.value ? `${text.value} ${finalText}` : finalText;
    nextTick(autoResize);
    voice.clearTranscript();
  }
});

async function toggleRecording() {
  if (voice.isRecording) {
    const finalText = await voice.stopRecording();
    if (finalText) {
      text.value = text.value ? `${text.value} ${finalText}` : finalText;
      nextTick(autoResize);
      voice.clearTranscript();
    }
  } else {
    try {
      voice.init();
      await voice.startRecording();
    } catch (e) {
      console.warn("[InputBar] start recording failed:", e);
    }
  }
}

const canSend = computed(() => {
  return !props.disabled && (text.value.trim().length > 0 || files.value.length > 0 || images.value.length > 0);
});

// ========== Token 估算 ==========
const tokenCount = computed(() => {
  const t = text.value;
  if (!t) return 0;
  const cjk = (t.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const nonCjk = t.length - cjk;
  // 附件粗略计入
  const fileTokens = files.value.reduce((s, f) => s + Math.ceil(f.size / 4000), 0);
  const imgTokens = images.value.length * 765; // 单图大致 token
  return cjk + Math.ceil(nonCjk / 4) + fileTokens + imgTokens;
});

// ========== 自动扩展高度 ==========
function autoResize() {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

// ========== 键盘事件 ==========
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    onSend();
  }
}

// ========== 发送 ==========
function onSend() {
  if (!canSend.value) return;
  const payload = {
    text: text.value.trim(),
    files: [...files.value],
    images: [...images.value],
  };
  emit("send", payload);
  text.value = "";
  files.value = [];
  images.value = [];
  nextTick(autoResize);
}

// ========== 粘贴图片 ==========
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        readImageFile(file);
      }
    }
  }
}

// ========== 文件选择 ==========
function triggerFileInput() {
  fileInputRef.value?.click();
}

function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) {
    handleFiles(Array.from(input.files));
  }
  input.value = "";
}

function handleFiles(list: File[]) {
  for (const f of list) {
    if (f.type.startsWith("image/")) {
      readImageFile(f);
    } else {
      readFileAsAttached(f);
    }
  }
}

function readImageFile(f: File) {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === "string") {
      images.value.push(reader.result);
    }
  };
  reader.readAsDataURL(f);
}

function readFileAsAttached(f: File) {
  const reader = new FileReader();
  reader.onload = () => {
    files.value.push({
      name: f.name,
      path: (f as any).path || f.name,
      size: f.size,
      type: f.type || "application/octet-stream",
      data: typeof reader.result === "string" ? reader.result.split(",")[1] : undefined,
    });
  };
  reader.readAsDataURL(f);
}

// ========== 拖拽 ==========
let dragCounter = 0;
function onDragEnter() {
  dragCounter++;
  dragging.value = true;
}
function onDragLeave() {
  dragCounter--;
  if (dragCounter <= 0) {
    dragging.value = false;
    dragCounter = 0;
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  dragCounter = 0;
  const dropped = e.dataTransfer?.files;
  if (dropped && dropped.length > 0) {
    handleFiles(Array.from(dropped));
  }
}

// ========== 附件管理 ==========
function removeFile(i: number) {
  files.value.splice(i, 1);
}
function removeImage(i: number) {
  images.value.splice(i, 1);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ========== 暴露给父组件（编辑重发时设置文本）==========
function setText(value: string) {
  text.value = value;
  nextTick(() => {
    autoResize();
    textareaRef.value?.focus();
  });
}

function focus() {
  textareaRef.value?.focus();
}

onMounted(() => {
  autoResize();
});

defineExpose({ setText, focus });
</script>

<style scoped>
.input-bar {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  margin: 0 16px 12px;
  transition: border-color 0.2s var(--ease-ios), box-shadow 0.2s var(--ease-ios);
}

.input-bar.dragging {
  border-color: var(--theme-color);
  box-shadow: 0 0 0 2px var(--glow-color);
}

/* 附件预览 */
.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border-subtle);
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--glass-bg);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  font-size: 12px;
  position: relative;
}

.image-chip {
  padding: 3px;
}

.chip-thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: var(--radius-sm);
}

.file-chip {
  max-width: 220px;
}

.chip-icon {
  flex-shrink: 0;
}
.chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  max-width: 120px;
}
.chip-size {
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
}

.chip-remove {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 10px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex-shrink: 0;
}
.chip-remove:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

/* 快捷按钮栏 */
.quick-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.spacer {
  flex: 1;
}

.quick-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s var(--ease-ios);
}
.quick-btn:hover {
  background: var(--bg-hover);
  color: var(--theme-color);
  border-color: var(--border-subtle);
}

.quick-btn.recording {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.4);
}

.rec-pulse {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #ef4444;
  animation: rec-pulse-anim 1.2s ease-in-out infinite;
  display: inline-block;
}

@keyframes rec-pulse-anim {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.85); }
}

.asr-preview {
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-hover);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-label {
  font-size: 12px;
}

.token-estimate {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-code);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
}
.token-estimate.warn {
  color: #f97316;
  background: rgba(249, 115, 22, 0.1);
}

/* 输入行 */
.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.input-textarea {
  flex: 1;
  resize: none;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.5;
  padding: 6px 4px;
  max-height: 200px;
  min-height: 24px;
  outline: none;
  overflow-y: auto;
}
.input-textarea::placeholder {
  color: var(--text-muted);
}
.input-textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 发送按钮 */
.send-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: linear-gradient(135deg, var(--theme-color), var(--theme-accent-muted));
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.18s var(--ease-ios);
  box-shadow: 0 2px 8px var(--glow-color);
}
.send-btn:hover:not(:disabled) {
  transform: scale(1.08);
}
.send-btn:active:not(:disabled) {
  transform: scale(0.95);
}
.send-btn:disabled {
  background: var(--bg-hover);
  color: var(--text-muted);
  cursor: not-allowed;
  box-shadow: none;
}

.send-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.hidden-input {
  display: none;
}

/* 拖拽遮罩 */
.drag-overlay {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--theme-color) 12%, transparent);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 5;
}
.drag-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--theme-color);
  font-weight: 500;
}
.drag-icon {
  font-size: 32px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s var(--ease-ios);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
