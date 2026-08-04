// services/sandbox/client.ts - 沙箱前端客户端
// 调用 Rust 后端沙箱命令：代码执行(Python/Shell/Node) + 结果 Jupyter 风格展示
// + 文件双向拖拽 + 环境信息显示 + pip install 需确认

import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/services/logger";
import type { SandboxConfig } from "@/types";

const log = logger;

// ========================= 类型定义 =========================

export type SandboxLanguage = "python" | "shell" | "node";

/** Jupyter 风格的执行结果单元格 */
export interface ExecutionCell {
  /** 单元格类型 */
  type: "code" | "stdout" | "stderr" | "result" | "image" | "html" | "error";
  /** 文本内容（stdout/stderr/result/error 用） */
  text?: string;
  /** 图片 base64（image 用，不含 data: 前缀） */
  imageBase64?: string;
  /** 图片 MIME */
  imageMime?: string;
  /** HTML 富文本（html 用） */
  html?: string;
  /** 执行耗时（毫秒） */
  durationMs?: number;
}

export interface ExecutionResult {
  /** 沙箱实例名称 */
  name: string;
  language: SandboxLanguage;
  /** 是否执行成功（exit code == 0） */
  success: boolean;
  /** 退出码 */
  exitCode?: number;
  /** 拆分后的单元格列表，按顺序用于 Jupyter 风格渲染 */
  cells: ExecutionCell[];
  /** 合并的标准输出（便于复制） */
  stdout: string;
  /** 合并的错误输出 */
  stderr: string;
  /** 总耗时 */
  durationMs: number;
  /** 沙箱环境信息（执行时附带） */
  environment?: SandboxEnvironment;
}

export interface SandboxEnvironment {
  pythonVersion?: string;
  nodeVersion?: string;
  shellVersion?: string;
  /** 已安装的 Python 包（仅 python 沙箱） */
  installedPackages?: Array<{ name: string; version: string }>;
  /** 沙箱已运行时间（秒） */
  uptimeSeconds?: number;
  /** 内存使用（MB） */
  memoryMb?: number;
  /** CPU 使用率（%） */
  cpuPercent?: number;
}

export interface FileTransferResult {
  /** 沙箱内路径 */
  sandboxPath: string;
  /** 大小（字节） */
  size: number;
  /** 是否成功 */
  success: boolean;
  error?: string;
}

/** pip 安装确认处理器：返回 true 则继续安装 */
export type PipInstallConfirmHandler = (
  packages: string[],
  language: SandboxLanguage,
) => Promise<boolean>;

// ========================= Rust 端契约（对齐 executor.ts 的命令名） =========================
//
// sandbox_execute      { name, lang, code, config } -> RustSandboxRawResult
// sandbox_pip_install  { name, packages, autoConfirm } -> PipInstallRawResult
// sandbox_env_info     { name } -> SandboxEnvironment
// sandbox_file_upload  { name, localPath, remotePath } -> FileTransferResult
// sandbox_file_download{ name, remotePath, localPath } -> FileTransferResult
// sandbox_destroy      { name } -> void

interface RustSandboxRawResult {
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Jupyter 风格单元格（Rust 端解析 stdout 中的特殊标记后给出） */
  cells?: Array<{
    type: string;
    text?: string;
    imageBase64?: string;
    imageMime?: string;
    html?: string;
    durationMs?: number;
  }>;
  durationMs?: number;
  environment?: SandboxEnvironment;
}

interface PipInstallRawResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  installed?: Array<{ name: string; version: string }>;
  durationMs?: number;
}

// ========================= 状态 =========================

let defaultConfig: SandboxConfig = {
  enabled: true,
  memoryLimit: "2g",
  cpuLimit: "2",
  diskLimit: "10g",
  networkMode: "http-only",
  autoDestroy: true,
  timeout: 30000,
};

let pipConfirmHandler: PipInstallConfirmHandler | null = null;

/** 默认沙箱实例名（一个长驻沙箱，避免每次启动新容器） */
const DEFAULT_SANDBOX_NAME = "default";

// ========================= 配置 =========================

/** 更新默认沙箱配置（一般来自 settings store） */
export function setDefaultConfig(config: SandboxConfig): void {
  defaultConfig = { ...config };
  log.debug("sandbox", "default config updated", { enabled: config.enabled });
}

export function getDefaultConfig(): SandboxConfig {
  return { ...defaultConfig };
}

/** 注册 pip 安装确认处理器（UI 层接管弹窗） */
export function registerPipInstallConfirmHandler(handler: PipInstallConfirmHandler): void {
  pipConfirmHandler = handler;
}

// ========================= 代码执行 =========================

/**
 * 在沙箱中执行代码
 * - 默认使用长驻沙箱实例 `default`
 * - 自动附带环境信息
 * - 结果按 Jupyter 风格拆分为 cells
 */
export async function executeCode(
  code: string,
  language: SandboxLanguage,
  options?: {
    name?: string;
    config?: Partial<SandboxConfig>;
    /** 是否附带环境信息（默认 true） */
    withEnv?: boolean;
  },
): Promise<ExecutionResult> {
  const name = options?.name ?? DEFAULT_SANDBOX_NAME;
  const config: SandboxConfig = { ...defaultConfig, ...options?.config };
  if (!config.enabled) {
    throw new Error("沙箱未启用，请在设置中开启沙箱功能");
  }

  const started = Date.now();
  log.info("sandbox", `executing ${language} code (${code.length} chars)`);

  let raw: RustSandboxRawResult;
  try {
    raw = await invoke<RustSandboxRawResult>("sandbox_execute", {
      name,
      lang: language,
      code,
      config,
    });
  } catch (e) {
    log.error("sandbox", "execute invoke failed", e);
    throw new Error(`沙箱执行失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 可选附带环境信息
  let env: SandboxEnvironment | undefined = raw.environment;
  if (options?.withEnv !== false && !env) {
    env = await getEnvironment(name).catch(() => undefined);
  }

  const cells = normalizeCells(raw.cells, raw.stdout, raw.stderr);
  const result: ExecutionResult = {
    name,
    language,
    success: raw.success,
    exitCode: raw.exitCode,
    cells,
    stdout: raw.stdout ?? "",
    stderr: raw.stderr ?? "",
    durationMs: raw.durationMs ?? Date.now() - started,
    environment: env,
  };
  log.info("sandbox", `execution done`, {
    success: result.success,
    cells: result.cells.length,
    durationMs: result.durationMs,
  });
  return result;
}

/** Python 快捷入口 */
export function runPython(code: string, options?: { name?: string; config?: Partial<SandboxConfig> }): Promise<ExecutionResult> {
  return executeCode(code, "python", options);
}

/** Shell 快捷入口 */
export function runShell(code: string, options?: { name?: string; config?: Partial<SandboxConfig> }): Promise<ExecutionResult> {
  return executeCode(code, "shell", options);
}

/** Node 快捷入口 */
export function runNode(code: string, options?: { name?: string; config?: Partial<SandboxConfig> }): Promise<ExecutionResult> {
  return executeCode(code, "node", options);
}

// ========================= pip 安装（需确认） =========================

/**
 * 在沙箱中安装 Python 包
 * - 调用前必须经用户确认（pipConfirmHandler）
 * - 未注册 handler 时默认拒绝（安全起见）
 */
export async function pipInstall(
  packages: string[],
  options?: { name?: string; skipConfirm?: boolean },
): Promise<{ success: boolean; installed: Array<{ name: string; version: string }>; stdout: string; stderr: string }> {
  if (packages.length === 0) {
    return { success: false, installed: [], stdout: "", stderr: "no packages specified" };
  }
  const name = options?.name ?? DEFAULT_SANDBOX_NAME;

  // 用户确认
  if (!options?.skipConfirm) {
    if (!pipConfirmHandler) {
      log.warn("sandbox", "pip install blocked: no confirm handler registered");
      throw new Error("未注册 pip 安装确认处理器，已拒绝执行");
    }
    const ok = await pipConfirmHandler(packages, "python");
    if (!ok) {
      log.info("sandbox", "pip install cancelled by user", { packages });
      return { success: false, installed: [], stdout: "", stderr: "user declined" };
    }
  }

  log.info("sandbox", `pip install: ${packages.join(", ")}`);
  let raw: PipInstallRawResult;
  try {
    raw = await invoke<PipInstallRawResult>("sandbox_pip_install", {
      name,
      packages,
      autoConfirm: false,
    });
  } catch (e) {
    log.error("sandbox", "pip install invoke failed", e);
    throw new Error(`pip 安装失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    success: raw.success,
    installed: raw.installed ?? [],
    stdout: raw.stdout ?? "",
    stderr: raw.stderr ?? "",
  };
}

// ========================= 环境信息 =========================

/** 获取沙箱环境信息（Python 版本 / 已装包 / 运行时间等） */
export async function getEnvironment(name: string = DEFAULT_SANDBOX_NAME): Promise<SandboxEnvironment> {
  try {
    return await invoke<SandboxEnvironment>("sandbox_env_info", { name });
  } catch (e) {
    log.warn("sandbox", "env info invoke failed", e);
    return {};
  }
}

/** 仅获取已安装 Python 包列表（便于 UI 单独刷新） */
export async function listInstalledPackages(name: string = DEFAULT_SANDBOX_NAME): Promise<Array<{ name: string; version: string }>> {
  const env = await getEnvironment(name);
  return env.installedPackages ?? [];
}

// ========================= 文件双向拖拽 =========================

/**
 * 上传本地文件到沙箱（拖入）
 * @param localPath 宿主机本地路径
 * @param remotePath 沙箱内目标路径；省略则放到沙箱 /workspace 同名文件
 */
export async function uploadFile(
  localPath: string,
  remotePath?: string,
  name: string = DEFAULT_SANDBOX_NAME,
): Promise<FileTransferResult> {
  log.info("sandbox", `uploading ${localPath} → ${remotePath ?? "(auto)"}`);
  try {
    return await invoke<FileTransferResult>("sandbox_file_upload", {
      name,
      localPath,
      remotePath: remotePath ?? "",
    });
  } catch (e) {
    log.error("sandbox", "upload failed", e);
    return {
      sandboxPath: remotePath ?? "",
      size: 0,
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 从沙箱下载文件到本地（拖出）
 * @param remotePath 沙箱内文件路径
 * @param localPath 宿主机目标路径；省略则弹保存对话框
 */
export async function downloadFile(
  remotePath: string,
  localPath?: string,
  name: string = DEFAULT_SANDBOX_NAME,
): Promise<FileTransferResult> {
  log.info("sandbox", `downloading ${remotePath} → ${localPath ?? "(picker)"}`);
  try {
    // 若未指定本地路径，让 Rust 端调用文件保存对话框
    return await invoke<FileTransferResult>("sandbox_file_download", {
      name,
      remotePath,
      localPath: localPath ?? "",
    });
  } catch (e) {
    log.error("sandbox", "download failed", e);
    return {
      sandboxPath: remotePath,
      size: 0,
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ========================= 沙箱生命周期 =========================

/** 销毁沙箱实例（释放资源） */
export async function destroySandbox(name: string = DEFAULT_SANDBOX_NAME): Promise<void> {
  try {
    await invoke("sandbox_destroy", { name });
    log.info("sandbox", `destroyed: ${name}`);
  } catch (e) {
    log.warn("sandbox", "destroy failed", e);
  }
}

// ========================= 内部：单元格规范化 =========================

function normalizeCells(
  raw: RustSandboxRawResult["cells"],
  stdout: string | undefined,
  stderr: string | undefined,
): ExecutionCell[] {
  const cells: ExecutionCell[] = [];

  if (raw && raw.length > 0) {
    for (const c of raw) {
      cells.push({
        type: (c.type as ExecutionCell["type"]) ?? "stdout",
        text: c.text,
        imageBase64: c.imageBase64,
        imageMime: c.imageMime,
        html: c.html,
        durationMs: c.durationMs,
      });
    }
    // 若 Rust 已给出 cells，stdout/stderr 仅作为兜底补充
    if (stderr && !cells.some((c) => c.type === "stderr" || c.type === "error")) {
      cells.push({ type: "stderr", text: stderr });
    }
    return cells;
  }

  // Rust 未拆分 cells：前端按 stdout/stderr 简单拆分
  if (stdout) cells.push({ type: "stdout", text: stdout });
  if (stderr) cells.push({ type: "stderr", text: stderr });
  return cells;
}

// ========================= Jupyter 风格展示辅助 =========================

/**
 * 将 matplotlib 等通过 stdout 输出的 base64 图片标记解析为 image 单元格
 * 约定：stdout 中以 `<<IMAGE:base64,mime>>` 包裹的片段视为图片
 * - 由前端二次解析；Rust 端未做时使用
 */
export function parseInlineImageMarkers(stdout: string): ExecutionCell[] {
  const cells: ExecutionCell[] = [];
  const re = /<<IMAGE:([a-zA-Z0-9+/=]+),([a-zA-Z0-9/.+-]+)>>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    if (m.index > last) {
      cells.push({ type: "stdout", text: stdout.slice(last, m.index) });
    }
    cells.push({ type: "image", imageBase64: m[1], imageMime: m[2] });
    last = m.index + m[0].length;
  }
  if (last < stdout.length) {
    cells.push({ type: "stdout", text: stdout.slice(last) });
  }
  return cells;
}

/** 把执行结果格式化为纯文本摘要（用于聊天中预览） */
export function summarizeResult(result: ExecutionResult, maxLen = 500): string {
  const lines: string[] = [];
  lines.push(`[${result.language}] ${result.success ? "✓" : "✗"} ${result.durationMs}ms`);
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    lines.push(`exit code: ${result.exitCode}`);
  }
  if (result.stdout) {
    lines.push("--- stdout ---");
    lines.push(truncate(result.stdout, maxLen));
  }
  if (result.stderr) {
    lines.push("--- stderr ---");
    lines.push(truncate(result.stderr, maxLen));
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…\n(${s.length - max} more chars)` : s;
}
