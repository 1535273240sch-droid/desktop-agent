// services/system/shortcuts.ts - 快捷键服务
// 全局快捷键（@tauri-apps/plugin-global-shortcut）+ 应用内快捷键（window keydown）
// 可自定义；默认：Ctrl+N(新建) / Ctrl+K(搜索) / Ctrl+,(设置) / Enter(发送)

import { register, unregister, isRegistered } from "@tauri-apps/plugin-global-shortcut";
import { logger } from "@/services/logger";

const log = logger;

// ========================= 类型定义 =========================

export type ShortcutScope = "global" | "app";

export type ShortcutAction =
  | "new-conversation"
  | "search"
  | "settings"
  | "send"
  | "toggle-sidebar"
  | "toggle-voice"
  | "open-memory";

export interface ShortcutDefinition {
  /** 内部 action 标识 */
  action: ShortcutAction;
  /** 默认快捷键 */
  default: string;
  /** 作用域：global 走系统全局，app 仅窗口内有效 */
  scope: ShortcutScope;
  /** 是否启用 */
  enabled: boolean;
}

export type ShortcutHandler = (action: ShortcutAction) => void;

// ========================= 默认快捷键 =========================

const DEFAULT_SHORTCUTS: Record<ShortcutAction, ShortcutDefinition> = {
  "new-conversation": { action: "new-conversation", default: "Ctrl+N", scope: "global", enabled: true },
  "search": { action: "search", default: "Ctrl+K", scope: "app", enabled: true },
  "settings": { action: "settings", default: "Ctrl+,", scope: "app", enabled: true },
  "send": { action: "send", default: "Enter", scope: "app", enabled: true },
  "toggle-sidebar": { action: "toggle-sidebar", default: "Ctrl+B", scope: "app", enabled: true },
  "toggle-voice": { action: "toggle-voice", default: "Ctrl+Shift+V", scope: "app", enabled: true },
  "open-memory": { action: "open-memory", default: "Ctrl+M", scope: "app", enabled: true },
};

// Tauri global-shortcut 使用 CmdOrCtrl 等修饰键；
// 为统一存储，对外仍用 Ctrl/Meta，注册时做转换
function toTauriAccel(combo: string): string {
  return combo.replace(/\bCtrl\b/g, "CommandOrControl").replace(/\bMeta\b/g, "Super");
}

// ========================= 状态 =========================

const STORAGE_KEY = "desktop-agent-shortcuts";

/** 当前生效的快捷键映射（action → 当前 combo） */
let shortcuts: Record<ShortcutAction, ShortcutDefinition> = loadShortcuts();

/** 当前 combo → action 的反查表（仅 app scope 使用） */
let comboToAction: Map<string, ShortcutAction> = new Map();

const handlers = new Set<ShortcutHandler>();
let appKeyListener: ((e: KeyboardEvent) => void) | null = null;
let appKeyInstalled = false;

// ========================= 持久化 =========================

function loadShortcuts(): Record<ShortcutAction, ShortcutDefinition> {
  const merged: Record<ShortcutAction, ShortcutDefinition> = { ...DEFAULT_SHORTCUTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<ShortcutAction, Partial<ShortcutDefinition>>>;
      for (const key of Object.keys(merged) as ShortcutAction[]) {
        const s = saved[key];
        if (s) {
          merged[key] = { ...merged[key], ...s, action: key };
        }
      }
    }
  } catch (e) {
    log.warn("shortcuts", "load shortcuts failed, use defaults", e);
  }
  return merged;
}

function persistShortcuts(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
  } catch (e) {
    log.warn("shortcuts", "persist failed", e);
  }
}

// ========================= Combo 解析与匹配 =========================

/** 将 KeyboardEvent 转成与配置一致的字符串形式 */
function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key;
  // 忽略纯修饰键
  if (["Control", "Meta", "Alt", "Shift"].includes(key)) return "";
  // 规范化键名：Enter / Escape 保留原样，单字母转大写
  let normalized: string;
  if (key === " ") normalized = "Space";
  else if (key.length === 1) normalized = key.toUpperCase();
  else normalized = key;
  parts.push(normalized);
  return parts.join("+");
}

function normalizeCombo(combo: string): string {
  // 去空格、统一分隔
  return combo
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("+");
}

// ========================= 公开 API =========================

/** 初始化快捷键服务：注册所有全局快捷键 + 安装应用内监听 */
export async function initShortcuts(): Promise<void> {
  rebuildComboMap();
  await registerAllGlobal();
  installAppKeyListener();
  log.info("shortcuts", "initialized", { count: Object.keys(shortcuts).length });
}

/** 注册所有 enabled 的 global 快捷键 */
async function registerAllGlobal(): Promise<void> {
  for (const def of Object.values(shortcuts)) {
    if (!def.enabled || def.scope !== "global") continue;
    await registerOne(def);
  }
}

async function registerOne(def: ShortcutDefinition): Promise<void> {
  if (def.scope !== "global") return;
  const accel = toTauriAccel(def.default);
  try {
    if (await isRegistered(accel)) {
      await unregister(accel);
    }
    await register(accel, () => {
      log.debug("shortcuts", `global fired: ${def.action}`);
      dispatch(def.action);
    });
    log.debug("shortcuts", `registered global: ${def.action} = ${accel}`);
  } catch (e) {
    log.warn("shortcuts", `register failed: ${def.action} (${accel})`, e);
  }
}

async function unregisterOne(def: ShortcutDefinition): Promise<void> {
  if (def.scope !== "global") return;
  const accel = toTauriAccel(def.default);
  try {
    if (await isRegistered(accel)) {
      await unregister(accel);
    }
  } catch (e) {
    log.warn("shortcuts", `unregister failed: ${def.action} (${accel})`, e);
  }
}

/** 安装应用内键盘监听（覆盖 app scope 快捷键） */
function installAppKeyListener(): void {
  if (appKeyInstalled) return;
  appKeyInstalled = true;
  appKeyListener = (e: KeyboardEvent) => {
    const combo = eventToCombo(e);
    if (!combo) return;
    const action = comboToAction.get(combo);
    if (!action) return;
    const def = shortcuts[action];
    if (!def?.enabled || def.scope !== "app") return;
    // Enter 默认无修饰键，需要避免与输入框多行（Shift+Enter）冲突
    if (action === "send" && e.shiftKey) return;
    e.preventDefault();
    dispatch(action);
  };
  window.addEventListener("keydown", appKeyListener, true);
}

function rebuildComboMap(): void {
  comboToAction = new Map();
  for (const def of Object.values(shortcuts)) {
    if (!def.enabled || def.scope !== "app") continue;
    comboToAction.set(normalizeCombo(def.default), def.action);
  }
}

function dispatch(action: ShortcutAction): void {
  for (const h of handlers) {
    try {
      h(action);
    } catch (e) {
      log.warn("shortcuts", "handler error", e);
    }
  }
}

// ========================= 订阅 / 自定义 =========================

/** 订阅快捷键 action */
export function onShortcut(handler: ShortcutHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** 获取当前所有快捷键定义 */
export function getShortcuts(): Record<ShortcutAction, ShortcutDefinition> {
  return { ...shortcuts };
}

/** 获取某个 action 的当前 combo */
export function getCombo(action: ShortcutAction): string {
  return shortcuts[action]?.default ?? DEFAULT_SHORTCUTS[action].default;
}

/**
 * 重新绑定某个 action 的快捷键
 * - 先注销旧 combo（global）→ 更新映射 → 注册新 combo（global）→ 重建 combo map
 * - 冲突检测：若新 combo 已被其他 action 占用，返回 false
 */
export async function rebindShortcut(
  action: ShortcutAction,
  combo: string,
  options?: { scope?: ShortcutScope },
): Promise<boolean> {
  const norm = normalizeCombo(combo);
  if (!norm) {
    log.warn("shortcuts", `invalid combo: ${combo}`);
    return false;
  }

  // 冲突检测：是否已被其他 action 占用
  for (const [otherAction, def] of Object.entries(shortcuts) as Array<[ShortcutAction, ShortcutDefinition]>) {
    if (otherAction === action) continue;
    if (normalizeCombo(def.default) === norm) {
      log.warn("shortcuts", `combo ${norm} already used by ${otherAction}`);
      return false;
    }
  }

  const old = shortcuts[action];
  // 注销旧 combo
  await unregisterOne(old);

  // 更新
  shortcuts[action] = {
    ...old,
    default: norm,
    scope: options?.scope ?? old.scope,
  };
  persistShortcuts();

  // 注册新 combo
  await registerOne(shortcuts[action]);
  rebuildComboMap();
  log.info("shortcuts", `rebound ${action} → ${norm} (${shortcuts[action].scope})`);
  return true;
}

/** 启用 / 禁用某个 action 的快捷键 */
export async function setShortcutEnabled(action: ShortcutAction, enabled: boolean): Promise<void> {
  const def = shortcuts[action];
  if (!def) return;
  if (def.enabled === enabled) return;
  if (enabled) {
    def.enabled = true;
    await registerOne(def);
  } else {
    await unregisterOne(def);
    def.enabled = false;
  }
  persistShortcuts();
  rebuildComboMap();
}

/** 重置为默认快捷键 */
export async function resetShortcuts(): Promise<void> {
  // 先注销所有 global
  for (const def of Object.values(shortcuts)) {
    await unregisterOne(def);
  }
  shortcuts = { ...DEFAULT_SHORTCUTS };
  persistShortcuts();
  await registerAllGlobal();
  rebuildComboMap();
  log.info("shortcuts", "reset to defaults");
}

/** 注销全部（应用退出前调用） */
export async function destroyShortcuts(): Promise<void> {
  for (const def of Object.values(shortcuts)) {
    await unregisterOne(def);
  }
  if (appKeyListener) {
    window.removeEventListener("keydown", appKeyListener, true);
    appKeyListener = null;
  }
  appKeyInstalled = false;
  handlers.clear();
}

// ========================= 默认快捷键导出（供 settings store 同步） =========================

export function defaultShortcuts(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [action, def] of Object.entries(DEFAULT_SHORTCUTS) as Array<[ShortcutAction, ShortcutDefinition]>) {
    map[action] = def.default;
  }
  return map;
}
