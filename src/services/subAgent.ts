// services/subAgent.ts - 子Agent管理器
// 进程内创建 + 上限3并发 + 全能力工具 + 继承父上下文(对话历史+记忆图谱) + 自动命名 + 结果汇总

import { nanoid } from "nanoid";
import type { TaskApiClient, ChatCompletionMessage } from "@/services/api/taskApi";
import type { SubAgent, Message, MemoryGraph } from "@/types";
import {
  FunctionCallingEngine,
  toApiMessages,
  type FunctionCallingResult,
} from "@/services/tools/functionCalling";
import type { ToolCategory } from "@/services/tools/registry";
import type { ExecutionResult } from "@/services/tools/executor";

const STORAGE_KEY = "desktop-agent-sub-agents";

/** 子Agent 并发上限 */
export const MAX_CONCURRENT = 3;

/** 子Agent 可用的全部工具类别（全能力） */
const SUB_AGENT_CATEGORIES: ToolCategory[] = [
  "capability",
  "desktop",
  "sandbox",
  "sub-agent",
  "plugin",
  "file",
];

// ========================= 派生选项 =========================

export interface SpawnOptions {
  /** 子Agent名称（不传则自动生成） */
  name?: string;
  /** 任务描述 */
  task: string;
  /** 补充上下文 */
  context?: string;
  /** 父对话 ID */
  parentConversationId: string;
  /** 父Agent对话历史（继承） */
  parentMessages?: Message[];
  /** 父Agent记忆图谱（继承） */
  parentMemory?: MemoryGraph;
  /** 任务 API 客户端（不传则使用管理器配置的） */
  client?: TaskApiClient;
  /** 中止信号 */
  signal?: AbortSignal;
}

// ========================= 自动命名 =========================

/**
 * 根据任务描述自动生成子Agent名称，如 "图片分析Agent"
 * 启发式：匹配对象 + 动作关键词组合
 */
export function generateAgentName(task: string): string {
  const t = (task ?? "").trim();
  if (!t) return "子Agent";

  const objects: Array<[RegExp, string]> = [
    [/图片|图像|截图|照片|photo|image/i, "图片"],
    [/代码|脚本|程序|code|script/i, "代码"],
    [/文件|文档|file|doc/i, "文件"],
    [/网络|网页|网站|链接|url|web/i, "网络"],
    [/数据|表格|data|table/i, "数据"],
    [/视频|video/i, "视频"],
    [/音频|语音|音乐|audio|music/i, "音频"],
    [/邮件|email|mail/i, "邮件"],
  ];
  const actions: Array<[RegExp, string]> = [
    [/分析|识别|理解|解读|analy/i, "分析"],
    [/搜索|查找|检索|search|find/i, "搜索"],
    [/执行|运行|run|exec/i, "执行"],
    [/计算|统计|核算|calcul|stat/i, "计算"],
    [/生成|创建|制作|creat|generat|make/i, "生成"],
    [/翻译|translat/i, "翻译"],
    [/总结|归纳|概括|summar/i, "总结"],
    [/转换|convert/i, "转换"],
    [/读取|获取|read|fetch|get/i, "读取"],
    [/写入|保存|write|save/i, "写入"],
    [/编辑|修改|更新|edit|modif|updat/i, "编辑"],
    [/监控|监视|monitor|watch/i, "监控"],
  ];

  let obj = "";
  for (const [re, label] of objects) {
    if (re.test(t)) {
      obj = label;
      break;
    }
  }
  let act = "";
  for (const [re, label] of actions) {
    if (re.test(t)) {
      act = label;
      break;
    }
  }

  if (obj && act) return `${obj}${act}Agent`;
  if (act) return `${act}Agent`;
  if (obj) return `${obj}处理Agent`;
  // 回退：截取前 6 字
  return t.length > 6 ? `${t.slice(0, 6)}Agent` : `${t}Agent`;
}

// ========================= 管理器 =========================

/**
 * 子Agent管理器（进程内）
 *
 * - 上限 MAX_CONCURRENT 个并发
 * - 每个子Agent继承父Agent对话历史与记忆图谱作为上下文
 * - 可调用全部 6 类工具
 * - 自动命名
 * - 完成后结果汇总写入 agent.result
 */
export class SubAgentManager {
  /** 当前配置的客户端（公开以便单例比较） */
  client: TaskApiClient | null = null;
  private clientGetter: (() => TaskApiClient | null) | null = null;
  private agents = new Map<string, SubAgent>();
  private running = new Set<string>();

  constructor(client?: TaskApiClient) {
    if (client) this.client = client;
  }

  setClientGetter(getter: () => TaskApiClient | null): void {
    this.clientGetter = getter;
    this.client = null;
  }

  setClient(client: TaskApiClient): void {
    this.client = client;
    this.clientGetter = null;
  }

  private getClient(clientOverride?: TaskApiClient): TaskApiClient {
    const c = clientOverride ?? this.client ?? this.clientGetter?.() ?? null;
    if (!c) {
      throw new Error("SubAgentManager: TaskApiClient 未配置");
    }
    return c;
  }

  // ============== 容量 ==============

  get maxConcurrent(): number {
    return MAX_CONCURRENT;
  }

  canSpawn(): boolean {
    return this.running.size < MAX_CONCURRENT;
  }

  runningCount(): number {
    return this.running.size;
  }

  // ============== 查询 ==============

  list(): SubAgent[] {
    return Array.from(this.agents.values());
  }

  get(id: string): SubAgent | undefined {
    return this.agents.get(id);
  }

  getRunning(): SubAgent[] {
    return this.list().filter((a) => a.status === "running");
  }

  getByConversation(conversationId: string): SubAgent[] {
    return this.list().filter((a) => a.parentConversationId === conversationId);
  }

  // ============== 创建 / 执行 ==============

  /**
   * 派生子Agent处理独立子任务（并发执行）
   * @throws 达到并发上限时抛错
   */
  spawn(opts: SpawnOptions): SubAgent {
    if (!this.canSpawn()) {
      throw new Error(
        `已达到子Agent并发上限（${MAX_CONCURRENT}），请等待现有任务完成`,
      );
    }
    const client = this.getClient(opts.client);
    const name = opts.name?.trim() || generateAgentName(opts.task);
    const now = Date.now();

    const agent: SubAgent = {
      id: nanoid(),
      name,
      task: opts.task,
      status: "running",
      startedAt: now,
      parentConversationId: opts.parentConversationId,
      messages: [],
    };
    this.agents.set(agent.id, agent);
    this.running.add(agent.id);

    // 进程内并发执行（不阻塞调用方）
    void this._runAgent(agent, client, opts).catch((err) => {
      agent.status = "failed";
      agent.completedAt = Date.now();
      agent.result = `执行失败：${err?.message ?? String(err)}`;
      this.running.delete(agent.id);
    });

    return agent;
  }

  /** 实际执行子Agent任务 */
  private async _runAgent(
    agent: SubAgent,
    client: TaskApiClient,
    opts: SpawnOptions,
  ): Promise<void> {
    // 记录子Agent自身的用户消息
    agent.messages.push({
      id: nanoid(),
      role: "user",
      content: opts.context
        ? `${opts.task}\n\n补充上下文：${opts.context}`
        : opts.task,
      timestamp: Date.now(),
    });

    // 构造上下文（继承父对话历史 + 记忆图谱）
    const apiMessages = this._buildContextMessages(agent, opts);

    // 使用全能力 function calling 引擎执行
    const engine = new FunctionCallingEngine(client);
    let result: FunctionCallingResult;
    try {
      result = await engine.run(apiMessages, {
        categories: SUB_AGENT_CATEGORIES,
        signal: opts.signal,
      });
    } catch (err: any) {
      if (opts.signal?.aborted) {
        agent.result = "已取消";
      } else {
        agent.result = `执行失败：${err?.message ?? String(err)}`;
      }
      agent.status = "failed";
      agent.completedAt = Date.now();
      this.running.delete(agent.id);
      return;
    }

    // 记录助手回复
    agent.messages.push({
      id: nanoid(),
      role: "assistant",
      content: result.text || "(无输出)",
      timestamp: Date.now(),
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
    });

    // 汇总结果
    agent.result = this._summarize(agent, result);
    agent.status = "completed";
    agent.completedAt = Date.now();
    this.running.delete(agent.id);
  }

  /** 构造子Agent上下文：system + 父历史 + 记忆图谱 + 任务 */
  private _buildContextMessages(
    agent: SubAgent,
    opts: SpawnOptions,
  ): ChatCompletionMessage[] {
    const messages: ChatCompletionMessage[] = [
      { role: "system", content: this._buildSystemPrompt() },
    ];

    // 继承父Agent对话历史（取最近若干条，避免 token 溢出）
    if (opts.parentMessages && opts.parentMessages.length > 0) {
      const recent = opts.parentMessages.slice(-10);
      const apiParent = toApiMessages(recent).filter(
        (m) => m.role === "user" || m.role === "assistant",
      );
      const historyText = apiParent
        .map((m) => {
          const c =
            typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return `[${m.role}] ${c}`;
        })
        .join("\n");
      messages.push({
        role: "system",
        content: `以下是父Agent的近期对话历史，供你理解任务背景（不要直接回复这些内容）：\n${historyText}`,
      });
    }

    // 继承父Agent记忆图谱
    if (opts.parentMemory && opts.parentMemory.nodes.length > 0) {
      const memText = opts.parentMemory.nodes
        .slice(0, 20)
        .map((n) => `- ${n.title}：${n.summary}`)
        .join("\n");
      messages.push({
        role: "system",
        content: `以下是父Agent的记忆图谱节点，可供参考：\n${memText}`,
      });
    }

    // 任务本身
    const userContent = opts.context
      ? `请完成以下任务：\n${opts.task}\n\n补充上下文：${opts.context}`
      : `请完成以下任务：\n${opts.task}`;
    messages.push({ role: "user", content: userContent });

    return messages;
  }

  private _buildSystemPrompt(): string {
    return `你是一个子Agent，负责独立完成父Agent分派的子任务。
你可以调用所有可用工具（能力 / 桌面操控 / 沙箱执行 / 子Agent / 插件 / 文件操作）来完成任务。
请高效、专注地完成任务，尽量减少不必要的交互，直接执行并给出简洁的结果总结。`;
  }

  /** 汇总子Agent执行结果 */
  private _summarize(agent: SubAgent, result: FunctionCallingResult): string {
    const toolCount = result.toolCalls.length;
    const results: ExecutionResult[] = result.results;
    const successCount = results.filter((r) => r.success).length;
    const header = `【${agent.name}】完成 ${toolCount} 项工具调用（${successCount} 成功）`;
    const body = (result.text || "").trim();
    if (!body) return header;
    // 截断过长结果
    return body.length > 600 ? `${header}\n${body.slice(0, 600)}...` : `${header}\n${body}`;
  }

  // ============== 等待 / 取消 ==============

  /** 等待子Agent完成并返回结果 */
  async wait(agentId: string, timeoutMs = 180_000): Promise<string> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`SubAgent 不存在：${agentId}`);
    if (agent.status !== "running") return agent.result ?? "";

    const start = Date.now();
    while (agent.status === "running") {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`等待子Agent「${agent.name}」超时`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return agent.result ?? "";
  }

  /** 取消正在运行的子Agent（best-effort） */
  cancel(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== "running") return false;
    agent.status = "failed";
    agent.completedAt = Date.now();
    if (!agent.result) agent.result = "已被取消";
    this.running.delete(agentId);
    return true;
  }

  /** 移除子Agent记录 */
  remove(agentId: string): void {
    this.running.delete(agentId);
    this.agents.delete(agentId);
  }

  /** 清空全部子Agent */
  clear(): void {
    this.running.clear();
    this.agents.clear();
  }

  // ============== 持久化 ==============

  /**
   * 持久化子Agent列表：running 状态在重载后无法恢复执行，标记为 failed
   */
  static saveAgents(agents: SubAgent[]): void {
    try {
      const persistable = agents.map((a) =>
        a.status === "running"
          ? {
              ...a,
              status: "failed" as const,
              result: a.result ?? "因应用重启中断",
              completedAt: a.completedAt ?? Date.now(),
            }
          : a,
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
    } catch (e) {
      console.error("Failed to save sub-agents:", e);
    }
  }

  static loadAgents(): SubAgent[] {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored) as SubAgent[];
    } catch (e) {
      console.error("Failed to load sub-agents:", e);
    }
    return [];
  }

  static clearStorage(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // noop
    }
  }
}

// ========================= 单例 =========================

let _defaultManager: SubAgentManager | null = null;

export function getDefaultSubAgentManager(client?: TaskApiClient): SubAgentManager {
  if (!_defaultManager) {
    _defaultManager = new SubAgentManager(client);
  } else if (client && _defaultManager.client !== client) {
    _defaultManager.setClient(client);
  }
  return _defaultManager;
}

export function resetDefaultSubAgentManager(): void {
  _defaultManager = null;
}
