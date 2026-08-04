// stores/taskPlan.ts - 任务规划 Pinia store
// 管理当前任务计划 + 步骤状态更新 + 持久化加载/保存 + 任务列表管理

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { TaskPlan, TaskStep, TaskStepStatus } from "@/types";
import { getDefaultTaskPlanner } from "@/services/taskPlanner";

const STORAGE_KEY = "desktop-agent-task-plans";

export const useTaskPlanStore = defineStore("taskPlan", () => {
  const plans = ref<TaskPlan[]>([]);
  const activePlanId = ref<string | null>(null);

  // ============== 计算属性 ==============

  const activePlan = computed(
    () => plans.value.find((p) => p.id === activePlanId.value) ?? null,
  );

  /** 正在进行中的计划（planning / executing） */
  const activePlans = computed(() =>
    plans.value.filter((p) => p.status === "planning" || p.status === "executing"),
  );

  // ============== 持久化 ==============

  function load(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        plans.value = JSON.parse(stored) as TaskPlan[];
        // 重载后：执行中的计划无法继续运行，标记为已中断（可手动恢复）
        for (const p of plans.value) {
          if (p.status === "executing") {
            p.status = "interrupted";
            for (const s of p.steps) {
              if (s.status === "running") s.status = "pending";
            }
          }
        }
      }
    } catch (e) {
      console.error("Failed to load task plans:", e);
    }
  }

  function save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plans.value));
    } catch (e) {
      console.error("Failed to save task plans:", e);
    }
  }

  // ============== 计划 CRUD ==============

  function createPlan(plan: TaskPlan): TaskPlan {
    plans.value.unshift(plan);
    activePlanId.value = plan.id;
    save();
    return plan;
  }

  function updatePlan(planId: string, updates: Partial<TaskPlan>): void {
    const plan = plans.value.find((p) => p.id === planId);
    if (plan) {
      Object.assign(plan, updates, { updatedAt: Date.now() });
      save();
    }
  }

  function deletePlan(planId: string): void {
    const idx = plans.value.findIndex((p) => p.id === planId);
    if (idx !== -1) {
      plans.value.splice(idx, 1);
      if (activePlanId.value === planId) activePlanId.value = null;
      save();
    }
  }

  function getPlan(planId: string): TaskPlan | undefined {
    return plans.value.find((p) => p.id === planId);
  }

  function getPlansByConversation(conversationId: string): TaskPlan[] {
    return plans.value.filter((p) => p.conversationId === conversationId);
  }

  function setActivePlan(planId: string | null): void {
    activePlanId.value = planId;
  }

  // ============== 步骤状态更新 ==============

  function updateStep(
    planId: string,
    stepId: string,
    updates: Partial<TaskStep>,
  ): void {
    const plan = plans.value.find((p) => p.id === planId);
    if (!plan) return;
    const step = plan.steps.find((s) => s.id === stepId);
    if (step) {
      Object.assign(step, updates);
      plan.updatedAt = Date.now();
      save();
    }
  }

  function setStepStatus(
    planId: string,
    stepId: string,
    status: TaskStepStatus,
    result?: string,
  ): void {
    const plan = plans.value.find((p) => p.id === planId);
    if (!plan) return;
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return;
    step.status = status;
    if (status === "running") {
      step.startedAt = Date.now();
    }
    if (status === "completed" || status === "failed" || status === "skipped") {
      step.completedAt = Date.now();
      if (result !== undefined) step.result = result;
    }
    plan.updatedAt = Date.now();
    save();
  }

  /** 标记某步为执行中，并把计划置为 executing */
  function markStepRunning(planId: string, stepId: string): void {
    setStepStatus(planId, stepId, "running");
    updatePlan(planId, { status: "executing" });
  }

  /** 完成某步：更新状态 + 发送通知 + 检查整体完成 */
  function completeStep(planId: string, stepId: string, result?: string): void {
    const plan = plans.value.find((p) => p.id === planId);
    if (!plan) return;
    setStepStatus(planId, stepId, "completed", result);

    const step = plan.steps.find((s) => s.id === stepId);
    if (step) {
      void getDefaultTaskPlanner().notifyStepComplete(plan, step);
    }
    checkPlanCompletion(planId);
  }

  function failStep(planId: string, stepId: string, error?: string): void {
    setStepStatus(planId, stepId, "failed", error);
    checkPlanCompletion(planId);
  }

  function skipStep(planId: string, stepId: string): void {
    setStepStatus(planId, stepId, "skipped");
    checkPlanCompletion(planId);
  }

  /** 修改单步描述（用于"修改"确认动作或中断恢复时编辑） */
  function modifyStep(
    planId: string,
    stepId: string,
    newDescription: string,
  ): void {
    updateStep(planId, stepId, { description: newDescription });
  }

  /** 检查计划是否全部完成 */
  function checkPlanCompletion(planId: string): void {
    const plan = plans.value.find((p) => p.id === planId);
    if (!plan) return;
    const terminal: TaskStepStatus[] = ["completed", "failed", "skipped"];
    const allDone = plan.steps.every((s) => terminal.includes(s.status));
    if (!allDone) return;

    const hasFailed = plan.steps.some((s) => s.status === "failed");
    plan.status = hasFailed ? "failed" : "completed";
    plan.updatedAt = Date.now();
    save();

    if (plan.status === "completed") {
      void getDefaultTaskPlanner().notifyPlanComplete(plan);
    }
  }

  // ============== 中断 / 恢复 ==============

  /** 中断计划：running 步骤回退为 pending */
  function interruptPlan(planId: string): void {
    const plan = plans.value.find((p) => p.id === planId);
    if (!plan) return;
    for (const s of plan.steps) {
      if (s.status === "running") s.status = "pending";
    }
    plan.status = "interrupted";
    plan.updatedAt = Date.now();
    save();
  }

  /** 恢复计划：可同时修改步骤描述 */
  function resumePlan(
    planId: string,
    modifiedSteps?: Array<{ id: string; description: string }>,
  ): void {
    const plan = plans.value.find((p) => p.id === planId);
    if (!plan) return;
    if (modifiedSteps && modifiedSteps.length > 0) {
      const map = new Map(modifiedSteps.map((m) => [m.id, m.description]));
      for (const s of plan.steps) {
        if (map.has(s.id)) s.description = map.get(s.id)!;
      }
    }
    plan.status = "executing";
    plan.updatedAt = Date.now();
    save();
  }

  return {
    plans,
    activePlanId,
    activePlan,
    activePlans,
    // 持久化
    load,
    save,
    // 计划 CRUD
    createPlan,
    updatePlan,
    deletePlan,
    getPlan,
    getPlansByConversation,
    setActivePlan,
    // 步骤状态
    updateStep,
    setStepStatus,
    markStepRunning,
    completeStep,
    failStep,
    skipStep,
    modifyStep,
    checkPlanCompletion,
    // 中断/恢复
    interruptPlan,
    resumePlan,
  };
});
