<template>
  <div class="tool-call-card glass" :class="`status-${toolCall.status}`">
    <!-- 头部：工具名 + 状态 -->
    <div class="tool-header" @click="toggleExpand">
      <div class="tool-icon-wrap" :title="toolCall.name">
        <span class="tool-icon">{{ toolIcon }}</span>
      </div>
      <div class="tool-meta">
        <span class="tool-name">{{ toolCall.name }}</span>
        <span class="tool-status" :class="`status-${toolCall.status}`">
          <span v-if="toolCall.status === 'running' || toolCall.status === 'pending'" class="status-dot pulsing" />
          <span v-else class="status-dot" />
          {{ statusLabel }}
        </span>
      </div>
      <span class="expand-toggle" :class="{ expanded: isExpanded }">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </div>

    <!-- 展开内容 -->
    <transition name="expand">
      <div v-show="isExpanded" class="tool-body">
        <!-- 参数 -->
        <div v-if="hasArguments" class="tool-section">
          <div class="section-label">参数</div>
          <pre class="code-block params-block"><code>{{ formattedArguments }}</code></pre>
        </div>

        <!-- 结果 -->
        <div v-if="toolCall.result !== undefined && toolCall.status === 'success'" class="tool-section">
          <div class="section-label">
            结果
            <button class="copy-btn" @click.stop="copyResult" title="复制结果">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>
          <pre class="code-block result-block"><code>{{ formattedResult }}</code></pre>
        </div>

        <!-- 错误 -->
        <div v-if="toolCall.error && (toolCall.status === 'error' || toolCall.status === 'timeout')" class="tool-section error-section">
          <div class="section-label">错误详情</div>
          <div class="error-content">{{ toolCall.error }}</div>
        </div>

        <!-- 耗时 -->
        <div v-if="duration !== null" class="tool-duration">
          耗时 {{ duration }}ms
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { ToolCall } from "@/types";

const props = defineProps<{
  toolCall: ToolCall;
  defaultExpanded?: boolean;
}>();

const isExpanded = ref(props.defaultExpanded ?? false);

function toggleExpand() {
  isExpanded.value = !isExpanded.value;
}

const toolIcon = computed(() => {
  const name = props.toolCall.name.toLowerCase();
  if (name.includes("file") || name.includes("read") || name.includes("write")) return "📄";
  if (name.includes("search") || name.includes("grep")) return "🔍";
  if (name.includes("shell") || name.includes("exec") || name.includes("bash")) return "⚡";
  if (name.includes("browser") || name.includes("web")) return "🌐";
  if (name.includes("code") || name.includes("python")) return "🐍";
  if (name.includes("image") || name.includes("vision")) return "🖼";
  if (name.includes("memory") || name.includes("remember")) return "🧠";
  return "🛠";
});

const statusLabel = computed(() => {
  switch (props.toolCall.status) {
    case "pending": return "等待中...";
    case "running": return "调用中...";
    case "success": return "完成";
    case "error": return "失败";
    case "timeout": return "超时";
    default: return "";
  }
});

const hasArguments = computed(() => {
  return props.toolCall.arguments && Object.keys(props.toolCall.arguments).length > 0;
});

const formattedArguments = computed(() => {
  try {
    return JSON.stringify(props.toolCall.arguments, null, 2);
  } catch {
    return String(props.toolCall.arguments);
  }
});

const formattedResult = computed(() => {
  const r = props.toolCall.result;
  if (r === null || r === undefined) return "";
  if (typeof r === "string") {
    // 尝试解析为JSON以美化
    try {
      return JSON.stringify(JSON.parse(r), null, 2);
    } catch {
      return r;
    }
  }
  try {
    return JSON.stringify(r, null, 2);
  } catch {
    return String(r);
  }
});

const duration = computed(() => {
  if (!props.toolCall.startedAt || !props.toolCall.completedAt) return null;
  return props.toolCall.completedAt - props.toolCall.startedAt;
});

async function copyResult() {
  try {
    await navigator.clipboard.writeText(formattedResult.value);
  } catch {
    // 忽略复制失败
  }
}
</script>

<style scoped>
.tool-call-card {
  border-radius: var(--radius-md);
  padding: 8px 12px;
  margin: 6px 0;
  border: 1px solid var(--border-subtle);
  transition: border-color 0.2s var(--ease-ios), background 0.2s var(--ease-ios);
  font-size: 13px;
}

.tool-call-card.status-error,
.tool-call-card.status-timeout {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.06);
}

.tool-call-card.status-running {
  border-color: color-mix(in srgb, var(--theme-color) 40%, transparent);
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.tool-icon-wrap {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.tool-meta {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tool-name {
  font-weight: 500;
  color: var(--text-primary);
  font-family: var(--font-code);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.tool-status.status-running,
.tool-status.status-pending {
  color: var(--theme-color);
}

.tool-status.status-success {
  color: #22c55e;
}

.tool-status.status-error,
.tool-status.status-timeout {
  color: #ef4444;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  display: inline-block;
}

.status-dot.pulsing {
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.expand-toggle {
  flex-shrink: 0;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  transition: transform 0.2s var(--ease-ios);
}

.expand-toggle.expanded {
  transform: rotate(180deg);
}

.tool-body {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tool-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.copy-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  border-radius: 3px;
  transition: color 0.15s, background 0.15s;
}

.copy-btn:hover {
  color: var(--theme-color);
  background: var(--bg-hover);
}

.code-block {
  background: rgba(0, 0, 0, 0.18);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-family: var(--font-code);
  font-size: 12px;
  color: var(--text-primary);
  overflow-x: auto;
  max-height: 240px;
  overflow-y: auto;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.error-section .error-content {
  background: rgba(239, 68, 68, 0.1);
  color: #dc2626;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  word-break: break-word;
}

.tool-duration {
  font-size: 11px;
  color: var(--text-muted);
  text-align: right;
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
  max-height: 600px;
}
</style>
