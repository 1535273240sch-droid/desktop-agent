// plugins/extension.ts - 功能扩展管理器
// 加载功能扩展(JSON+JS) + 热加载 + UI组件注册 + 工具命令注册 + 启用/禁用
// 内置示例：番茄钟（计时器组件）+ 计算器（计算器组件）

import { defineComponent, h, ref, computed, type Component } from "vue";
import type { FunctionExtension, ExtensionCommand } from "@/types";

// ========================= 外部扩展脚本契约 =========================

/**
 * 外部扩展脚本导出契约
 * - components: 组件名 → Vue 组件
 * - commands: 命令名 → 处理函数
 */
export interface ExternalExtensionScript {
  components?: Record<string, Component>;
  commands?: Record<string, (args?: Record<string, any>) => any>;
  default?: {
    components?: Record<string, Component>;
    commands?: Record<string, (args?: Record<string, any>) => any>;
  };
}

// ========================= 已加载扩展 =========================

export interface LoadedExtension {
  ext: FunctionExtension;
  /** 组件名 → Vue 组件 */
  components: Map<string, Component>;
  /** 命令名 → 处理函数 */
  commands: Map<string, (args?: Record<string, any>) => any>;
  /** 来源：内置 / 外部 */
  source: "builtin" | "external";
  /** 外部脚本路径（用于热重载） */
  scriptPath?: string;
  /** 加载时间戳 */
  loadedAt: number;
}

// ========================= 错误类型 =========================

export class ExtensionError extends Error {
  constructor(
    message: string,
    public code: "not-found" | "circular-dep" | "missing-dep" | "load-failed" | "duplicate",
  ) {
    super(message);
    this.name = "ExtensionError";
  }
}

// ========================= 内置组件：番茄钟 =========================

/** 番茄钟组件：25分钟工作 + 5分钟休息，可启停/重置 */
const PomodoroComponent = defineComponent({
  name: "BuiltinPomodoro",
  setup() {
    const WORK_MS = 25 * 60 * 1000;
    const BREAK_MS = 5 * 60 * 1000;
    const remaining = ref(WORK_MS);
    const running = ref(false);
    const isBreak = ref(false);
    let timer: ReturnType<typeof setInterval> | null = null;

    const fmt = (ms: number) => {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const m = String(Math.floor(total / 60)).padStart(2, "0");
      const s = String(total % 60).padStart(2, "0");
      return `${m}:${s}`;
    };

    const display = computed(() => fmt(remaining.value));
    const phase = computed(() => (isBreak.value ? "休息" : "工作"));

    const tick = () => {
      remaining.value -= 1000;
      if (remaining.value <= 0) {
        isBreak.value = !isBreak.value;
        remaining.value = isBreak.value ? BREAK_MS : WORK_MS;
      }
    };

    const start = () => {
      if (running.value) return;
      running.value = true;
      timer = setInterval(tick, 1000);
    };
    const pause = () => {
      running.value = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const reset = () => {
      pause();
      isBreak.value = false;
      remaining.value = WORK_MS;
    };

    return () =>
      h("div", { class: "ext-pomodoro", style: { textAlign: "center", padding: "16px" } }, [
        h("div", { style: { fontSize: "14px", opacity: 0.7, marginBottom: "8px" } }, `番茄钟 · ${phase.value}`),
        h("div", { style: { fontSize: "40px", fontVariantNumeric: "tabular-nums", fontWeight: 600 } }, display.value),
        h("div", { style: { display: "flex", gap: "8px", justifyContent: "center", marginTop: "12px" } }, [
          h(
            "button",
            { onClick: running.value ? pause : start, style: _btnStyle() },
            running.value ? "暂停" : "开始",
          ),
          h("button", { onClick: reset, style: _btnStyle() }, "重置"),
        ]),
      ]);
  },
});

// ========================= 内置组件：计算器 =========================

/** 计算器组件：基础四则运算 */
const CalculatorComponent = defineComponent({
  name: "BuiltinCalculator",
  setup() {
    const expr = ref("");
    const result = ref("0");

    const press = (key: string) => {
      if (key === "C") {
        expr.value = "";
        result.value = "0";
        return;
      }
      if (key === "Del") {
        expr.value = expr.value.slice(0, -1);
        return;
      }
      if (key === "=") {
        evaluate();
        return;
      }
      expr.value += key;
    };

    const evaluate = () => {
      try {
        // 仅允许数字与 + - * / . ( )
        if (!/^[0-9+\-*/.() ]+$/.test(expr.value)) {
          result.value = "Error";
          return;
        }
        // eslint-disable-next-line no-new-func
        const val = Function(`"use strict";return (${expr.value})`)();
        result.value = String(val);
      } catch {
        result.value = "Error";
      }
    };

    const keys = ["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "=", "+", "C", "Del"];

    return () =>
      h("div", { class: "ext-calculator", style: { padding: "12px", maxWidth: "240px" } }, [
        h("div", { style: { fontSize: "12px", opacity: 0.7, marginBottom: "4px" } }, "计算器"),
        h(
          "div",
          { style: { fontSize: "13px", opacity: 0.6, minHeight: "18px", textAlign: "right" } },
          expr.value || " ",
        ),
        h(
          "div",
          { style: { fontSize: "24px", fontWeight: 600, textAlign: "right", marginBottom: "8px" } },
          result.value,
        ),
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "4px" } },
          keys.map((k) =>
            h(
              "button",
              {
                onClick: () => press(k),
                style: {
                  padding: "8px",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "6px",
                  background: "rgba(255,255,255,0.05)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                },
              },
              k,
            ),
          ),
        ),
      ]);
  },
});

function _btnStyle(): Record<string, string> {
  return {
    padding: "6px 14px",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "6px",
    background: "rgba(255,255,255,0.06)",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

// ========================= 内置扩展定义 =========================

const BUILTIN_EXTENSIONS: Array<{
  ext: FunctionExtension;
  components: Record<string, Component>;
  commands: Record<string, (args?: Record<string, any>) => any>;
}> = [
  {
    ext: {
      id: "builtin.pomodoro",
      name: "番茄钟",
      description: "25 分钟工作 + 5 分钟休息的计时器组件",
      version: "1.0.0",
      author: "system",
      dependencies: [],
      components: ["Pomodoro"],
      commands: [
        {
          name: "pomodoro.start",
          description: "启动番茄钟",
          shortcut: "Ctrl+Shift+P",
          handler: "builtin:pomodoro.start",
        },
        {
          name: "pomodoro.reset",
          description: "重置番茄钟",
          handler: "builtin:pomodoro.reset",
        },
      ],
      enabled: true,
    },
    components: { Pomodoro: PomodoroComponent },
    commands: {
      "pomodoro.start": () => console.info("[pomodoro] start command"),
      "pomodoro.reset": () => console.info("[pomodoro] reset command"),
    },
  },
  {
    ext: {
      id: "builtin.calculator",
      name: "计算器",
      description: "基础四则运算计算器组件",
      version: "1.0.0",
      author: "system",
      dependencies: [],
      components: ["Calculator"],
      commands: [
        {
          name: "calculator.evaluate",
          description: "计算表达式",
          handler: "builtin:calculator.evaluate",
        },
      ],
      enabled: true,
    },
    components: { Calculator: CalculatorComponent },
    commands: {
      "calculator.evaluate": (args?: Record<string, any>) => {
        const expr = String(args?.expr ?? "");
        if (!/^[0-9+\-*/.() ]+$/.test(expr)) throw new Error("invalid expression");
        // eslint-disable-next-line no-new-func
        return Function(`"use strict";return (${expr})`)();
      },
    },
  },
];

// ========================= 管理器 =========================

class ExtensionManager {
  /** 已加载扩展：id → LoadedExtension */
  private extensions = new Map<string, LoadedExtension>();
  /** 全局组件注册表：组件名 → { component, extId } */
  private componentRegistry = new Map<string, { component: Component; extId: string }>();
  /** 全局命令注册表：命令名 → { handler, extId, shortcut, meta } */
  private commandRegistry = new Map<
    string,
    { handler: (args?: Record<string, any>) => any; extId: string; shortcut?: string; meta: ExtensionCommand }
  >();
  /** 是否已初始化 */
  private initialized = false;

  // ============== 初始化 ==============

  /** 启动时调用：注册所有内置扩展 */
  async init(): Promise<void> {
    if (this.initialized) return;
    for (const def of BUILTIN_EXTENSIONS) {
      this._registerBuiltin(def.ext, def.components, def.commands);
    }
    this.initialized = true;
    console.info(
      `[ExtensionManager] initialized with ${this.extensions.size} extensions, ` +
        `${this.componentRegistry.size} components, ${this.commandRegistry.size} commands`,
    );
  }

  /** 注册内置扩展 */
  private _registerBuiltin(
    ext: FunctionExtension,
    components: Record<string, Component>,
    commands: Record<string, (args?: Record<string, any>) => any>,
  ): void {
    if (this.extensions.has(ext.id)) {
      console.warn(`[ExtensionManager] builtin ext "${ext.id}" already exists, overwriting`);
    }
    const loaded: LoadedExtension = {
      ext,
      components: new Map(Object.entries(components)),
      commands: new Map(Object.entries(commands)),
      source: "builtin",
      loadedAt: Date.now(),
    };
    this.extensions.set(ext.id, loaded);
    if (ext.enabled) {
      this._registerExtResources(loaded);
    }
  }

  // ============== 外部加载（热加载） ==============

  /**
   * 从清单 + 脚本路径加载外部扩展
   * - 导入后立即生效，不需要重启
   */
  async loadFromManifest(
    manifest: FunctionExtension,
    scriptPath: string,
  ): Promise<LoadedExtension> {
    if (this.extensions.has(manifest.id)) {
      throw new ExtensionError(`extension "${manifest.id}" already loaded`, "duplicate");
    }
    this._validateDependencies(manifest);

    const { components, commands } = await this._loadScript(scriptPath);

    const loaded: LoadedExtension = {
      ext: manifest,
      components: new Map(Object.entries(components)),
      commands: new Map(Object.entries(commands)),
      source: "external",
      scriptPath,
      loadedAt: Date.now(),
    };
    this.extensions.set(manifest.id, loaded);

    if (manifest.enabled) {
      this._registerExtResources(loaded);
    }

    console.info(
      `[ExtensionManager] loaded external ext "${manifest.id}" ` +
        `(${components.size} components, ${commands.size} commands)`,
    );
    return loaded;
  }

  /** 从 JSON 字符串加载清单 */
  async loadFromJson(manifestJson: string, scriptPath: string): Promise<LoadedExtension> {
    let manifest: FunctionExtension;
    try {
      manifest = JSON.parse(manifestJson);
    } catch (e) {
      throw new ExtensionError(
        `invalid manifest JSON: ${(e as Error).message}`,
        "load-failed",
      );
    }
    return this.loadFromManifest(manifest, scriptPath);
  }

  /** 加载外部脚本，提取 components 与 commands */
  private async _loadScript(scriptPath: string): Promise<{
    components: Record<string, Component>;
    commands: Record<string, (args?: Record<string, any>) => any>;
  }> {
    let mod: ExternalExtensionScript;
    try {
      mod = (await import(/* @vite-ignore */ scriptPath)) as ExternalExtensionScript;
    } catch (e) {
      throw new ExtensionError(
        `failed to import script "${scriptPath}": ${(e as Error).message}`,
        "load-failed",
      );
    }
    const components = mod.components ?? mod.default?.components ?? {};
    const commands = mod.commands ?? mod.default?.commands ?? {};
    return { components, commands };
  }

  // ============== 热重载 ==============

  /** 热重载指定扩展（仅外部扩展支持） */
  async reload(id: string): Promise<LoadedExtension> {
    const existing = this.extensions.get(id);
    if (!existing) {
      throw new ExtensionError(`extension "${id}" not found`, "not-found");
    }
    if (existing.source !== "external" || !existing.scriptPath) {
      throw new ExtensionError(`builtin ext "${id}" cannot be reloaded`, "load-failed");
    }

    this._unregisterExtResources(existing);
    const { components, commands } = await this._loadScript(existing.scriptPath);
    existing.components = new Map(Object.entries(components));
    existing.commands = new Map(Object.entries(commands));
    existing.loadedAt = Date.now();

    if (existing.ext.enabled) {
      this._registerExtResources(existing);
    }
    console.info(`[ExtensionManager] reloaded ext "${id}"`);
    return existing;
  }

  // ============== 启用 / 禁用 ==============

  enable(id: string): void {
    const loaded = this.extensions.get(id);
    if (!loaded) throw new ExtensionError(`extension "${id}" not found`, "not-found");
    if (loaded.ext.enabled) return;

    // 校验依赖已启用
    for (const dep of loaded.ext.dependencies) {
      const depExt = this.extensions.get(dep);
      if (!depExt) {
        throw new ExtensionError(`dependency "${dep}" of ext "${id}" not loaded`, "missing-dep");
      }
      if (!depExt.ext.enabled) {
        throw new ExtensionError(`dependency "${dep}" of ext "${id}" not enabled`, "missing-dep");
      }
    }

    loaded.ext.enabled = true;
    this._registerExtResources(loaded);
    console.info(`[ExtensionManager] enabled ext "${id}"`);
  }

  disable(id: string): void {
    const loaded = this.extensions.get(id);
    if (!loaded) throw new ExtensionError(`extension "${id}" not found`, "not-found");
    if (!loaded.ext.enabled) return;

    // 级联禁用依赖项
    for (const [depId, depExt] of this.extensions) {
      if (depExt.ext.dependencies.includes(id) && depExt.ext.enabled) {
        console.warn(`[ExtensionManager] cascading disable "${depId}" (depends on "${id}")`);
        this.disable(depId);
      }
    }

    loaded.ext.enabled = false;
    this._unregisterExtResources(loaded);
    console.info(`[ExtensionManager] disabled ext "${id}"`);
  }

  // ============== 卸载 ==============

  unload(id: string): void {
    const loaded = this.extensions.get(id);
    if (!loaded) return;

    for (const [depId, depExt] of this.extensions) {
      if (depExt.ext.dependencies.includes(id)) {
        if (depExt.ext.enabled) this.disable(depId);
        console.warn(`[ExtensionManager] cascading unload "${depId}" (depends on "${id}")`);
        this.unload(depId);
      }
    }

    this._unregisterExtResources(loaded);
    this.extensions.delete(id);
    console.info(`[ExtensionManager] unloaded ext "${id}"`);
  }

  // ============== 依赖解析 ==============

  /** 拓扑排序：依赖在前 */
  resolveDependencies(ids: string[]): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: string[] = [];

    const visit = (id: string, path: string[]) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new ExtensionError(
          `circular dependency: ${[...path, id].join(" → ")}`,
          "circular-dep",
        );
      }
      const ext = this.extensions.get(id);
      if (!ext) {
        throw new ExtensionError(`dependency "${id}" not loaded`, "missing-dep");
      }
      visiting.add(id);
      for (const dep of ext.ext.dependencies) visit(dep, [...path, id]);
      visiting.delete(id);
      visited.add(id);
      result.push(id);
    };

    for (const id of ids) visit(id, []);
    return result;
  }

  private _validateDependencies(ext: FunctionExtension): void {
    for (const dep of ext.dependencies) {
      if (!this.extensions.has(dep)) {
        throw new ExtensionError(`dependency "${dep}" of ext "${ext.id}" not loaded`, "missing-dep");
      }
    }
  }

  // ============== 资源注册 ==============

  /** 注册扩展的组件 + 命令到全局注册表 */
  private _registerExtResources(loaded: LoadedExtension): void {
    // 注册组件
    for (const [name, comp] of loaded.components) {
      if (!loaded.ext.components.includes(name)) {
        console.warn(
          `[ExtensionManager] ext "${loaded.ext.id}" component "${name}" not declared in manifest, registering anyway`,
        );
      }
      if (this.componentRegistry.has(name)) {
        console.warn(`[ExtensionManager] component "${name}" already registered, overwriting`);
      }
      this.componentRegistry.set(name, { component: comp, extId: loaded.ext.id });
    }

    // 注册命令
    for (const cmd of loaded.ext.commands) {
      const handler = loaded.commands.get(cmd.name);
      if (!handler) {
        console.warn(
          `[ExtensionManager] ext "${loaded.ext.id}" command "${cmd.name}" has no handler, skipping`,
        );
        continue;
      }
      if (this.commandRegistry.has(cmd.name)) {
        console.warn(`[ExtensionManager] command "${cmd.name}" already registered, overwriting`);
      }
      this.commandRegistry.set(cmd.name, {
        handler,
        extId: loaded.ext.id,
        shortcut: cmd.shortcut,
        meta: cmd,
      });
    }
  }

  /** 注销扩展的组件 + 命令 */
  private _unregisterExtResources(loaded: LoadedExtension): void {
    for (const [name] of loaded.components) {
      const entry = this.componentRegistry.get(name);
      if (entry && entry.extId === loaded.ext.id) {
        this.componentRegistry.delete(name);
      }
    }
    for (const cmd of loaded.ext.commands) {
      const entry = this.commandRegistry.get(cmd.name);
      if (entry && entry.extId === loaded.ext.id) {
        this.commandRegistry.delete(cmd.name);
      }
    }
  }

  // ============== 组件查询 ==============

  /** 获取已注册组件 */
  getComponent(name: string): Component | undefined {
    return this.componentRegistry.get(name)?.component;
  }

  /** 列出所有已注册组件 */
  listComponents(): Array<{ name: string; extId: string; component: Component }> {
    return Array.from(this.componentRegistry.entries()).map(([name, { component, extId }]) => ({
      name,
      extId,
      component,
    }));
  }

  // ============== 命令查询与执行 ==============

  /** 获取命令处理函数 */
  getCommand(name: string): ((args?: Record<string, any>) => any) | undefined {
    return this.commandRegistry.get(name)?.handler;
  }

  /** 列出所有已注册命令 */
  listCommands(): Array<{
    name: string;
    description: string;
    shortcut?: string;
    extId: string;
  }> {
    return Array.from(this.commandRegistry.entries()).map(([name, { meta, extId, shortcut }]) => ({
      name,
      description: meta.description,
      shortcut,
      extId,
    }));
  }

  /** 执行命令 */
  async executeCommand(name: string, args?: Record<string, any>): Promise<any> {
    const entry = this.commandRegistry.get(name);
    if (!entry) {
      throw new ExtensionError(`command "${name}" not found`, "not-found");
    }
    return entry.handler(args);
  }

  /** 获取快捷键映射：shortcut → command name */
  getShortcutMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [name, { shortcut }] of this.commandRegistry) {
      if (shortcut) map[shortcut] = name;
    }
    return map;
  }

  // ============== 查询 ==============

  get(id: string): LoadedExtension | undefined {
    return this.extensions.get(id);
  }

  has(id: string): boolean {
    return this.extensions.has(id);
  }

  list(): LoadedExtension[] {
    return Array.from(this.extensions.values());
  }

  listEnabled(): LoadedExtension[] {
    return this.list().filter((e) => e.ext.enabled);
  }

  /** 导出所有扩展清单（用于持久化） */
  exportManifests(): FunctionExtension[] {
    return this.list().map((e) => e.ext);
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

// ========================= 单例导出 =========================

export const extensionManager = new ExtensionManager();

/** 启动时调用：注册所有内置扩展 */
export async function initExtensions(): Promise<ExtensionManager> {
  await extensionManager.init();
  return extensionManager;
}
