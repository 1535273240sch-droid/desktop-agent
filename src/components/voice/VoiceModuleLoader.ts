import { defineComponent, h, onErrorCaptured, ref, type Component } from "vue";
// 重新导出标准 API 契约，供自定义模块实现时引用
export type { VoiceModuleProps, VoiceModuleEmits } from "@/types";

/**
 * 语音模块加载器
 *
 * 职责：
 * 1. 动态加载 .vue 组件文件（运行时路径，经 Vite @vite-ignore 处理）
 * 2. 提供并校验标准 API 契约（VoiceModuleProps / VoiceModuleEmits）
 * 3. 沙箱执行：用错误边界包裹自定义模块，捕获其渲染/运行时异常，避免拖垮主界面
 * 4. 默认回退到内置 VoiceOverlay
 */

export interface VoiceModuleMeta {
  name?: string;
  version?: string;
}

interface VoiceModuleExport {
  default?: Component;
  __voiceModuleMeta?: VoiceModuleMeta;
}

/**
 * 校验加载到的对象是否为合法 Vue 组件。
 * 自定义模块应 `export default defineComponent({...})` 或导出 SFC 默认对象。
 */
function assertVueComponent(comp: unknown, modulePath: string): asserts comp is Component {
  if (comp == null) {
    throw new Error(`[VoiceModuleLoader] 模块 ${modulePath} 未导出任何内容`);
  }
  const isFn = typeof comp === "function";
  const isObj = typeof comp === "object";
  const hasRender = isObj && typeof (comp as Record<string, unknown>).render === "function";
  const hasSetup = isObj && typeof (comp as Record<string, unknown>).setup === "function";
  if (!(isFn || hasRender || hasSetup)) {
    throw new Error(
      `[VoiceModuleLoader] 模块 ${modulePath} 未导出有效的 Vue 组件（需要 default 导出）`
    );
  }
}

/**
 * 原始加载：按路径动态 import 一个 .vue / .js / .ts 模块，返回其默认导出组件。
 * 不做任何回退，加载或校验失败时直接抛出，由调用方决定如何处理。
 *
 * 注意：Vite 运行时动态 import 需要路径可被 dev server / 打包产物解析。
 * 用户自制的模块应放置在可被解析的位置（例如 src 下或通过插件机制预编译）。
 */
export async function loadCustomVoiceModule(modulePath: string): Promise<Component> {
  if (!modulePath || typeof modulePath !== "string") {
    throw new Error("[VoiceModuleLoader] modulePath 不能为空");
  }

  const mod = (await import(/* @vite-ignore */ modulePath)) as VoiceModuleExport;
  const comp = mod?.default ?? (mod as unknown as Component);
  assertVueComponent(comp, modulePath);

  // 记录模块元信息（可选），便于调试
  if (mod.__voiceModuleMeta) {
    console.debug(
      `[VoiceModuleLoader] 已加载自定义语音模块: ${mod.__voiceModuleMeta.name ?? modulePath} ` +
        `v${mod.__voiceModuleMeta.version ?? "?"}`
    );
  }
  return comp;
}

/**
 * 错误边界：包裹自定义模块，捕获其渲染/生命周期异常，
 * 出错时展示降级 UI，而非白屏整个应用。返回新的包装组件。
 */
export function withErrorBoundary(inner: Component): Component {
  return defineComponent({
    name: "VoiceModuleErrorBoundary",
    setup() {
      const error = ref<Error | null>(null);
      onErrorCaptured((err) => {
        error.value = err as Error;
        console.error("[VoiceModuleLoader] 自定义语音模块运行时错误:", err);
        // 阻止错误继续向上冒泡，避免影响主界面
        return false;
      });
      return () => {
        if (error.value) {
          return h(
            "div",
            {
              style: {
                position: "fixed",
                inset: "0",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "column",
                gap: "8px",
                background: "rgba(20,18,40,0.6)",
                color: "#fff",
                fontFamily: "system-ui, sans-serif",
                zIndex: 200,
              },
            },
            [
              h("div", { style: { fontSize: "15px", fontWeight: 600 } }, "语音模块运行出错"),
              h(
                "div",
                { style: { fontSize: "12px", opacity: 0.8, maxWidth: "420px", textAlign: "center" } },
                String(error.value.message ?? error.value)
              ),
            ]
          );
        }
        return h(inner);
      };
    },
  });
}

/**
 * 加载语音模块（带回退）：
 * - 提供 modulePath 时，尝试加载并校验自定义模块，并用错误边界包裹；
 * - 加载失败则回退到内置 VoiceOverlay。
 * - 未提供 modulePath 时，直接使用内置 VoiceOverlay。
 */
export async function loadVoiceModule(modulePath?: string): Promise<Component> {
  if (modulePath) {
    try {
      const comp = await loadCustomVoiceModule(modulePath);
      return withErrorBoundary(comp);
    } catch (e) {
      console.warn("[VoiceModuleLoader] 自定义模块加载失败，回退到内置 VoiceOverlay:", e);
    }
  }
  const builtin = await import("./VoiceOverlay.vue");
  return builtin.default;
}

/**
 * 标准契约常量，供自定义模块开发参考与运行时自检。
 */
export const VOICE_MODULE_CONTRACT = {
  props: [
    "audioStream",
    "state",
    "userTranscript",
    "aiTranscript",
    "operationLog",
    "themeVars",
    "agentAvatar",
    "agentName",
  ] as const,
  emits: ["onMute", "onEnd", "onInterrupt", "onDesktopControl"] as const,
} as const;

export type VoiceModuleContractProps = (typeof VOICE_MODULE_CONTRACT)["props"][number];
export type VoiceModuleContractEmits = (typeof VOICE_MODULE_CONTRACT)["emits"][number];
