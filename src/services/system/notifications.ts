// services/system/notifications.ts - 系统通知服务
// 任务每步完成通知 + 子 Agent 完成通知 + 点击通知唤起窗口 + 跳转相关会话
// 走 @tauri-apps/plugin-notification；点击事件通过自定义 eventType 路由

import {
  sendNotification,
  requestPermission,
  isPermissionGranted,
  type Options,
} from "@tauri-apps/plugin-notification";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logger } from "@/services/logger";
import { showWindow } from "@/services/system/tray";

const log = logger;

// ========================= 类型与常量 =========================

export type NotificationKind =
  | "task-step"
  | "sub-agent"
  | "tool-error"
  | "system";

export interface NotificationPayload {
  kind: NotificationKind;
  title: string;
  body?: string;
  /** 跳转目标会话 ID */
  conversationId?: string;
  /** 跳转目标子 Agent ID */
  subAgentId?: string;
  /** 任务步骤 ID */
  stepId?: string;
}

export type NotificationClickHandler = (payload: NotificationPayload) => void;

/** 点击通知时由 Rust 端发出的事件名 */
const NOTIFICATION_CLICK_EVENT = "notification-clicked";
/** 内部事件：唤起窗口 + 跳转 */
const NOTIFICATION_NAVIGATE_EVENT = "notification-navigate";

// ========================= 状态 =========================

let permissionGranted: boolean | null = null;
let clickUnlisten: UnlistenFn | null = null;
const handlers = new Set<NotificationClickHandler>();

// ========================= 权限 =========================

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted !== null) return permissionGranted;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    permissionGranted = granted;
    if (!granted) {
      log.warn("notifications", "notification permission not granted");
    }
    return granted;
  } catch (e) {
    log.warn("notifications", "permission check failed", e);
    permissionGranted = false;
    return false;
  }
}

// ========================= 内部：发送 =========================

/**
 * 发送系统通知
 * - 通过 eventType 携带 payload，使 Rust 端在用户点击时能回传完整数据
 * - payload 同时写入 data 字段便于调试
 */
async function notifyRaw(payload: NotificationPayload): Promise<void> {
  const granted = await ensurePermission();
  if (!granted) {
    // 降级：仅记录到日志
    log.info("notifications", `[fallback] ${payload.title}: ${payload.body ?? ""}`);
    return;
  }

  const options: Options & { eventType?: string; data?: unknown } = {
    title: payload.title,
    body: payload.body,
    // 通知点击事件类型（Rust 端据此回推 NOTIFICATION_CLICK_EVENT）
    eventType: NOTIFICATION_CLICK_EVENT,
    data: payload,
  };

  try {
    await sendNotification(options);
    log.debug("notifications", "sent", { kind: payload.kind, title: payload.title });
  } catch (e) {
    log.warn("notifications", "send failed, fallback to log", e);
  }
}

// ========================= 内部：点击处理 =========================

async function installClickListener(): Promise<void> {
  if (clickUnlisten) return;
  clickUnlisten = await listen<NotificationPayload>(NOTIFICATION_CLICK_EVENT, async (e) => {
    const payload = e.payload;
    if (!payload) return;
    log.debug("notifications", "clicked", { kind: payload.kind, conversationId: payload.conversationId });

    // 1. 唤起窗口
    await showWindow().catch(() => undefined);
    // 也尝试直接调用 window API，避免 tray 未初始化时无效
    try {
      const win = getCurrentWindow();
      await win.show();
      await win.unminimize();
      await win.setFocus();
    } catch {
      /* noop */
    }

    // 2. 内部分发跳转事件（让 UI 层订阅后切到对应会话）
    await emit(NOTIFICATION_NAVIGATE_EVENT, payload).catch(() => undefined);

    // 3. 通知所有注册的 handler
    for (const h of handlers) {
      try {
        h(payload);
      } catch (err) {
        log.warn("notifications", "click handler error", err);
      }
    }
  });
}

// ========================= 公开 API =========================

/** 启动时调用：申请权限 + 安装点击监听 */
export async function initNotifications(): Promise<void> {
  await ensurePermission();
  await installClickListener();
  log.info("notifications", "initialized");
}

/**
 * 任务步骤完成通知
 * @param conversationId 所属会话
 * @param stepIndex 步骤序号（1-based）
 * @param stepTotal 总步骤数
 * @param description 步骤描述
 */
export async function notifyTaskStep(
  conversationId: string,
  stepIndex: number,
  stepTotal: number,
  description: string,
  stepId?: string,
): Promise<void> {
  await notifyRaw({
    kind: "task-step",
    title: `任务步骤 ${stepIndex}/${stepTotal} 已完成`,
    body: truncate(description, 120),
    conversationId,
    stepId,
  });
}

/**
 * 子 Agent 完成通知
 * @param parentConversationId 父会话 ID
 * @param subAgentId 子 Agent ID
 * @param name 子 Agent 名称
 * @param summary 结果摘要
 */
export async function notifySubAgentCompleted(
  parentConversationId: string,
  subAgentId: string,
  name: string,
  summary: string,
): Promise<void> {
  await notifyRaw({
    kind: "sub-agent",
    title: `子 Agent「${name}」已完成`,
    body: truncate(summary, 120),
    conversationId: parentConversationId,
    subAgentId,
  });
}

/** 工具执行失败通知 */
export async function notifyToolError(
  conversationId: string,
  toolName: string,
  error: string,
): Promise<void> {
  await notifyRaw({
    kind: "tool-error",
    title: `工具 ${toolName} 执行失败`,
    body: truncate(error, 200),
    conversationId,
  });
}

/** 系统通知 */
export async function notifySystem(title: string, body?: string): Promise<void> {
  await notifyRaw({ kind: "system", title, body });
}

/**
 * 通用发送入口
 * - 用于自定义场景
 */
export async function notify(payload: NotificationPayload): Promise<void> {
  await notifyRaw(payload);
}

// ========================= 订阅 =========================

/** 订阅通知点击事件（在 UI 层接管跳转） */
export function onNotificationClick(handler: NotificationClickHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * 订阅"通知跳转"事件（与 onNotificationClick 等价，但通过 Tauri 事件）
 * 适用于跨组件订阅
 */
export async function onNotificationNavigate(
  handler: (payload: NotificationPayload) => void,
): Promise<() => void> {
  return listen<NotificationPayload>(NOTIFICATION_NAVIGATE_EVENT, (e) => {
    if (e.payload) handler(e.payload);
  });
}

/** 销毁（应用退出前调用） */
export async function destroyNotifications(): Promise<void> {
  if (clickUnlisten) {
    clickUnlisten();
    clickUnlisten = null;
  }
  handlers.clear();
}

// ========================= 工具 =========================

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
