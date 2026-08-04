// plugins/skillPack.ts - 技能包管理器
// 加载技能包(JSON+脚本) + 热加载(导入即生效) + 依赖声明解析 + 启用/禁用 + 注册工具到 function calling

import type { SkillPack, SkillTool, ToolDefinition } from "@/types";
import { toolRegistry, registerCustomTools } from "@/services/tools/registry";

// ========================= 内置技能包模块契约 =========================

/**
 * 内置技能包模块导出契约
 * - pack: 技能包元数据
 * - handlers: 工具名 → 处理函数 的映射
 */
export interface BuiltinSkillPackModule {
  pack: SkillPack;
  handlers: Record<string, (args: Record<string, any>) => Promise<any>>;
}

/** 外部技能包脚本模块导出契约（脚本需 default export 或命名 export handlers） */
export interface ExternalSkillPackScript {
  handlers?: Record<string, (args: Record<string, any>) => Promise<any>>;
  default?: Record<string, (args: Record<string, any>) => Promise<any>>;
}

// ========================= 已加载技能包 =========================

export interface LoadedSkillPack {
  pack: SkillPack;
  /** 工具名 → 处理函数 */
  handlers: Map<string, (args: Record<string, any>) => Promise<any>>;
  /** 来源：内置 / 外部 */
  source: "builtin" | "external";
  /** 外部脚本路径（用于热重载） */
  scriptPath?: string;
  /** 加载时间戳 */
  loadedAt: number;
}

// ========================= 错误类型 =========================

export class SkillPackError extends Error {
  constructor(
    message: string,
    public code: "not-found" | "circular-dep" | "missing-dep" | "load-failed" | "duplicate",
  ) {
    super(message);
    this.name = "SkillPackError";
  }
}

// ========================= 管理器 =========================

class SkillPackManager {
  /** 已加载技能包：id → LoadedSkillPack */
  private packs = new Map<string, LoadedSkillPack>();
  /** 是否已初始化 */
  private initialized = false;

  // ============== 初始化 ==============

  /** 启动时调用：注册所有内置技能包 */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 内置技能包：导入即注册（顺序无所谓，依赖在 enable 时校验）
    const builtins = await Promise.all([
      import("./builtin/webSearch"),
      import("./builtin/fileConvert"),
      import("./builtin/codeExec"),
    ]);

    for (const mod of builtins) {
      const m = mod as unknown as BuiltinSkillPackModule;
      this._registerBuiltin(m);
    }

    this.initialized = true;
    // 初始化后注册所有启用技能包的工具
    this.syncTools();
    console.info(
      `[SkillPackManager] initialized with ${this.packs.size} packs, ` +
        `${this.listEnabled().reduce((n, p) => n + p.pack.tools.length, 0)} tools`,
    );
  }

  // ============== 内置注册 ==============

  /** 注册内置技能包（不触发 syncTools，由 init 统一触发） */
  private _registerBuiltin(mod: BuiltinSkillPackModule): void {
    const pack = mod.pack;
    if (this.packs.has(pack.id)) {
      console.warn(`[SkillPackManager] builtin pack "${pack.id}" already exists, overwriting`);
    }
    const handlers = new Map<string, (args: Record<string, any>) => Promise<any>>();
    for (const tool of pack.tools) {
      const fn = mod.handlers[tool.name];
      if (fn) {
        handlers.set(tool.name, fn);
      } else {
        console.warn(
          `[SkillPackManager] builtin pack "${pack.id}" missing handler for tool "${tool.name}"`,
        );
      }
    }
    this.packs.set(pack.id, {
      pack,
      handlers,
      source: "builtin",
      loadedAt: Date.now(),
    });
  }

  // ============== 外部加载（热加载） ==============

  /**
   * 从清单 + 脚本路径加载外部技能包
   * - 导入后立即生效，不需要重启
   * @param manifest 技能包元数据
   * @param scriptPath 脚本文件路径（ES Module，导出 handlers）
   */
  async loadFromManifest(
    manifest: SkillPack,
    scriptPath: string,
  ): Promise<LoadedSkillPack> {
    if (this.packs.has(manifest.id)) {
      throw new SkillPackError(
        `skill pack "${manifest.id}" already loaded`,
        "duplicate",
      );
    }

    // 校验依赖：所有依赖必须已加载（不要求依赖已启用，注册时不影响）
    this._validateDependencies(manifest);

    // 动态导入脚本（Vite @vite-ignore 支持运行时路径）
    const handlers = await this._loadHandlersFromScript(scriptPath);

    const loaded: LoadedSkillPack = {
      pack: manifest,
      handlers,
      source: "external",
      scriptPath,
      loadedAt: Date.now(),
    };
    this.packs.set(manifest.id, loaded);

    // 热加载：立即注册工具到 function calling
    if (manifest.enabled) {
      this._registerPackTools(loaded);
    }

    console.info(
      `[SkillPackManager] loaded external pack "${manifest.id}" (${manifest.tools.length} tools)`,
    );
    return loaded;
  }

  /**
   * 从 JSON 字符串加载清单
   * @param manifestJson 清单 JSON 字符串
   * @param scriptPath 脚本路径
   */
  async loadFromJson(manifestJson: string, scriptPath: string): Promise<LoadedSkillPack> {
    let manifest: SkillPack;
    try {
      manifest = JSON.parse(manifestJson);
    } catch (e) {
      throw new SkillPackError(
        `invalid manifest JSON: ${(e as Error).message}`,
        "load-failed",
      );
    }
    return this.loadFromManifest(manifest, scriptPath);
  }

  /** 从脚本模块加载 handlers */
  private async _loadHandlersFromScript(
    scriptPath: string,
  ): Promise<Map<string, (args: Record<string, any>) => Promise<any>>> {
    let mod: ExternalSkillPackScript;
    try {
      mod = (await import(/* @vite-ignore */ scriptPath)) as ExternalSkillPackScript;
    } catch (e) {
      throw new SkillPackError(
        `failed to import script "${scriptPath}": ${(e as Error).message}`,
        "load-failed",
      );
    }
    const handlersMap = mod.handlers ?? mod.default ?? {};
    return new Map(Object.entries(handlersMap));
  }

  // ============== 热重载 ==============

  /**
   * 热重载指定技能包（仅外部技能包支持）
   * - 重新导入脚本
   * - 重新注册工具
   */
  async reload(id: string): Promise<LoadedSkillPack> {
    const existing = this.packs.get(id);
    if (!existing) {
      throw new SkillPackError(`skill pack "${id}" not found`, "not-found");
    }
    if (existing.source !== "external" || !existing.scriptPath) {
      throw new SkillPackError(
        `builtin pack "${id}" cannot be reloaded`,
        "load-failed",
      );
    }

    // 先卸载工具
    this._unregisterPackTools(existing);

    // 重新导入脚本
    const handlers = await this._loadHandlersFromScript(existing.scriptPath);
    existing.handlers = handlers;
    existing.loadedAt = Date.now();

    // 重新注册
    if (existing.pack.enabled) {
      this._registerPackTools(existing);
    }

    console.info(`[SkillPackManager] reloaded pack "${id}"`);
    return existing;
  }

  // ============== 启用 / 禁用 ==============

  /** 启用技能包：校验依赖后注册工具 */
  enable(id: string): void {
    const loaded = this.packs.get(id);
    if (!loaded) {
      throw new SkillPackError(`skill pack "${id}" not found`, "not-found");
    }
    if (loaded.pack.enabled) return;

    // 校验依赖已启用
    for (const dep of loaded.pack.dependencies) {
      const depPack = this.packs.get(dep);
      if (!depPack) {
        throw new SkillPackError(
          `dependency "${dep}" of pack "${id}" is not loaded`,
          "missing-dep",
        );
      }
      if (!depPack.pack.enabled) {
        throw new SkillPackError(
          `dependency "${dep}" of pack "${id}" is not enabled`,
          "missing-dep",
        );
      }
    }

    loaded.pack.enabled = true;
    this._registerPackTools(loaded);
    console.info(`[SkillPackManager] enabled pack "${id}"`);
  }

  /** 禁用技能包：注销工具，并禁用所有依赖它的包 */
  disable(id: string): void {
    const loaded = this.packs.get(id);
    if (!loaded) {
      throw new SkillPackError(`skill pack "${id}" not found`, "not-found");
    }
    if (!loaded.pack.enabled) return;

    // 级联禁用依赖此包的技能包
    for (const [depId, depPack] of this.packs) {
      if (depPack.pack.dependencies.includes(id) && depPack.pack.enabled) {
        console.warn(
          `[SkillPackManager] cascading disable "${depId}" (depends on "${id}")`,
        );
        this.disable(depId);
      }
    }

    loaded.pack.enabled = false;
    this._unregisterPackTools(loaded);
    console.info(`[SkillPackManager] disabled pack "${id}"`);
  }

  // ============== 卸载 ==============

  /** 卸载技能包：注销工具 + 移除记录（会级联禁用依赖项） */
  unload(id: string): void {
    const loaded = this.packs.get(id);
    if (!loaded) return;

    // 级联禁用依赖项
    for (const [depId, depPack] of this.packs) {
      if (depPack.pack.dependencies.includes(id)) {
        if (depPack.pack.enabled) this.disable(depId);
        console.warn(
          `[SkillPackManager] cascading unload "${depId}" (depends on "${id}")`,
        );
        this.unload(depId);
      }
    }

    this._unregisterPackTools(loaded);
    this.packs.delete(id);
    console.info(`[SkillPackManager] unloaded pack "${id}"`);
  }

  // ============== 依赖解析 ==============

  /**
   * 解析技能包间的依赖关系，返回拓扑排序后的加载顺序
   * - 用于批量加载时确定正确顺序
   * @param ids 需要排序的技能包 id 列表
   * @returns 拓扑排序后的 id 列表（依赖在前）
   */
  resolveDependencies(ids: string[]): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>(); // 用于检测环
    const result: string[] = [];

    const visit = (id: string, path: string[]) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new SkillPackError(
          `circular dependency detected: ${[...path, id].join(" → ")}`,
          "circular-dep",
        );
      }
      const pack = this.packs.get(id);
      if (!pack) {
        throw new SkillPackError(
          `dependency "${id}" is not loaded`,
          "missing-dep",
        );
      }
      visiting.add(id);
      for (const dep of pack.pack.dependencies) {
        visit(dep, [...path, id]);
      }
      visiting.delete(id);
      visited.add(id);
      result.push(id);
    };

    for (const id of ids) visit(id, []);
    return result;
  }

  /** 校验依赖是否都已加载（不检测环，环在 resolveDependencies 时检测） */
  private _validateDependencies(pack: SkillPack): void {
    for (const dep of pack.dependencies) {
      if (!this.packs.has(dep)) {
        throw new SkillPackError(
          `dependency "${dep}" of pack "${pack.id}" is not loaded`,
          "missing-dep",
        );
      }
    }
  }

  // ============== 工具注册 ==============

  /** 将单个技能包的工具注册到 function calling */
  private _registerPackTools(loaded: LoadedSkillPack): void {
    const defs: ToolDefinition[] = [];
    for (const tool of loaded.pack.tools) {
      const handler = loaded.handlers.get(tool.name);
      if (!handler) {
        console.warn(
          `[SkillPackManager] pack "${loaded.pack.id}" has no handler for tool "${tool.name}", skipping`,
        );
        continue;
      }
      defs.push({
        name: tool.name,
        description: tool.description,
        category: "plugin",
        parameters: tool.parameters,
        handler,
      });
    }
    if (defs.length > 0) {
      registerCustomTools(defs, "plugin");
    }
  }

  /** 注销单个技能包的工具 */
  private _unregisterPackTools(loaded: LoadedSkillPack): void {
    for (const tool of loaded.pack.tools) {
      toolRegistry.unregister(tool.name);
    }
  }

  /**
   * 同步所有已启用技能包的工具注册状态
   * - 先清空所有插件类工具，再按拓扑顺序重新注册
   * - 用于初始化或大批量变更后的一致性恢复
   */
  syncTools(): void {
    // 清空所有 plugin 类工具
    for (const t of toolRegistry.listByCategory("plugin")) {
      toolRegistry.unregister(t.name);
    }
    // 按拓扑顺序注册（依赖在前，确保被依赖的工具先可用）
    const enabledIds = this.listEnabled().map((p) => p.pack.id);
    let sortedIds: string[];
    try {
      sortedIds = this.resolveDependencies(enabledIds);
    } catch {
      // 出现环或缺失时，降级为按加载顺序
      sortedIds = enabledIds;
    }
    for (const id of sortedIds) {
      const loaded = this.packs.get(id);
      if (loaded && loaded.pack.enabled) {
        this._registerPackTools(loaded);
      }
    }
  }

  // ============== 查询 ==============

  /** 获取已加载技能包 */
  get(id: string): LoadedSkillPack | undefined {
    return this.packs.get(id);
  }

  /** 是否已加载 */
  has(id: string): boolean {
    return this.packs.has(id);
  }

  /** 列出所有已加载技能包 */
  list(): LoadedSkillPack[] {
    return Array.from(this.packs.values());
  }

  /** 列出所有已启用的技能包 */
  listEnabled(): LoadedSkillPack[] {
    return this.list().filter((p) => p.pack.enabled);
  }

  /** 列出所有工具（来自启用的技能包） */
  listTools(): SkillTool[] {
    return this.listEnabled().flatMap((p) => p.pack.tools);
  }

  /** 获取指定工具的处理函数 */
  getToolHandler(
    toolName: string,
  ): ((args: Record<string, any>) => Promise<any>) | undefined {
    for (const loaded of this.packs.values()) {
      if (!loaded.pack.enabled) continue;
      const fn = loaded.handlers.get(toolName);
      if (fn) return fn;
    }
    return undefined;
  }

  /** 导出所有技能包清单（用于持久化） */
  exportManifests(): SkillPack[] {
    return this.list().map((p) => p.pack);
  }

  /** 是否已初始化 */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// ========================= 单例导出 =========================

export const skillPackManager = new SkillPackManager();

/** 启动时调用：注册所有内置技能包 */
export async function initSkillPacks(): Promise<SkillPackManager> {
  await skillPackManager.init();
  return skillPackManager;
}
