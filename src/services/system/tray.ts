// services/system/tray.ts - 系统托盘服务
// 托盘菜单（显示窗口/新建会话/切换模式/退出） + 未读消息徽章 + 最小化到托盘
// 依赖 Rust 端 tauri.conf.json 中开启 "trayIcon" 配置；运行时通过 @tauri-apps/api/tray 创建托盘

import { TrayIcon } from "@tauri-apps/api/tray";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logger } from "@/services/logger";

const log = logger;

// ========================= 类型与常量 =========================

export type TrayMode = "safe" | "full";

export interface TrayOptions {
  /** 托盘图标 tooltip */
  tooltip?: string;
  /** 初始模式（safe / full） */
  initialMode?: TrayMode;
  /** 自定义图标路径（默认用应用图标） */
  iconPath?: string;
}

export interface TrayEvent {
  type: "show-window" | "new-conversation" | "toggle-mode" | "quit" | "tray-click";
  mode?: TrayMode;
}

export type TrayEventHandler = (event: TrayEvent) => void;

const TRAY_ID = "main-tray";
const TRAY_EVENT = "tray-event";
const MODE_EVENT = "tray-mode-changed";

// ========================= 状态 =========================

let tray: TrayIcon | null = null;
let currentMode: TrayMode = "safe";
let unreadCount = 0;
let unlistenFn: UnlistenFn | null = null;
const handlers = new Set<TrayEventHandler>();

// ========================= 内部：菜单构建 =========================

async function buildMenu(mode: TrayMode): Promise<Menu> {
  const showItem = await MenuItem.new({
    id: "show-window",
    text: "显示窗口",
    accelerator: undefined,
    action: () => emitToHandlers({ type: "show-window" }),
  });

  const newItem = await MenuItem.new({
    id: "new-conversation",
    text: "新建会话",
    accelerator: "CmdOrCtrl+N",
    action: () => emitToHandlers({ type: "new-conversation" }),
  });

  const modeLabel = mode === "safe" ? "切换为完全访问模式" : "切换为安全模式";
  const toggleModeItem = await MenuItem.new({
    id: "toggle-mode",
    text: modeLabel,
    action: () => {
      const next: TrayMode = mode === "safe" ? "full" : "safe";
      currentMode = next;
      emit(MODE_EVENT, next).catch(() => undefined);
      emitToHandlers({ type: "toggle-mode", mode: next });
      // 重建菜单以刷新文本
      rebuildMenu().catch((e) => log.warn("tray", "rebuild menu failed", e));
    },
  });

  const separator1 = await PredefinedMenuItem.new({ item: "Separator" });
  const quitItem = await MenuItem.new({
    id: "quit",
    text: "退出",
    action: () => emitToHandlers({ type: "quit" }),
  });

  return Menu.new({
    items: [showItem, newItem, separator1, toggleModeItem, separator1, quitItem],
  });
}

async function rebuildMenu(): Promise<void> {
  if (!tray) return;
  const menu = await buildMenu(currentMode);
  await tray.setMenu(menu);
  await tray.setTooltip(buildTooltip());
}

function buildTooltip(): string {
  const base = "Desktop Agent";
  const unread = unreadCount > 0 ? `  ·  ${unreadCount} 条未读` : "";
  const modeTag = currentMode === "safe" ? "[安全模式]" : "[完全访问]";
  return `${base} ${modeTag}${unread}`;
}

// ========================= 内部：未读徽章 =========================

/**
 * 通过修改 tooltip 体现未读消息数；
 * 系统级徽章（macOS dock badge / Windows overlay）委托 Rust 端可选实现。
 */
async function refreshBadge(): Promise<void> {
  if (!tray) return;
  await tray.setTooltip(buildTooltip());
  try {
    await setOverlayBadge(unreadCount);
  } catch (e) {
    log.debug("tray", "overlay badge unsupported, skipped", e);
  }
}

async function setOverlayBadge(count: number): Promise<void> {
  // Windows / Linux 上：尝试通过 Rust 设置任务栏覆盖图标
  // 失败时静默忽略（仅 tooltip 体现）
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("tray_set_badge", { count });
}

function emitToHandlers(event: TrayEvent): void {
  for (const h of handlers) {
    try {
      h(event);
    } catch (e) {
      log.warn("tray", "handler error", e);
    }
  }
  // 同时 emit 一个 Tauri 事件，便于非 TS 模块订阅
  emit(TRAY_EVENT, event).catch(() => undefined);
}

// ========================= 公开 API =========================

/**
 * 初始化托盘
 * - 创建托盘图标 + 菜单
 * - 默认点击左键显示窗口
 * - 设置 close-requested 拦截，使关闭按钮最小化到托盘
 */
export async function initTray(options: TrayOptions = {}): Promise<TrayIcon> {
  if (tray) {
    log.warn("tray", "tray already initialized");
    return tray;
  }

  currentMode = options.initialMode ?? "safe";
  unreadCount = 0;

  const menu = await buildMenu(currentMode);
  const tooltip = buildTooltip();

  // 复用已注册的托盘 ID（Rust 端配置的）；action 回调仅能在构造时传入，
  // 故若已存在同 ID 托盘则先移除，再统一 new 一个带 action 的托盘
  try {
    const existing = await TrayIcon.getById(TRAY_ID);
    if (existing) {
      await TrayIcon.removeById(TRAY_ID);
    }
  } catch {
    /* 没有预注册则下面 new 一个 */
  }

  tray = await TrayIcon.new({
    id: TRAY_ID,
    icon: options.iconPath as any,
    tooltip,
    menu,
    // 左键点击：显示窗口
    action: (event) => {
      if (event.type === "Click" && event.button === "Left") {
        emitToHandlers({ type: "tray-click" });
        showWindow().catch((e) => log.warn("tray", "show window failed", e));
      }
    },
  });

  // 拦截窗口关闭按钮 → 最小化到托盘
  setupMinimizeToTray();

  // 监听 Rust 端可能推送的"最小化到托盘"请求
  unlistenFn = await listen<TrayEvent>(TRAY_EVENT, (e) => {
    if (e.payload?.type === "show-window") {
      showWindow().catch(() => undefined);
    }
  });

  log.info("tray", "tray initialized");
  return tray;
}

/** 显示并聚焦主窗口 */
export async function showWindow(): Promise<void> {
  const win = getCurrentWindow();
  await win.show();
  await win.unminimize();
  try {
    await win.setFocus();
  } catch {
    /* 部分平台不支持 setFocus */
  }
}

/** 隐藏到托盘（不退出） */
export async function hideToTray(): Promise<void> {
  const win = getCurrentWindow();
  await win.hide();
}

/** 设置未读消息徽章数 */
export async function setUnreadCount(count: number): Promise<void> {
  unreadCount = Math.max(0, count | 0);
  await refreshBadge();
}

/** 增量调整未读数 */
export async function incrementUnread(delta: number): Promise<void> {
  unreadCount = Math.max(0, unreadCount + delta);
  await refreshBadge();
}

/** 获取当前模式 */
export function getMode(): TrayMode {
  return currentMode;
}

/** 订阅托盘事件 */
export function onTrayEvent(handler: TrayEventHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** 订阅模式变更事件（便于 settings 同步） */
export async function onModeChanged(handler: (mode: TrayMode) => void): Promise<() => void> {
  const unlisten = await listen<TrayMode>(MODE_EVENT, (e) => {
    if (e.payload) handler(e.payload);
  });
  return unlisten;
}

/** 主动切换模式 */
export async function setMode(mode: TrayMode): Promise<void> {
  if (mode === currentMode) return;
  currentMode = mode;
  await emit(MODE_EVENT, mode);
  emitToHandlers({ type: "toggle-mode", mode });
  await rebuildMenu();
}

/** 销毁托盘（一般只在退出时调用） */
export async function destroyTray(): Promise<void> {
  if (unlistenFn) {
    unlistenFn();
    unlistenFn = null;
  }
  if (tray) {
    try {
      await tray.setMenu(null as any);
    } catch {
      /* noop */
    }
    tray = null;
  }
  handlers.clear();
}

// ========================= 最小化到托盘 =========================

let closeGuardInstalled = false;

function setupMinimizeToTray(): void {
  if (closeGuardInstalled) return;
  closeGuardInstalled = true;

  const win = getCurrentWindow();
  win.onCloseRequested(async (event) => {
    // 拦截关闭 → 最小化到托盘
    event.preventDefault();
    await hideToTray();
    log.debug("tray", "window minimized to tray instead of closing");
  });
}
