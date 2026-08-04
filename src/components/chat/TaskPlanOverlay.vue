<template>
  <div class="task-plan-overlay" :class="{ collapsed }">
    <!-- 折叠态：小标签 -->
    <button v-if="collapsed" class="overlay-toggle collapsed" @click="collapsed = false">
      <span class="toggle-icon">📋</span>
      <span class="toggle-text">{{ activePlans.length }} 个任务进行中</span>
    </button>

    <!-- 展开态：浮层卡片 -->
    <div v-else class="overlay-card glass-panel">
      <div class="overlay-header">
        <span class="overlay-title">任务规划</span>
        <div class="overlay-actions">
          <button class="icon-btn" title="收起" @click="collapsed = true">—</button>
          <button class="icon-btn" title="关闭" @click="closeAll">✕</button>
        </div>
      </div>

      <div class="overlay-body">
        <div v-if="activePlans.length === 0" class="empty-plan">
          <span>暂无进行中的任务</span>
        </div>
        <TaskPlanView
          v-for="plan in activePlans"
          :key="plan.id"
          :plan="plan"
          @confirm="(stepId, action, modifiedDescription) => onConfirm(plan.id, stepId, action, modifiedDescription)"
          @interrupt="onInterrupt(plan.id)"
          @resume="onResume(plan.id)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useTaskPlanStore } from "@/stores/taskPlan";
import type { ConfirmAction } from "@/services/taskPlanner";
import TaskPlanView from "./TaskPlanView.vue";

const taskPlanStore = useTaskPlanStore();
const collapsed = ref(false);

const activePlans = computed(() => taskPlanStore.activePlans);

function onConfirm(planId: string, stepId: string, action: ConfirmAction, modifiedDescription?: string) {
  if (action === "continue") {
    taskPlanStore.completeStep(planId, stepId);
  } else if (action === "skip") {
    taskPlanStore.skipStep(planId, stepId);
  } else if (action === "modify" && modifiedDescription) {
    taskPlanStore.modifyStep(planId, stepId, modifiedDescription);
    taskPlanStore.completeStep(planId, stepId);
  }
}

function onInterrupt(planId: string) {
  taskPlanStore.interruptPlan(planId);
}

function onResume(planId: string) {
  taskPlanStore.resumePlan(planId);
}

function closeAll() {
  collapsed.value = true;
}
</script>

<style scoped>
.task-plan-overlay {
  position: fixed;
  right: 20px;
  bottom: 60px;
  z-index: 1200;
  max-width: 420px;
  width: 380px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
}

.overlay-toggle.collapsed {
  align-self: flex-end;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--glass-bg-strong);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-lg);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  transition: all 0.18s var(--ease-ios);
}

.overlay-toggle.collapsed:hover {
  background: var(--theme-color);
  color: #fff;
  transform: translateY(-2px);
}

.toggle-icon {
  font-size: 14px;
}

.overlay-card {
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
}

.overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.overlay-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.overlay-actions {
  display: flex;
  gap: 4px;
}

.icon-btn {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s var(--ease-ios);
}

.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.overlay-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.empty-plan {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
