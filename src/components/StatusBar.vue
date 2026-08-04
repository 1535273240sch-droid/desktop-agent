<template>
  <div class="status-bar glass-panel">
    <!-- 左侧: 紧急终止 + Agent 状态 -->
    <div class="sb-left">
      <button
        class="emergency-btn"
        type="button"
        title="紧急终止 (停止所有任务)"
        @click="emergencyStop"
      >
        <span class="emergency-dot" />
        <span class="emergency-text">STOP</span>
      </button>

      <div class="status-indicator" :class="`is-${agentStatus}`" :title="statusTitle">
        <span class="status-dot" />
        <span class="status-label">{{ statusLabel }}</span>
      </div>
    </div>

    <!-- 中间: 访问模式 + 网络状态 -->
    <div class="sb-center">
      <div class="access-toggle" role="switch" :aria-checked="accessMode === 'full'">
        <button
          class="access-opt"
          :class="{ active: accessMode === 'safe' }"
          type="button"
          title="安全模式: 所有写操作需确认"
          @click="setAccessMode('safe')"
        >
          安全
        </button>
        <button
          class="access-opt"
          :class="{ active: accessMode === 'full' }"
          type="button"
          title="完全访问: 允许自动执行操作"
          @click="setAccessMode('full')"
        >
          完全
        </button>
      </div>

      <div class="net-status" :class="`net-${netStatus}`" :title="netTitle">
        <span class="net-icon" />
        <span class="net-label">{{ netLabel }}</span>
      </div>
    </div>

    <!-- 右侧: Token 用量 + 排队状态 -->
    <div class="sb-right">
      <div class="metric" title="当前会话 Token 用量">
        <span class="metric-label">Token</span>
        <span class="metric-value">{{ formatToken(tokenUsage) }}</span>
      </div>

      <div class="metric" :class="{ 'metric-active': queueSize > 0 }" title="API 请求队列">
        <span class="metric-label">队列</span>
        <span class="metric-value">{{ queueSize }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useChatStore } from "@/stores/chat";
import type { AccessMode } from "@/types";

const chat = useChatStore();

// ===== Agent 状态 =====
// idle 空闲 / thinking 思考中 / executing 执行任务 / speaking 语音中
type AgentStatus = "idle" | "thinking" | "executing" | "speaking";
const agentStatus = ref<AgentStatus>("idle");

const statusLabel = computed(
  () =>
    ({
      idle: "空闲",
      thinking: "思考中",
      executing: "执行任务",
      speaking: "语音中",
    }[agentStatus.value])
);

const statusTitle = computed(
  () => `Agent 状态: ${statusLabel.value}`
);

// ===== 访问模式 =====
const accessMode = ref<AccessMode>("safe");

function setAccessMode(mode: AccessMode) {
  accessMode.value = mode;
  window.dispatchEvent(
    new CustomEvent("access-mode-change", { detail: { mode } })
  );
}

// ===== 网络状态 =====
type NetStatus = "online" | "offline" | "limited";
const netStatus = ref<NetStatus>("online");

const netLabel = computed(
  () =>
    ({
      online: "在线",
      offline: "离线",
      limited: "受限",
    }[netStatus.value])
);

const netTitle = computed(() => `网络: ${netLabel.value}`);

function updateNetStatus() {
  if (typeof navigator === "undefined") return;
  netStatus.value = navigator.onLine ? "online" : "offline";
}

// ===== Token & 队列 =====
const tokenUsage = ref(0);
const queueSize = ref(0);

function formatToken(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + "K";
  return (n / 1000000).toFixed(2) + "M";
}

// ===== 紧急终止 =====
function emergencyStop() {
  agentStatus.value = "idle";
  queueSize.value = 0;
  window.dispatchEvent(new CustomEvent("emergency-stop"));
}

// ===== 外部状态同步 =====
function onAgentStatus(e: Event) {
  const detail = (e as CustomEvent).detail as { status?: AgentStatus };
  if (detail?.status) agentStatus.value = detail.status;
}

function onTokenUpdate(e: Event) {
  const detail = (e as CustomEvent).detail as { usage?: number };
  if (typeof detail?.usage === "number") tokenUsage.value = detail.usage;
}

function onQueueUpdate(e: Event) {
  const detail = (e as CustomEvent).detail as { size?: number };
  if (typeof detail?.size === "number") queueSize.value = detail.size;
}

function onNetStatus(e: Event) {
  const detail = (e as CustomEvent).detail as { status?: NetStatus };
  if (detail?.status) netStatus.value = detail.status;
}

// 跟随 chat streaming 状态粗略反映 agent 状态
function syncFromChat() {
  if (chat.isStreaming) {
    agentStatus.value =
      agentStatus.value === "speaking" ? "speaking" : "thinking";
  } else if (agentStatus.value === "thinking") {
    agentStatus.value = "idle";
  }
}

onMounted(() => {
  updateNetStatus();
  window.addEventListener("online", updateNetStatus);
  window.addEventListener("offline", updateNetStatus);
  window.addEventListener("agent-status-change", onAgentStatus as EventListener);
  window.addEventListener("token-usage-update", onTokenUpdate as EventListener);
  window.addEventListener("queue-status-update", onQueueUpdate as EventListener);
  window.addEventListener("net-status-change", onNetStatus as EventListener);
  // 定时同步 chat 状态
  window.setInterval(syncFromChat, 500);
});

onUnmounted(() => {
  window.removeEventListener("online", updateNetStatus);
  window.removeEventListener("offline", updateNetStatus);
  window.removeEventListener("agent-status-change", onAgentStatus as EventListener);
  window.removeEventListener("token-usage-update", onTokenUpdate as EventListener);
  window.removeEventListener("queue-status-update", onQueueUpdate as EventListener);
  window.removeEventListener("net-status-change", onNetStatus as EventListener);
});
</script>

<style scoped>
.status-bar {
  height: var(--statusbar-height);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-bottom: none;
  font-size: 11px;
  position: relative;
  z-index: 100;
  gap: 12px;
}

/* 左侧 */
.sb-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.emergency-btn {
  height: 22px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  gap: 5px;
  background: #e81123;
  color: #fff;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  cursor: pointer;
  transition: background 0.15s var(--ease-ios), transform 0.1s var(--ease-ios);
}

.emergency-btn:hover {
  background: #c50f1f;
}

.emergency-btn:active {
  transform: scale(0.95);
}

.emergency-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fff;
  animation: emergency-pulse 1.2s ease-in-out infinite;
}

@keyframes emergency-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}

.status-indicator.is-idle .status-dot {
  background: #22c55e;
}
.status-indicator.is-thinking .status-dot {
  background: #f59e0b;
  animation: status-blink 1s ease-in-out infinite;
}
.status-indicator.is-executing .status-dot {
  background: #3b82f6;
  animation: status-blink 0.6s ease-in-out infinite;
}
.status-indicator.is-speaking .status-dot {
  background: #a855f7;
  animation: status-blink 0.4s ease-in-out infinite;
}

@keyframes status-blink {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

/* 中间 */
.sb-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.access-toggle {
  display: inline-flex;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  padding: 1px;
  gap: 1px;
}

.access-opt {
  height: 18px;
  padding: 0 8px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
  transition: background 0.15s var(--ease-ios), color 0.15s var(--ease-ios);
}

.access-opt:hover {
  color: var(--text-secondary);
}

.access-opt.active {
  background: var(--theme-color);
  color: #fff;
}

.net-status {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
}

.net-icon {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}

.net-online .net-icon { background: #22c55e; }
.net-offline .net-icon { background: #ef4444; }
.net-limited .net-icon { background: #f59e0b; }

/* 右侧 */
.sb-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.metric {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
}

.metric-label {
  font-size: 10px;
  opacity: 0.85;
}

.metric-value {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.metric-active .metric-value {
  color: var(--theme-color);
}
</style>
