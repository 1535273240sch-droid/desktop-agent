<template>
  <div class="task-plan-view glass" :class="`status-${plan.status}`">
    <!-- 头部：标题 + 状态 + 进度 -->
    <div class="plan-header">
      <div class="plan-icon-wrap">
        <span class="plan-icon">{{ statusIcon }}</span>
      </div>
      <div class="plan-title-wrap">
        <span class="plan-title">{{ plan.title }}</span>
        <span class="plan-status" :class="`status-${plan.status}`">
          <span
            class="status-dot"
            :class="{ pulsing: plan.status === 'executing' || plan.status === 'planning' }"
          />
          {{ statusLabel }}
        </span>
      </div>
      <div class="plan-progress">
        <span class="progress-text">{{ doneCount }}/{{ plan.steps.length }}</span>
      </div>
    </div>

    <!-- 进度条 -->
    <div class="progress-bar">
      <div class="progress-fill" :style="{ width: progressPercent + '%' }" />
    </div>

    <!-- 步骤列表 -->
    <div class="steps-list">
      <div
        v-for="(step, idx) in plan.steps"
        :key="step.id"
        class="step-item"
        :class="[
          `status-${step.status}`,
          { current: isCurrentStep(step), editing: editingStepId === step.id },
        ]"
      >
        <div class="step-index">
          <span class="step-icon">{{ stepIcon(step) }}</span>
          <span class="step-num">{{ idx + 1 }}</span>
        </div>

        <div class="step-body">
          <!-- 编辑态 -->
          <template v-if="editingStepId === step.id">
            <textarea
              v-model="editingText"
              class="step-edit-input"
              rows="2"
              :placeholder="step.description"
            />
            <div class="step-edit-actions">
              <button class="step-btn primary" @click="saveEdit(step)">保存</button>
              <button class="step-btn" @click="cancelEdit">取消</button>
            </div>
          </template>

          <!-- 展示态 -->
          <template v-else>
            <div class="step-description">{{ step.description }}</div>
            <div v-if="step.result" class="step-result">{{ step.result }}</div>

            <!-- 当前待确认步骤的操作按钮 -->
            <div
              v-if="isCurrentStep(step) && plan.status === 'executing'"
              class="step-actions"
            >
              <button
                class="step-btn primary"
                @click="emit('confirm', step.id, 'continue')"
              >
                继续
              </button>
              <button class="step-btn" @click="emit('confirm', step.id, 'skip')">
                跳过
              </button>
              <button class="step-btn" @click="startEdit(step)">修改</button>
            </div>

            <!-- 中断态下，pending 步骤可编辑 -->
            <div
              v-else-if="plan.status === 'interrupted' && step.status === 'pending'"
              class="step-actions"
            >
              <button class="step-btn ghost" @click="startEdit(step)">编辑此步</button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 底部操作 -->
    <div class="plan-footer">
      <button
        v-if="plan.status === 'executing'"
        class="plan-btn interrupt"
        @click="emit('interrupt')"
      >
        中断
      </button>
      <button
        v-if="plan.status === 'interrupted'"
        class="plan-btn primary"
        @click="emit('resume')"
      >
        继续执行
      </button>
      <button
        v-if="plan.status === 'planning'"
        class="plan-btn primary"
        @click="emit('resume')"
      >
        开始执行
      </button>

      <!-- 完成总结 -->
      <span v-if="plan.status === 'completed'" class="plan-summary completed">
        ✓ 任务完成（{{ completedCount }}/{{ plan.steps.length }} 步完成<span
          v-if="skippedCount"
        >，{{ skippedCount }} 步跳过</span>）
      </span>
      <span v-else-if="plan.status === 'failed'" class="plan-summary failed">
        ✕ 任务结束（{{ completedCount }} 步完成，{{ failedCount }} 步失败<span
          v-if="skippedCount"
        >，{{ skippedCount }} 步跳过</span>）
      </span>
      <span v-else-if="plan.status === 'interrupted'" class="plan-summary">
        已中断，可修改步骤后继续
      </span>
      <span v-else-if="plan.status === 'executing'" class="plan-summary">
        正在执行…
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import type { TaskPlan, TaskStep } from "@/types";
import type { ConfirmAction } from "@/services/taskPlanner";

const props = defineProps<{
  plan: TaskPlan;
}>();

const emit = defineEmits<{
  (e: "confirm", stepId: string, action: ConfirmAction, modifiedDescription?: string): void;
  (e: "interrupt"): void;
  (e: "resume"): void;
}>();

// ========== 内联编辑 ==========
const editingStepId = ref<string | null>(null);
const editingText = ref("");

function startEdit(step: TaskStep): void {
  editingStepId.value = step.id;
  editingText.value = step.description;
}

function cancelEdit(): void {
  editingStepId.value = null;
  editingText.value = "";
}

function saveEdit(step: TaskStep): void {
  const newText = editingText.value.trim();
  editingStepId.value = null;
  editingText.value = "";
  if (!newText || newText === step.description) return;
  // 修改后继续执行当前步
  emit("confirm", step.id, "modify", newText);
}

// ========== 计算属性 ==========
const statusIcon = computed(() => {
  switch (props.plan.status) {
    case "planning": return "📋";
    case "executing": return "⚙";
    case "completed": return "✓";
    case "interrupted": return "⏸";
    case "failed": return "✕";
    default: return "📋";
  }
});

const statusLabel = computed(() => {
  switch (props.plan.status) {
    case "planning": return "规划中";
    case "executing": return "执行中";
    case "completed": return "已完成";
    case "interrupted": return "已中断";
    case "failed": return "已结束";
    default: return "";
  }
});

const completedCount = computed(
  () => props.plan.steps.filter((s) => s.status === "completed").length,
);
const failedCount = computed(
  () => props.plan.steps.filter((s) => s.status === "failed").length,
);
const skippedCount = computed(
  () => props.plan.steps.filter((s) => s.status === "skipped").length,
);
/** 已完成 + 已跳过计入进度 */
const doneCount = computed(() => completedCount.value + skippedCount.value);

const progressPercent = computed(() => {
  if (props.plan.steps.length === 0) return 0;
  return Math.round((doneCount.value / props.plan.steps.length) * 100);
});

// ========== 工具方法 ==========

/** 当前步骤：执行中状态下第一个 pending 步骤 */
function isCurrentStep(step: TaskStep): boolean {
  if (props.plan.status !== "executing") return false;
  const firstPending = props.plan.steps.find((s) => s.status === "pending");
  return firstPending?.id === step.id;
}

function stepIcon(step: TaskStep): string {
  switch (step.status) {
    case "completed": return "✓";
    case "running": return "⏳";
    case "failed": return "✕";
    case "skipped": return "–";
    case "pending":
    default: return "○";
  }
}
</script>

<style scoped>
.task-plan-view {
  border-radius: var(--radius-md);
  padding: 10px 12px;
  margin: 6px 0;
  border: 1px solid var(--border-subtle);
  font-size: 13px;
  transition: border-color 0.2s var(--ease-ios);
  max-width: min(720px, 90%);
}

.task-plan-view.status-executing {
  border-color: color-mix(in srgb, var(--theme-color) 40%, transparent);
}
.task-plan-view.status-completed {
  border-color: rgba(34, 197, 94, 0.35);
}
.task-plan-view.status-failed {
  border-color: rgba(239, 68, 68, 0.35);
}
.task-plan-view.status-interrupted {
  border-color: rgba(245, 158, 11, 0.4);
}

/* 头部 */
.plan-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plan-icon-wrap {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--theme-color) 18%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}

.task-plan-view.status-completed .plan-icon-wrap {
  background: rgba(34, 197, 94, 0.18);
}
.task-plan-view.status-failed .plan-icon-wrap {
  background: rgba(239, 68, 68, 0.18);
}
.task-plan-view.status-interrupted .plan-icon-wrap {
  background: rgba(245, 158, 11, 0.18);
}

.plan-title-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.plan-title {
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-muted);
}
.plan-status.status-executing {
  color: var(--theme-color);
}
.plan-status.status-completed {
  color: #22c55e;
}
.plan-status.status-failed {
  color: #ef4444;
}
.plan-status.status-interrupted {
  color: #f59e0b;
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

.plan-progress {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--font-code);
}

/* 进度条 */
.progress-bar {
  margin: 8px 0;
  height: 4px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.08);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--theme-color), var(--theme-accent-muted));
  border-radius: 2px;
  transition: width 0.3s var(--ease-ios);
}
.task-plan-view.status-completed .progress-fill {
  background: #22c55e;
}
.task-plan-view.status-failed .progress-fill {
  background: #ef4444;
}

/* 步骤列表 */
.steps-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-item {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.04);
  transition: background 0.15s var(--ease-ios);
}

.step-item.current {
  background: color-mix(in srgb, var(--theme-color) 10%, transparent);
  box-shadow: inset 2px 0 0 var(--theme-color);
}

.step-item.status-completed {
  opacity: 0.75;
}
.step-item.status-failed {
  background: rgba(239, 68, 68, 0.08);
}
.step-item.status-skipped {
  opacity: 0.5;
}

.step-index {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding-top: 1px;
}

.step-icon {
  font-size: 13px;
  line-height: 1;
  color: var(--text-muted);
}
.step-item.status-completed .step-icon {
  color: #22c55e;
}
.step-item.status-running .step-icon,
.step-item.current .step-icon {
  color: var(--theme-color);
}
.step-item.status-failed .step-icon {
  color: #ef4444;
}

.step-num {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-code);
}

.step-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-description {
  color: var(--text-primary);
  word-break: break-word;
  line-height: 1.5;
}

.step-result {
  font-size: 12px;
  color: var(--text-secondary);
  background: rgba(0, 0, 0, 0.05);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  word-break: break-word;
  white-space: pre-wrap;
}

/* 步骤操作按钮 */
.step-actions,
.step-edit-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.step-btn {
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--glass-bg);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s var(--ease-ios);
}
.step-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.step-btn.primary {
  background: var(--theme-color);
  border-color: var(--theme-color);
  color: #fff;
}
.step-btn.primary:hover {
  opacity: 0.9;
  color: #fff;
}
.step-btn.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
}
.step-btn.ghost:hover {
  color: var(--theme-color);
}

.step-edit-input {
  width: 100%;
  resize: vertical;
  min-height: 44px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--theme-color);
  background: var(--glass-bg);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

/* 底部 */
.plan-footer {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.plan-btn {
  padding: 4px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--glass-bg);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s var(--ease-ios);
}
.plan-btn:hover {
  background: var(--bg-hover);
}
.plan-btn.primary {
  background: var(--theme-color);
  border-color: var(--theme-color);
  color: #fff;
}
.plan-btn.primary:hover {
  opacity: 0.9;
}
.plan-btn.interrupt {
  border-color: rgba(245, 158, 11, 0.5);
  color: #f59e0b;
}
.plan-btn.interrupt:hover {
  background: rgba(245, 158, 11, 0.12);
}

.plan-summary {
  font-size: 12px;
  color: var(--text-muted);
}
.plan-summary.completed {
  color: #22c55e;
}
.plan-summary.failed {
  color: #ef4444;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}
</style>
