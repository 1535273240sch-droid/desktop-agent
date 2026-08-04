// services/markdown/renderer.ts
// 高性能 Markdown 渲染器（模块级单例）
// 优化点：
// 1. highlight.js 改用 lib/core + 按需注册常用语言（体积 ~1.3MB → ~80KB）
// 2. katex 改为动态 import（仅当出现 $$/$ 时才加载，首屏可省 ~250KB）
// 3. 单例 MarkdownIt 实例避免每条消息重建
// 4. 渲染结果 LRU 缓存，相同内容直接命中

import MarkdownIt from "markdown-it";
import hljsCore from "highlight.js/lib/core";
// `MarkdownIt` 既是值也是类型（构造器 + 实例类型），直接复用即可
type MarkdownItInstance = MarkdownIt;

// ========================= 按需注册常用语言（同步） =========================
// 只注册最高频语言；未注册语言走 highlightAuto fallback 或纯文本
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import markdownLang from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import diff from "highlight.js/lib/languages/diff";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";

hljsCore.registerLanguage("javascript", javascript);
hljsCore.registerLanguage("js", javascript);
hljsCore.registerLanguage("typescript", typescript);
hljsCore.registerLanguage("ts", typescript);
hljsCore.registerLanguage("python", python);
hljsCore.registerLanguage("py", python);
hljsCore.registerLanguage("rust", rust);
hljsCore.registerLanguage("rs", rust);
hljsCore.registerLanguage("json", json);
hljsCore.registerLanguage("bash", bash);
hljsCore.registerLanguage("sh", bash);
hljsCore.registerLanguage("shell", shell);
hljsCore.registerLanguage("zsh", shell);
hljsCore.registerLanguage("xml", xml);
hljsCore.registerLanguage("html", xml);
hljsCore.registerLanguage("css", css);
hljsCore.registerLanguage("scss", scss);
hljsCore.registerLanguage("sql", sql);
hljsCore.registerLanguage("markdown", markdownLang);
hljsCore.registerLanguage("md", markdownLang);
hljsCore.registerLanguage("yaml", yaml);
hljsCore.registerLanguage("yml", yaml);
hljsCore.registerLanguage("ini", ini);
hljsCore.registerLanguage("toml", ini);
hljsCore.registerLanguage("diff", diff);
hljsCore.registerLanguage("c", c);
hljsCore.registerLanguage("cpp", cpp);
hljsCore.registerLanguage("c++", cpp);
hljsCore.registerLanguage("go", go);
hljsCore.registerLanguage("golang", go);
hljsCore.registerLanguage("java", java);

// ========================= KaTeX 懒加载 =========================
let _katexReady: Promise<typeof import("katex")["default"]> | null = null;

function loadKatex(): Promise<typeof import("katex")["default"]> {
  if (!_katexReady) {
    // katex JS + CSS 并行加载，CSS 通过 Vite 自动注入 <link>
    _katexReady = Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
      ([mod]) => mod.default,
    );
  }
  return _katexReady;
}

// ========================= 工具函数 =========================
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 数学占位：等 katex 加载后异步刷新
function renderMathPlaceholder(content: string, displayMode: boolean): string {
  const cls = displayMode ? "math-block math-pending" : "math-pending";
  return `<span class="${cls}" data-raw="${encodeURIComponent(content)}" data-display="${displayMode ? "1" : "0"}">${escapeHtml(content)}</span>`;
}

// 异步刷新所有 .math-pending 节点
let _katexFlushScheduled = false;
function scheduleMathFlush(root: HTMLElement) {
  if (_katexFlushScheduled) return;
  _katexFlushScheduled = true;
  queueMicrotask(() => {
    requestAnimationFrame(() => {
      _katexFlushScheduled = false;
      flushMathNodes(root);
    });
  });
}

async function flushMathNodes(root: HTMLElement) {
  const pendings = root.querySelectorAll<HTMLElement>(".math-pending");
  if (pendings.length === 0) return;
  const katex = await loadKatex();
  pendings.forEach((el) => {
    const raw = decodeURIComponent(el.dataset.raw || "");
    const display = el.dataset.display === "1";
    try {
      el.innerHTML = katex.renderToString(raw, {
        displayMode: display,
        throwOnError: false,
        strict: false,
      });
      el.classList.remove("math-pending");
    } catch {
      el.classList.remove("math-pending");
      el.classList.add("math-error");
    }
  });
}

// ========================= MarkdownIt 实例 =========================
let _md: MarkdownItInstance | null = null;

function getMd(): MarkdownItInstance {
  if (_md) return _md;

  const md: MarkdownItInstance = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    typographer: true,
  });

  // 链接：新窗口打开 + 安全 rel
  // RenderRule 类型：md.renderer.rules 的值类型，TypeScript 自动推断参数类型
  const rules = md.renderer.rules;
  const defaultLinkOpen = rules.link_open || rules.text!;
  rules.link_open = (tokens, idx, options, env, self) => {
    const aIndex = tokens[idx].attrIndex("target");
    if (aIndex < 0) {
      tokens[idx].attrPush(["target", "_blank"]);
      tokens[idx].attrPush(["rel", "noopener noreferrer"]);
    } else {
      tokens[idx].attrs![aIndex][1] = "_blank";
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  // 数学公式：$$...$$ 块级
  md.block.ruler.before(
    "fence",
    "math_block",
    (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      if (start + 2 > max) return false;
      if (state.src.charCodeAt(start) !== 0x24 || state.src.charCodeAt(start + 1) !== 0x24) return false;

      let line = startLine;
      let content = "";
      let found = false;
      const afterOpen = state.src.slice(start + 2, max);
      const closeIdx = afterOpen.indexOf("$$");
      if (closeIdx >= 0) {
        content = afterOpen.slice(0, closeIdx);
        found = true;
      } else {
        content = afterOpen + "\n";
        for (line = startLine + 1; line < endLine; line++) {
          const ls = state.bMarks[line] + state.tShift[line];
          const le = state.eMarks[line];
          const lt = state.src.slice(ls, le);
          const ci = lt.indexOf("$$");
          if (ci >= 0) {
            content += lt.slice(0, ci);
            found = true;
            break;
          }
          content += lt + "\n";
        }
      }
      if (!found) return false;
      if (!silent) {
        const token = state.push("math_block", "div", 0);
        token.content = content.trim();
        token.map = [startLine, line];
        token.markup = "$$";
      }
      state.line = line + 1;
      return true;
    },
  );

  rules.math_block = (tokens, idx) => {
    return `<div class="math-block">${renderMathPlaceholder(tokens[idx].content, true)}</div>`;
  };

  // 数学公式：$...$ 行内
  md.inline.ruler.after(
    "escape",
    "math_inline",
    (state, silent) => {
      if (state.src.charCodeAt(state.pos) !== 0x24) return false;
      if (state.src.charCodeAt(state.pos + 1) === 0x24) return false;
      const start = state.pos + 1;
      let end = start;
      while (end < state.posMax) {
        const code = state.src.charCodeAt(end);
        if (code === 0x24) break;
        if (code === 0x5c) {
          end += 2;
          continue;
        }
        if (code === 0x0a) return false;
        end++;
      }
      if (end >= state.posMax) return false;
      const content = state.src.slice(start, end);
      if (!content.trim()) return false;
      if (!silent) {
        const token = state.push("math_inline", "span", 0);
        token.content = content;
        token.markup = "$";
      }
      state.pos = end + 1;
      return true;
    },
  );

  rules.math_inline = (tokens, idx) => {
    return renderMathPlaceholder(tokens[idx].content, false);
  };

  // 代码块：高亮 + 复制按钮 + 语言标签
  rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const langName = (token.info || "").trim();
    const code = token.content;
    let highlighted: string;
    if (langName && hljsCore.getLanguage(langName)) {
      try {
        highlighted = hljsCore.highlight(code, { language: langName }).value;
      } catch {
        highlighted = escapeHtml(code);
      }
    } else {
      try {
        highlighted = hljsCore.highlightAuto(code).value;
      } catch {
        highlighted = escapeHtml(code);
      }
    }
    const langLabel = langName
      ? `<span class="code-lang">${escapeHtml(langName)}</span>`
      : `<span class="code-lang">text</span>`;
    return `<div class="code-block-wrapper"><div class="code-block-header">${langLabel}<button class="code-copy-btn" data-action="copy-code" type="button">复制</button></div><pre class="hljs"><code>${highlighted}</code></pre></div>`;
  };

  _md = md;
  return md;
}

// ========================= LRU 渲染缓存 =========================
const CACHE_MAX = 64;
const _cache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const v = _cache.get(key);
  if (v !== undefined) {
    // LRU: 命中后移到末尾
    _cache.delete(key);
    _cache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, value: string) {
  if (_cache.size >= CACHE_MAX) {
    const firstKey = _cache.keys().next().value;
    if (firstKey !== undefined) _cache.delete(firstKey);
  }
  _cache.set(key, value);
}

// ========================= 公共 API =========================

/**
 * 渲染 markdown 字符串为 HTML
 * @param content markdown 文本
 * @param rootEl 可选的根元素，传入后会异步刷新数学公式
 */
export function renderMarkdown(content: string, rootEl?: HTMLElement | null): string {
  if (!content) return "";
  const cached = cacheGet(content);
  if (cached !== undefined) {
    if (rootEl && cached.includes("math-pending")) scheduleMathFlush(rootEl);
    return cached;
  }
  const md = getMd();
  const html = md.render(content);
  // 含数学占位时不缓存（等 katex 加载后内容会变）
  if (!html.includes("math-pending")) {
    cacheSet(content, html);
  }
  if (rootEl && html.includes("math-pending")) scheduleMathFlush(rootEl);
  return html;
}

/** 清空渲染缓存（主题/字体变更后调用） */
export function clearMarkdownCache() {
  _cache.clear();
}

/** 预加载 katex（空闲时调用以提前预热） */
export function prefetchKatex() {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => {
      loadKatex();
    });
  } else {
    setTimeout(() => loadKatex(), 2000);
  }
}

export { escapeHtml };
