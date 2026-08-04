// stores/subAgent.ts - 子Agent Pinia store
// 管理活跃子Agent列表 + 创建/完成/失败状态管理 + 结果汇总

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { nanoid } from "nanoid";
import type { SubAgent, Message, MemoryGraph } from "@/types";
import type { TaskApiClient } from "@/services/api/taskApi";
import {
  SubAgentManager,
  MAX_CONCURRENT,
  generateAgentName,
} from "@/services/subAgent";

const STORAGE_KEY = "desktop-agent-sub-agents";

export interface SpawnParams {
  name?: string;
  task: string;
  context?: string;
  parentConversationId: string;
  parentMessages?: Message[];
  parentMemory?: MemoryGraph;
  client?: TaskApiClient;
  signal?: AbortSignal;
}

export const useSubAgentStore = defineStore("subAgent", () => {
  const agents = ref<SubAgent[]>([]);
  // store 自有的管理器实例（Pinia 单例 → manager 也即单例）
  const manager = new SubAgentManager();
  // 轮询定时器引用，便于清理
  const watchers = new Map<string, ReturnType<typeof setInterval>>();

  // ============== 计算属性 ==============

  const runningAgents = computed(() =>
    agents.value.filter((a) => a.status === "running"),
  );

  const completedAgents = computed(() =>
    agents.value.filter((a) => a.status === "completed"),
  );

  const canSpawn = computed(() => runningAgents.value.length < MAX_CONCURRENT);

  // ============== 持久化 ==============

  function load(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        agents.value = JSON.parse(stored) as SubAgent[];
        // 重载后：running 状态无法恢复执行，标记为 failed
        for (const a of agents.value) {
          if (a.status === "running") {
            a.status = "failed";
            if (!a.result) a.result = "因应用重启中断";
            if (!a.completedAt) a.completedAt = Date.now();
          }
        }
      }
    } catch (e) {
      console.error("Failed to load sub-agents:", e);
    }
  }

  function save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(agents.value));
    } catch (e) {
      console.error("Failed to save sub-agents:", e);
    }
  }

  // ============== 客户端配置 ==============

  function setClientGetter(getter: () => TaskApiClient | null): void {
    manager.setClientGetter(getter);
  }

  function setClient(client: TaskApiClient): void {
    manager.setClient(client);
  }

  // ============== 创建 / 状态管理 ==============

  /**
   * 派生子Agent（并发执行）
   * @returns 创建的子Agent；达到上限返回 null
   */
  function spawn(params: SpawnParams): SubAgent | null {
    if (!canSpawn.value) {
      console.warn(
        `已达到子Agent并发上限（${MAX_CONCURRENT}），无法创建新子Agent`,
      );
      return null;
    }

    const agent = manager.spawn({
      name: params.name,
      task: params.task,
      context: params.context,
      parentConversationId: params.parentConversationId,
      parentMessages: params.parentMessages,
      parentMemory: params.parentMemory,
      client: params.client,
      signal: params.signal,
    });

    // 管理器持有的是同一引用，store 也记录一份并启动状态同步
    agents.value.unshift(agent);
    save();
    watchAgent(agent.id);
    return agent;
  }

  /** 轮询同步管理器中的实时状态到 store（子Agent在进程内异步执行） */
  function watchAgent(agentId: string): void {
    if (watchers.has(agentId)) return;
    const interval = setInterval(() => {
      const live = manager.get(agentId);
      const target = agents.value.find((a) => a.id === agentId);
      if (!live) {
        // 管理器中已移除
        if (target) target.status = target.status === "running" ? "failed" : target.status;
        clearWatcher(agentId);
        save();
        return;
      }
      if (target) {
        target.status = live.status;
        target.result = live.result;
        target.completedAt = live.completedAt;
        target.messages = live.messages;
      }
      if (live.status !== "running") {
        clearWatcher(agentId);
      }
      save();
    }, 500);
    watchers.set(agentId, interval);
  }

  function clearWatcher(agentId: string): void {
    const handle = watchers.get(agentId);
    if (handle) {
      clearInterval(handle);
      watchers.delete(agentId);
    }
  }

  function completeAgent(agentId: string, result: string): void {
    const agent = agents.value.find((a) => a.id === agentId);
    if (agent) {
      agent.status = "completed";
      agent.result = result;
      agent.completedAt = Date.now();
      save();
    }
  }

  function failAgent(agentId: string, error: string): void {
    const agent = agents.value.find((a) => a.id === agentId);
    if (agent) {
      agent.status = "failed";
      agent.result = error;
      agent.completedAt = Date.now();
      save();
    }
  }

  function cancelAgent(agentId: string): boolean {
    const ok = manager.cancel(agentId);
    const agent = agents.value.find((a) => a.id === agentId);
    if (agent && ok) {
      agent.status = "failed";
      if (!agent.result) agent.result = "已取消";
      agent.completedAt = Date.now();
      save();
    }
    clearWatcher(agentId);
    return ok;
  }

  function removeAgent(agentId: string): void {
    const idx = agents.value.findIndex((a) => a.id === agentId);
    if (idx !== -1) {
      agents.value.splice(idx, 1);
      manager.remove(agentId);
      clearWatcher(agentId);
      save();
    }
  }

  function clearAll(): void {
    for (const id of Array.from(watchers.keys())) clearWatcher(id);
    agents.value = [];
    manager.clear();
    save();
  }

  // ============== 查询 ==============

  function getAgent(agentId: string): SubAgent | undefined {
    return agents.value.find((a) => a.id === agentId);
  }

  function getAgentsByConversation(conversationId: string): SubAgent[] {
    return agents.value.filter((a) => a.parentConversationId === conversationId);
  }

  // ============== 消息追加 ==============

  function appendMessage(agentId: string, message: Partial<Message>): void {
    const agent = agents.value.find((a) => a.id === agentId);
    if (!agent) return;
    agent.messages.push({
      id: nanoid(),
      role: message.role ?? "assistant",
      content: message.content ?? "",
      timestamp: Date.now(),
      ...message,
    });
    save();
  }

  // ============== 等待 ==============

  /** 等待子Agent完成并返回结果（透传到管理器） */
  function waitAgent(agentId: string, timeoutMs?: number): Promise<string> {
    return manager.wait(agentId, timeoutMs);
  }

  return {
    agents,
    runningAgents,
    completedAgents,
    canSpawn,
    maxConcurrent: MAX_CONCURRENT,
    manager,
    // 持久化
    load,
    save,
    // 客户端配置
    setClientGetter,
    setClient,
    // 创建 / 状态
    spawn,
    completeAgent,
    failAgent,
    cancelAgent,
    removeAgent,
    clearAll,
    // 查询
    getAgent,
    getAgentsByConversation,
    // 消息
    appendMessage,
    // 等待
    waitAgent,
    // 命名工具（暴露给外部使用）
    generateAgentName,
  };
});
