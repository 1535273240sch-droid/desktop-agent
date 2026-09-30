# Desktop Agent (桌面 AI 智能助理)

<div align="center">

![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square&logo=windows)
![Tauri](https://img.shields.io/badge/Tauri-v2.0-24C8D8?style=flat-square&logo=tauri)
![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?style=flat-square&logo=vuedotjs)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript)
![Vite](https://img.shields.io/badge/Vite-6.0-646CFF?style=flat-square&logo=vite)
![License](https://img.shields.io/badge/License-MIT-purple?style=flat-square)

<p align="center">
  <b>基于 Tauri v2 + Vue 3 + TypeScript 构建的高性能、低资源占用桌面级 AI 助理客户端</b><br>
  集成 D3.js 知识图谱动态可视化、KaTeX 数学公式渲染、代码高亮与系统级全局快捷键交互。
</p>

</div>

---

## 🌟 核心特性

- ⚡ **极致轻量与极速响应**：基于 **Tauri v2** 原生架构，内存占用远低于传统 Electron 方案，启动迅速，资源消耗极低。
- 🕸️ **D3.js 动态知识图谱**：内置 `d3-force` 力导向图引擎，支持节点拖拽、力学碰撞模拟、多级缩放与知识拓扑可视化呈现。
- 📝 **全功能 Markdown & 数学排版**：
  - 基于 `markdown-it` 实现高保真富文本流式解析；
  - 完美支持 `KaTeX` 数学与物理公式排版；
  - 集成 `highlight.js` 实现 50+ 种编程语言的代码高亮。
- 🖥️ **深层系统级集成**：
  - **全局快捷键**：支持自定义全局热键一键唤出 / 隐藏窗口；
  - **剪贴板联动**：监听与快速捕获剪贴板文本进行智能处理；
  - **桌面系统通知**：关键任务完成或后台状态变更时即时桌面弹窗提示；
  - **自动更新机制**：内置 Tauri Updater 增量更新与安全验签。
- 🎨 **现代 Fluent / 极简视觉设计**：深色模式适配、平滑交互动画与自适应响应式布局。

---

## 🏗️ 架构概览

```
┌────────────────────────────────────────────────────────┐
│                   Desktop Agent 客户端                  │
├──────────────────────────┬─────────────────────────────┤
│      前端展现层 (Vue 3)    │       原生宿主层 (Rust)      │
│  - Pinia 状态管理        │  - Tauri v2 Core            │
│  - D3.js 知识图谱画布     │  - 系统全局快捷键 (Shortcut) │
│  - Markdown + KaTeX 解析 │  - 原生文件对话框 / FS      │
│  - 代码语法高亮引擎       │  - 进程监控与托盘常驻       │
└──────────────────────────┴─────────────────────────────┘
```

---

## 🚀 快速开始

### 1. 环境准备
确保本机已安装：
- [Node.js](https://nodejs.org/) (>= 18.0.0)
- [Rust & Cargo](https://rustup.rs/) (用于编译 Tauri 底层)
- C++ 编译工具链（如 Windows 上的 Visual Studio C++ 生成工具）

### 2. 安装项目依赖
```bash
# 克隆仓库
git clone https://github.com/1535273240sch-droid/desktop-agent.git
cd desktop-agent

# 安装 npm 依赖
npm install
```

### 3. 本地开发与调试
```bash
# 启动 Vite 前端并拉起 Tauri 桌面原生窗口
npm run tauri dev
```

### 4. 生产环境打包构建
```bash
# 自动生成 Windows (.msi / .exe) 或对应平台的安装包
npm run tauri build
```
构建产物将输出在 `src-tauri/target/release/bundle/` 目录下。

---

## 📦 技术栈一览

| 维度 | 技术选型 | 说明 |
|---|---|---|
| **桌面框架** | **Tauri v2** | Rust 驱动的安全轻量跨平台原生应用底座 |
| **前端框架** | **Vue 3.5 + Vite 6** | 组合式 API (Composition API) + 极速热更新构建 |
| **语言规范** | **TypeScript 5.7** | 全流程严格类型推导与静态检查 |
| **状态流转** | **Pinia 2.3** | 响应式多模块全局状态管理 |
| **图谱可视化** | **D3.js (d3-force, d3-drag)** | 高性能物理力导向知识图谱渲染 |
| **排版引擎** | **markdown-it + KaTeX** | LaTeX 复杂数学公式与代码高亮排版 |

---

## 📄 开源许可

本项目遵循 [MIT License](LICENSE) 开源协议。
