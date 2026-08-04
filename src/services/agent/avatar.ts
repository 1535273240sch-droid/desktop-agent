// services/agent/avatar.ts - Agent 头像服务
// 首次自动生成(AI 生图) + 多风格预设(极简/科技/可爱/商务) + 可重新生成 + 保存到 APPDATA

import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readFile, writeFile, readDir, remove } from "@tauri-apps/plugin-fs";
import { logger } from "@/services/logger";
import { StepApiClient } from "@/services/api/stepApi";

const log = logger;

// ========================= 类型与常量 =========================

export type AvatarStyle = "minimal" | "tech" | "cute" | "business";

export interface AvatarStylePreset {
  id: AvatarStyle;
  name: string;
  description: string;
  /** 生图 prompt 模板，{name} 占位会被 Agent 名字替换 */
  promptTemplate: string;
}

export interface AvatarInfo {
  /** 相对 APPDATA 的路径或 data: URL */
  path: string;
  style: AvatarStyle;
  /** 生成时间戳 */
  createdAt: number;
  /** 是否为用户上传而非 AI 生成 */
  uploaded: boolean;
}

const AVATAR_DIR_NAME = "avatars";
const AVATAR_INDEX_KEY = "desktop-agent-avatar-index";

/** 多风格预设 */
export const AVATAR_STYLES: AvatarStylePreset[] = [
  {
    id: "minimal",
    name: "极简",
    description: "扁平、留白、几何感",
    promptTemplate:
      "Minimalist avatar icon of an AI assistant named {name}, flat geometric design, " +
      "soft pastel gradient background, simple shapes, clean lines, centered, app icon style",
  },
  {
    id: "tech",
    name: "科技",
    description: "霓虹、未来感、电路纹理",
    promptTemplate:
      "Futuristic tech-style avatar icon of an AI assistant named {name}, glowing neon circuit patterns, " +
      "holographic blue-purple gradient, sci-fi UI aesthetic, dark background, high detail, app icon style",
  },
  {
    id: "cute",
    name: "可爱",
    description: "萌系卡通、圆润、明亮",
    promptTemplate:
      "Cute kawaii cartoon avatar icon of an AI assistant named {name}, round face, big friendly eyes, " +
      "soft bright colors, chibi style, pastel background, app icon style",
  },
  {
    id: "business",
    name: "商务",
    description: "稳重、专业、企业风",
    promptTemplate:
      "Professional business-style avatar icon of an AI assistant named {name}, sleek modern design, " +
      "corporate blue tone, subtle metallic texture, minimalist, executive aesthetic, app icon style",
  },
];

// ========================= 状态 =========================

let cachedAvatar: AvatarInfo | null = null;
let avatarDir: string | null = null;

// ========================= 内部：路径与索引 =========================

async function getAvatarDir(): Promise<string> {
  if (avatarDir) return avatarDir;
  const base = await appDataDir();
  avatarDir = await join(base, AVATAR_DIR_NAME);
  if (!(await exists(avatarDir))) {
    await mkdir(avatarDir, { recursive: true });
  }
  return avatarDir;
}

function loadIndex(): AvatarInfo | null {
  try {
    const raw = localStorage.getItem(AVATAR_INDEX_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AvatarInfo;
  } catch (e) {
    log.warn("avatar", "load index failed", e);
    return null;
  }
}

function saveIndex(info: AvatarInfo | null): void {
  try {
    if (info) {
      localStorage.setItem(AVATAR_INDEX_KEY, JSON.stringify(info));
    } else {
      localStorage.removeItem(AVATAR_INDEX_KEY);
    }
  } catch (e) {
    log.warn("avatar", "save index failed", e);
  }
}

// ========================= 内部：图片处理 =========================

/** 将 base64 字符串（不含前缀）写入 PNG 文件 */
async function saveBase64AsPng(base64: string, fileName: string): Promise<string> {
  const dir = await getAvatarDir();
  const path = await join(dir, fileName);
  const bytes = base64ToBytes(base64);
  await writeFile(path, bytes);
  return path;
}

function base64ToBytes(b64: string): Uint8Array {
  // 去掉可能存在的 data: 前缀
  const clean = b64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(clean);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function bytesToDataUrl(bytes: Uint8Array, mime = "image/png"): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

// ========================= 公开 API =========================

/**
 * 获取当前头像
 * - 优先返回缓存
 * - 缓存未命中时从索引加载
 * - 返回 data URL（便于直接绑定到 <img>）
 */
export async function getCurrentAvatar(): Promise<string | null> {
  if (cachedAvatar) {
    return resolveAvatarDataUrl(cachedAvatar);
  }
  const info = loadIndex();
  if (!info) return null;
  cachedAvatar = info;
  return resolveAvatarDataUrl(info);
}

async function resolveAvatarDataUrl(info: AvatarInfo): Promise<string | null> {
  // data URL 直接返回
  if (info.path.startsWith("data:")) return info.path;
  try {
    const bytes = await readFile(info.path);
    return bytesToDataUrl(bytes);
  } catch (e) {
    log.warn("avatar", "read avatar file failed", e);
    return null;
  }
}

/** 获取当前头像信息 */
export function getCurrentAvatarInfo(): AvatarInfo | null {
  return cachedAvatar ?? loadIndex();
}

/**
 * 首次自动生成头像
 * - 仅当当前没有头像时触发
 * - 默认使用 minimal 风格
 */
export async function generateInitialAvatarIfMissing(
  client: StepApiClient,
  agentName: string,
  style: AvatarStyle = "minimal",
): Promise<string | null> {
  const existing = await getCurrentAvatar();
  if (existing) {
    log.debug("avatar", "avatar already exists, skip initial generation");
    return existing;
  }
  return generateAvatar(client, agentName, style);
}

/**
 * AI 生成头像
 * - 调用 StepApiClient.textToImage
 * - 取首张图保存为 PNG 到 APPDATA/avatars
 * - 失败时返回 null（不抛出，由调用方决定降级）
 */
export async function generateAvatar(
  client: StepApiClient,
  agentName: string,
  style: AvatarStyle,
): Promise<string | null> {
  const preset = AVATAR_STYLES.find((s) => s.id === style);
  if (!preset) {
    log.warn("avatar", `unknown style: ${style}`);
    return null;
  }

  const prompt = preset.promptTemplate.replace("{name}", agentName || "Assistant");
  log.info("avatar", `generating avatar (style=${style})`);

  try {
    const result = await client.textToImage(prompt, {
      width: 512,
      height: 512,
    });
    const first = result.images?.[0];
    if (!first) {
      log.warn("avatar", "no image returned from API");
      return null;
    }

    const fileName = `avatar-${style}-${Date.now()}.png`;
    const filePath = await saveBase64AsPng(first, fileName);

    // 清理旧头像文件（保留最新）
    await pruneOldAvatars(filePath).catch(() => undefined);

    const info: AvatarInfo = {
      path: filePath,
      style,
      createdAt: Date.now(),
      uploaded: false,
    };
    saveIndex(info);
    cachedAvatar = info;
    log.info("avatar", `avatar saved: ${filePath}`);
    return bytesToDataUrl(base64ToBytes(first));
  } catch (e) {
    log.error("avatar", "generate failed", e);
    return null;
  }
}

/**
 * 用户上传自定义头像
 * - 接收任意图片的 data URL 或 base64
 * - 转存为 PNG 到 APPDATA/avatars
 */
export async function uploadAvatar(dataUrlOrBase64: string): Promise<string | null> {
  try {
    const fileName = `avatar-upload-${Date.now()}.png`;
    const filePath = await saveBase64AsPng(dataUrlOrBase64, fileName);

    await pruneOldAvatars(filePath).catch(() => undefined);

    const info: AvatarInfo = {
      path: filePath,
      style: "minimal" as AvatarStyle,
      createdAt: Date.now(),
      uploaded: true,
    };
    saveIndex(info);
    cachedAvatar = info;
    log.info("avatar", `uploaded avatar saved: ${filePath}`);
    return resolveAvatarDataUrl(info);
  } catch (e) {
    log.error("avatar", "upload failed", e);
    return null;
  }
}

/** 删除当前头像 */
export async function deleteAvatar(): Promise<void> {
  const info = loadIndex();
  if (info && !info.path.startsWith("data:")) {
    try {
      await remove(info.path);
    } catch (e) {
      log.warn("avatar", "delete file failed", e);
    }
  }
  cachedAvatar = null;
  saveIndex(null);
  log.info("avatar", "avatar deleted");
}

/** 列出所有风格预设 */
export function listStyles(): AvatarStylePreset[] {
  return [...AVATAR_STYLES];
}

// ========================= 内部：清理 =========================

/** 保留传入的当前头像，删除目录下其它旧文件 */
async function pruneOldAvatars(keepPath: string): Promise<void> {
  const dir = await getAvatarDir();
  let entries: Awaited<ReturnType<typeof readDir>>;
  try {
    entries = await readDir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const full = await join(dir, entry.name);
    if (full === keepPath) continue;
    try {
      await remove(full);
      log.debug("avatar", `pruned old avatar: ${full}`);
    } catch {
      /* 忽略单个文件删除失败 */
    }
  }
}

// ========================= Rust 端桥接（可选） =========================

/**
 * 调用 Rust 端生成头像（如果配置了本地生图后端）
 * - 与 generateAvatar 互为补充；调用方按可用性选择
 */
export async function generateAvatarViaRust(
  agentName: string,
  style: AvatarStyle,
): Promise<string | null> {
  try {
    const base64 = await invoke<string>("avatar_generate", { agentName, style });
    if (!base64) return null;
    const fileName = `avatar-${style}-${Date.now()}.png`;
    const filePath = await saveBase64AsPng(base64, fileName);
    const info: AvatarInfo = {
      path: filePath,
      style,
      createdAt: Date.now(),
      uploaded: false,
    };
    saveIndex(info);
    cachedAvatar = info;
    return bytesToDataUrl(base64ToBytes(base64));
  } catch (e) {
    log.warn("avatar", "rust generate failed", e);
    return null;
  }
}
