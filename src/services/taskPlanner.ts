// services/taskPlanner.ts - 任务规划器
// Agent自动规划 + 步骤展示 + 每步确认 + 中断恢复 + localStorage 持久化 + 完成通知 + 自动标题

import { nanoid } from "nanoid";
import type { TaskApiClient, ChatCompletionMessage } from "@/services/api/taskApi";
import type { TaskPlan, TaskStep, TaskStepStatus } from "@/types";

const STORAGE_KEY = "desktop-agent-task-plans";

// ========================= 通知 =========================

/**
 * 发送系统通知：优先使用 Tauri 通知插件，回退到浏览器 Notification，再回退到 console
 */
async function notify(title: string, body: string): Promise<void> {
  // 1. Tauri 通知插件
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    const isGranted = await mod.isPermissionGranted();
    if (!isGranted) {
      const perm = await mod.requestPermission();
      if (perm === "granted") {
        mod.sendNotification({ title, body });
        return;
      }
    } else {
      mod.sendNotification({ title, body });
      return;
    }
  } catch {
    // 非 Tauri 环境或插件未启用，继续回退
  }

  // 2. 浏览器 Notification
  try {
    if (typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "granted") {
        new Notification(title, { body });
        return;
      }
      if (Notification.permission !== "denied") {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          new Notification(title, { body });
          return;
        }
      }
    }
  } catch {
    // 继续
  }

  // 3. 控制台回退
  console.info(`[TaskNotify] ${title}: ${body}`);
}

// ========================= 类型 =========================

export interface PlanStepDraft {
  description: string;
}

export interface PlanResult {
  title: string;
  steps: PlanStepDraft[];
}

/** 单步确认动作 */
export type ConfirmAction = "continue" | "skip" | "modify";

export interface StepConfirm {
  action: ConfirmAction;
  modifiedDescription?: string;
}

// ========================= 规划器 =========================

/**
 * 任务规划器
 *
 * 职责：
 * - 根据用户输入调用任务 API 生成步骤计划
 * - 自动生成任务标题
 * - 提供中断/恢复/修改步骤的不可变辅助方法
 * - 每步完成后发送系统通知
 * - localStorage 持久化（关闭重开可继续）
 */
export class TaskPlanner {
  /** 当前配置的客户端（公开以便单例比较） */
  client: TaskApiClient | null = null;
  private clientGetter: (() => TaskApiClient | null) | null = null;

  constructor(client?: TaskApiClient) {
    if (client) this.client = client;
  }

  /** 设置客户端获取器（推荐：设置加载后再取最新配置） */
  setClientGetter(getter: () => TaskApiClient | null): void {
    this.clientGetter = getter;
    this.client = null;
  }

  /** 直接设置客户端 */
  setClient(client: TaskApiClient): void {
    this.client = client;
    this.clientGetter = null;
  }

  private getClient(): TaskApiClient {
    const c = this.client ?? this.clientGetter?.() ?? null;
    if (!c) {
      throw new Error("TaskPlanner: TaskApiClient 未配置，请先调用 setClient / setClientGetter");
    }
    return c;
  }

  // ============== 自动规划 ==============

  /**
   * 根据用户输入生成步骤计划
   * @param userInput 用户原始输入
   * @param conversationId 所属对话 ID
   * @param context 可选上下文（如对话摘要）
   */
  async plan(userInput: string, conversationId: string, context?: string): Promise<TaskPlan> {
    const client = this.getClient();
    const messages = buildPlanMessages(userInput, context);
    const resp = await client.chat({ messages, enableFallbackParse: false });
    const text = resp.choices?.[0]?.message?.content ?? "";
    const parsed = parsePlanJson(text);

    // 标题：优先用规划返回的；否则走 generateTitle
    let title = parsed.title.trim();
    if (!title) {
      title = await this.generateTitle(userInput);
    }

    const now = Date.now();
    const plan: TaskPlan = {
      id: nanoid(),
      conversationId,
      title,
      steps: (parsed.steps.length > 0
        ? parsed.steps
        : [{ description: userInput.trim() || "执行任务" }]
      ).map((s) => ({
        id: nanoid(),
        description: s.description,
        status: "pending" as TaskStepStatus,
      })),
      status: "planning",
      createdAt: now,
      updatedAt: now,
    };
    return plan;
  }

  // ============== 自动生成标题 ==============

  /**
   * 自动生成任务标题：先走启发式（无需 API），失败再调用 API
   */
  async generateTitle(userInput: string): Promise<string> {
    const heuristic = generateTitleHeuristic(userInput);
    if (heuristic) return heuristic;
    try {
      const client = this.getClient();
      const messages: ChatCompletionMessage[] = [
        {
          role: "system",
          content:
            "为以下用户任务生成一个简短的标题（不超过15个字，不加引号和标点符号）。只返回标题文本。",
        },
        { role: "user", content: userInput },
      ];
      const resp = await client.chat({ messages, enableFallbackParse: false });
      const title = (resp.choices?.[0]?.message?.content ?? "")
        .trim()
        .replace(/["""'。.!！？?]/g, "")
        .slice(0, 20);
      return title || userInput.slice(0, 15) || "新任务";
    } catch {
      return userInput.slice(0, 15) || "新任务";
    }
  }

  // ============== 中断 / 恢复 / 修改（不可变辅助） ==============

  /** 中断计划：把 running 步骤回退为 pending */
  interrupt(plan: TaskPlan): TaskPlan {
    return {
      ...plan,
      status: "interrupted",
      steps: plan.steps.map((s) =>
        s.status === "running" ? { ...s, status: "pending" as TaskStepStatus } : s,
      ),
      updatedAt: Date.now(),
    };
  }

  /** 恢复计划：可同时修改步骤描述 */
  resume(plan: TaskPlan, modifiedSteps?: Array<{ id: string; description: string }>): TaskPlan {
    let steps = plan.steps;
    if (modifiedSteps && modifiedSteps.length > 0) {
      const map = new Map(modifiedSteps.map((m) => [m.id, m.description]));
      steps = plan.steps.map((s) =>
        map.has(s.id) ? { ...s, description: map.get(s.id)! } : s,
      );
    }
    return {
      ...plan,
      steps,
      status: "executing",
      updatedAt: Date.now(),
    };
  }

  /** 修改单步描述 */
  modifyStep(plan: TaskPlan, stepId: string, newDescription: string): TaskPlan {
    return {
      ...plan,
      steps: plan.steps.map((s) =>
        s.id === stepId ? { ...s, description: newDescription } : s,
      ),
      updatedAt: Date.now(),
    };
  }

  // ============== 通知 ==============

  /** 某步完成时发送通知 */
  async notifyStepComplete(plan: TaskPlan, step: TaskStep): Promise<void> {
    const title = `步骤完成 · ${plan.title}`;
    const body = step.result
      ? `${step.description}\n结果：${step.result}`
      : step.description;
    await notify(title, body);
  }

  /** 整个计划完成时发送通知 */
  async notifyPlanComplete(plan: TaskPlan): Promise<void> {
    const completed = plan.steps.filter((s) => s.status === "completed").length;
    const skipped = plan.steps.filter((s) => s.status === "skipped").length;
    await notify("任务完成", `${plan.title}（${completed}/${plan.steps.length} 步完成${skipped ? `，${skipped} 步跳过` : ""}）`);
  }

  // ============== 持久化 ==============

  static savePlans(plans: TaskPlan[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plans));
    } catch (e) {
      console.error("Failed to save task plans:", e);
    }
  }

  static loadPlans(): TaskPlan[] {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored) as TaskPlan[];
    } catch (e) {
      console.error("Failed to load task plans:", e);
    }
    return [];
  }

  static clearPlans(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // noop
    }
  }
}

// ========================= 规划消息构造 =========================

function buildPlanMessages(userInput: string, context?: string): ChatCompletionMessage[] {
  const sys = `你是一个任务规划助手。根据用户的请求，将其拆解为可执行的步骤列表。
请只返回严格的 JSON（不要包含 markdown 代码块标记或任何解释文字），格式如下：
{
  "title": "任务标题（简短，不超过15字）",
  "steps": [
    { "description": "步骤1的描述（明确的动作）" },
    { "description": "步骤2的描述" }
  ]
}
要求：
- 步骤数量在 1-8 步之间
- 每个步骤应当是一个独立、可执行的动作
- 步骤描述要具体、明确，不要包含"步骤X:"这类前缀
- 只返回 JSON，不要有任何额外文字`;
  const userContent = context
    ? `上下文：${context}\n\n用户请求：${userInput}`
    : userInput;
  return [
    { role: "system", content: sys },
    { role: "user", content: userContent },
  ];
}

// ========================= JSON 解析 =========================

function parsePlanJson(text: string): PlanResult {
  let candidate = (text ?? "").trim();
  if (!candidate) return { title: "", steps: [] };

  // 剥离 markdown 代码块
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidate = fence[1].trim();

  // 截取最外层 { ... }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    candidate = candidate.slice(start, end + 1);
  }

  try {
    const parsed = JSON.parse(candidate) as any;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const steps: PlanStepDraft[] = Array.isArray(parsed.steps)
      ? parsed.steps
          .filter(
            (s: any) =>
              s && typeof s.description === "string" && s.description.trim(),
          )
          .map((s: any) => ({ description: s.description.trim() }))
      : [];
    return { title, steps };
  } catch {
    // 解析失败：降级为单步
    return { title: "", steps: [{ description: candidate.slice(0, 200) || "执行任务" }] };
  }
}

// ========================= 标题启发式 =========================

function generateTitleHeuristic(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= 15) return trimmed;
  // 取第一个分句
  const clauseEnd = trimmed.search(/[，。；！？,.!?;\n]/);
  if (clauseEnd > 0 && clauseEnd <= 15) return trimmed.slice(0, clauseEnd);
  return trimmed.slice(0, 15);
}

// ========================= 单例 =========================

let _defaultPlanner: TaskPlanner | null = null;

export function getDefaultTaskPlanner(client?: TaskApiClient): TaskPlanner {
  if (!_defaultPlanner) {
    _defaultPlanner = new TaskPlanner(client);
  } else if (client && _defaultPlanner.client !== client) {
    _defaultPlanner.setClient(client);
  }
  return _defaultPlanner;
}

export function resetDefaultTaskPlanner(): void {
  _defaultPlanner = null;
}
