<template>
  <aside class="sidebar glass-panel">
    <!-- 顶部: 新建会话按钮 -->
    <div class="sidebar-top">
      <button class="new-chat-btn" type="button" @click="createNew">
        <svg width="14" height="14" viewBox="0 0 14 14">
          <line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <span>新建会话</span>
      </button>
    </div>

    <!-- 中间: 会话列表 -->
    <div class="conv-list" @scroll.passive="onScroll">
      <div v-if="conversations.length === 0" class="empty-tip">
        暂无会话，点击上方按钮开始
      </div>

      <div
        v-for="conv in conversations"
        :key="conv.id"
        class="conv-item"
        :class="{ active: conv.id === chat.activeConversationId }"
        @click="selectConv(conv.id)"
        @contextmenu.prevent="openMenu($event, conv)"
      >
        <div class="conv-main">
          <div class="conv-title">{{ conv.title || "新对话" }}</div>
          <div class="conv-time">{{ formatTime(conv.updatedAt) }}</div>
        </div>
        <span v-if="conv.pinned" class="pin-mark" title="已置顶">★</span>
      </div>
    </div>

    <!-- 底部: 搜索 + 设置 -->
    <div class="sidebar-bottom">
      <button class="bottom-btn" type="button" @click="openSearch" title="搜索会话 (Ctrl+K)">
        <svg width="14" height="14" viewBox="0 0 14 14">
          <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.4" />
          <line x1="9" y1="9" x2="12" y2="12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <span>搜索</span>
        <kbd class="kbd">Ctrl K</kbd>
      </button>
      <button class="bottom-btn" type="button" @click="openSettings" title="设置 (Ctrl+,)">
        <svg width="14" height="14" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="2.4" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path
            d="M7 1.5v1.8 M7 10.7v1.8 M12.5 7h-1.8 M3.3 7H1.5 M10.6 3.4l-1.3 1.3 M4.7 9.3l-1.3 1.3 M10.6 10.6L9.3 9.3 M4.7 4.7L3.4 3.4"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
        <span>设置</span>
      </button>
    </div>

    <!-- 右键菜单 -->
    <transition name="fade">
      <div
        v-if="menu.visible"
        class="ctx-menu glass-panel"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" type="button" @click="onRename">
          <span class="ctx-icon">✎</span>重命名
        </button>
        <button class="ctx-item" type="button" @click="onExport('markdown')">
          <span class="ctx-icon">⤓</span>导出 Markdown
        </button>
        <button class="ctx-item" type="button" @click="onExport('json')">
          <span class="ctx-icon">⤓</span>导出 JSON
        </button>
        <div class="ctx-divider" />
        <button class="ctx-item ctx-danger" type="button" @click="onDelete">
          <span class="ctx-icon">🗑</span>删除
        </button>
      </div>
    </transition>

    <!-- 重命名对话框 -->
    <div v-if="rename.visible" class="rename-mask" @click.self="rename.visible = false">
      <div class="rename-dialog glass-panel">
        <div class="rename-title">重命名会话</div>
        <input
          ref="renameInputRef"
          v-model="rename.value"
          class="rename-input"
          type="text"
          placeholder="会话标题"
          @keydown.enter="confirmRename"
          @keydown.esc="rename.visible = false"
        />
        <div class="rename-actions">
          <button class="btn-secondary" type="button" @click="rename.visible = false">取消</button>
          <button class="btn-primary" type="button" @click="confirmRename">确定</button>
        </div>
      </div>
    </div>

    <!-- 搜索面板 -->
    <div v-if="search.visible" class="search-mask" @click.self="search.visible = false">
      <div class="search-dialog glass-panel">
        <input
          ref="searchInputRef"
          v-model="search.query"
          class="search-input"
          type="text"
          placeholder="搜索会话标题或内容..."
          @keydown.esc="search.visible = false"
        />
        <div class="search-results">
          <div v-if="searchResults.length === 0 && search.query" class="empty-tip">
            无匹配结果
          </div>
          <div
            v-for="conv in searchResults"
            :key="conv.id"
            class="conv-item"
            @click="selectFromSearch(conv.id)"
          >
            <div class="conv-main">
              <div class="conv-title">{{ conv.title || "新对话" }}</div>
              <div class="conv-time">{{ formatTime(conv.updatedAt) }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from "vue";
import dayjs from "dayjs";
import { useChatStore } from "@/stores/chat";
import type { Conversation } from "@/types";

const chat = useChatStore();

const conversations = computed(() => chat.sortedConversations);
const searchResults = computed(() =>
  search.query.trim() ? chat.searchConversations(search.query.trim()) : []
);

// ===== 会话操作 =====
function createNew() {
  chat.createConversation();
}

function selectConv(id: string) {
  chat.activeConversationId = id;
}

// ===== 右键菜单 =====
const menu = reactive({
  visible: false,
  x: 0,
  y: 0,
  id: "" as string,
});

function openMenu(e: MouseEvent, conv: Conversation) {
  menu.visible = true;
  menu.x = e.clientX;
  menu.y = e.clientY;
  menu.id = conv.id;
  // 防止超出边界
  nextTick(() => {
    // 关闭已选中状态由全局 click 处理
  });
}

function closeMenu() {
  menu.visible = false;
}

// ===== 重命名 =====
const renameInputRef = ref<HTMLInputElement | null>(null);
const rename = reactive({
  visible: false,
  value: "",
  id: "",
});

function onRename() {
  const conv = chat.conversations.find((c) => c.id === menu.id);
  if (!conv) return;
  rename.value = conv.title;
  rename.id = menu.id;
  rename.visible = true;
  menu.visible = false;
  nextTick(() => renameInputRef.value?.focus());
}

function confirmRename() {
  if (rename.value.trim()) {
    chat.renameConversation(rename.id, rename.value.trim());
  }
  rename.visible = false;
}

// ===== 删除 =====
function onDelete() {
  if (menu.id) {
    chat.deleteConversation(menu.id);
  }
  menu.visible = false;
}

// ===== 导出 =====
function onExport(format: "markdown" | "json") {
  const content = chat.exportConversation(menu.id, format);
  if (!content) {
    menu.visible = false;
    return;
  }
  const conv = chat.conversations.find((c) => c.id === menu.id);
  const filename = `${conv?.title || "conversation"}.${format === "markdown" ? "md" : "json"}`;
  const blob = new Blob([content], {
    type: format === "markdown" ? "text/markdown" : "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  menu.visible = false;
}

// ===== 搜索 =====
const searchInputRef = ref<HTMLInputElement | null>(null);
const search = reactive({
  visible: false,
  query: "",
});

function openSearch() {
  search.visible = true;
  search.query = "";
  nextTick(() => searchInputRef.value?.focus());
}

function selectFromSearch(id: string) {
  chat.activeConversationId = id;
  search.visible = false;
}

// ===== 工具 =====
function formatTime(ts: number): string {
  const d = dayjs(ts);
  const now = dayjs();
  if (d.isSame(now, "day")) return d.format("HH:mm");
  if (d.isSame(now.subtract(1, "day"), "day")) return "昨天";
  if (d.isSame(now, "year")) return d.format("M月D日");
  return d.format("YYYY-MM-DD");
}

function openSettings() {
  window.dispatchEvent(new CustomEvent("toggle-settings"));
}

function onScroll() {
  /* 占位, 可用于懒加载 */
}

// ===== 全局事件 =====
function onGlobalClick() {
  closeMenu();
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openSearch();
  }
}

onMounted(() => {
  window.addEventListener("click", onGlobalClick);
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  window.removeEventListener("click", onGlobalClick);
  window.removeEventListener("keydown", onKeydown);
});
</script>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-radius: 0;
  border-top: none;
  border-left: none;
  border-bottom: none;
  overflow: hidden;
}

/* 顶部 */
.sidebar-top {
  padding: 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.new-chat-btn {
  width: 100%;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--theme-color);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.18s var(--ease-ios), transform 0.12s var(--ease-ios);
}

.new-chat-btn:hover {
  background: var(--theme-accent-hover, var(--theme-color));
}

.new-chat-btn:active {
  transform: scale(0.97);
}

/* 会话列表 */
.conv-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
}

.empty-tip {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.conv-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin: 2px 0;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.15s var(--ease-ios);
  position: relative;
}

.conv-item:hover {
  background: var(--bg-hover);
}

.conv-item.active {
  background: var(--bg-elevated);
  box-shadow: inset 0 0 0 1px var(--border-hover);
}

.conv-main {
  flex: 1;
  min-width: 0;
}

.conv-title {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv-time {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.pin-mark {
  color: var(--theme-color);
  font-size: 11px;
  flex-shrink: 0;
}

/* 底部 */
.sidebar-bottom {
  border-top: 1px solid var(--border-subtle);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bottom-btn {
  width: 100%;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s var(--ease-ios), color 0.15s var(--ease-ios);
}

.bottom-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.bottom-btn .kbd {
  margin-left: auto;
  padding: 1px 6px;
  border: 1px solid var(--border-DEFAULT);
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-input);
}

/* 右键菜单 */
.ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  padding: 4px;
  border-radius: var(--radius-md);
  animation: ctx-in 0.12s var(--ease-ios);
}

@keyframes ctx-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.ctx-item {
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s var(--ease-ios);
}

.ctx-item:hover {
  background: var(--bg-hover);
}

.ctx-icon {
  width: 14px;
  text-align: center;
  color: var(--text-muted);
}

.ctx-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 0;
}

.ctx-danger {
  color: #e81123;
}

.ctx-danger .ctx-icon {
  color: #e81123;
}

/* 重命名对话框 */
.rename-mask,
.search-mask {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(4px);
}

.rename-dialog {
  width: 340px;
  padding: 18px;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.rename-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.rename-input {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.rename-input:focus {
  border-color: var(--theme-color);
}

.rename-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn-secondary,
.btn-primary {
  height: 30px;
  padding: 0 14px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s var(--ease-ios);
}

.btn-secondary {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.btn-secondary:hover {
  background: var(--bg-elevated);
}

.btn-primary {
  background: var(--theme-color);
  color: #fff;
}

.btn-primary:hover {
  background: var(--theme-accent-hover, var(--theme-color));
}

/* 搜索面板 */
.search-dialog {
  width: 480px;
  max-height: 60vh;
  padding: 14px;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.search-input {
  width: 100%;
  height: 38px;
  padding: 0 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.search-input:focus {
  border-color: var(--theme-color);
}

.search-results {
  flex: 1;
  overflow-y: auto;
  padding: 2px;
}

/* 过渡 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s var(--ease-ios);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
