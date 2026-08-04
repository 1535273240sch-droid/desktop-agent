import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

// ========================= 性能优化配置 =========================
//
// 目标：首屏 bundle < 200KB（gzip < 80KB），各 vendor 分块并行加载。
// 关键策略：
// 1. target esnext - 现代浏览器无需 polyfill，体积更小
// 2. minify esbuild + drop console/debug - 生产环境去除日志
// 3. cssCodeSplit - 每个 chunk 的 CSS 独立，避免大 CSS 阻塞
// 4. manualChunks - 细粒度分块，最大化浏览器并行下载 + 长期缓存
// 5. assetsInlineLimit - 小资源内联为 base64 减少 HTTP 请求

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  esbuild: {
    // 生产环境移除 console.log/debug，保留 warn/error
    drop: ["console", "debugger"],
    legalComments: "none",
    // 更激进的压缩
    minifyIdentifiers: true,
    minifySyntax: true,
    minifyWhitespace: true,
  },
  build: {
    // 现代浏览器目标，跳过 ES 兼容层
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
    // 大 chunk 不报警（vendor 拆分后单 chunk 仍可能较大）
    chunkSizeWarningLimit: 600,
    // CSS 按需分块
    cssCodeSplit: true,
    // 8KB 以下资源内联为 base64
    assetsInlineLimit: 8192,
    // 报告压缩后体积
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        // 文件名带内容哈希，长期缓存友好
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
        // 按依赖关系精细拆分 vendor，最大化并行加载
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;

          // katex 走动态 import，让 Rollup 自动拆为独立懒加载 chunk
          // （不返回 chunk 名，避免被合并进 vendor）
          if (id.includes("/node_modules/katex/")) {
            return undefined;
          }

          // Vue 生态（核心，必须最早加载）
          if (id.includes("/node_modules/vue/") || id.includes("/node_modules/@vue/")) {
            return "vendor-vue";
          }
          if (id.includes("/node_modules/pinia/")) {
            return "vendor-vue";
          }

          // Tauri API
          if (id.includes("/node_modules/@tauri-apps/api/")) {
            return "vendor-tauri";
          }

          // Markdown 渲染栈（不含 katex，katex 由动态 import 自动拆分）
          if (id.includes("/node_modules/markdown-it/")) {
            return "vendor-markdown";
          }
          if (id.includes("/node_modules/linkify-it/") || id.includes("/node_modules/mdurl/")) {
            return "vendor-markdown";
          }

          // highlight.js lib/core + 按需语言
          if (id.includes("/node_modules/highlight.js/")) {
            return "vendor-hljs";
          }

          // d3 系列仅记忆图谱用到，懒加载
          if (id.includes("/node_modules/d3-") || id.includes("/node_modules/delaunator/") || id.includes("/node_modules/robust-predicates/")) {
            return "vendor-d3";
          }

          // 其他第三方小依赖统一归入 vendor
          return "vendor";
        },
      },
    },
  },
});
