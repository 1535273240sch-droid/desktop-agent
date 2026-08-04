<template>
  <div
    class="title-bar glass-panel"
    data-tauri-drag-region
    @dblclick="toggleMaximize"
  >
    <!-- 左侧: 应用名 -->
    <div class="title-left" data-tauri-drag-region>
      <div class="app-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <rect
            x="5"
            y="5"
            width="14"
            height="14"
            rx="4"
            fill="var(--theme-color)"
            fill-opacity="0.18"
            stroke="var(--theme-color)"
            stroke-width="1.4"
          />
          <circle cx="10" cy="11" r="1" fill="var(--theme-color)" />
          <circle cx="14" cy="11" r="1" fill="var(--theme-color)" />
          <path
            d="M9.5 14.5 Q12 16 14.5 14.5"
            fill="none"
            stroke="var(--theme-color)"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
      </div>
      <span class="app-title">Desktop Agent</span>
    </div>

    <!-- 中部占位(可拖拽) -->
    <div class="title-center" data-tauri-drag-region />

    <!-- 右侧: 窗口控制按钮 -->
    <div class="title-controls">
      <button
        class="ctrl-btn"
        type="button"
        title="最小化"
        @click="onMinimize"
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="ctrl-btn"
        type="button"
        :title="isMaximized ? '还原' : '最大化'"
        @click="toggleMaximize"
      >
        <svg v-if="!isMaximized" width="12" height="12" viewBox="0 0 12 12">
          <rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3" />
        </svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12">
          <rect x="2.5" y="1.5" width="7" height="2" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          <rect x="2.5" y="4.5" width="7" height="6" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <button
        class="ctrl-btn ctrl-close"
        type="button"
        title="关闭"
        @click="onClose"
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          <line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";

// Tauri v2 窗口 API (浏览器开发环境降级处理)
type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (cb: () => void) => Promise<() => void>;
};

let appWindow: TauriWindow | null = null;
const isMaximized = ref(false);
let unlisten: (() => void) | null = null;

async function loadTauriWindow() {
  try {
    const mod = await import("@tauri-apps/api/window");
    const win = mod.getCurrentWindow ? mod.getCurrentWindow() : (mod as any).appWindow;
    if (win) appWindow = win as TauriWindow;
  } catch {
    appWindow = null;
  }
}

async function refreshMaximized() {
  if (!appWindow) return;
  try {
    isMaximized.value = await appWindow.isMaximized();
  } catch {
    /* ignore */
  }
}

async function onMinimize() {
  await appWindow?.minimize();
}

async function toggleMaximize() {
  await appWindow?.toggleMaximize();
  await refreshMaximized();
}

async function onClose() {
  await appWindow?.close();
}

onMounted(async () => {
  await loadTauriWindow();
  await refreshMaximized();
  if (appWindow) {
    try {
      unlisten = await appWindow.onResized(refreshMaximized);
    } catch {
      /* ignore */
    }
  }
});

onUnmounted(() => {
  if (unlisten) unlisten();
});
</script>

<style scoped>
.title-bar {
  height: var(--titlebar-height);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 6px 0 14px;
  border-top: none;
  border-left: none;
  border-right: none;
  border-radius: 0;
  position: relative;
  z-index: 100;
}

.title-left {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 100%;
  pointer-events: none;
}

.app-logo {
  display: flex;
  align-items: center;
  justify-content: center;
}

.app-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.4px;
}

.title-center {
  flex: 1;
  height: 100%;
}

.title-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 100%;
}

.ctrl-btn {
  width: 34px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.18s var(--ease-ios), color 0.18s var(--ease-ios);
  -webkit-app-region: no-drag;
}

.ctrl-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.ctrl-btn:active {
  background: var(--theme-color);
  color: #fff;
  opacity: 0.85;
}

.ctrl-close:hover {
  background: #e81123;
  color: #fff;
}

.ctrl-close:active {
  background: #c50f1f;
}
</style>
