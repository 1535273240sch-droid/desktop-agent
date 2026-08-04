// plugins/builtin/webSearch.ts - 内置技能包：网页搜索
// 搜索关键词并返回结构化结果（标题/链接/摘要）
// 实现：优先走 Tauri 后端 web_search 命令；不可用时降级到 DuckDuckGo Instant Answer API

import type { SkillPack } from "@/types";

// ========================= 技能包元数据 =========================

export const pack: SkillPack = {
  id: "builtin.web-search",
  name: "网页搜索",
  description: "搜索关键词，返回相关网页结果（标题/链接/摘要）",
  version: "1.0.0",
  author: "system",
  dependencies: [],
  enabled: true,
  tools: [
    {
      name: "web_search",
      description: "搜索关键词，返回网页搜索结果列表",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          maxResults: {
            type: "integer",
            default: 5,
            description: "最大返回结果数（1-20）",
          },
        },
        required: ["query"],
      },
      handler: "builtin:web_search",
    },
  ],
};

// ========================= 工具实现 =========================

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * 网页搜索工具实现
 * 1. 优先尝试 Tauri 后端命令 `web_search`（Rust 侧可接入任意搜索后端）
 * 2. 降级到 DuckDuckGo Instant Answer API（无需 API Key）
 */
async function webSearch(args: Record<string, any>): Promise<{
  query: string;
  results: SearchResult[];
  source: string;
}> {
  const query: string = String(args.query ?? "").trim();
  const maxResults = Math.max(1, Math.min(20, Number(args.maxResults ?? 5)));
  if (!query) {
    throw new Error("web_search: query is required");
  }

  // 1. 优先 Tauri 后端
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const backend = await invoke<SearchResult[] | { results: SearchResult[] }>(
      "web_search",
      { query, maxResults },
    );
    const results = Array.isArray(backend) ? backend : backend?.results ?? [];
    if (results.length > 0) {
      return { query, results: results.slice(0, maxResults), source: "tauri" };
    }
  } catch (e) {
    // 后端命令不可用，继续降级
    console.debug("[webSearch] tauri backend unavailable, fallback:", e);
  }

  // 2. 降级到 DuckDuckGo Instant Answer API
  const results = await duckDuckGoSearch(query, maxResults);
  return { query, results, source: "duckduckgo" };
}

/** DuckDuckGo Instant Answer API 搜索 */
async function duckDuckGoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`web_search failed: ${resp.status}`);
  }
  const data = await resp.json();

  const out: SearchResult[] = [];

  // Abstract 主题
  if (data.AbstractText && data.AbstractURL) {
    out.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      snippet: data.AbstractText,
    });
  }

  // Related Topics（平铺 + 子话题）
  const topics: any[] = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  for (const t of topics) {
    if (out.length >= maxResults) break;
    if (t.Text && t.FirstURL) {
      out.push({ title: t.Text.split(" - ")[0] || t.Text, url: t.FirstURL, snippet: t.Text });
    } else if (Array.isArray(t.Topics)) {
      for (const sub of t.Topics) {
        if (out.length >= maxResults) break;
        if (sub.Text && sub.FirstURL) {
          out.push({
            title: sub.Text.split(" - ")[0] || sub.Text,
            url: sub.FirstURL,
            snippet: sub.Text,
          });
        }
      }
    }
  }

  // 结果不足时补充查询链接
  if (out.length === 0) {
    out.push({
      title: `在浏览器中搜索 “${query}”`,
      url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      snippet: "未找到 Instant Answer，可点击在浏览器中查看完整搜索结果。",
    });
  }

  return out.slice(0, maxResults);
}

// ========================= 导出 handlers =========================

export const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  web_search: webSearch,
};
