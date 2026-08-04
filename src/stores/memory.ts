// stores/memory.ts - 记忆 Pinia store
// 节点 CRUD + 图谱数据管理 + 检索（关键词 + 1 层关联扩展，最多 20 条）+ localStorage 持久化

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { nanoid } from "nanoid";
import type { MemoryNode, MemoryLink, MemoryGraph, MemoryNodeType } from "@/types";
import { logger } from "@/services/logger";

const log = logger;

// ========================= 常量 =========================

const STORAGE_KEY = "desktop-agent-memory-graph";
/** 检索结果 + 1 层关联扩展的总上限 */
const SEARCH_RESULT_LIMIT = 20;

// ========================= Store =========================

export const useMemoryStore = defineStore("memory", () => {
  // ============== 状态 ==============
  const nodes = ref<MemoryNode[]>([]);
  const links = ref<MemoryLink[]>([]);

  // ============== 计算属性 ==============

  /** 完整图谱数据（用于图谱渲染组件） */
  const graph = computed<MemoryGraph>(() => ({
    nodes: nodes.value,
    links: links.value,
  }));

  /** 按类型分组 */
  const nodesByType = computed<Record<MemoryNodeType, MemoryNode[]>>(() => ({
    "user-info": nodes.value.filter((n) => n.type === "user-info"),
    knowledge: nodes.value.filter((n) => n.type === "knowledge"),
    "task-record": nodes.value.filter((n) => n.type === "task-record"),
  }));

  /** 节点总数 */
  const nodeCount = computed(() => nodes.value.length);

  /** 关联总数 */
  const linkCount = computed(() => links.value.length);

  // ============== 持久化 ==============

  function load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as MemoryGraph;
      if (Array.isArray(parsed.nodes)) nodes.value = parsed.nodes;
      if (Array.isArray(parsed.links)) links.value = parsed.links;
      log.info("memory.store", `loaded ${nodes.value.length} nodes, ${links.value.length} links`);
    } catch (e) {
      log.error("memory.store", "load failed", e);
    }
  }

  function save(): void {
    try {
      const data: MemoryGraph = { nodes: nodes.value, links: links.value };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      log.error("memory.store", "save failed", e);
    }
  }

  // ============== 节点 CRUD ==============

  /** 添加节点（若同 id 已存在则覆盖） */
  function addNode(node: MemoryNode): MemoryNode {
    const idx = nodes.value.findIndex((n) => n.id === node.id);
    if (idx === -1) {
      nodes.value.push(node);
    } else {
      nodes.value[idx] = node;
    }
    save();
    return node;
  }

  /** 创建新节点（自动生成 id 与时间戳） */
  function createNode(input: Omit<MemoryNode, "id" | "createdAt" | "updatedAt"> & { id?: string }): MemoryNode {
    const now = Date.now();
    const node: MemoryNode = {
      id: input.id ?? nanoid(),
      type: input.type,
      title: input.title,
      summary: input.summary,
      details: input.details ?? "",
      tags: input.tags ?? [],
      x: input.x,
      y: input.y,
      createdAt: now,
      updatedAt: now,
    };
    return addNode(node);
  }

  /** 更新节点（部分字段） */
  function updateNode(id: string, updates: Partial<Omit<MemoryNode, "id" | "createdAt">>): MemoryNode | null {
    const idx = nodes.value.findIndex((n) => n.id === id);
    if (idx === -1) return null;
    const updated: MemoryNode = {
      ...nodes.value[idx],
      ...updates,
      id,
      updatedAt: Date.now(),
    };
    nodes.value[idx] = updated;
    save();
    return updated;
  }

  /** 删除节点（同时清理相关关联） */
  function deleteNode(id: string): boolean {
    const before = nodes.value.length;
    nodes.value = nodes.value.filter((n) => n.id !== id);
    if (nodes.value.length === before) return false;
    // 清理关联
    links.value = links.value.filter((l) => l.source !== id && l.target !== id);
    save();
    log.info("memory.store", `node deleted: ${id}`);
    return true;
  }

  /** 按 id 查找节点 */
  function getNode(id: string): MemoryNode | undefined {
    return nodes.value.find((n) => n.id === id);
  }

  // ============== 关联管理 ==============

  /** 添加关联（同 source+target 已存在则更新 strength） */
  function addLink(link: MemoryLink): MemoryLink {
    const idx = links.value.findIndex(
      (l) =>
        (l.source === link.source && l.target === link.target) ||
        (l.source === link.target && l.target === link.source),
    );
    if (idx === -1) {
      links.value.push(link);
    } else {
      links.value[idx] = { ...links.value[idx], ...link };
    }
    save();
    return link;
  }

  /** 删除关联 */
  function removeLink(source: string, target: string): boolean {
    const before = links.value.length;
    links.value = links.value.filter(
      (l) =>
        !(
          (l.source === source && l.target === target) ||
          (l.source === target && l.target === source)
        ),
    );
    if (links.value.length === before) return false;
    save();
    return true;
  }

  /** 获取与某节点直接关联的所有 link */
  function getLinksOf(nodeId: string): MemoryLink[] {
    return links.value.filter((l) => l.source === nodeId || l.target === nodeId);
  }

  /** 获取与某节点直接相邻的节点 id 集合 */
  function getNeighborIds(nodeId: string): string[] {
    const ids = new Set<string>();
    for (const l of links.value) {
      if (l.source === nodeId) ids.add(l.target);
      else if (l.target === nodeId) ids.add(l.source);
    }
    return Array.from(ids);
  }

  // ============== 检索 ==============

  /**
   * 关键词检索：返回匹配节点 + 1 层关联扩展，总共最多 SEARCH_RESULT_LIMIT 条
   * - 匹配字段：title / summary / details / tags
   * - 匹配方式：包含（大小写不敏感）
   * - 关联扩展：每个命中节点附上其直接邻居
   */
  function search(keyword: string, limit: number = SEARCH_RESULT_LIMIT): MemoryNode[] {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return [];

    // 1. 直接命中的节点
    const matched = nodes.value.filter((n) => matchNode(n, kw));
    if (matched.length === 0) return [];

    // 2. 1 层关联扩展
    const expanded = new Map<string, MemoryNode>();
    for (const node of matched) {
      expanded.set(node.id, node);
      // 加直接邻居
      for (const neighborId of getNeighborIds(node.id)) {
        if (expanded.size >= limit) break;
        const neighbor = getNode(neighborId);
        if (neighbor && !expanded.has(neighborId)) {
          expanded.set(neighborId, neighbor);
        }
      }
      if (expanded.size >= limit) break;
    }

    // 优先返回命中节点，再补邻居，截断到 limit
    const matchedIds = new Set(matched.map((n) => n.id));
    const ordered = [
      ...matched,
      ...Array.from(expanded.values()).filter((n) => !matchedIds.has(n.id)),
    ];
    return ordered.slice(0, limit);
  }

  function matchNode(node: MemoryNode, kw: string): boolean {
    if (node.title.toLowerCase().includes(kw)) return true;
    if (node.summary.toLowerCase().includes(kw)) return true;
    if (node.details?.toLowerCase().includes(kw)) return true;
    if (node.tags?.some((t) => t.toLowerCase().includes(kw))) return true;
    return false;
  }

  /**
   * 高级检索：按类型 + 关键词 + 标签
   */
  function searchAdvanced(options: {
    keyword?: string;
    type?: MemoryNodeType;
    tags?: string[];
    limit?: number;
  }): MemoryNode[] {
    const { keyword: kw, type, tags, limit = SEARCH_RESULT_LIMIT } = options;
    const k = kw?.trim().toLowerCase();
    const tagSet = tags?.length ? new Set(tags.map((t) => t.toLowerCase())) : null;

    let result = nodes.value.filter((n) => {
      if (type && n.type !== type) return false;
      if (tagSet && !(n.tags ?? []).some((t) => tagSet.has(t.toLowerCase()))) return false;
      if (k && !matchNode(n, k)) return false;
      return true;
    });

    if (result.length > limit) result = result.slice(0, limit);
    return result;
  }

  // ============== 批量操作 ==============

  /** 一次性设置整个图谱（用于备份恢复） */
  function setGraph(graph: MemoryGraph): void {
    nodes.value = Array.isArray(graph.nodes) ? [...graph.nodes] : [];
    links.value = Array.isArray(graph.links) ? [...graph.links] : [];
    save();
    log.info("memory.store", `graph replaced: ${nodes.value.length} nodes`);
  }

  /** 清空全部 */
  function clear(): void {
    nodes.value = [];
    links.value = [];
    save();
    log.info("memory.store", "all memory cleared");
  }

  /** 批量添加节点（去重） */
  function addNodes(list: MemoryNode[]): number {
    const existing = new Set(nodes.value.map((n) => n.id));
    let added = 0;
    for (const n of list) {
      if (existing.has(n.id)) continue;
      nodes.value.push(n);
      existing.add(n.id);
      added++;
    }
    if (added > 0) save();
    return added;
  }

  /** 批量添加关联（去重） */
  function addLinks(list: MemoryLink[]): number {
    const existing = new Set(
      links.value.map((l) => `${l.source}->${l.target}`),
    );
    let added = 0;
    for (const l of list) {
      const key1 = `${l.source}->${l.target}`;
      const key2 = `${l.target}->${l.source}`;
      if (existing.has(key1) || existing.has(key2)) continue;
      links.value.push(l);
      existing.add(key1);
      added++;
    }
    if (added > 0) save();
    return added;
  }

  // ============== 导出 ==============

  /** 导出图谱为 JSON 字符串（用于备份） */
  function exportGraph(): string {
    return JSON.stringify({ nodes: nodes.value, links: links.value }, null, 2);
  }

  /** 从 JSON 字符串导入（覆盖） */
  function importGraph(json: string): boolean {
    try {
      const parsed = JSON.parse(json) as MemoryGraph;
      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.links)) {
        throw new Error("invalid graph format");
      }
      setGraph(parsed);
      return true;
    } catch (e) {
      log.error("memory.store", "import failed", e);
      return false;
    }
  }

  return {
    // 状态
    nodes,
    links,
    graph,
    nodesByType,
    nodeCount,
    linkCount,
    // 持久化
    load,
    save,
    // 节点 CRUD
    addNode,
    createNode,
    updateNode,
    deleteNode,
    getNode,
    // 关联
    addLink,
    removeLink,
    getLinksOf,
    getNeighborIds,
    // 检索
    search,
    searchAdvanced,
    // 批量
    setGraph,
    clear,
    addNodes,
    addLinks,
    // 导入导出
    exportGraph,
    importGraph,
  };
});
