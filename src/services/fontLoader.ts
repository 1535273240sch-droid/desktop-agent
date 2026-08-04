// fontLoader.ts - 字体文件动态加载服务
// 使用 CSS Font Loading API (FontFace) 动态注册用户导入的本地字体文件
// 支持 ttf/otf/woff/woff2，加载后写入 CSS 变量供全局使用

import { invoke } from "@tauri-apps/api/core";

// ========================= 类型 =========================

export interface LoadedFont {
  /** 字体名（family name，用作 font-family 的值） */
  family: string;
  /** 显示名（文件名） */
  displayName: string;
  /** 字体文件路径（绝对路径） */
  path: string;
  /** 字体格式 */
  format: "truetype" | "opentype" | "woff" | "woff2";
  /** 加载状态 */
  status: "loading" | "loaded" | "error";
  /** 字重 */
  weight?: string;
  /** 字形 */
  style?: string;
}

// ========================= 单例管理 =========================

class FontLoaderManager {
  /** 已加载字体表：family -> LoadedFont */
  private fonts = new Map<string, LoadedFont>();
  /** 已注册的 FontFace 对象 */
  private faces = new Map<string, FontFace>();

  /** 列出所有已加载字体 */
  list(): LoadedFont[] {
    return Array.from(this.fonts.values());
  }

  /** 检测是否已加载 */
  has(family: string): boolean {
    return this.fonts.has(family);
  }

  /**
   * 从本地文件路径加载字体
   * @param filePath 字体文件绝对路径
   * @param familyName 可选自定义字体名；默认从文件名推断
   */
  async loadFromFile(filePath: string, familyName?: string): Promise<LoadedFont> {
    // 推断字体名
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    const baseName = fileName.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/i, "");
    const family = familyName ?? baseName;
    const format = this._detectFormat(fileName);

    // 若已加载则直接返回
    if (this.fonts.has(family)) {
      return this.fonts.get(family)!;
    }

    const loaded: LoadedFont = {
      family,
      displayName: baseName,
      path: filePath,
      format,
      status: "loading",
    };
    this.fonts.set(family, loaded);

    try {
      // 通过 Tauri 后端读取字体文件为 base64
      let dataUrl: string;
      try {
        const base64 = await invoke<string>("read_font_file", { path: filePath });
        const mime = this._mimeForFormat(format);
        dataUrl = `data:${mime};base64,${base64}`;
      } catch {
        // Tauri 命令不可用时降级到 fetch（仅 http(s) URL 可用）
        if (/^https?:\/\//i.test(filePath)) {
          dataUrl = filePath;
        } else {
          throw new Error("无法读取字体文件：需要 Tauri 后端 read_font_file 命令或 http URL");
        }
      }

      // 注册 FontFace
      const face = new FontFace(family, `url(${dataUrl})`);
      this.faces.set(family, face);
      await face.load();
      // 加入文档字体集
      (document.fonts as FontFaceSet).add(face);
      loaded.status = "loaded";
      return loaded;
    } catch (e) {
      loaded.status = "error";
      console.warn(`[fontLoader] 加载字体 ${family} 失败:`, e);
      throw e;
    }
  }

  /** 卸载字体 */
  unload(family: string): void {
    const face = this.faces.get(family);
    if (face) {
      (document.fonts as FontFaceSet).delete(face);
      this.faces.delete(family);
    }
    this.fonts.delete(family);
  }

  /**
   * 应用为 CSS 字体变量
   * @param family 字体名
   * @param target "ui" | "code" 应用到界面字体或代码字体
   */
  applyToCssVar(family: string, target: "ui" | "code"): void {
    const varName = target === "ui" ? "--font-ui" : "--font-code";
    if (family) {
      document.documentElement.style.setProperty(varName, `"${family}", var(--font-fallback-${target})`);
    } else {
      document.documentElement.style.removeProperty(varName);
    }
  }

  /**
   * 批量从 settings.font.customFonts 路径数组加载
   * @param paths 字体文件路径数组
   */
  async loadAll(paths: string[]): Promise<LoadedFont[]> {
    const results: LoadedFont[] = [];
    for (const p of paths) {
      try {
        const f = await this.loadFromFile(p);
        results.push(f);
      } catch (e) {
        console.warn(`[fontLoader] 加载 ${p} 失败:`, e);
      }
    }
    return results;
  }

  // ========================= 工具方法 =========================

  private _detectFormat(fileName: string): LoadedFont["format"] {
    const ext = (fileName.split(".").pop() ?? "").toLowerCase();
    if (ext === "ttf") return "truetype";
    if (ext === "otf") return "opentype";
    if (ext === "woff") return "woff";
    if (ext === "woff2") return "woff2";
    return "truetype";
  }

  private _mimeForFormat(format: LoadedFont["format"]): string {
    switch (format) {
      case "woff2": return "font/woff2";
      case "woff": return "font/woff";
      case "truetype": return "font/ttf";
      case "opentype": return "font/otf";
      default: return "font/ttf";
    }
  }
}

// ========================= 单例导出 =========================

export const fontLoader = new FontLoaderManager();

/** 启动时加载持久化的自定义字体 */
export async function loadCustomFontsFromSettings(): Promise<void> {
  try {
    const { useSettingsStore } = await import("@/stores/settings");
    const settings = useSettingsStore();
    const paths = settings.settings.font.customFonts ?? [];
    if (paths.length > 0) {
      await fontLoader.loadAll(paths);
    }
    // 应用 UI 字体
    if (settings.settings.font.uiFont) {
      fontLoader.applyToCssVar(settings.settings.font.uiFont, "ui");
    }
    if (settings.settings.font.codeFont) {
      fontLoader.applyToCssVar(settings.settings.font.codeFont, "code");
    }
  } catch (e) {
    console.warn("[fontLoader] 初始化自定义字体失败:", e);
  }
}
