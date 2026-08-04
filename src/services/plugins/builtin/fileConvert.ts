// plugins/builtin/fileConvert.ts - 内置技能包：文件转换
// PDF 转文本 + 图片格式转换（jpg/png/webp 互转）
// 实现：优先走 Tauri 后端 file_convert 命令；图片格式转换在前端用 Canvas 兜底

import type { SkillPack } from "@/types";

// ========================= 技能包元数据 =========================

export const pack: SkillPack = {
  id: "builtin.file-convert",
  name: "文件转换",
  description: "PDF 转文本、图片格式转换（jpg/png/webp 互转）",
  version: "1.0.0",
  author: "system",
  dependencies: [],
  enabled: true,
  tools: [
    {
      name: "pdf_to_text",
      description: "将 PDF 文件提取为纯文本",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "PDF 文件路径或 data URL" },
          pages: {
            type: "string",
            description: "可选页码范围，如 '1-3'、'1,3,5'，默认全部",
          },
        },
        required: ["path"],
      },
      handler: "builtin:pdf_to_text",
    },
    {
      name: "image_convert",
      description: "图片格式转换（支持 jpg/png/webp 互转）",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "源图片路径或 data URL" },
          targetFormat: {
            type: "string",
            enum: ["jpg", "png", "webp"],
            description: "目标格式",
          },
          quality: {
            type: "number",
            minimum: 0.1,
            maximum: 1,
            default: 0.92,
            description: "输出质量（仅 jpg/webp 有效）",
          },
        },
        required: ["source", "targetFormat"],
      },
      handler: "builtin:image_convert",
    },
  ],
};

// ========================= 工具实现 =========================

export interface PdfToTextResult {
  text: string;
  pages: number;
  source: string;
}

export interface ImageConvertResult {
  dataUrl: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
}

/** PDF 转文本：优先 Tauri 后端，降级到 pdf.js CDN */
async function pdfToText(args: Record<string, any>): Promise<PdfToTextResult> {
  const path: string = String(args.path ?? "").trim();
  if (!path) throw new Error("pdf_to_text: path is required");

  // 1. 优先 Tauri 后端
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ text: string; pages: number } | string>(
      "pdf_to_text",
      { path, pages: args.pages ?? null },
    );
    if (typeof result === "string") {
      return { text: result, pages: 0, source: "tauri" };
    }
    return { text: result.text, pages: result.pages, source: "tauri" };
  } catch (e) {
    console.debug("[fileConvert] tauri pdf_to_text unavailable, fallback to pdf.js:", e);
  }

  // 2. 降级到 pdf.js（仅支持 data URL / 远程 URL）
  if (path.startsWith("data:") || path.startsWith("http")) {
    return pdfToTextViaPdfJs(path);
  }
  throw new Error(
    "pdf_to_text: 后端不可用，且前端仅支持 data URL / http URL 输入",
  );
}

/** 通过动态加载 pdf.js 解析 PDF（不写入依赖，按需从 CDN 加载） */
async function pdfToTextViaPdfJs(url: string): Promise<PdfToTextResult> {
  // 动态加载 pdf.js（CDN）—— 用变量承载 URL 避免 TS 模块解析
  const pdfjsUrl =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs";
  const pdfjs: any = await import(/* @vite-ignore */ pdfjsUrl);
  pdfjs.GlobalWorkerOptions.workerSrc =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs";

  const loadingTask = pdfjs.getDocument(url);
  const pdf = await loadingTask.promise;
  const numPages: number = pdf.numPages;
  const texts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((it: any) => (typeof it.str === "string" ? it.str : ""))
      .join(" ");
    texts.push(pageText);
  }
  return { text: texts.join("\n\n"), pages: numPages, source: "pdfjs" };
}

/** 图片格式转换：优先 Tauri 后端，降级到 Canvas */
async function imageConvert(args: Record<string, any>): Promise<ImageConvertResult> {
  const source: string = String(args.source ?? "").trim();
  const targetFormat: string = String(args.targetFormat ?? "").toLowerCase();
  const quality: number = Number(args.quality ?? 0.92);
  if (!source) throw new Error("image_convert: source is required");
  if (!["jpg", "png", "webp"].includes(targetFormat)) {
    throw new Error(`image_convert: unsupported target format "${targetFormat}"`);
  }

  // 1. 优先 Tauri 后端
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ dataUrl: string; width: number; height: number }>(
      "image_convert",
      { source, targetFormat, quality },
    );
    const commaIdx = result.dataUrl.indexOf(",");
    const bytes = Math.floor((result.dataUrl.length - commaIdx - 1) * 0.75);
    return {
      dataUrl: result.dataUrl,
      format: targetFormat,
      width: result.width,
      height: result.height,
      bytes,
    };
  } catch (e) {
    console.debug("[fileConvert] tauri image_convert unavailable, fallback to canvas:", e);
  }

  // 2. Canvas 兜底（仅支持 data URL / http URL）
  if (!source.startsWith("data:") && !source.startsWith("http")) {
    throw new Error("image_convert: 后端不可用，前端仅支持 data URL / http URL 输入");
  }
  return imageConvertViaCanvas(source, targetFormat, quality);
}

/** 用 Canvas 完成图片格式转换 */
function imageConvertViaCanvas(
  source: string,
  targetFormat: string,
  quality: number,
): Promise<ImageConvertResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas 2d context unavailable");
        // jpg 需要白底（不支持透明）
        if (targetFormat === "jpg") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0);
        const mime = targetFormat === "jpg" ? "image/jpeg" : `image/${targetFormat}`;
        const dataUrl = canvas.toDataURL(mime, quality);
        const bytes = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
        resolve({
          dataUrl,
          format: targetFormat,
          width: canvas.width,
          height: canvas.height,
          bytes,
        });
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("image_convert: 图片加载失败"));
    img.src = source;
  });
}

// ========================= 导出 handlers =========================

export const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  pdf_to_text: pdfToText,
  image_convert: imageConvert,
};
