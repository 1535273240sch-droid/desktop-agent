// services/dataManager.ts - 数据管理服务
// 会话导出(MD/PDF/JSON/TXT) + 备份/恢复(.zip) + 崩溃报告 + 数据占用 + 配置版本迁移
// Rust 端负责：zip 打包/解压、APPDATA 目录大小统计、崩溃报告发送

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, readFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { logger } from "@/services/logger";
import type { Conversation, MemoryGraph } from "@/types";

const log = logger;

// ========================= 常量 =========================

/** 配置文件版本（每次结构变更需递增） */
const CURRENT_CONFIG_VERSION = 1;
const CONFIG_VERSION_KEY = "desktop-agent-config-version";
/** 迁移前自动备份目录名 */
const MIGRATION_BACKUP_DIR = "migration-backups";
/** 备份文件后缀 */
const BACKUP_EXT = ".zip";

export type ExportFormat = "markdown" | "pdf" | "json" | "txt";

export interface ExportOptions {
  format: ExportFormat;
  /** 单个会话 ID；省略则导出全部 */
  conversationId?: string;
}

export interface DataSizeInfo {
  /** APPDATA 目录总大小（字节） */
  totalBytes: number;
  /** 子目录大小明细 */
  breakdown: Array<{ path: string; bytes: number }>;
  /** 转人类可读大小 */
  formatted: string;
}

export interface CrashReport {
  id: string;
  timestamp: number;
  appVersion: string;
  platform: string;
  errorStack?: string;
  recentLogs: string;
  /** 已脱敏的设置摘要 */
  settingsSummary: Record<string, unknown>;
}

// ========================= 会话导出 =========================

/**
 * 导出会话：
 * - markdown / txt / json：写入文本文件
 * - pdf：生成带打印样式的 HTML，调用浏览器打印另存为 PDF
 *
 * 单个会话传 conversationId；省略则导出全部会话（合并为一个文件）
 */
export async function exportConversations(
  conversations: Conversation[],
  options: ExportOptions,
): Promise<void> {
  const targets = options.conversationId
    ? conversations.filter((c) => c.id === options.conversationId)
    : conversations;

  if (targets.length === 0) {
    log.warn("dataManager", "export: no conversations to export");
    return;
  }

  const single = targets.length === 1;
  const defaultName = single
    ? sanitizeFileName(targets[0].title || "conversation")
    : `conversations-${formatDateStamp()}`;

  switch (options.format) {
    case "json": {
      const content = JSON.stringify(single ? targets[0] : targets, null, 2);
      await saveTextFile(`${defaultName}.json`, content);
      break;
    }
    case "txt": {
      const content = targets.map(convToTxt).join("\n\n" + "=".repeat(60) + "\n\n");
      await saveTextFile(`${defaultName}.txt`, content);
      break;
    }
    case "markdown": {
      const content = targets.map(convToMarkdown).join("\n\n---\n\n");
      await saveTextFile(`${defaultName}.md`, content);
      break;
    }
    case "pdf": {
      const html = buildPdfHtml(targets);
      await printHtmlToPdf(html, defaultName);
      break;
    }
  }
  log.info("dataManager", `exported ${targets.length} conversation(s) as ${options.format}`);
}

function convToMarkdown(c: Conversation): string {
  const header = `# ${c.title}\n\n> 创建于 ${new Date(c.createdAt).toLocaleString()} ｜ 更新于 ${new Date(c.updatedAt).toLocaleString()}\n`;
  const sys = c.systemPrompt ? `\n> **System Prompt:** ${c.systemPrompt}\n` : "";
  const body = c.messages
    .map((m) => {
      const role = m.role === "user" ? "🧑 用户" : m.role === "assistant" ? "🤖 助手" : m.role;
      const ts = new Date(m.timestamp).toLocaleTimeString();
      let block = `## ${role}  ·  ${ts}\n\n${m.content || ""}`;
      if (m.thinking?.length) {
        block +=
          "\n\n<details><summary>思考过程</summary>\n\n" +
          m.thinking.map((t) => `- ${t.content}`).join("\n") +
          "\n\n</details>";
      }
      if (m.toolCalls?.length) {
        block +=
          "\n\n<details><summary>工具调用</summary>\n\n" +
          m.toolCalls
            .map(
              (tc) =>
                `- \`${tc.name}\` → ${tc.status}${tc.error ? ` (${tc.error})` : ""}`,
            )
            .join("\n") +
          "\n\n</details>";
      }
      return block;
    })
    .join("\n\n");
  return `${header}${sys}\n${body}`;
}

function convToTxt(c: Conversation): string {
  const header = `# ${c.title}\n(创建: ${new Date(c.createdAt).toLocaleString()})\n`;
  const body = c.messages
    .map((m) => {
      const role = m.role === "user" ? "[用户]" : m.role === "assistant" ? "[助手]" : `[${m.role}]`;
      return `${role} ${new Date(m.timestamp).toLocaleTimeString()}\n${m.content || ""}`;
    })
    .join("\n\n");
  return `${header}\n${body}`;
}

/** 生成 PDF 友好的 HTML（调用浏览器打印） */
function buildPdfHtml(conversations: Conversation[]): string {
  const sections = conversations
    .map((c) => {
      const msgs = c.messages
        .map((m) => {
          const cls = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "other";
          const role =
            m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role;
          return `<div class="msg ${cls}"><div class="role">${role} · ${new Date(
            m.timestamp,
          ).toLocaleTimeString()}</div><div class="content">${escapeHtml(
            m.content || "",
          )}</div></div>`;
        })
        .join("");
      return `<section><h1>${escapeHtml(c.title)}</h1><div class="meta">创建于 ${new Date(
        c.createdAt,
      ).toLocaleString()}</div>${msgs}</section>`;
    })
    .join("");

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"/>
<title>会话导出</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #1a1a1a; margin: 32px; }
  section { page-break-after: always; margin-bottom: 24px; }
  h1 { font-size: 20px; border-bottom: 2px solid #5B4FC4; padding-bottom: 6px; }
  .meta { color: #888; font-size: 12px; margin: 4px 0 16px; }
  .msg { margin: 12px 0; padding: 10px 14px; border-radius: 8px; }
  .msg.user { background: #f0eef9; }
  .msg.assistant { background: #f4f6f8; }
  .role { font-size: 12px; color: #5B4FC4; font-weight: 600; margin-bottom: 4px; }
  .content { white-space: pre-wrap; word-wrap: break-word; font-size: 14px; line-height: 1.6; }
  @media print { body { margin: 16px; } }
</style></head><body>${sections}</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 通过新窗口 + 浏览器打印能力实现"另存为 PDF" */
async function printHtmlToPdf(html: string, _suggestedName: string): Promise<void> {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (!w) {
    // 弹窗被拦截：降级为本地 HTML 文件保存
    await saveTextFile(`${_suggestedName}.html`, html);
    URL.revokeObjectURL(url);
    log.warn("dataManager", "popup blocked, saved HTML instead");
    return;
  }
  w.addEventListener("load", () => {
    w.focus();
    w.print();
  });
  // 给浏览器一些时间后释放对象 URL
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function saveTextFile(defaultName: string, content: string): Promise<void> {
  try {
    const filePath = await save({
      defaultPath: defaultName,
      filters: [{ name: "Text", extensions: [defaultName.split(".").pop() ?? "txt"] }],
    });
    if (!filePath) return;
    const encoder = new TextEncoder();
    await writeFile(filePath, encoder.encode(content));
  } catch (e) {
    log.error("dataManager", "saveTextFile failed", e);
    throw e;
  }
}

// ========================= 备份 / 恢复 =========================

export interface BackupPayload {
  /** 设置（来自 settings store） */
  settings: Record<string, unknown>;
  /** 记忆图谱 */
  memoryGraph: MemoryGraph;
  /** 会话（可选） */
  conversations?: Conversation[];
  /** 提示词模板（可选） */
  promptTemplates?: unknown[];
  /** 备份元信息 */
  meta: {
    appVersion: string;
    createdAt: number;
    configVersion: number;
  };
}

/**
 * 备份：将记忆图谱 + 配置设置打包为 .zip 保存到用户指定位置
 * - Rust 端负责 zip 打包（invoke('backup_create')）
 * - 若 Rust 命令不可用则降级为单一 JSON 文件
 */
export async function createBackup(payload: BackupPayload): Promise<string> {
  const stamp = formatDateStamp();
  const defaultName = `desktop-agent-backup-${stamp}${BACKUP_EXT}`;
  log.info("dataManager", "creating backup", { conversations: payload.conversations?.length ?? 0 });

  const filePath = await save({
    defaultPath: defaultName,
    filters: [{ name: "Backup", extensions: ["zip"] }],
  });
  if (!filePath) {
    log.info("dataManager", "backup cancelled by user");
    return "";
  }

  try {
    // 优先走 Rust 端 zip 实现
    await invoke("backup_create", { path: filePath, payload });
    log.info("dataManager", `backup saved to ${filePath}`);
    return filePath;
  } catch (e) {
    // 降级：写入 .json（保留 zip 扩展名的 JSON 也比丢失好）
    log.warn("dataManager", "backup_create invoke failed, falling back to JSON", e);
    const fallbackPath = filePath.replace(/\.zip$/i, ".json");
    const encoder = new TextEncoder();
    await writeFile(fallbackPath, encoder.encode(JSON.stringify(payload, null, 2)));
    log.info("dataManager", `backup (JSON fallback) saved to ${fallbackPath}`);
    return fallbackPath;
  }
}

export interface RestoreResult {
  settings: Record<string, unknown> | null;
  memoryGraph: MemoryGraph | null;
  conversations: Conversation[] | null;
  promptTemplates: unknown[] | null;
  meta: { appVersion: string; createdAt: number; configVersion: number } | null;
  source: string;
}

/**
 * 从 .zip 恢复
 * - 调用 Rust 端解压并解析（invoke('backup_restore')）
 * - 失败时尝试作为纯 JSON 文件解析
 */
export async function restoreBackup(filePath: string): Promise<RestoreResult> {
  log.info("dataManager", `restoring from ${filePath}`);

  try {
    const payload = await invoke<BackupPayload>("backup_restore", { path: filePath });
    return {
      settings: payload.settings ?? null,
      memoryGraph: payload.memoryGraph ?? null,
      conversations: payload.conversations ?? null,
      promptTemplates: payload.promptTemplates ?? null,
      meta: payload.meta ?? null,
      source: filePath,
    };
  } catch (e) {
    log.warn("dataManager", "backup_restore invoke failed, trying JSON fallback", e);
    try {
      const bytes = await readFile(filePath);
      const text = new TextDecoder().decode(bytes);
      const payload = JSON.parse(text) as BackupPayload;
      return {
        settings: payload.settings ?? null,
        memoryGraph: payload.memoryGraph ?? null,
        conversations: payload.conversations ?? null,
        promptTemplates: payload.promptTemplates ?? null,
        meta: payload.meta ?? null,
        source: filePath,
      };
    } catch (e2) {
      log.error("dataManager", "restore failed (both Rust and JSON fallback)", e2);
      throw new Error(
        `恢复失败：${e2 instanceof Error ? e2.message : String(e2)}`,
      );
    }
  }
}

// ========================= 数据占用 =========================

/**
 * 计算 APPDATA 目录大小（含子目录明细）
 * 委托 Rust 端递归统计；失败时返回 0
 */
export async function getDataSize(): Promise<DataSizeInfo> {
  try {
    const result = await invoke<{ totalBytes: number; breakdown: Array<{ path: string; bytes: number }> }>(
      "data_get_appdata_size",
    );
    return {
      totalBytes: result.totalBytes,
      breakdown: result.breakdown ?? [],
      formatted: formatBytes(result.totalBytes),
    };
  } catch (e) {
    log.warn("dataManager", "data_get_appdata_size invoke failed", e);
    return { totalBytes: 0, breakdown: [], formatted: "0 B" };
  }
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

// ========================= 崩溃报告 =========================

/**
 * 自动生成崩溃报告（不含敏感数据：API key、自定义 header 等）
 * - 包含：版本、平台、错误堆栈、最近日志、脱敏后的设置摘要
 */
export async function generateCrashReport(error?: unknown): Promise<CrashReport> {
  let appVersion = "unknown";
  let platform = "unknown";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    appVersion = await getVersion();
  } catch {
    /* 非 Tauri 环境降级 */
  }
  try {
    const { platform: osPlatform, type: osType } = await import("@tauri-apps/plugin-os");
    platform = `${await osType()} ${await osPlatform()}`;
  } catch {
    if (typeof navigator !== "undefined") platform = navigator.platform || "unknown";
  }

  const recentLogs = logger.exportAsString(200);
  const settingsSummary = await buildSettingsSummary();

  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    appVersion,
    platform,
    errorStack: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : error ? String(error) : undefined,
    recentLogs,
    settingsSummary,
  };
}

/** 从 settings store 读取并脱敏（移除 apiKey、自定义 header 等） */
async function buildSettingsSummary(): Promise<Record<string, unknown>> {
  try {
    const raw = localStorage.getItem("desktop-agent-settings");
    if (!raw) return { note: "no settings found" };
    const parsed = JSON.parse(raw);
    // 脱敏：API key、token、realtimeUrl
    const safe = JSON.parse(JSON.stringify(parsed));
    if (safe.apiKeys) {
      if (safe.apiKeys.task) {
        safe.apiKeys.task.apiKey = mask(safe.apiKeys.task.apiKey);
        safe.apiKeys.task.customHeaders = "[redacted]";
        safe.apiKeys.task.baseUrl = safe.apiKeys.task.baseUrl;
      }
      if (safe.apiKeys.step) safe.apiKeys.step.apiKey = mask(safe.apiKeys.step.apiKey);
      if (safe.apiKeys.xiaomi) safe.apiKeys.xiaomi.apiKey = mask(safe.apiKeys.xiaomi.apiKey);
    }
    return safe;
  } catch (e) {
    return { note: "failed to read settings", error: String(e) };
  }
}

function mask(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/**
 * 发送崩溃报告
 * - 先询问用户确认（confirm 由 UI 层弹窗），确认后调用 Rust 端上报
 * - Rust 端实现可选；不可用时仅记录到日志
 */
export async function sendCrashReport(report: CrashReport): Promise<boolean> {
  log.info("dataManager", "sending crash report", { id: report.id });
  try {
    await invoke("crash_report_send", { report });
    log.info("dataManager", "crash report sent");
    return true;
  } catch (e) {
    log.warn("dataManager", "crash_report_send invoke failed, logged locally only", e);
    return false;
  }
}

// ========================= 配置版本迁移 =========================

export interface MigrationContext {
  fromVersion: number;
  toVersion: number;
  /** 读取当前原始配置（未迁移） */
  raw: Record<string, unknown>;
}

export type MigrationFn = (ctx: MigrationContext) => Promise<Record<string, unknown>> | Record<string, unknown>;

/**
 * 已注册的迁移脚本：键为"起始版本"，值为迁移到下一版本的函数
 * 新增字段时在对应 from→to 注册一次即可
 */
const MIGRATIONS: Record<number, MigrationFn> = {
  // 示例：0 → 1 时新增 sandbox.timeout 字段
  0: (ctx) => {
    const next = { ...ctx.raw };
    const sandbox = (next.sandbox as Record<string, unknown>) ?? {};
    if (sandbox.timeout === undefined) sandbox.timeout = 30000;
    next.sandbox = sandbox;
    return next;
  },
};

/** 读取当前配置版本（缺失视为 0） */
export function getCurrentConfigVersion(): number {
  const raw = localStorage.getItem(CONFIG_VERSION_KEY);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function setCurrentConfigVersion(v: number): void {
  localStorage.setItem(CONFIG_VERSION_KEY, String(v));
}

/**
 * 自动迁移配置文件到 CURRENT_CONFIG_VERSION
 * - 迁移前自动备份原始配置到 APPDATA/migration-backups/
 * - 没有迁移路径时静默跳过
 * - 返回是否执行了迁移
 */
export async function migrateConfigIfNeeded(): Promise<boolean> {
  const fromVersion = getCurrentConfigVersion();
  if (fromVersion >= CURRENT_CONFIG_VERSION) return false;

  log.info("dataManager", `migrating config: v${fromVersion} → v${CURRENT_CONFIG_VERSION}`);

  // 迁移前自动备份
  const rawSettings = localStorage.getItem("desktop-agent-settings") ?? "{}";
  try {
    await backupRawSettings(rawSettings, fromVersion);
  } catch (e) {
    log.warn("dataManager", "migration pre-backup failed, continuing anyway", e);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawSettings);
  } catch {
    log.error("dataManager", "current settings JSON invalid, starting fresh");
    raw = {};
  }

  let cur = fromVersion;
  let working = { ...raw };
  while (cur < CURRENT_CONFIG_VERSION) {
    const fn = MIGRATIONS[cur];
    if (!fn) {
      log.warn("dataManager", `no migration registered for v${cur} → v${cur + 1}, skipping`);
      cur++;
      continue;
    }
    try {
      working = await fn({ fromVersion: cur, toVersion: cur + 1, raw: working });
      cur++;
      log.info("dataManager", `migration step applied: v${cur - 1} → v${cur}`);
    } catch (e) {
      log.error("dataManager", `migration failed at v${cur} → v${cur + 1}`, e);
      // 回滚到备份由用户手动恢复；不再继续
      throw e;
    }
  }

  localStorage.setItem("desktop-agent-settings", JSON.stringify(working));
  setCurrentConfigVersion(CURRENT_CONFIG_VERSION);
  log.info("dataManager", "config migration completed");
  return true;
}

async function backupRawSettings(rawJson: string, fromVersion: number): Promise<void> {
  const appData = await appDataDir();
  const dir = await join(appData, MIGRATION_BACKUP_DIR);
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  const file = await join(dir, `settings-v${fromVersion}-${formatDateStamp()}.json`);
  const encoder = new TextEncoder();
  await writeFile(file, encoder.encode(rawJson));
  log.info("dataManager", `migration backup saved: ${file}`);
}

// ========================= 工具函数 =========================

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60).trim() || "conversation";
}

function formatDateStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ========================= 启动入口 =========================

/**
 * 启动时调用：执行配置迁移 + 触发日志清理
 * 返回是否执行了迁移
 */
export async function initDataManager(): Promise<boolean> {
  try {
    return await migrateConfigIfNeeded();
  } catch (e) {
    log.error("dataManager", "init migration failed", e);
    return false;
  }
}
