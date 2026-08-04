/// <reference types="vite/client" />

// 允许从 node_modules 导入 CSS 文件（如 katex/dist/katex.min.css）
declare module "*.css";
declare module "*.scss";
declare module "*.sass";

// katex CSS 子路径导入
declare module "katex/dist/katex.min.css";

// highlight.js lib/core 子路径导入
declare module "highlight.js/lib/core";
declare module "highlight.js/lib/languages/*";
