// tools/registry.ts - 工具注册中心
// 启动时自动注册所有可用工具到 function calling 的 tools 参数
// 6类工具：能力工具 / 桌面操控 / 沙箱执行 / 子Agent / 插件工具 / 文件操作

import { invoke } from "@tauri-apps/api/core";
import type { ToolDefinition } from "@/types";
import type { FunctionTool } from "@/services/api/taskApi";

// ========================= 类型扩展 =========================

export type ToolCategory =
  | "capability" // 能力工具（识图/生图/TTS/ASR等模型能力）
  | "desktop" // 桌面操控（窗口/输入/截图/剪贴板）
  | "sandbox" // 沙箱执行（Python/Shell/Node 代码运行）
  | "sub-agent" // 子Agent（多Agent协作）
  | "plugin" // 插件工具（SkillPack/FunctionExtension 提供）
  | "file"; // 文件操作（读写/搜索）

export interface RegisteredTool {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: Record<string, any>;
  /** 执行入口（来自 ToolDefinition.handler） */
  handler?: (args: Record<string, any>) => Promise<any>;
  /** 是否需要在沙箱中执行 */
  requiresSandbox?: boolean;
  /** 是否需要权限确认 */
  requiresPermission?: boolean;
}

// ========================= 内置工具定义 =========================

/** 能力工具：调用模型的多模态能力 */
const CAPABILITY_TOOLS: RegisteredTool[] = [
  {
    name: "capability.vision",
    description: "识别图片内容（基于阶跃 step-1o-turbo-vision）。输入 image(base64或URL) 与 prompt",
    category: "capability",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "图片 base64 或 URL" },
        prompt: { type: "string", description: "询问内容" },
      },
      required: ["image", "prompt"],
    },
  },
  {
    name: "capability.image_gen",
    description: "文生图（step-image-edit-2）。输入 prompt 与可选尺寸",
    category: "capability",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        width: { type: "integer", default: 1024 },
        height: { type: "integer", default: 1024 },
      },
      required: ["prompt"],
    },
  },
  {
    name: "capability.image_edit",
    description: "图生图（step-image-edit-2）。输入 prompt 与 referenceImage",
    category: "capability",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        referenceImage: { type: "string", description: "参考图 base64 或 URL" },
      },
      required: ["prompt", "referenceImage"],
    },
  },
  {
    name: "capability.tts",
    description: "文本转语音（StepAudio 2.5）。输入 text 与可选音色",
    category: "capability",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        voiceId: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "capability.asr",
    description: "语音识别（小米 MiMo 流式 ASR）",
    category: "capability",
    parameters: {
      type: "object",
      properties: {
        audio: { type: "string", description: "音频 base64" },
        format: { type: "string", enum: ["pcm16", "wav", "mp3"] },
      },
      required: ["audio"],
    },
  },
];

/** 桌面操控工具：通过 nuphus-mcp 桥接 */
const DESKTOP_TOOLS: RegisteredTool[] = [
  {
    name: "desktop.window_list",
    description: "列出当前所有窗口",
    category: "desktop",
    parameters: { type: "object", properties: {} },
    requiresPermission: true,
  },
  {
    name: "desktop.window_focus",
    description: "聚焦指定窗口",
    category: "desktop",
    parameters: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    requiresPermission: true,
  },
  {
    name: "desktop.screenshot",
    description: "截取屏幕",
    category: "desktop",
    parameters: {
      type: "object",
      properties: { region: { type: "string", enum: ["full", "active"], default: "full" } },
    },
  },
  {
    name: "desktop.mouse_click",
    description: "在屏幕指定坐标点击鼠标",
    category: "desktop",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
      },
      required: ["x", "y"],
    },
    requiresPermission: true,
  },
  {
    name: "desktop.keyboard_type",
    description: "键盘输入文本",
    category: "desktop",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    requiresPermission: true,
  },
  {
    name: "desktop.clipboard_read",
    description: "读取剪贴板内容",
    category: "desktop",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "desktop.clipboard_write",
    description: "写入剪贴板内容",
    category: "desktop",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

/** 沙箱执行工具 */
const SANDBOX_TOOLS: RegisteredTool[] = [
  {
    name: "sandbox.run_python",
    description: "在 Docker 沙箱中执行 Python 代码（预装 numpy/pandas/requests/matplotlib）",
    category: "sandbox",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
    requiresSandbox: true,
    requiresPermission: true,
  },
  {
    name: "sandbox.run_shell",
    description: "在 Docker 沙箱中执行 Shell 命令",
    category: "sandbox",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
    requiresSandbox: true,
    requiresPermission: true,
  },
  {
    name: "sandbox.run_node",
    description: "在 Docker 沙箱中执行 Node.js 代码",
    category: "sandbox",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
    requiresSandbox: true,
    requiresPermission: true,
  },
  {
    name: "sandbox.pip_install",
    description: "在沙箱中安装 Python 包（需要用户确认）",
    category: "sandbox",
    parameters: {
      type: "object",
      properties: { packages: { type: "array", items: { type: "string" } } },
      required: ["packages"],
    },
    requiresSandbox: true,
    requiresPermission: true,
  },
];

/** 子Agent 工具 */
const SUB_AGENT_TOOLS: RegisteredTool[] = [
  {
    name: "sub_agent.spawn",
    description: "派生子 Agent 处理独立子任务（多Agent协作）",
    category: "sub-agent",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "子Agent名称" },
        task: { type: "string", description: "子Agent任务描述" },
        context: { type: "string", description: "上下文信息" },
      },
      required: ["name", "task"],
    },
  },
  {
    name: "sub_agent.wait",
    description: "等待子 Agent 完成并获取结果",
    category: "sub-agent",
    parameters: {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
  },
];

/** 文件操作工具（通过 Rust 后端） */
const FILE_TOOLS: RegisteredTool[] = [
  {
    name: "file.read",
    description: "读取文件内容（支持文本/图片/PDF）",
    category: "file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    requiresPermission: true,
  },
  {
    name: "file.write",
    description: "写入文件",
    category: "file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    requiresPermission: true,
  },
  {
    name: "file.search",
    description: "在指定目录搜索文件（支持 glob 模式）",
    category: "file",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string" },
        pattern: { type: "string" },
        maxResults: { type: "integer", default: 200 },
      },
      required: ["root", "pattern"],
    },
  },
];

// ========================= 注册中心 =========================

class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private initialized = false;

  /** 注册单个工具 */
  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] tool "${tool.name}" already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 批量注册 */
  registerAll(tools: RegisteredTool[]): void {
    for (const t of tools) this.register(t);
  }

  /** 取消注册 */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** 启动时自动注册所有内置工具 + 远程工具发现 */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 注册内置工具
    this.registerAll([
      ...CAPABILITY_TOOLS,
      ...DESKTOP_TOOLS,
      ...SANDBOX_TOOLS,
      ...SUB_AGENT_TOOLS,
      ...FILE_TOOLS,
    ]);

    // 远程工具发现：从 nuphus-mcp 拉取可用工具列表
    await this.discoverRemoteTools().catch((e) => {
      console.warn("[ToolRegistry] remote discovery failed:", e);
    });

    this.initialized = true;
    console.info(`[ToolRegistry] initialized with ${this.tools.size} tools`);
  }

  /** 从 nuphus-mcp 发现可用工具 */
  private async discoverRemoteTools(): Promise<void> {
    try {
      const remote = await invoke<Array<{ name: string; description: string; group?: string }>>(
        "mcp_list_tools",
      );
      for (const t of remote) {
        // 避免与内置工具重名
        if (this.tools.has(t.name)) continue;
        this.register({
          name: t.name,
          description: t.description,
          category: this._mapGroup(t.group),
          parameters: { type: "object", properties: {} },
          requiresPermission: true,
        });
      }
    } catch (e) {
      // nuphus-mcp 尚未启动时静默跳过
    }
  }

  private _mapGroup(group?: string): ToolCategory {
    if (!group) return "desktop";
    const g = group.toLowerCase();
    if (g.includes("file")) return "file";
    if (g.includes("window")) return "desktop";
    if (g.includes("system")) return "desktop";
    if (g.includes("input")) return "desktop";
    if (g.includes("vision")) return "desktop";
    if (g.includes("clipboard")) return "desktop";
    if (g.includes("process")) return "desktop";
    if (g.includes("browser")) return "desktop";
    if (g.includes("network")) return "desktop";
    return "desktop";
  }

  /** 获取所有已注册工具 */
  list(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /** 按类别筛选 */
  listByCategory(category: ToolCategory): RegisteredTool[] {
    return this.list().filter((t) => t.category === category);
  }

  /** 查找工具 */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** 是否存在 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 导出为 function calling 使用的 tools 参数格式
   * @param categories 限定导出的类别（默认全部）
   */
  toFunctionTools(categories?: ToolCategory[]): FunctionTool[] {
    const list = categories
      ? this.list().filter((t) => categories.includes(t.category))
      : this.list();
    return list.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

// ========================= 单例导出 =========================

export const toolRegistry = new ToolRegistry();

/** 启动时调用：自动注册所有工具 */
export async function initToolRegistry(): Promise<ToolRegistry> {
  await toolRegistry.init();
  return toolRegistry;
}

/** 获取所有可用工具的 function calling 格式 */
export function getAvailableFunctionTools(categories?: ToolCategory[]): FunctionTool[] {
  return toolRegistry.toFunctionTools(categories);
}

// ========================= 自定义工具注册（插件入口） =========================

/**
 * 供 SkillPack / FunctionExtension 注册自定义工具
 * @param defs ToolDefinition 列表（来自插件清单）
 * @param categoryOverride 强制类别（插件统一为 "plugin"）
 */
export function registerCustomTools(
  defs: ToolDefinition[],
  categoryOverride: ToolCategory = "plugin",
): void {
  for (const d of defs) {
    toolRegistry.register({
      name: d.name,
      description: d.description,
      category: categoryOverride,
      parameters: d.parameters,
      handler: d.handler,
    });
  }
}
