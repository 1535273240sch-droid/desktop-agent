import { defineStore } from "pinia";
import { ref, reactive } from "vue";
import type { AppSettings, TaskApiConfig, StepApiConfig, XiaomiApiConfig } from "@/types";

const STORAGE_KEY = "desktop-agent-settings";

function defaultSettings(): AppSettings {
  return {
    apiKeys: {
      task: {
        baseUrl: "",
        apiKey: "",
        model: "",
        temperature: 0.7,
        topP: 1.0,
        maxTokens: 4096,
        systemPrompt: "",
        customHeaders: {},
        advancedParams: {},
      },
      step: {
        apiKey: "",
        visionModel: "step-1o-turbo-vision",
        imageModel: "step-image-edit-2",
        ttsModel: "step-tts-mini",
        realtimeUrl: "",
      },
      xiaomi: {
        apiKey: "",
        appId: "",
      },
    },
    rateLimits: {
      task: {
        maxConcurrent: 3,
        requestsPerMinute: 60,
        retryAttempts: 5,
        retryBaseDelay: 1000,
        retryMaxDelay: 32000,
        queueMaxSize: 100,
      },
      step: {
        maxConcurrent: 3,
        requestsPerMinute: 30,
        retryAttempts: 5,
        retryBaseDelay: 1000,
        retryMaxDelay: 32000,
        queueMaxSize: 100,
      },
      xiaomi: {
        maxConcurrent: 3,
        requestsPerMinute: 30,
        retryAttempts: 5,
        retryBaseDelay: 1000,
        retryMaxDelay: 32000,
        queueMaxSize: 100,
      },
    },
    agentName: "小助",
    agentPersona: "",
    systemPrompt: "",
    voice: {
      voiceId: "",
      speed: 1.0,
      volume: 80,
      pitch: 0,
      autoInterrupt: true,
      ttsAutoPlay: false,
    },
    sandbox: {
      enabled: false,
      memoryLimit: "2g",
      cpuLimit: "2",
      diskLimit: "10g",
      networkMode: "http-only",
      autoDestroy: true,
      timeout: 30000,
    },
    theme: {
      currentThemeId: "aurora-glass",
      darkMode: "auto",
      customOverrides: {},
      auroraOrbs: true,
      glassEffect: true,
    },
    font: {
      uiFont: "",
      codeFont: "",
      uiFontSize: 14,
      codeFontSize: 13,
      uiFontWeight: 400,
      customFonts: [],
    },
    bootAnimation: {
      template: "aurora",
      durationMs: 1800,
      showSkipHint: true,
      enabled: true,
    },
    shortcuts: {
      "new-conversation": "Ctrl+N",
      "search": "Ctrl+K",
      "settings": "Ctrl+,",
      "send": "Enter",
    },
    firstRun: true,
    onboardingCompleted: false,
  };
}

export const useSettingsStore = defineStore("settings", () => {
  const settings = reactive<AppSettings>(defaultSettings());
  const loaded = ref(false);

  async function load() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // 深合并：确保新增的嵌套字段（如 bootAnimation、voice.modulePath 等）
        // 在旧持久化数据缺失时使用默认值，避免 undefined 引发类型错误
        deepMerge(settings, parsed);
      }
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
    loaded.value = true;
  }

  /** 深合并：将 src 的字段合并到 dst；对纯对象递归合并，其他类型直接覆盖 */
  function deepMerge(dst: any, src: any): void {
    if (!src || typeof src !== "object") return;
    for (const key of Object.keys(src)) {
      const sv = src[key];
      const dv = dst[key];
      if (
        sv && typeof sv === "object" && !Array.isArray(sv) &&
        dv && typeof dv === "object" && !Array.isArray(dv)
      ) {
        deepMerge(dv, sv);
      } else {
        dst[key] = sv;
      }
    }
  }

  async function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }

  async function updateTaskApi(config: Partial<TaskApiConfig>) {
    Object.assign(settings.apiKeys.task, config);
    await save();
  }

  async function updateStepApi(config: Partial<StepApiConfig>) {
    Object.assign(settings.apiKeys.step, config);
    await save();
  }

  async function updateXiaomiApi(config: Partial<XiaomiApiConfig>) {
    Object.assign(settings.apiKeys.xiaomi, config);
    await save();
  }

  async function updateVoice(config: Partial<typeof settings.voice>) {
    Object.assign(settings.voice, config);
    await save();
  }

  async function updateTheme(config: Partial<typeof settings.theme>) {
    Object.assign(settings.theme, config);
    await save();
  }

  async function updateFont(config: Partial<typeof settings.font>) {
    Object.assign(settings.font, config);
    await save();
  }

  async function updateBootAnimation(config: Partial<typeof settings.bootAnimation>) {
    Object.assign(settings.bootAnimation, config);
    await save();
  }

  async function completeOnboarding() {
    settings.firstRun = false;
    settings.onboardingCompleted = true;
    await save();
  }

  async function reset() {
    Object.assign(settings, defaultSettings());
    await save();
  }

  return {
    settings,
    loaded,
    load,
    save,
    updateTaskApi,
    updateStepApi,
    updateXiaomiApi,
    updateVoice,
    updateTheme,
    updateFont,
    updateBootAnimation,
    completeOnboarding,
    reset,
  };
});
