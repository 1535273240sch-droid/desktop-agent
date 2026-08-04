<template>
  <!-- 自定义模块：加载成功后接管整个覆盖层 -->
  <component
    :is="customModule"
    v-if="customModule"
    v-bind="passthroughProps"
    @on-mute="emit('onMute')"
    @on-end="emit('onEnd')"
    @on-interrupt="emit('onInterrupt')"
    @on-desktop-control="emit('onDesktopControl')"
  />
  <div v-else class="voice-overlay glass-panel" :style="rootStyle">
    <!-- 顶部：关闭 + 静音 -->
    <header class="voice-topbar">
      <div class="topbar-left">
        <button class="top-btn" :class="{ active: muted }" @click="toggleMute">
          <span class="ico" :class="muted ? 'ico-muted' : 'ico-mic'" />
          <span>{{ muted ? "已静音" : "静音" }}</span>
        </button>
      </div>
      <div class="topbar-right">
        <button class="top-btn close-btn" title="关闭语音模式" @click="emit('onEnd')">
          <span class="ico ico-close" />
        </button>
      </div>
    </header>

    <!-- 中间 -->
    <main class="voice-center">
      <!-- Agent 头像（三状态） -->
      <div class="avatar-stage" :class="`stage-${displayState}`">
        <div class="avatar-halo" />
        <div class="avatar-ring" />
        <div class="avatar-core">
          <img v-if="agentAvatar" :src="agentAvatar" :alt="agentName" class="avatar-img" />
          <span v-else class="avatar-text">{{ avatarInitial }}</span>
        </div>
      </div>

      <!-- 状态指示 -->
      <div class="status-row">
        <span class="status-dot" :class="`dot-${displayState}`" />
        <span class="status-text">{{ statusLabel }}</span>
      </div>

      <!-- 波形 -->
      <WaveformVisualizer
        :state="props.state"
        :audio-stream="muted ? null : props.audioStream"
      />

      <!-- 双向实时字幕 + 操作日志 -->
      <div class="subtitles" ref="subtitlesRef">
        <transition-group name="sub">
          <div v-if="userTranscript" key="user" class="subtitle user">
            <span class="sub-label">你</span>
            <span class="sub-text">{{ userTranscript }}</span>
          </div>
          <div v-if="aiTranscript" key="ai" class="subtitle ai">
            <span class="sub-label">{{ agentName || "AI" }}</span>
            <span class="sub-text">{{ aiTranscript }}</span>
          </div>
          <div
            v-for="(log, i) in operationLog"
            :key="`op-${i}-${log.slice(0, 8)}`"
            class="subtitle op-log"
          >
            <span class="sub-label op">操作</span>
            <span class="sub-text">{{ log }}</span>
          </div>
        </transition-group>
        <div v-if="!userTranscript && !aiTranscript && operationLog.length === 0" class="subtitle-hint">
          正在等待对话…
        </div>
      </div>
    </main>

    <!-- 底部控制栏 -->
    <footer class="voice-controls">
      <button class="ctrl-btn" :class="{ active: muted }" @click="toggleMute">
        <span class="ico" :class="muted ? 'ico-muted' : 'ico-mic'" />
        <span>{{ muted ? "取消静音" : "静音" }}</span>
      </button>
      <button class="ctrl-btn end" @click="emit('onEnd')">
        <span class="ico ico-end" />
        <span>结束对话</span>
      </button>
      <button class="ctrl-btn" @click="emit('onDesktopControl')">
        <span class="ico ico-desktop" />
        <span>桌面操控</span>
      </button>
    </footer>

    <!-- 自定义模块加载失败的兜底提示 -->
    <div v-if="customLoadError" class="load-error-tip">
      自定义语音模块加载失败，已使用内置界面
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  ref,
  computed,
  shallowRef,
  onMounted,
  onBeforeUnmount,
  watch,
  nextTick,
  type Component,
} from "vue";
import type { VoiceModuleProps } from "@/types";
import { useSettingsStore } from "@/stores/settings";
import WaveformVisualizer from "./WaveformVisualizer.vue";
import { loadCustomVoiceModule } from "./VoiceModuleLoader";

type VoiceState = VoiceModuleProps["state"];

const props = withDefaults(
  defineProps<{
    audioStream?: MediaStream | null;
    state?: VoiceState;
    userTranscript?: string;
    aiTranscript?: string;
    operationLog?: string[];
    themeVars?: Record<string, string>;
    agentAvatar?: string;
    agentName?: string;
  }>(),
  {
    audioStream: null,
    state: "idle",
    userTranscript: "",
    aiTranscript: "",
    operationLog: () => [],
    themeVars: () => ({}),
    agentAvatar: "",
    agentName: "",
  }
);

const emit = defineEmits<{
  (e: "onMute"): void;
  (e: "onEnd"): void;
  (e: "onInterrupt"): void;
  (e: "onDesktopControl"): void;
}>();

const settings = useSettingsStore();

// 静音状态
const muted = ref(false);
function toggleMute() {
  muted.value = !muted.value;
  emit("onMute");
}

// agentName / avatar 优先用 props，缺省回退到设置
const agentName = computed(() => props.agentName || settings.settings.agentName || "AI");
const agentAvatar = computed(() => props.agentAvatar || "");
const avatarInitial = computed(() => (agentName.value || "A").trim().charAt(0).toUpperCase());

// 状态映射到展示态
const displayState = computed<VoiceState>(() => props.state);
const statusLabel = computed(() => {
  switch (props.state) {
    case "listening":
      return "正在听…";
    case "recording":
      return "录音中…";
    case "thinking":
      return "思考中…";
    case "speaking":
      return "回复中…";
    default:
      return "待命中";
  }
});

// 主题变量合并
const rootStyle = computed(() => ({ ...props.themeVars }));

// 字幕区自动滚动到底部
const subtitlesRef = ref<HTMLDivElement | null>(null);
watch(
  () => [props.userTranscript, props.aiTranscript, props.operationLog.length],
  async () => {
    await nextTick();
    const el = subtitlesRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  }
);

// 透传给自定义模块的 props（符合 VoiceModuleProps 契约）
const passthroughProps = computed<VoiceModuleProps>(() => ({
  audioStream: props.audioStream ?? null,
  state: props.state,
  userTranscript: props.userTranscript,
  aiTranscript: props.aiTranscript,
  operationLog: props.operationLog,
  themeVars: props.themeVars,
  agentAvatar: agentAvatar.value,
  agentName: agentName.value,
}));

// ========== 动态加载自定义语音模块 ==========
const customModule = shallowRef<Component | null>(null);
const customLoadError = ref(false);

async function tryLoadCustomModule() {
  const modulePath = settings.settings.voice.modulePath;
  if (!modulePath) {
    customModule.value = null;
    return;
  }
  try {
    const mod = await loadCustomVoiceModule(modulePath);
    customModule.value = mod;
    customLoadError.value = false;
  } catch (e) {
    console.warn("[VoiceOverlay] 自定义语音模块加载失败，回退到内置界面:", e);
    customModule.value = null;
    customLoadError.value = true;
  }
}

onMounted(() => {
  void tryLoadCustomModule();
});

watch(
  () => settings.settings.voice.modulePath,
  () => {
    void tryLoadCustomModule();
  }
);

// 键盘：Esc 结束、空格打断
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("onEnd");
  if (e.code === "Space" && props.state === "speaking") {
    e.preventDefault();
    emit("onInterrupt");
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<style scoped>
.voice-overlay {
  position: fixed;
  inset: 0;
  z-index: 150;
  display: flex;
  flex-direction: column;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  color: var(--text-primary);
  overflow: hidden;
}

/* 顶部 */
.voice-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
}
.top-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-DEFAULT);
  color: var(--text-secondary);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.2s var(--ease-ios), color 0.2s var(--ease-ios);
}
.top-btn:hover {
  background: var(--bg-hover);
}
.top-btn.active {
  background: color-mix(in srgb, var(--theme-color) 22%, transparent);
  color: var(--theme-color);
}
.close-btn {
  padding: 7px 10px;
}
.ico {
  display: inline-block;
  width: 14px;
  height: 14px;
  position: relative;
}
.ico-mic::before {
  content: "🎙";
  font-size: 13px;
  line-height: 1;
}
.ico-muted::before {
  content: "🔇";
  font-size: 13px;
  line-height: 1;
}
.ico-close::before {
  content: "×";
  font-size: 18px;
  line-height: 1;
}
.ico-end::before {
  content: "■";
  font-size: 11px;
  color: #ef4444;
}
.ico-desktop::before {
  content: "🖥";
  font-size: 13px;
  line-height: 1;
}

/* 中间 */
.voice-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 12px 24px;
  overflow: hidden;
}

/* 头像舞台 */
.avatar-stage {
  position: relative;
  width: 132px;
  height: 132px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.avatar-core {
  position: relative;
  width: 92px;
  height: 92px;
  border-radius: 50%;
  overflow: hidden;
  background: color-mix(in srgb, var(--theme-color) 30%, white);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  transition: transform 0.6s var(--ease-out-expo);
  z-index: 2;
}
.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar-text {
  font-size: 36px;
  font-weight: 700;
  color: #fff;
}
.avatar-halo,
.avatar-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  z-index: 1;
}

/* 正在听：缩小 + 蓝色脉冲光晕 */
.stage-listening .avatar-core {
  transform: scale(0.9);
  animation: breathe-in 2.4s var(--ease-ios) infinite;
}
.stage-listening .avatar-halo {
  box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.55);
  animation: pulse-blue 2.4s var(--ease-out-expo) infinite;
}
.stage-listening .avatar-ring {
  display: none;
}

/* 思考中：光圈旋转 */
.stage-thinking .avatar-core {
  transform: scale(1);
}
.stage-thinking .avatar-ring {
  border: 2px solid transparent;
  border-top-color: var(--theme-color);
  border-right-color: color-mix(in srgb, var(--theme-color) 50%, transparent);
  animation: spin-ring 1.1s linear infinite;
  inset: -8px;
}
.stage-thinking .avatar-halo {
  box-shadow: 0 0 24px 4px var(--glow-color);
  opacity: 0.6;
}

/* 回复中：放大 + 主题色光晕 */
.stage-speaking .avatar-core {
  transform: scale(1.12);
  animation: breathe-out 1.4s var(--ease-ios) infinite;
}
.stage-speaking .avatar-halo {
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--theme-color) 60%, transparent);
  animation: pulse-theme 1.4s var(--ease-out-expo) infinite;
}
.stage-speaking .avatar-ring {
  display: none;
}

/* 待命 */
.stage-idle .avatar-core {
  transform: scale(1);
}
.stage-idle .avatar-halo {
  box-shadow: 0 0 18px 2px var(--glow-color);
  opacity: 0.4;
}

@keyframes breathe-in {
  0%, 100% { transform: scale(0.9); }
  50% { transform: scale(0.96); }
}
@keyframes breathe-out {
  0%, 100% { transform: scale(1.12); }
  50% { transform: scale(1.04); }
}
@keyframes pulse-blue {
  0% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.55); }
  70% { box-shadow: 0 0 0 24px rgba(56, 189, 248, 0); }
  100% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0); }
}
@keyframes pulse-theme {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--theme-color) 60%, transparent); }
  70% { box-shadow: 0 0 0 28px color-mix(in srgb, var(--theme-color) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--theme-color) 0%, transparent); }
}
@keyframes spin-ring {
  to { transform: rotate(360deg); }
}

/* 状态行 */
.status-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  letter-spacing: 0.5px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}
.dot-listening { background: #38bdf8; box-shadow: 0 0 8px #38bdf8; }
.dot-thinking { background: var(--theme-color); box-shadow: 0 0 8px var(--theme-color); }
.dot-speaking { background: var(--theme-color); box-shadow: 0 0 10px var(--theme-color); animation: blink 1s infinite; }
.dot-idle { background: var(--text-muted); }
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* 字幕区 */
.subtitles {
  width: 100%;
  max-width: 640px;
  min-height: 96px;
  max-height: 28vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 4px;
}
.subtitle {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  font-size: 14px;
  line-height: 1.5;
}
.subtitle.user {
  background: color-mix(in srgb, var(--theme-color) 14%, transparent);
  align-self: flex-end;
  max-width: 86%;
}
.subtitle.ai {
  background: var(--bg-elevated);
  align-self: flex-start;
  max-width: 86%;
}
.subtitle.op-log {
  background: color-mix(in srgb, #f97316 14%, transparent);
  align-self: center;
  max-width: 92%;
  font-size: 12px;
  font-family: var(--font-code);
}
.sub-label {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-input);
  align-self: flex-start;
  margin-top: 2px;
}
.sub-label.op {
  color: #f97316;
}
.sub-text {
  flex: 1;
  word-break: break-word;
  color: var(--text-primary);
}
.subtitle-hint {
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 24px 0;
}

.sub-enter-active,
.sub-leave-active {
  transition: all 0.25s var(--ease-ios);
}
.sub-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.sub-leave-to {
  opacity: 0;
}

/* 底部控制栏 */
.voice-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 18px 24px 26px;
}
.ctrl-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-DEFAULT);
  color: var(--text-primary);
  border-radius: 999px;
  padding: 10px 18px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.2s var(--ease-ios), transform 0.15s var(--ease-ios);
}
.ctrl-btn:hover {
  background: var(--bg-hover);
  transform: translateY(-1px);
}
.ctrl-btn.active {
  background: color-mix(in srgb, var(--theme-color) 22%, transparent);
  color: var(--theme-color);
  border-color: color-mix(in srgb, var(--theme-color) 40%, transparent);
}
.ctrl-btn.end {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.4);
}
.ctrl-btn.end:hover {
  background: rgba(239, 68, 68, 0.2);
}

.load-error-tip {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-elevated);
  padding: 4px 10px;
  border-radius: 999px;
  pointer-events: none;
}
</style>
