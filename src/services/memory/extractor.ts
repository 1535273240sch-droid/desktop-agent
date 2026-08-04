// services/memory/extractor.ts - 记忆自动提取服务
// 每轮对话后自动提取记忆节点 + 用 TaskAPI 分析 + 自动分类 + 自动关联 + 新节点轻量提示

import { logger } from "@/services/logger";
import { TaskApiClient, type ChatCompletionMessage } from "@/services/api/taskApi";
import type {
  MemoryNode,
  MemoryNodeType,
  MemoryLink,
  Conversation,
  Message,
} from "@/types";

const log = logger;

// ========================= 类型定义 =========================

export interface ExtractionResult {
  /** 本次提取出的新节点 */
  nodes: MemoryNode[];
  /** 自动建立的关联 */
  links: MemoryLink[];
  /** 是否实际执行了提取（对话太短 / 模型返回空时为 false） */
  extracted: boolean;
  /** 跳过原因（extracted=false 时给出） */
  reason?: string;
}

/** 新节点轻量提示（推送到聊天流中展示） */
export interface MemoryHint {
  type: MemoryNodeType;
  title: string;
  summary: string;
  /** 关联到的既有节点标题列表 */
  relatedTo: string[];
  /** 提示时间戳 */
  timestamp: number;
}

export type MemoryHintHandler = (hint: MemoryHint) => void;

/** 模型返回的单条记忆抽取项 */
interface RawExtractionItem {
  type: MemoryNodeType;
  title: string;
  summary: string;
  details?: string;
  tags?: string[];
  /** 用于关联检索的关键词 */
  keywords?: string[];
}

// ========================= 常量与策略 =========================

/** 最近 N 条消息参与提取（避免上下文过长） */
const RECENT_MESSAGES_WINDOW = 12;
/** 触发提取的最小消息数 */
const MIN_MESSAGES_TO_EXTRACT = 4;
/** 单次提取的节点上限 */
const MAX_NODES_PER_EXTRACTION = 5;
/** 关联强度默认值 */
const DEFAULT_LINK_STRENGTH = 0.6;
/** 关键词匹配阈值（每个关键词在已有节点中出现 ≥ 此值则建立关联） */
const KEYWORD_MATCH_MIN = 1;

// ========================= 状态 =========================

const hintHandlers = new Set<MemoryHintHandler>();

// ========================= 提示词 =========================

const EXTRACTION_SYSTEM_PROMPT = `你是一个记忆提取助手。从给定的对话片段中提取值得长期记忆的信息，并按以下三类输出：

1. user-info: 用户的个人信息、偏好、技能、背景（如"用户是 Java 开发者"、"用户偏好简洁回答"）
2. knowledge: 通用的知识点、事实、概念解释（如"React Hooks 必须在顶层调用"）
3. task-record: 用户已完成的任务记录或决策（如"用户决定用 PostgreSQL 替代 MySQL"）

输出要求：
- 仅输出 JSON 数组，不要任何解释或 markdown 包裹
- 每条包含 type / title / summary / details / tags / keywords 字段
- title 不超过 20 字；summary 不超过 60 字；details 可为空
- tags 为字符串数组（≤3 个）；keywords 为用于关联检索的关键词数组（≤5 个）
- 跳过琐碎、临时性、与长期记忆无关的内容
- 最多输出 ${MAX_NODES_PER_EXTRACTION} 条

示例输出：
[{"type":"user-info","title":"用户偏好暗色主题","summary":"用户在多场合表示偏好深色界面","tags":["UI","偏好"],"keywords":["暗色","主题","深色"]}]`;

// ========================= 公开 API =========================

/** 订阅新节点轻量提示（聊天流中展示） */
export function onMemoryHint(handler: MemoryHintHandler): () => void {
  hintHandlers.add(handler);
  return () => hintHandlers.delete(handler);
}

function emitHint(hint: MemoryHint): void {
  for (const h of hintHandlers) {
    try {
      h(hint);
    } catch (e) {
      log.warn("memory.extractor", "hint handler error", e);
    }
  }
}

/**
 * 从一轮对话中自动提取记忆节点
 * - 取最近 RECENT_MESSAGES_WINDOW 条消息
 * - 用 TaskAPI 分析后得到候选节点
 * - 与已有节点做关键词关联
 * - 通过 hintHandlers 推送轻量提示
 *
 * @param client TaskAPI 客户端（用于 LLM 调用）
 * @param conversation 当前会话
 * @param existingNodes 已有节点（用于去重与关联）
 * @returns 提取结果
 */
export async function extractFromConversation(
  client: TaskApiClient,
  conversation: Conversation,
  existingNodes: MemoryNode[],
): Promise<ExtractionResult> {
  // 1. 基础判断：消息数过少则跳过
  const recent = takeRecentMessages(conversation.messages, RECENT_MESSAGES_WINDOW);
  if (recent.length < MIN_MESSAGES_TO_EXTRACT) {
    return {
      nodes: [],
      links: [],
      extracted: false,
      reason: `消息数不足（${recent.length} < ${MIN_MESSAGES_TO_EXTRACT}）`,
    };
  }

  // 2. 调用 LLM 提取
  const rawItems = await callExtractor(client, recent).catch((e) => {
    log.warn("memory.extractor", "LLM extraction failed", e);
    return [] as RawExtractionItem[];
  });

  if (rawItems.length === 0) {
    return { nodes: [], links: [], extracted: false, reason: "无可提取的记忆点" };
  }

  // 3. 去重（与已有节点 title 相同则跳过）
  const existingTitles = new Set(existingNodes.map((n) => n.title.toLowerCase()));
  const existingSummaries = new Set(existingNodes.map((n) => n.summary.toLowerCase()));

  const newNodes: MemoryNode[] = [];
  const now = Date.now();
  for (const item of rawItems) {
    if (!item.title?.trim() || !item.type) continue;
    const titleLower = item.title.toLowerCase().trim();
    const summaryLower = (item.summary ?? "").toLowerCase().trim();
    if (existingTitles.has(titleLower)) continue;
    if (summaryLower && existingSummaries.has(summaryLower)) continue;

    newNodes.push({
      id: crypto.randomUUID(),
      type: item.type,
      title: item.title.trim(),
      summary: (item.summary ?? "").trim(),
      details: (item.details ?? "").trim(),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 5) : [],
      createdAt: now,
      updatedAt: now,
    });
    if (newNodes.length >= MAX_NODES_PER_EXTRACTION) break;
  }

  if (newNodes.length === 0) {
    return { nodes: [], links: [], extracted: false, reason: "提取结果与已有记忆重复" };
  }

  // 4. 自动关联：用 keywords 与已有节点匹配
  const links = buildAutoLinks(newNodes, rawItems, existingNodes);

  // 5. 推送轻量提示
  for (const node of newNodes) {
    const relatedTitles = links
      .filter((l) => l.source === node.id || l.target === node.id)
      .map((l) => {
        const otherId = l.source === node.id ? l.target : l.source;
        return existingNodes.find((n) => n.id === otherId)?.title ?? "";
      })
      .filter(Boolean);

    emitHint({
      type: node.type,
      title: node.title,
      summary: node.summary,
      relatedTo: relatedTitles,
      timestamp: now,
    });
  }

  log.info("memory.extractor", `extracted ${newNodes.length} nodes, ${links.length} links`, {
    conversationId: conversation.id,
  });

  return { nodes: newNodes, links, extracted: true };
}

// ========================= 内部：调用 LLM =========================

async function callExtractor(
  client: TaskApiClient,
  messages: Message[],
): Promise<RawExtractionItem[]> {
  const dialogText = messages
    .map((m) => {
      const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role;
      return `${role}: ${m.content}`;
    })
    .join("\n");

  const chatMessages: ChatCompletionMessage[] = [
    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: `请从以下对话中提取值得长期记忆的信息：\n\n${dialogText}`,
    },
  ];

  // 使用非流式 chat；强制低温保证稳定 JSON
  const resp = await client.chat({
    messages: chatMessages,
    enableFallbackParse: false,
  });

  const content = resp.choices?.[0]?.message?.content ?? "";
  return parseExtractorResponse(content);
}

function parseExtractorResponse(content: string): RawExtractionItem[] {
  if (!content?.trim()) return [];

  // 尝试直接解析
  try {
    const arr = JSON.parse(content);
    if (Array.isArray(arr)) return normalizeItems(arr);
  } catch {
    /* 继续尝试提取代码块 */
  }

  // 提取 ```json ... ``` 代码块
  const blockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (blockMatch) {
    try {
      const arr = JSON.parse(blockMatch[1]);
      if (Array.isArray(arr)) return normalizeItems(arr);
    } catch {
      /* 继续兜底 */
    }
  }

  // 兜底：找到首个 [ ... ] JSON 数组
  const arrayMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) {
    try {
      const arr = JSON.parse(arrayMatch[0]);
      if (Array.isArray(arr)) return normalizeItems(arr);
    } catch {
      /* 解析失败 */
    }
  }
  return [];
}

function normalizeItems(arr: any[]): RawExtractionItem[] {
  const validTypes: MemoryNodeType[] = ["user-info", "knowledge", "task-record"];
  return arr
    .filter((it) => it && typeof it === "object" && validTypes.includes(it.type))
    .map((it) => ({
      type: it.type as MemoryNodeType,
      title: String(it.title ?? "").trim(),
      summary: String(it.summary ?? "").trim(),
      details: it.details ? String(it.details) : undefined,
      tags: Array.isArray(it.tags) ? it.tags.map(String) : undefined,
      keywords: Array.isArray(it.keywords) ? it.keywords.map(String) : undefined,
    }))
    .filter((it) => it.title);
}

// ========================= 内部：自动关联 =========================

/**
 * 用每个新节点的 keywords 与已有节点匹配
 * - 匹配方式：keyword 出现在已有节点的 title/summary/tags 中
 * - 命中数 ≥ KEYWORD_MATCH_MIN 时建立 link
 */
function buildAutoLinks(
  newNodes: MemoryNode[],
  rawItems: RawExtractionItem[],
  existingNodes: MemoryNode[],
): MemoryLink[] {
  const links: MemoryLink[] = [];
  const newNodeToKeywords = new Map<string, string[]>();
  for (const node of newNodes) {
    const raw = rawItems.find((r) => r.title.trim() === node.title.trim());
    const kws = (raw?.keywords ?? extractKeywordsFromNode(node)).map((k) =>
      k.toLowerCase().trim(),
    );
    newNodeToKeywords.set(node.id, kws);
  }

  for (const newNode of newNodes) {
    const kws = newNodeToKeywords.get(newNode.id) ?? [];
    if (kws.length === 0) continue;

    for (const existing of existingNodes) {
      const matchCount = countKeywordMatches(kws, existing);
      if (matchCount < KEYWORD_MATCH_MIN) continue;

      // 关联强度 = 命中数 / 关键词数（最少 0.3，最多 1.0）
      const strength = Math.min(1.0, Math.max(0.3, matchCount / kws.length));
      links.push({
        source: newNode.id,
        target: existing.id,
        strength: Math.max(DEFAULT_LINK_STRENGTH, strength),
        label: matchCount >= 2 ? "强关联" : "关联",
      });
    }
  }

  return links;
}

function countKeywordMatches(keywords: string[], node: MemoryNode): number {
  const haystack = [
    node.title,
    node.summary,
    node.details,
    ...(node.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    if (!kw) continue;
    if (haystack.includes(kw)) count++;
  }
  return count;
}

/** 若模型未返回 keywords，则从节点本身提取（tags + title 关键词） */
function extractKeywordsFromNode(node: MemoryNode): string[] {
  const kws = new Set<string>();
  for (const tag of node.tags ?? []) kws.add(tag.toLowerCase());
  // title 拆分为长度 ≥ 2 的词
  for (const w of node.title.split(/[\s,，。、:：;；]+/)) {
    if (w.length >= 2) kws.add(w.toLowerCase());
  }
  return Array.from(kws).slice(0, 5);
}

// ========================= 内部：消息窗口 =========================

function takeRecentMessages(messages: Message[], n: number): Message[] {
  if (messages.length <= n) return [...messages];
  return messages.slice(-n);
}

// ========================= 编排入口：每轮对话后调用 =========================

/**
 * 每轮对话后调用：异步提取并写入记忆 store
 * - 失败时仅记录日志，不抛出（不影响主对话流）
 * - 通过动态 import 避免 store 循环依赖
 *
 * @param client TaskAPI 客户端
 * @param conversation 当前会话
 */
export async function runExtractionAfterTurn(
  client: TaskApiClient,
  conversation: Conversation,
): Promise<ExtractionResult> {
  try {
    const { useMemoryStore } = await import("@/stores/memory");
    const store = useMemoryStore();
    const existing = store.nodes;
    const result = await extractFromConversation(client, conversation, existing);

    if (!result.extracted) {
      log.debug("memory.extractor", "skip", { reason: result.reason });
      return result;
    }

    // 写入 store（store 内部负责持久化）
    for (const node of result.nodes) {
      store.addNode(node);
    }
    for (const link of result.links) {
      store.addLink(link);
    }

    return result;
  } catch (e) {
    log.error("memory.extractor", "runExtractionAfterTurn failed", e);
    return { nodes: [], links: [], extracted: false, reason: String(e) };
  }
}
