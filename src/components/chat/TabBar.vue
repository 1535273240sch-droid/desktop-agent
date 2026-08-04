<template>
  <div class="tab-bar glass">
    <div class="tabs-scroll" ref="scrollRef" @wheel.passive="onWheel">
      <transition-group name="tab">
        <div
          v-for="conv in conversations"
          :key="conv.id"
          class="tab-item"
          :class="{ active: conv.id === activeId, pinned: conv.pinned }"
          @click="selectTab(conv.id)"
          @contextmenu.prevent="onContextMenu($event, conv)"
          @mousedown.middle.prevent="onContextMenu($event, conv)"
        >
          <span v-if="conv.pinned" class="pin-icon" title="已置顶">📌</span>
          <span v-if="editingId === conv.id" class="tab-edit">
            <input
              ref="editInputRef"
              v-model="editingTitle"
              class="tab-edit-input"
              @click.stop
              @keyup.enter="commitRename"
              @keyup.esc="cancelRename"
              @blur="commitRename"
            />
          </span>
          <span v-else class="tab-title" :title="conv.title">{{ conv.title }}</span>
          <span
            v-if="conv.id === activeId"
            class="tab-close"
            @click.stop="closeTab(conv.id)"
            title="关闭"
          >✕</span>
        </div>
      </transition-group>
    </div>

    <!-- 新建会话按钮 -->
    <button class="new-tab-btn" @click="newConversation" title="新建对话">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>

    <!-- 右键菜单 -->
    <teleport to="body">
      <transition name="fade">
        <div
          v-if="ctxMenu.visible"
          class="ctx-menu glass-panel"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
          @click.stop
        >
          <button class="ctx-item" @click="startRename">
            <span class="ctx-icon">✏️</span>重命名
          </button>
          <button class="ctx-item" @click="togglePin">
            <span class="ctx-icon">{{ ctxMenu.conv?.pinned ? "📍" : "📌" }}</span>
            {{ ctxMenu.conv?.pinned ? "取消置顶" : "置顶" }}
          </button>
          <div class="ctx-divider" />
          <button class="ctx-item" @click="exportConv('markdown')">
            <span class="ctx-icon">📝</span>导出 Markdown
          </button>
          <button class="ctx-item" @click="exportConv('json')">
            <span class="ctx-icon">{ }</span>导出 JSON
          </button>
          <button class="ctx-item" @click="exportConv('txt')">
            <span class="ctx-icon">📄</span>导出 TXT
          </button>
          <div class="ctx-divider" />
          <button class="ctx-item danger" @click="removeConv">
            <span class="ctx-icon">🗑</span>删除
          </button>
        </div>
      </transition>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useChatStore } from "@/stores/chat";
import type { Conversation } from "@/types";

const chat = useChatStore();

const conversations = computed(() => chat.sortedConversations);
const activeId = computed(() => chat.activeConversationId);

const scrollRef = ref<HTMLElement | null>(null);
const editInputRef = ref<HTMLInputElement | null>(null);

// 滚轮横向滚动
function onWheel(e: WheelEvent) {
  if (scrollRef.value) {
    scrollRef.value.scrollLeft += e.deltaY;
  }
}

function selectTab(id: string) {
  chat.activeConversationId = id;
}

function newConversation() {
  chat.createConversation();
}

function closeTab(id: string) {
  chat.deleteConversation(id);
}

// ========== 重命名 ==========
const editingId = ref<string | null>(null);
const editingTitle = ref("");

function startRename() {
  const conv = ctxMenu.conv;
  if (!conv) return;
  editingId.value = conv.id;
  editingTitle.value = conv.title;
  closeCtxMenu();
  nextTick(() => {
    editInputRef.value?.focus();
    editInputRef.value?.select();
  });
}

function commitRename() {
  if (editingId.value) {
    const title = editingTitle.value.trim() || "未命名对话";
    chat.renameConversation(editingId.value, title);
    editingId.value = null;
  }
}

function cancelRename() {
  editingId.value = null;
}

// ========== 置顶 ==========
function togglePin() {
  const conv = ctxMenu.conv;
  if (conv) {
    conv.pinned = !conv.pinned;
    chat.save();
  }
  closeCtxMenu();
}

// ========== 导出 ==========
function exportConv(format: "markdown" | "json" | "txt") {
  const conv = ctxMenu.conv;
  if (!conv) return;
  const content = chat.exportConversation(conv.id, format);
  const ext = format === "markdown" ? "md" : format;
  const mime = format === "json" ? "application/json" : format === "markdown" ? "text/markdown" : "text/plain";
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${conv.title.replace(/[\\/:*?"<>|]/g, "_")}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
  closeCtxMenu();
}

// ========== 删除 ==========
function removeConv() {
  const conv = ctxMenu.conv;
  if (conv) {
    chat.deleteConversation(conv.id);
  }
  closeCtxMenu();
}

// ========== 右键菜单 ==========
const ctxMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  conv: null as Conversation | null,
});

function onContextMenu(e: MouseEvent, conv: Conversation) {
  ctxMenu.conv = conv;
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.visible = true;
}

function closeCtxMenu() {
  ctxMenu.visible = false;
  ctxMenu.conv = null;
}

function onDocClick() {
  if (ctxMenu.visible) closeCtxMenu();
}

// 活动会话变化时滚动到可见
watch(activeId, (id) => {
  if (!id) return;
  nextTick(() => {
    const el = scrollRef.value?.querySelector(`[class*="active"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
});

onMounted(() => {
  document.addEventListener("click", onDocClick);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
});
</script>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
  min-height: 40px;
}

.tabs-scroll {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.tabs-scroll::-webkit-scrollbar {
  display: none;
}

.tab-item {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 180px;
  padding: 5px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  transition: all 0.18s var(--ease-ios);
  user-select: none;
}

.tab-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tab-item.active {
  background: var(--glass-bg-strong);
  color: var(--theme-color);
  border-color: var(--border-DEFAULT);
  box-shadow: 0 2px 8px var(--glow-color);
}

.pin-icon {
  font-size: 10px;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.tab-edit {
  display: inline-flex;
}

.tab-edit-input {
  width: 120px;
  background: var(--bg-input);
  border: 1px solid var(--theme-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 13px;
  padding: 1px 4px;
  outline: none;
  font-family: inherit;
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0;
  transition: all 0.15s;
}

.tab-item:hover .tab-close,
.tab-item.active .tab-close {
  opacity: 0.8;
}

.tab-close:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  opacity: 1;
}

.new-tab-btn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--glass-bg);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.18s var(--ease-ios);
}

.new-tab-btn:hover {
  background: var(--theme-color);
  color: #fff;
  border-color: var(--theme-color);
  transform: scale(1.05);
}

/* 右键菜单 */
.ctx-menu {
  position: fixed;
  z-index: 10000;
  min-width: 160px;
  padding: 4px;
  border-radius: var(--radius-md);
  box-shadow: var(--glass-shadow);
}

.ctx-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  text-align: left;
  transition: background 0.12s;
  white-space: nowrap;
}
.ctx-item:hover {
  background: var(--bg-hover);
}
.ctx-item.danger {
  color: #ef4444;
}
.ctx-item.danger:hover {
  background: rgba(239, 68, 68, 0.1);
}
.ctx-icon {
  font-size: 12px;
  width: 16px;
  text-align: center;
}
.ctx-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 0;
}

/* 过渡 */
.tab-enter-active,
.tab-leave-active {
  transition: all 0.25s var(--ease-ios);
}
.tab-enter-from {
  opacity: 0;
  transform: translateX(-10px) scale(0.9);
}
.tab-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
.tab-leave-active {
  position: absolute;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s var(--ease-ios);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
