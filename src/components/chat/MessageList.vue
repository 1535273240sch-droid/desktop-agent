<template>
  <div class="message-list-wrap">
   <div class="message-list" @scroll.passive="onScroll" ref="scrollRef">
    <!-- 空列表占位 -->
    <div v-if="flatItems.length === 0" class="list-empty">
      <slot name="empty" />
    </div>

    <!-- 普通模式（<= 100 条）：直接渲染 -->
    <div v-else-if="!useVirtual" class="list-inner">
      <template v-for="item in flatItems" :key="item.key">
        <div v-if="item.type === 'date'" class="date-separator">
          <span class="date-label">{{ item.dateLabel }}</span>
        </div>
        <div v-else class="message-row" :class="`role-${item.message!.role}`" @contextmenu.prevent="onContextMenu($event, item.message!)">
          <MessageBubble
            :message="item.message!"
            :sub-agent="getSubAgent(item.message!.subAgentId)"
            @retry="$emit('retry', $event)"
          />
          <span class="hover-time">{{ formatHoverTime(item.message!.timestamp) }}</span>
        </div>
      </template>
    </div>

    <!-- 虚拟滚动模式（> 100 条）-->
    <div v-else class="virtual-inner" :style="{ height: totalHeight + 'px', position: 'relative' }">
      <div
        v-for="item in visibleItems"
        :key="item.key"
        :ref="(el) => setItemRef(item.key, el as HTMLElement)"
        class="virtual-item"
        :style="{ position: 'absolute', top: item.top + 'px', left: 0, right: 0 }"
      >
        <div v-if="item.type === 'date'" class="date-separator">
          <span class="date-label">{{ item.dateLabel }}</span>
        </div>
        <div v-else class="message-row" :class="`role-${item.message!.role}`" @contextmenu.prevent="onContextMenu($event, item.message!)">
          <MessageBubble
            :message="item.message!"
            :sub-agent="getSubAgent(item.message!.subAgentId)"
            @retry="$emit('retry', $event)"
          />
          <span class="hover-time">{{ formatHoverTime(item.message!.timestamp) }}</span>
        </div>
      </div>
    </div>
   </div><!-- /.message-list -->

    <!-- 回到底部按钮 -->
    <transition name="fade">
      <button v-if="showScrollBottom" class="scroll-bottom-btn" @click="scrollToBottom()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span v-if="unreadCount > 0" class="unread-badge">{{ unreadCount }}</span>
      </button>
    </transition>

    <!-- 右键菜单 -->
    <teleport to="body">
      <transition name="fade">
        <div
          v-if="ctxMenu.visible"
          class="ctx-menu glass-panel"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
          @click.stop
        >
          <button class="ctx-item" @click="onCopy">
            <span class="ctx-icon">📋</span>复制
          </button>
          <button
            v-if="ctxMenu.message?.role === 'user'"
            class="ctx-item"
            @click="onEditResend"
          >
            <span class="ctx-icon">✏️</span>编辑重发
          </button>
          <div class="ctx-divider" />
          <button class="ctx-item danger" @click="onDelete">
            <span class="ctx-icon">🗑</span>删除
          </button>
        </div>
      </transition>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import type { Message, SubAgent } from "@/types";
import MessageBubble from "./MessageBubble.vue";

const props = defineProps<{
  messages: Message[];
  subAgents?: SubAgent[];
}>();

const emit = defineEmits<{
  (e: "retry", messageId: string): void;
  (e: "edit", message: Message): void;
  (e: "delete", messageId: string): void;
}>();

dayjs.locale("zh-cn");

// ========== 扁平化列表（含日期分组）==========
interface FlatItem {
  type: "date" | "message";
  key: string;
  message?: Message;
  dateLabel?: string;
}

function dateLabel(ts: number): string {
  const d = dayjs(ts);
  const now = dayjs();
  if (d.isSame(now, "day")) return "今天";
  if (d.isSame(now.subtract(1, "day"), "day")) return "昨天";
  if (d.isSame(now, "year")) return d.format("M月D日");
  return d.format("YYYY年M月D日");
}

const flatItems = computed<FlatItem[]>(() => {
  const items: FlatItem[] = [];
  let lastDate = "";
  for (const msg of props.messages) {
    const label = dateLabel(msg.timestamp);
    if (label !== lastDate) {
      items.push({ type: "date", key: `date-${label}-${msg.timestamp}`, dateLabel: label });
      lastDate = label;
    }
    items.push({ type: "message", key: msg.id, message: msg });
  }
  return items;
});

const useVirtual = computed(() => flatItems.value.length > 100);

function getSubAgent(subAgentId?: string): SubAgent | undefined {
  if (!subAgentId) return undefined;
  return props.subAgents?.find((s) => s.id === subAgentId);
}

// ========== 滚动状态 ==========
const scrollRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
const showScrollBottom = ref(false);
const unreadCount = ref(0);
const atBottom = ref(true);

let resizeObserver: ResizeObserver | null = null;

function onScroll() {
  const el = scrollRef.value;
  if (!el) return;
  scrollTop.value = el.scrollTop;
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  atBottom.value = distFromBottom < 80;
  showScrollBottom.value = distFromBottom > 200;
  if (atBottom.value) unreadCount.value = 0;
}

function scrollToBottom(smooth = true) {
  const el = scrollRef.value;
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  atBottom.value = true;
  showScrollBottom.value = false;
  unreadCount.value = 0;
}

// 新消息到来时自动滚动
watch(
  () => props.messages.length,
  () => {
    if (atBottom.value) {
      nextTick(() => scrollToBottom(false));
    } else {
      unreadCount.value++;
    }
  }
);

// 流式内容更新时跟随
watch(
  () => {
    const arr = props.messages;
    return arr.length ? arr[arr.length - 1].content : "";
  },
  () => {
    if (atBottom.value) {
      nextTick(() => {
        const el = scrollRef.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }
);

// ========== 虚拟滚动 ==========
const heightCache = new Map<string, number>();
const itemRefs = new Map<string, HTMLElement>();
const itemResizeObservers = new Map<string, ResizeObserver>();

function estimateHeight(item: FlatItem): number {
  if (item.type === "date") return 40;
  const msg = item.message!;
  let h = 60;
  if (msg.content) h += Math.ceil(msg.content.length / 50) * 22;
  if (msg.thinking?.length) h += 40;
  if (msg.toolCalls?.length) h += msg.toolCalls.length * 70;
  if (msg.images?.length) h += 210;
  return Math.min(h, 1200);
}

const layout = computed(() => {
  const offsets: number[] = [];
  const heights: number[] = [];
  let acc = 0;
  for (const item of flatItems.value) {
    const h = heightCache.get(item.key) ?? estimateHeight(item);
    heights.push(h);
    offsets.push(acc);
    acc += h;
  }
  return { offsets, heights, total: acc };
});

const visibleItems = computed(() => {
  if (!useVirtual.value) return [];
  const { offsets } = layout.value;
  const top = scrollTop.value - 200;
  const bottom = scrollTop.value + viewportHeight.value + 200;
  const result: (FlatItem & { top: number })[] = [];
  for (let i = 0; i < flatItems.value.length; i++) {
    const off = offsets[i];
    const h = layout.value.heights[i];
    if (off + h < top) continue;
    if (off > bottom) break;
    result.push({ ...flatItems.value[i], top: off });
  }
  return result;
});

const totalHeight = computed(() => layout.value.total);

function setItemRef(key: string, el: HTMLElement | null) {
  if (!el) {
    const ob = itemResizeObservers.get(key);
    if (ob) {
      ob.disconnect();
      itemResizeObservers.delete(key);
    }
    itemRefs.delete(key);
    return;
  }
  itemRefs.set(key, el);
  measureItem(key, el);
  if (!itemResizeObservers.has(key)) {
    const ob = new ResizeObserver(() => measureItem(key, el));
    ob.observe(el);
    itemResizeObservers.set(key, ob);
  }
}

function measureItem(key: string, el: HTMLElement) {
  const h = el.offsetHeight;
  if (h > 0 && heightCache.get(key) !== h) {
    heightCache.set(key, h);
  }
}

// ========== 右键菜单 ==========
const ctxMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  message: null as Message | null,
});

function onContextMenu(e: MouseEvent, message: Message) {
  ctxMenu.message = message;
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.visible = true;
}

function closeCtxMenu() {
  ctxMenu.visible = false;
  ctxMenu.message = null;
}

function onCopy() {
  const msg = ctxMenu.message;
  if (msg) {
    navigator.clipboard.writeText(msg.content).catch(() => {});
  }
  closeCtxMenu();
}

function onEditResend() {
  const msg = ctxMenu.message;
  if (msg) {
    emit("edit", msg);
  }
  closeCtxMenu();
}

function onDelete() {
  const msg = ctxMenu.message;
  if (msg) {
    emit("delete", msg.id);
  }
  closeCtxMenu();
}

function onDocClick() {
  if (ctxMenu.visible) closeCtxMenu();
}

// ========== 时间格式 ==========
function formatHoverTime(ts: number): string {
  return dayjs(ts).format("HH:mm");
}

// ========== 生命周期 ==========
onMounted(() => {
  const el = scrollRef.value;
  if (el) {
    viewportHeight.value = el.clientHeight;
    resizeObserver = new ResizeObserver(() => {
      viewportHeight.value = el.clientHeight;
    });
    resizeObserver.observe(el);
  }
  document.addEventListener("click", onDocClick);
  document.addEventListener("contextmenu", onDocClick);
  nextTick(() => scrollToBottom(false));
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  itemResizeObservers.forEach((ob) => ob.disconnect());
  itemResizeObservers.clear();
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("contextmenu", onDocClick);
});

defineExpose({ scrollToBottom });
</script>

<style scoped>
.message-list-wrap {
  flex: 1;
  position: relative;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 20px;
  position: relative;
  scroll-behavior: auto;
}

.list-inner {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.virtual-inner {
  width: 100%;
}

.virtual-item {
  width: 100%;
}

.list-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 日期分隔线 */
.date-separator {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 8px 0;
  height: 32px;
}
.date-label {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--glass-bg);
  padding: 2px 12px;
  border-radius: var(--radius-lg);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

/* 消息行 */
.message-row {
  display: flex;
  flex-direction: column;
  position: relative;
  padding: 2px 0;
}

.message-row.role-user {
  align-items: flex-end;
}
.message-row.role-assistant,
.message-row.role-tool,
.message-row.role-system {
  align-items: flex-start;
}

.hover-time {
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 0.15s;
  margin-top: 2px;
  pointer-events: none;
}

.message-row:hover .hover-time {
  opacity: 0.8;
}

.message-row.role-user .hover-time {
  align-self: flex-end;
}

/* 回到底部按钮 */
.scroll-bottom-btn {
  position: absolute;
  bottom: 20px;
  right: 24px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--theme-color);
  box-shadow: var(--glass-shadow);
  transition: transform 0.2s var(--ease-ios);
  z-index: 10;
}
.scroll-bottom-btn:hover {
  transform: translateY(-2px);
}
.unread-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--theme-color);
  color: #fff;
  font-size: 10px;
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

/* 右键菜单 */
.ctx-menu {
  position: fixed;
  z-index: 10000;
  min-width: 140px;
  padding: 4px;
  border-radius: var(--radius-md);
  box-shadow: var(--glass-shadow);
}

.ctx-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  text-align: left;
  transition: background 0.12s;
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
  font-size: 13px;
  width: 16px;
  text-align: center;
}
.ctx-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 0;
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
