<template>
  <aside class="memory-panel glass-panel" :class="{ 'filter-open': filtersOpen }">
    <!-- 顶部：标题 + 搜索 + 折叠 -->
    <header class="panel-header">
      <div class="title-row">
        <h2 class="panel-title">记忆图谱</h2>
        <div class="header-actions">
          <button
            class="icon-btn"
            :class="{ active: filtersOpen }"
            title="筛选"
            @click="filtersOpen = !filtersOpen"
          >
            <span class="i-filter" />
          </button>
          <button class="icon-btn" title="收起面板" @click="$emit('collapse')">
            <span class="i-collapse" />
          </button>
        </div>
      </div>
      <div class="search-row">
        <span class="search-icon">⌕</span>
        <input
          v-model="searchQuery"
          class="search-input"
          placeholder="搜索节点…"
          @input="onSearchInput"
        />
        <button v-if="searchQuery" class="search-clear" @click="clearSearch">×</button>
      </div>
      <transition name="drop">
        <ul v-if="showResults && searchResults.length" class="search-dropdown glass-panel">
          <li
            v-for="n in searchResults"
            :key="n.id"
            class="search-item"
            @mousedown.prevent="onSelectResult(n.id)"
          >
            <span class="dot" :style="{ background: typeColor(n.type) }" />
            <div class="search-item-main">
              <div class="search-item-title">{{ n.title }}</div>
              <div class="search-item-summary">{{ n.summary }}</div>
            </div>
            <span class="search-item-type">{{ typeLabel(n.type) }}</span>
          </li>
        </ul>
      </transition>
    </header>

    <!-- 左侧筛选面板（抽屉） -->
    <transition name="drawer">
      <aside v-if="filtersOpen" class="filter-drawer glass-panel">
        <div class="filter-group">
          <div class="filter-title">类型</div>
          <label v-for="opt in typeOptions" :key="opt.value" class="filter-option">
            <input
              type="checkbox"
              :checked="filters.types.has(opt.value)"
              @change="toggleType(opt.value)"
            />
            <span class="dot" :style="{ background: typeColor(opt.value) }" />
            <span>{{ opt.label }}</span>
          </label>
        </div>

        <div class="filter-group">
          <div class="filter-title">标签</div>
          <div v-if="allTags.length === 0" class="empty">暂无标签</div>
          <label v-for="tag in allTags" :key="tag" class="filter-option">
            <input
              type="checkbox"
              :checked="filters.tags.has(tag)"
              @change="toggleTag(tag)"
            />
            <span>{{ tag }}</span>
          </label>
        </div>

        <div class="filter-group">
          <div class="filter-title">时间</div>
          <label v-for="opt in timeOptions" :key="opt.value" class="filter-option">
            <input
              type="radio"
              name="time-filter"
              :checked="filters.time === opt.value"
              @change="filters.time = opt.value; applyFilters()"
            />
            <span>{{ opt.label }}</span>
          </label>
        </div>

        <button class="reset-btn" @click="resetFilters">重置筛选</button>
      </aside>
    </transition>

    <!-- 中间：Canvas 力导向图 -->
    <div class="canvas-wrap">
      <canvas ref="canvasRef" class="memory-canvas" />
      <div v-if="filteredCount === 0" class="canvas-empty">
        <span>没有匹配的记忆节点</span>
      </div>
      <div v-if="selectedNode" class="node-card glass">
        <div class="node-card-head">
          <span class="dot" :style="{ background: typeColor(selectedNode.type) }" />
          <span class="node-card-title">{{ selectedNode.title }}</span>
          <button class="card-edit" @click="openEditor(selectedNode)">编辑</button>
        </div>
        <p class="node-card-summary">{{ selectedNode.summary }}</p>
        <div class="node-card-tags">
          <span v-for="t in selectedNode.tags" :key="t" class="tag-mini">{{ t }}</span>
        </div>
      </div>
    </div>

    <!-- 底部：导出 -->
    <footer class="panel-footer">
      <span class="count-text">{{ filteredCount }} / {{ nodes.length }} 节点</span>
      <div class="footer-actions">
        <button class="footer-btn" @click="exportJSON">导出 JSON</button>
        <button class="footer-btn" @click="exportPNG">导出 PNG</button>
      </div>
    </footer>

    <!-- 节点编辑器 -->
    <MemoryNodeEditor
      :visible="editorVisible"
      :node="editingNode"
      :all-nodes="nodes"
      :links="links"
      @close="editorVisible = false"
      @save="onEditorSave"
      @delete="onEditorDelete"
      @add-link="onEditorAddLink"
      @remove-link="onEditorRemoveLink"
    />
  </aside>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import type { MemoryNode, MemoryLink, MemoryNodeType } from "@/types";
import { MemoryGraphEngine, MEMORY_TYPE_LABEL } from "./MemoryGraph";
import MemoryNodeEditor from "./MemoryNodeEditor.vue";

defineEmits<{ (e: "collapse"): void }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
let engine: MemoryGraphEngine | null = null;

const nodes = ref<MemoryNode[]>([]);
const links = ref<MemoryLink[]>([]);

const filtersOpen = ref(false);
const searchQuery = ref("");
const showResults = ref(false);
const searchResults = ref<MemoryNode[]>([]);
const selectedNode = ref<MemoryNode | null>(null);

const editorVisible = ref(false);
const editingNode = ref<MemoryNode | null>(null);

interface Filters {
  types: Set<MemoryNodeType>;
  tags: Set<string>;
  time: "all" | "today" | "week" | "month";
}
const filters = reactive<Filters>({
  types: new Set<MemoryNodeType>(["user-info", "knowledge", "task-record"]),
  tags: new Set<string>(),
  time: "all",
});

const typeOptions: { value: MemoryNodeType; label: string }[] = [
  { value: "user-info", label: "用户信息" },
  { value: "knowledge", label: "知识点" },
  { value: "task-record", label: "任务记录" },
];

const timeOptions: { value: Filters["time"]; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "today", label: "今天" },
  { value: "week", label: "近一周" },
  { value: "month", label: "近一月" },
];

const allTags = computed(() => {
  const s = new Set<string>();
  for (const n of nodes.value) for (const t of n.tags) s.add(t);
  return Array.from(s).sort();
});

function typeColor(t: MemoryNodeType): string {
  const map: Record<MemoryNodeType, string> = {
    "user-info": "var(--memory-user-info)",
    knowledge: "var(--memory-knowledge)",
    "task-record": "var(--memory-task-record)",
  };
  return map[t];
}
function typeLabel(t: MemoryNodeType): string {
  return MEMORY_TYPE_LABEL[t];
}

// ========== 筛选 ==========
function inTimeRange(ts: number): boolean {
  if (filters.time === "all") return true;
  const now = Date.now();
  if (filters.time === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return ts >= start.getTime();
  }
  const days = filters.time === "week" ? 7 : 30;
  return ts >= now - days * 24 * 3600 * 1000;
}

const filteredNodes = computed(() => {
  return nodes.value.filter((n) => {
    if (!filters.types.has(n.type)) return false;
    if (!inTimeRange(n.createdAt)) return false;
    if (filters.tags.size > 0) {
      const has = n.tags.some((t) => filters.tags.has(t));
      if (!has) return false;
    }
    return true;
  });
});

const filteredLinks = computed(() => {
  const ids = new Set(filteredNodes.value.map((n) => n.id));
  return links.value.filter((l) => ids.has(l.source) && ids.has(l.target));
});

const filteredCount = computed(() => filteredNodes.value.length);

function syncToEngine() {
  engine?.setData(filteredNodes.value, filteredLinks.value);
}

function applyFilters() {
  syncToEngine();
}

function toggleType(t: MemoryNodeType) {
  if (filters.types.has(t)) filters.types.delete(t);
  else filters.types.add(t);
  filters.types = new Set(filters.types); // 触发响应式
  applyFilters();
}

function toggleTag(t: string) {
  if (filters.tags.has(t)) filters.tags.delete(t);
  else filters.tags.add(t);
  filters.tags = new Set(filters.tags);
  applyFilters();
}

function resetFilters() {
  filters.types = new Set<MemoryNodeType>(["user-info", "knowledge", "task-record"]);
  filters.tags = new Set<string>();
  filters.time = "all";
  applyFilters();
}

// ========== 搜索 ==========
function onSearchInput() {
  const q = searchQuery.value.trim();
  if (!q) {
    searchResults.value = [];
    showResults.value = false;
    return;
  }
  searchResults.value = engine ? engine.search(q).slice(0, 8) : [];
  showResults.value = true;
}

function clearSearch() {
  searchQuery.value = "";
  searchResults.value = [];
  showResults.value = false;
  engine?.clearFocus();
}

function onSelectResult(id: string) {
  showResults.value = false;
  engine?.focusNode(id);
  const n = nodes.value.find((x) => x.id === id);
  if (n) selectedNode.value = n;
}

// ========== 编辑器 ==========
function openEditor(node: MemoryNode) {
  editingNode.value = node;
  editorVisible.value = true;
}

function onEditorSave(updated: MemoryNode) {
  const idx = nodes.value.findIndex((n) => n.id === updated.id);
  if (idx !== -1) {
    nodes.value[idx] = { ...updated, x: nodes.value[idx].x, y: nodes.value[idx].y };
    engine?.updateNode(nodes.value[idx]);
    if (selectedNode.value?.id === updated.id) selectedNode.value = nodes.value[idx];
  }
  editorVisible.value = false;
}

function onEditorDelete(id: string) {
  nodes.value = nodes.value.filter((n) => n.id !== id);
  links.value = links.value.filter((l) => l.source !== id && l.target !== id);
  engine?.deleteNode(id);
  if (selectedNode.value?.id === id) selectedNode.value = null;
  editorVisible.value = false;
}

function onEditorAddLink(targetId: string) {
  if (!editingNode.value) return;
  const sourceId = editingNode.value.id;
  const exists = links.value.some(
    (l) =>
      (l.source === sourceId && l.target === targetId) ||
      (l.source === targetId && l.target === sourceId)
  );
  if (exists) return;
  links.value.push({ source: sourceId, target: targetId, strength: 0.5 });
  engine?.addLink({ source: sourceId, target: targetId, strength: 0.5 });
}

function onEditorRemoveLink(targetId: string) {
  if (!editingNode.value) return;
  const sourceId = editingNode.value.id;
  links.value = links.value.filter(
    (l) =>
      !((l.source === sourceId && l.target === targetId) ||
        (l.source === targetId && l.target === sourceId))
  );
  engine?.removeLink(sourceId, targetId);
}

// ========== 导出 ==========
function exportJSON() {
  const json = engine?.exportJSON() ?? "{}";
  const blob = new Blob([json], { type: "application/json" });
  triggerDownload(blob, `memory-${Date.now()}.json`);
}

function exportPNG() {
  const url = engine?.exportPNG();
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = `memory-${Date.now()}.png`;
  a.click();
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ========== 种子数据 ==========
function seedData() {
  const now = Date.now();
  const a: MemoryNode = {
    id: "n1", type: "user-info", title: "用户偏好",
    summary: "用户喜欢深色界面与简洁布局",
    details: "用户多次表达对深色主题的偏好，常用命令行工具。",
    tags: ["偏好", "UI"], createdAt: now, updatedAt: now,
  };
  const b: MemoryNode = {
    id: "n2", type: "knowledge", title: "Vue3 响应式原理",
    summary: "Proxy + 依赖收集",
    details: "Vue3 使用 Proxy 实现响应式，effect 进行依赖收集与触发。",
    tags: ["前端", "Vue"], createdAt: now - 86400000, updatedAt: now - 86400000,
  };
  const c: MemoryNode = {
    id: "n3", type: "task-record", title: "重构记忆模块",
    summary: "将记忆存储迁移到本地 SQLite",
    details: "计划本周完成记忆模块的持久化重构，使用 SQLite 替代 localStorage。",
    tags: ["任务", "重构"], createdAt: now - 3 * 86400000, updatedAt: now - 2 * 86400000,
  };
  const d: MemoryNode = {
    id: "n4", type: "knowledge", title: "d3-force 布局",
    summary: "力导向图算法",
    details: "d3-force 提供电荷力、弹力、向心力等，用于力导向图布局。",
    tags: ["前端", "可视化"], createdAt: now - 5 * 86400000, updatedAt: now - 5 * 86400000,
  };
  nodes.value = [a, b, c, d];
  links.value = [
    { source: "n1", target: "n2", strength: 0.6, label: "相关" },
    { source: "n2", target: "n4", strength: 0.8, label: "用到" },
    { source: "n3", target: "n4", strength: 0.4 },
    { source: "n1", target: "n3", strength: 0.3 },
  ];
}

// ========== 生命周期 ==========
// 筛选变化统一通过 applyFilters() -> syncToEngine() 同步，避免重复触发布局

onMounted(async () => {
  seedData();
  await nextTick();
  if (canvasRef.value) {
    engine = new MemoryGraphEngine({
      canvas: canvasRef.value,
      onNodeEdit: (n) => openEditor(n),
      onNodeSelect: (n) => {
        selectedNode.value = n;
      },
    });
    syncToEngine();
  }
});

onBeforeUnmount(() => {
  engine?.destroy();
  engine = null;
});
</script>

<style scoped>
.memory-panel {
  width: var(--memory-panel-width, 320px);
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 0;
  border-right: 1px solid var(--glass-border);
  border-left: 1px solid var(--glass-border);
  position: relative;
  overflow: hidden;
}

/* 顶部 */
.panel-header {
  padding: 12px 12px 8px;
  border-bottom: 1px solid var(--border-subtle);
  position: relative;
  z-index: 5;
}
.title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.header-actions {
  display: flex;
  gap: 4px;
}
.icon-btn {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: background 0.2s var(--ease-ios);
}
.icon-btn:hover {
  background: var(--bg-hover);
}
.icon-btn.active {
  background: color-mix(in srgb, var(--theme-color) 18%, transparent);
  color: var(--theme-color);
}
.i-filter::before { content: "≣"; font-size: 13px; }
.i-collapse::before { content: "›"; font-size: 16px; transform: rotate(0deg); display: inline-block; }

/* 搜索 */
.search-row {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
}
.search-icon {
  color: var(--text-muted);
  font-size: 13px;
}
.search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-size: 12px;
  color: var(--text-primary);
  font-family: inherit;
}
.search-clear {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 14px;
  padding: 0;
  line-height: 1;
}

.search-dropdown {
  position: absolute;
  top: 100%;
  left: 12px;
  right: 12px;
  margin-top: 4px;
  list-style: none;
  border-radius: var(--radius-md);
  overflow: hidden;
  z-index: 20;
  max-height: 260px;
  overflow-y: auto;
}
.search-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-subtle);
}
.search-item:last-child { border-bottom: none; }
.search-item:hover {
  background: var(--bg-hover);
}
.search-item-main { flex: 1; min-width: 0; }
.search-item-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-item-summary {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-item-type {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-elevated);
  padding: 2px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}

/* 筛选抽屉 */
.filter-drawer {
  position: absolute;
  top: 96px;
  left: 8px;
  width: 168px;
  z-index: 15;
  border-radius: var(--radius-md);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: calc(100% - 160px);
  overflow-y: auto;
}
.filter-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.filter-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 2px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.filter-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  padding: 2px 0;
}
.filter-option input {
  cursor: pointer;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.empty {
  font-size: 11px;
  color: var(--text-muted);
}
.reset-btn {
  margin-top: 4px;
  background: transparent;
  border: 1px solid var(--border-DEFAULT);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  padding: 5px;
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
}
.reset-btn:hover {
  background: var(--bg-hover);
}

/* Canvas 区 */
.canvas-wrap {
  flex: 1;
  position: relative;
  overflow: hidden;
}
.memory-canvas {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
}
.memory-canvas:active {
  cursor: grabbing;
}
.canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 12px;
  pointer-events: none;
}

.node-card {
  position: absolute;
  left: 8px;
  bottom: 8px;
  right: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(12px);
}
.node-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.node-card-title {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-edit {
  background: transparent;
  border: 1px solid var(--border-DEFAULT);
  color: var(--text-secondary);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
}
.card-edit:hover {
  background: var(--bg-hover);
}
.node-card-summary {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
  margin-bottom: 4px;
}
.node-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tag-mini {
  font-size: 10px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  padding: 1px 6px;
  border-radius: 8px;
}

/* 底部 */
.panel-footer {
  padding: 8px 12px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.count-text {
  font-size: 11px;
  color: var(--text-muted);
}
.footer-actions {
  display: flex;
  gap: 6px;
}
.footer-btn {
  background: var(--bg-elevated);
  border: 1px solid var(--border-DEFAULT);
  color: var(--text-secondary);
  font-size: 11px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
  transition: background 0.2s var(--ease-ios);
}
.footer-btn:hover {
  background: var(--bg-hover);
  color: var(--theme-color);
}

/* 过渡 */
.drop-enter-active, .drop-leave-active {
  transition: opacity 0.18s var(--ease-ios), transform 0.18s var(--ease-ios);
}
.drop-enter-from, .drop-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.drawer-enter-active, .drawer-leave-active {
  transition: opacity 0.22s var(--ease-ios), transform 0.22s var(--ease-ios);
}
.drawer-enter-from, .drawer-leave-to {
  opacity: 0;
  transform: translateX(-12px);
}
</style>
