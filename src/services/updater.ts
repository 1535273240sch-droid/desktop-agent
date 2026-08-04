// services/updater.ts - 更新检查服务
// GitHub Release 检查 + 启动时弹窗询问 + 更新前自动备份 + 配置自动迁移
// 检查范围：应用本体 + 内置插件 + 主题包
//
// 应用本体更新走 @tauri-apps/plugin-updater（依赖 Rust 端 updater 配置）；
// GitHub Release 拉取用于"内置插件 / 主题包"的版本对比与下载清单。

import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/services/logger";
import { migrateConfigIfNeeded, createBackup } from "@/services/dataManager";
import type { BackupPayload } from "@/services/dataManager";

const log = logger;

// ========================= 类型定义 =========================

export interface ReleaseAsset {
  name: string;
  downloadUrl: string;
  size: number;
  contentType?: string;
}

export interface GitHubRelease {
  tagName: string;
  name?: string;
  publishedAt: string;
  body?: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
  /** 解析后的语义化版本号（去前缀 v） */
  version: string;
  /** 是否为预发布 */
  prerelease: boolean;
}

export type UpdateChannel = "app" | "plugins" | "themes";

export interface UpdateCheckResult {
  channel: UpdateChannel;
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  release?: GitHubRelease;
  /** 仅当 hasUpdate 时给出可读说明 */
  notes?: string;
}

export interface AppUpdateProgress {
  downloaded: number;
  total: number;
  percent: number;
}

export type UpdatePromptHandler = (
  result: UpdateCheckResult,
) => Promise<boolean>;

// ========================= 配置 =========================

/** GitHub 仓库（owner/repo），可通过 setRepo 动态修改 */
let GITHUB_REPO = "user/desktop-agent";
/** 启动时是否自动检查（关闭后仅手动触发） */
let autoCheckOnStartup = true;
/** 是否包含预发布版本 */
let includePrerelease = false;
/** 检查间隔（毫秒），避免启动时每次都请求 GitHub */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
const LAST_CHECK_KEY = "desktop-agent-last-update-check";

let promptHandler: UpdatePromptHandler | null = null;
let lastResult: UpdateCheckResult | null = null;

// ========================= 公开 API =========================

export function configureUpdater(opts: {
  githubRepo?: string;
  autoCheck?: boolean;
  includePrerelease?: boolean;
}): void {
  if (opts.githubRepo) GITHUB_REPO = opts.githubRepo.replace(/^\/+|\/+$/g, "");
  if (typeof opts.autoCheck === "boolean") autoCheckOnStartup = opts.autoCheck;
  if (typeof opts.includePrerelease === "boolean") includePrerelease = opts.includePrerelease;
  log.debug("updater", "configured", { repo: GITHUB_REPO, autoCheck: autoCheckOnStartup });
}

/** 注册"是否更新"询问处理器（UI 层接管弹窗） */
export function registerUpdatePromptHandler(handler: UpdatePromptHandler): void {
  promptHandler = handler;
}

export function getLastCheckResult(): UpdateCheckResult | null {
  return lastResult;
}

// ========================= 版本对比 =========================

/** 简化的语义化版本对比：返回 1 / -1 / 0 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // 预发布标签比较（无标签 > 有标签）
  const ta = pa[3] ?? "";
  const tb = pb[3] ?? "";
  if (!ta && tb) return 1;
  if (ta && !tb) return -1;
  if (ta && tb) return ta === tb ? 0 : ta > tb ? 1 : -1;
  return 0;
}

function parseSemver(v: string): [number, number, number, string?] {
  const clean = v.replace(/^v/i, "").trim();
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return [0, 0, 0, clean];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
}

// ========================= GitHub Release 拉取 =========================

async function fetchLatestRelease(channel: UpdateChannel): Promise<GitHubRelease | null> {
  // 不同 channel 可以扩展为不同的 release tag 前缀；这里默认全部走 latest
  const tagPrefix = channel === "plugins" ? "plugins-" : channel === "themes" ? "themes-" : "";
  const url =
    `https://api.github.com/repos/${GITHUB_REPO}/releases` +
    (tagPrefix ? "" : "/latest");

  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!resp.ok) {
      log.warn("updater", `github releases fetch failed: ${resp.status}`);
      return null;
    }

    if (tagPrefix) {
      // 在列表中找匹配前缀的最新（非预发布或允许预发布）
      const list = (await resp.json()) as Array<any>;
      const matched = list.find(
        (r) =>
          (typeof r.tag_name === "string" && r.tag_name.startsWith(tagPrefix)) &&
          (includePrerelease || !r.prerelease),
      );
      return matched ? normalizeRelease(matched) : null;
    }
    const data = (await resp.json()) as any;
    if (data.prerelease && !includePrerelease) return null;
    return normalizeRelease(data);
  } catch (e) {
    log.warn("updater", "github release fetch error", e);
    return null;
  }
}

function normalizeRelease(r: any): GitHubRelease {
  const tag: string = r.tag_name ?? "";
  const version = tag.replace(/^v/i, "").replace(/^(plugins-|themes-)/, "");
  const assets: ReleaseAsset[] = (r.assets ?? []).map((a: any) => ({
    name: a.name,
    downloadUrl: a.browser_download_url,
    size: a.size ?? 0,
    contentType: a.content_type,
  }));
  return {
    tagName: tag,
    name: r.name ?? tag,
    publishedAt: r.published_at ?? "",
    body: r.body ?? "",
    htmlUrl: r.html_url ?? "",
    assets,
    version,
    prerelease: !!r.prerelease,
  };
}

// ========================= 应用本体更新（plugin-updater） =========================

async function checkAppUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  // 1. 走 Tauri 内置 updater（需要 Rust 端配置 endpoints）
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update?.available) {
      const release = await fetchLatestRelease("app");
      log.info("updater", `app update available: ${update.version}`);
      return {
        channel: "app",
        hasUpdate: true,
        currentVersion,
        latestVersion: update.version,
        release: release ?? undefined,
        notes: update.body?.slice(0, 600),
      };
    }
    return {
      channel: "app",
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
    };
  } catch (e) {
    // plugin-updater 不可用：降级到纯 GitHub Release 对比
    log.warn("updater", "plugin-updater check failed, fallback to GitHub", e);
    const release = await fetchLatestRelease("app");
    if (release && compareVersions(release.version, currentVersion) > 0) {
      return {
        channel: "app",
        hasUpdate: true,
        currentVersion,
        latestVersion: release.version,
        release,
        notes: release.body?.slice(0, 600),
      };
    }
    return {
      channel: "app",
      hasUpdate: false,
      currentVersion,
      latestVersion: release?.version ?? currentVersion,
    };
  }
}

/**
 * 执行应用本体更新（下载 + 安装 + 重启）
 * - 调用前会自动备份配置与记忆
 * - 备份失败仅警告，不阻断更新
 */
export async function downloadAndInstallAppUpdate(
  result: UpdateCheckResult,
  buildBackupPayload: () => BackupPayload | Promise<BackupPayload>,
  onProgress?: (p: AppUpdateProgress) => void,
): Promise<boolean> {
  if (!result.hasUpdate) return false;

  // 1. 更新前自动备份
  try {
    const payload = await buildBackupPayload();
    await createBackup(payload);
    log.info("updater", "pre-update backup done");
  } catch (e) {
    log.warn("updater", "pre-update backup failed, continuing", e);
  }

  // 2. 配置自动迁移（在更新前对齐 schema）
  try {
    await migrateConfigIfNeeded();
  } catch (e) {
    log.warn("updater", "pre-update migration failed", e);
  }

  // 3. 下载并安装（走 plugin-updater）
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update?.available) {
      log.warn("updater", "update no longer available on reinstall");
      return false;
    }
    let downloaded = 0;
    let total = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength ?? 0;
          break;
        case "Finished":
          downloaded = total;
          break;
      }
      onProgress?.({
        downloaded,
        total,
        percent: total > 0 ? Math.min(100, (downloaded / total) * 100) : 0,
      });
    });
    log.info("updater", "update installed, will relaunch");
    await relaunchApp();
    return true;
  } catch (e) {
    log.error("updater", "download/install failed", e);
    throw e;
  }
}

async function relaunchApp(): Promise<void> {
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    log.warn("updater", "relaunch failed; user may need to restart manually", e);
  }
}

// ========================= 插件 / 主题包更新 =========================

export interface ComponentVersionInfo {
  /** 内置插件 / 主题包的当前版本（key 为 id） */
  versions: Record<string, string>;
}

/**
 * 检查内置插件 / 主题包是否有新版本
 * - 调用方传入当前版本映射
 * - 通过 GitHub Release（带前缀标签）拉取最新版本对比
 */
export async function checkComponentUpdates(
  channel: "plugins" | "themes",
  current: ComponentVersionInfo,
): Promise<UpdateCheckResult> {
  const release = await fetchLatestRelease(channel);
  if (!release) {
    return {
      channel,
      hasUpdate: false,
      currentVersion: Object.values(current.versions).join(",") || "0.0.0",
    };
  }

  // 对比每个组件；任意一个落后即视为有更新
  let hasUpdate = false;
  const outdated: string[] = [];
  for (const [id, curVer] of Object.entries(current.versions)) {
    if (compareVersions(release.version, curVer) > 0) {
      hasUpdate = true;
      outdated.push(`${id}: ${curVer} → ${release.version}`);
    }
  }

  return {
    channel,
    hasUpdate,
    currentVersion: Object.values(current.versions).join(",") || "0.0.0",
    latestVersion: release.version,
    release,
    notes: hasUpdate
      ? `可更新组件：\n${outdated.join("\n")}`
      : undefined,
  };
}

/**
 * 下载并安装组件更新（插件 / 主题包）
 * - 委托 Rust 端解析 zip 并写入对应目录
 */
export async function installComponentUpdate(
  result: UpdateCheckResult,
  targetDir: string,
): Promise<boolean> {
  if (!result.hasUpdate || !result.release) return false;
  log.info("updater", `installing ${result.channel} update v${result.latestVersion}`);
  try {
    await invoke("component_update_install", {
      channel: result.channel,
      release: result.release,
      targetDir,
    });
    log.info("updater", `${result.channel} update installed`);
    return true;
  } catch (e) {
    log.error("updater", `install ${result.channel} update failed`, e);
    throw e;
  }
}

// ========================= 启动检查编排 =========================

/**
 * 启动时调用：检查全部 channel（应用 + 插件 + 主题包）
 * - 节流：距上次检查不足 CHECK_INTERVAL_MS 则跳过
 * - 仅自动询问应用本体更新；插件 / 主题包只记录结果，由设置页提示
 */
export async function checkForUpdatesOnStartup(
  options: {
    currentAppVersion: string;
    plugins?: ComponentVersionInfo;
    themes?: ComponentVersionInfo;
    /** 强制忽略节流 */
    force?: boolean;
  },
): Promise<UpdateCheckResult[]> {
  if (!autoCheckOnStartup && !options.force) {
    log.debug("updater", "auto check disabled, skip startup check");
    return [];
  }

  // 节流
  if (!options.force) {
    const lastRaw = localStorage.getItem(LAST_CHECK_KEY);
    const lastTs = lastRaw ? Number(lastRaw) : 0;
    if (Number.isFinite(lastTs) && Date.now() - lastTs < CHECK_INTERVAL_MS) {
      log.debug("updater", "skip check (too soon since last check)");
      return [];
    }
  }
  localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

  const results: UpdateCheckResult[] = [];
  // 应用本体
  const appResult = await checkAppUpdate(options.currentAppVersion).catch((e) => {
    log.warn("updater", "app update check failed", e);
    return null;
  });
  if (appResult) results.push(appResult);

  // 插件
  if (options.plugins) {
    const r = await checkComponentUpdates("plugins", options.plugins).catch((e) => {
      log.warn("updater", "plugins update check failed", e);
      return null;
    });
    if (r) results.push(r);
  }

  // 主题包
  if (options.themes) {
    const r = await checkComponentUpdates("themes", options.themes).catch((e) => {
      log.warn("updater", "themes update check failed", e);
      return null;
    });
    if (r) results.push(r);
  }

  // 仅对"应用本体"更新自动询问
  const appUpdate = results.find((r) => r.channel === "app" && r.hasUpdate);
  if (appUpdate && promptHandler) {
    try {
      const accept = await promptHandler(appUpdate);
      log.info("updater", `user ${accept ? "accepted" : "declined"} app update`);
    } catch (e) {
      log.warn("updater", "prompt handler error", e);
    }
  }

  // 保存最近一次结果
  lastResult = appUpdate ?? results[0] ?? null;
  return results;
}

/**
 * 手动触发检查（设置页"检查更新"按钮）
 * 与启动检查逻辑相同，但忽略节流
 */
export async function checkForUpdatesManually(
  options: {
    currentAppVersion: string;
    plugins?: ComponentVersionInfo;
    themes?: ComponentVersionInfo;
  },
): Promise<UpdateCheckResult[]> {
  return checkForUpdatesOnStartup({ ...options, force: true });
}

// ========================= 错误兜底：捕获全局未处理异常时也可触发生成崩溃报告 =========================

/** 启动入口：注册全局错误监听，配合 dataManager.generateCrashReport */
export function initUpdaterErrorHandler(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("unhandledrejection", (ev) => {
    log.error("updater", "unhandled rejection", ev.reason);
  });
  window.addEventListener("error", (ev) => {
    log.error("updater", "global error", ev.error ?? ev.message);
  });
}
