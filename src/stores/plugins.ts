// stores/plugins.ts - 插件 Pinia store
// 技能包列表管理 + 功能扩展列表管理 + 导入/删除/启用/禁用 + localStorage 持久化

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { SkillPack, FunctionExtension } from "@/types";
import {
  skillPackManager,
  type LoadedSkillPack,
} from "@/services/plugins/skillPack";
import {
  extensionManager,
  type LoadedExtension,
} from "@/services/plugins/extension";

// ========================= 持久化结构 =========================

/**
 * 仅持久化外部扩展的清单 + 脚本路径（内置不持久化）
 * 内置技能包/扩展在 init 时自动注册
 */
interface PersistedExternalPack {
  manifest: SkillPack;
  scriptPath: string;
}

interface PersistedExternalExtension {
  manifest: FunctionExtension;
  scriptPath: string;
}

interface PluginsPersistState {
  externalPacks: PersistedExternalPack[];
  externalExtensions: PersistedExternalExtension[];
  /** 启用/禁用状态覆盖（id → enabled），同时覆盖内置 */
  packEnabledOverride: Record<string, boolean>;
  extEnabledOverride: Record<string, boolean>;
}

const STORAGE_KEY = "desktop-agent-plugins";

// ========================= Store =========================

export const usePluginsStore = defineStore("plugins", () => {
  // ============== 状态 ==============
  const loaded = ref(false);
  const initializing = ref(false);

  /** 已加载技能包（响应式镜像 skillPackManager） */
  const skillPacks = ref<LoadedSkillPack[]>([]);
  /** 已加载功能扩展（响应式镜像 extensionManager） */
  const extensions = ref<LoadedExtension[]>([]);

  /** 持久化的外部技能包（用于重启后重新加载） */
  const persistedPacks = ref<PersistedExternalPack[]>([]);
  /** 持久化的外部扩展 */
  const persistedExtensions = ref<PersistedExternalExtension[]>([]);

  /** 启用/禁用覆盖 */
  const packEnabledOverride = ref<Record<string, boolean>>({});
  const extEnabledOverride = ref<Record<string, boolean>>({});

  // ============== 计算属性 ==============

  const enabledPacks = computed(() => skillPacks.value.filter((p) => p.pack.enabled));
  const disabledPacks = computed(() => skillPacks.value.filter((p) => !p.pack.enabled));
  const enabledExtensions = computed(() => extensions.value.filter((e) => e.ext.enabled));
  const disabledExtensions = computed(() => extensions.value.filter((e) => !e.ext.enabled));

  /** 所有可用工具数（来自启用的技能包） */
  const totalTools = computed(() =>
    enabledPacks.value.reduce((n, p) => n + p.pack.tools.length, 0),
  );

  /** 所有已注册组件数 */
  const totalComponents = computed(() =>
    enabledExtensions.value.reduce((n, e) => n + e.ext.components.length, 0),
  );

  /** 所有已注册命令数 */
  const totalCommands = computed(() =>
    enabledExtensions.value.reduce((n, e) => n + e.ext.commands.length, 0),
  );

  // ============== 内部：同步镜像 ==============

  /** 把 manager 中的状态同步到响应式 ref */
  function _syncPacks() {
    skillPacks.value = skillPackManager.list();
  }
  function _syncExtensions() {
    extensions.value = extensionManager.list();
  }

  // ============== 持久化 ==============

  function _loadPersisted(): PluginsPersistState | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as PluginsPersistState;
    } catch (e) {
      console.error("[plugins store] failed to load persisted state:", e);
      return null;
    }
  }

  function _persist() {
    const state: PluginsPersistState = {
      externalPacks: persistedPacks.value,
      externalExtensions: persistedExtensions.value,
      packEnabledOverride: packEnabledOverride.value,
      extEnabledOverride: extEnabledOverride.value,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("[plugins store] failed to persist state:", e);
    }
  }

  // ============== 初始化 ==============

  /** 启动时调用：注册内置 + 重新加载外部 + 应用启用状态 */
  async function init() {
    if (loaded.value || initializing.value) return;
    initializing.value = true;
    try {
      // 1. 初始化两个 manager（注册内置）
      await skillPackManager.init();
      await extensionManager.init();

      // 2. 加载持久化状态
      const persisted = _loadPersisted();
      if (persisted) {
        persistedPacks.value = persisted.externalPacks ?? [];
        persistedExtensions.value = persisted.externalExtensions ?? [];
        packEnabledOverride.value = persisted.packEnabledOverride ?? {};
        extEnabledOverride.value = persisted.extEnabledOverride ?? [];

        // 3. 重新加载外部技能包
        for (const p of persistedPacks.value) {
          try {
            await skillPackManager.loadFromManifest(p.manifest, p.scriptPath);
          } catch (e) {
            console.error(`[plugins store] failed to reload pack "${p.manifest.id}":`, e);
          }
        }

        // 4. 重新加载外部扩展
        for (const e of persistedExtensions.value) {
          try {
            await extensionManager.loadFromManifest(e.manifest, e.scriptPath);
          } catch (err) {
            console.error(`[plugins store] failed to reload ext "${e.manifest.id}":`, err);
          }
        }

        // 5. 应用启用/禁用覆盖
        for (const [id, enabled] of Object.entries(packEnabledOverride.value)) {
          try {
            if (enabled) skillPackManager.enable(id);
            else skillPackManager.disable(id);
          } catch (e) {
            console.warn(`[plugins store] failed to apply pack "${id}" enabled=${enabled}:`, e);
          }
        }
        for (const [id, enabled] of Object.entries(extEnabledOverride.value)) {
          try {
            if (enabled) extensionManager.enable(id);
            else extensionManager.disable(id);
          } catch (e) {
            console.warn(`[plugins store] failed to apply ext "${id}" enabled=${enabled}:`, e);
          }
        }
      }

      _syncPacks();
      _syncExtensions();
      loaded.value = true;
    } finally {
      initializing.value = false;
    }
  }

  // ============== 技能包操作 ==============

  /** 导入外部技能包 */
  async function importSkillPack(manifest: SkillPack, scriptPath: string) {
    const loadedPack = await skillPackManager.loadFromManifest(manifest, scriptPath);
    persistedPacks.value.push({ manifest, scriptPath });
    packEnabledOverride.value[manifest.id] = manifest.enabled;
    _syncPacks();
    _persist();
    return loadedPack;
  }

  /** 从 JSON 字符串导入技能包 */
  async function importSkillPackFromJson(manifestJson: string, scriptPath: string) {
    const manifest = JSON.parse(manifestJson) as SkillPack;
    return importSkillPack(manifest, scriptPath);
  }

  /** 删除技能包（外部可删，内置仅禁用） */
  function removeSkillPack(id: string) {
    const existing = skillPackManager.get(id);
    if (!existing) return;

    skillPackManager.unload(id);
    if (existing.source === "external") {
      persistedPacks.value = persistedPacks.value.filter((p) => p.manifest.id !== id);
    }
    delete packEnabledOverride.value[id];
    _syncPacks();
    _persist();
  }

  /** 启用技能包 */
  function enableSkillPack(id: string) {
    skillPackManager.enable(id);
    packEnabledOverride.value[id] = true;
    _syncPacks();
    _persist();
  }

  /** 禁用技能包 */
  function disableSkillPack(id: string) {
    skillPackManager.disable(id);
    packEnabledOverride.value[id] = false;
    _syncPacks();
    _persist();
  }

  /** 切换启用状态 */
  function toggleSkillPack(id: string) {
    const existing = skillPackManager.get(id);
    if (!existing) return;
    if (existing.pack.enabled) disableSkillPack(id);
    else enableSkillPack(id);
  }

  /** 热重载技能包 */
  async function reloadSkillPack(id: string) {
    await skillPackManager.reload(id);
    _syncPacks();
  }

  // ============== 功能扩展操作 ==============

  /** 导入外部扩展 */
  async function importExtension(manifest: FunctionExtension, scriptPath: string) {
    const loadedExt = await extensionManager.loadFromManifest(manifest, scriptPath);
    persistedExtensions.value.push({ manifest, scriptPath });
    extEnabledOverride.value[manifest.id] = manifest.enabled;
    _syncExtensions();
    _persist();
    return loadedExt;
  }

  /** 从 JSON 字符串导入扩展 */
  async function importExtensionFromJson(manifestJson: string, scriptPath: string) {
    const manifest = JSON.parse(manifestJson) as FunctionExtension;
    return importExtension(manifest, scriptPath);
  }

  /** 删除扩展 */
  function removeExtension(id: string) {
    const existing = extensionManager.get(id);
    if (!existing) return;

    extensionManager.unload(id);
    if (existing.source === "external") {
      persistedExtensions.value = persistedExtensions.value.filter(
        (e) => e.manifest.id !== id,
      );
    }
    delete extEnabledOverride.value[id];
    _syncExtensions();
    _persist();
  }

  /** 启用扩展 */
  function enableExtension(id: string) {
    extensionManager.enable(id);
    extEnabledOverride.value[id] = true;
    _syncExtensions();
    _persist();
  }

  /** 禁用扩展 */
  function disableExtension(id: string) {
    extensionManager.disable(id);
    extEnabledOverride.value[id] = false;
    _syncExtensions();
    _persist();
  }

  /** 切换启用状态 */
  function toggleExtension(id: string) {
    const existing = extensionManager.get(id);
    if (!existing) return;
    if (existing.ext.enabled) disableExtension(id);
    else enableExtension(id);
  }

  /** 热重载扩展 */
  async function reloadExtension(id: string) {
    await extensionManager.reload(id);
    _syncExtensions();
  }

  // ============== 命令执行 ==============

  /** 扩展命令调用 */
  async function executeCommand(name: string, args?: Record<string, any>) {
    return extensionManager.executeCommand(name, args);
  }

  // ============== 查询 ==============

  function getSkillPack(id: string): LoadedSkillPack | undefined {
    return skillPackManager.get(id);
  }

  function getExtension(id: string): LoadedExtension | undefined {
    return extensionManager.get(id);
  }

  function isBuiltinPack(id: string): boolean {
    return skillPackManager.get(id)?.source === "builtin";
  }

  function isBuiltinExtension(id: string): boolean {
    return extensionManager.get(id)?.source === "builtin";
  }

  return {
    // 状态
    loaded,
    initializing,
    skillPacks,
    extensions,
    persistedPacks,
    persistedExtensions,
    // 计算属性
    enabledPacks,
    disabledPacks,
    enabledExtensions,
    disabledExtensions,
    totalTools,
    totalComponents,
    totalCommands,
    // 初始化
    init,
    // 技能包
    importSkillPack,
    importSkillPackFromJson,
    removeSkillPack,
    enableSkillPack,
    disableSkillPack,
    toggleSkillPack,
    reloadSkillPack,
    // 扩展
    importExtension,
    importExtensionFromJson,
    removeExtension,
    enableExtension,
    disableExtension,
    toggleExtension,
    reloadExtension,
    // 命令
    executeCommand,
    // 查询
    getSkillPack,
    getExtension,
    isBuiltinPack,
    isBuiltinExtension,
  };
});
