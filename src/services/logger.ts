// services/logger.ts - 分级日志服务
// ERROR/WARN/INFO/DEBUG 四级 + localStorage 持久化 + 7 天自动清理 + 供日志查看界面消费

// ========================= 类型定义 =========================

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";

export interface LogEntry {
  id: string;
  level: LogLevel;
  /** 模块/分类，例如 "dataManager"、"updater" */
  scope: string;
  message: string;
  /** 可选的附加数据（已序列化为字符串，避免循环引用） */
  details?: string;
  timestamp: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const STORAGE_KEY = "desktop-agent-logs";
/** 7 天保留期（毫秒） */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 单次写入上限（条），防止 localStorage 爆炸 */
const MAX_ENTRIES = 2000;

// ========================= 读取 / 持久化 =========================

function loadEntries(): LogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LogEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (e) {
    console.error("[logger] failed to load logs:", e);
    return [];
  }
}

function persist(entries: LogEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e) {
    // 容量超限时丢弃最旧的条目重试一次
    console.error("[logger] persist failed:", e);
    try {
      const trimmed = entries.slice(-Math.floor(MAX_ENTRIES / 2));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      /* localStorage 不可用，静默放弃 */
    }
  }
}

// ========================= Logger =========================

class Logger {
  private entries: LogEntry[] = [];
  /** 控制台是否同步打印（开发环境默认开） */
  private mirrorToConsole = true;

  constructor() {
    this.entries = loadEntries();
    this.cleanup();
  }

  setMirrorToConsole(enabled: boolean): void {
    this.mirrorToConsole = enabled;
  }

  /** 当前最低输出级别（默认 DEBUG 全量记录） */
  minLevel: LogLevel = "DEBUG";

  log(level: LogLevel, scope: string, message: string, details?: unknown): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.minLevel]) return;

    const entry: LogEntry = {
      id: crypto.randomUUID(),
      level,
      scope,
      message,
      timestamp: Date.now(),
      details: details === undefined ? undefined : safeStringify(details),
    };

    this.entries.push(entry);
    // 超过上限丢弃最旧
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    persist(this.entries);

    if (this.mirrorToConsole) {
      const tag = `[${scope}]`;
      const detailArgs = details === undefined ? [] : [details];
      switch (level) {
        case "ERROR":
          console.error(tag, message, ...detailArgs);
          break;
        case "WARN":
          console.warn(tag, message, ...detailArgs);
          break;
        case "INFO":
          console.info(tag, message, ...detailArgs);
          break;
        default:
          console.debug(tag, message, ...detailArgs);
      }
    }
  }

  error(scope: string, message: string, details?: unknown): void {
    this.log("ERROR", scope, message, details);
  }
  warn(scope: string, message: string, details?: unknown): void {
    this.log("WARN", scope, message, details);
  }
  info(scope: string, message: string, details?: unknown): void {
    this.log("INFO", scope, message, details);
  }
  debug(scope: string, message: string, details?: unknown): void {
    this.log("DEBUG", scope, message, details);
  }

  // ============== 日志查看界面 ==============

  /** 返回所有日志（按时间倒序） */
  getAll(): LogEntry[] {
    return [...this.entries].reverse();
  }

  /** 按级别筛选 */
  filter(level?: LogLevel, scope?: string, keyword?: string): LogEntry[] {
    const kw = keyword?.trim().toLowerCase();
    return this.entries
      .filter((e) => (level ? e.level === level : true))
      .filter((e) => (scope ? e.scope === scope : true))
      .filter((e) =>
        kw
          ? e.message.toLowerCase().includes(kw) ||
            (e.details ?? "").toLowerCase().includes(kw) ||
            e.scope.toLowerCase().includes(kw)
          : true,
      )
      .reverse();
  }

  /** 已存在的 scope 列表（用于界面筛选下拉） */
  scopes(): string[] {
    return Array.from(new Set(this.entries.map((e) => e.scope))).sort();
  }

  /** 清空所有日志 */
  clear(): void {
    this.entries = [];
    persist(this.entries);
  }

  /** 清理超过 7 天的日志条目，返回被清理的条数 */
  cleanup(): number {
    const cutoff = Date.now() - RETENTION_MS;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.timestamp >= cutoff);
    const removed = before - this.entries.length;
    if (removed > 0) persist(this.entries);
    return removed;
  }

  /** 导出全部日志为字符串（用于崩溃报告附带） */
  exportAsString(maxEntries = 200): string {
    const recent = this.entries.slice(-maxEntries);
    return recent
      .map(
        (e) =>
          `${new Date(e.timestamp).toISOString()} [${e.level}] [${e.scope}] ${e.message}${
            e.details ? `\n  details: ${e.details}` : ""
          }`,
      )
      .join("\n");
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ========================= 单例导出 =========================

export const logger = new Logger();

/** 启动时调用：清理过期日志 + 启动定时清理（每小时一次） */
export function initLogger(): void {
  const removed = logger.cleanup();
  if (removed > 0) {
    logger.info("logger", `cleaned ${removed} expired log entries`);
  }
  // 定时清理：每小时一次
  setInterval(() => {
    logger.cleanup();
  }, 60 * 60 * 1000);
}

// ========================= 便捷工厂 =========================

/** 创建带固定 scope 的子 logger，便于模块内调用 */
export function createScopedLogger(scope: string) {
  return {
    error: (msg: string, details?: unknown) => logger.error(scope, msg, details),
    warn: (msg: string, details?: unknown) => logger.warn(scope, msg, details),
    info: (msg: string, details?: unknown) => logger.info(scope, msg, details),
    debug: (msg: string, details?: unknown) => logger.debug(scope, msg, details),
    log: (level: LogLevel, msg: string, details?: unknown) =>
      logger.log(level, scope, msg, details),
  };
}
