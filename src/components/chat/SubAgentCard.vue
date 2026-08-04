<template>
  <div class="sub-agent-card glass" :class="`status-${subAgent.status}`">
    <!-- 头部：名称 + 状态 -->
    <div class="agent-header" @click="toggleExpand">
      <div class="agent-icon-wrap">
        <span class="agent-icon">{{ statusIcon }}</span>
      </div>
      <div class="agent-meta">
        <span class="agent-name">{{ subAgent.name }}</span>
        <span class="agent-task" :title="subAgent.task">{{ subAgent.task }}</span>
      </div>
      <span class="agent-status" :class="`status-${subAgent.status}`">
        <span class="status-dot" :class="{ pulsing: subAgent.status === 'running' }" />
        {{ statusLabel }}
      </span>
      <span class="expand-toggle" :class="{ expanded: isExpanded }">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </div>

    <!-- 展开内容：执行过程 -->
    <transition name="expand">
      <div v-show="isExpanded" class="agent-body">
        <div v-if="subAgent.messages.length === 0" class="empty-process">
          暂无执行记录
        </div>
        <div v-else class="process-list">
          <div
            v-for="msg in subAgent.messages"
            :key="msg.id"
            class="process-item"
            :class="`role-${msg.role}`"
          >
            <span class="process-role">{{ roleLabel(msg.role) }}</span>
            <span class="process-content">{{ truncate(msg.content, 200) }}</span>
          </div>
        </div>

        <!-- 汇总结果 -->
        <div v-if="subAgent.result" class="agent-summary">
          <div class="summary-label">汇总结果</div>
          <div class="summary-content">{{ subAgent.result }}</div>
        </div>

        <!-- 耗时 -->
        <div v-if="duration !== null" class="agent-duration">
          耗时 {{ duration }}
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { SubAgent, MessageRole } from "@/types";

const props = defineProps<{
  subAgent: SubAgent;
  defaultExpanded?: boolean;
}>();

const isExpanded = ref(props.defaultExpanded ?? false);

function toggleExpand() {
  isExpanded.value = !isExpanded.value;
}

const statusIcon = computed(() => {
  switch (props.subAgent.status) {
    case "running": return "⚙";
    case "completed": return "✓";
    case "failed": return "✕";
    default: return "•";
  }
});

const statusLabel = computed(() => {
  switch (props.subAgent.status) {
    case "running": return "执行中";
    case "completed": return "已完成";
    case "failed": return "已失败";
    default: return "";
  }
});

const duration = computed(() => {
  if (!props.subAgent.startedAt) return null;
  const end = props.subAgent.completedAt ?? Date.now();
  const ms = end - props.subAgent.startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m${s}s`;
});

function roleLabel(role: MessageRole): string {
  switch (role) {
    case "user": return "用户";
    case "assistant": return "助手";
    case "system": return "系统";
    case "tool": return "工具";
    default: return role;
  }
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}
</script>

<style scoped>
.sub-agent-card {
  border-radius: var(--radius-md);
  padding: 8px 12px;
  margin: 6px 0;
  border: 1px solid var(--border-subtle);
  font-size: 13px;
  transition: border-color 0.2s var(--ease-ios);
}

.sub-agent-card.status-running {
  border-color: color-mix(in srgb, var(--theme-color) 40%, transparent);
}

.sub-agent-card.status-failed {
  border-color: rgba(239, 68, 68, 0.4);
}

.sub-agent-card.status-completed {
  border-color: rgba(34, 197, 94, 0.35);
}

.agent-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.agent-icon-wrap {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--theme-color) 18%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--theme-color);
}

.sub-agent-card.status-completed .agent-icon-wrap {
  background: rgba(34, 197, 94, 0.18);
  color: #22c55e;
}

.sub-agent-card.status-failed .agent-icon-wrap {
  background: rgba(239, 68, 68, 0.18);
  color: #ef4444;
}

.agent-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.agent-name {
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-task {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.agent-status.status-running {
  color: var(--theme-color);
}

.agent-status.status-completed {
  color: #22c55e;
}

.agent-status.status-failed {
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

.agent-body {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty-process {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 8px;
}

.process-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  overflow-y: auto;
}

.process-item {
  display: flex;
  gap: 6px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.06);
}

.process-role {
  flex-shrink: 0;
  font-weight: 500;
  color: var(--text-secondary);
  min-width: 36px;
}

.process-item.role-user .process-role {
  color: var(--theme-color);
}

.process-item.role-assistant .process-role {
  color: #22c55e;
}

.process-item.role-tool .process-role {
  color: #f97316;
}

.process-content {
  color: var(--text-primary);
  word-break: break-word;
  white-space: pre-wrap;
}

.agent-summary {
  background: color-mix(in srgb, var(--theme-color) 8%, transparent);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}

.summary-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.summary-content {
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-word;
  white-space: pre-wrap;
}

.agent-duration {
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
