import { defineStore } from "pinia";
import { ref, watch } from "vue";
import type { ThemePack } from "@/types";
import { useSettingsStore } from "./settings";

// 默认极光玻璃主题
export const auroraGlassTheme: ThemePack = {
  id: "aurora-glass",
  name: "极光玻璃",
  description: "基于玻璃拟态的清透紫蓝主题，高透玻璃配多层立体阴影，轻盈通透的未来质感",
  light: {
    "--theme-color": "#5B4FC4",
    "--bg-base": "#B5C2F0",
    "--bg-surface": "rgba(255, 255, 255, 0.26)",
    "--bg-elevated": "rgba(255, 255, 255, 0.4)",
    "--bg-hover": "rgba(91, 79, 196, 0.08)",
    "--bg-input": "rgba(255, 255, 255, 0.35)",
    "--glass-bg": "rgba(255, 255, 255, 0.18)",
    "--glass-bg-strong": "rgba(245, 242, 255, 0.34)",
    "--glass-border": "rgba(255, 255, 255, 0.55)",
    "--glass-highlight": "rgba(255, 255, 255, 0.85)",
    "--glass-shadow": "0 1px 2px rgba(26, 24, 48, 0.08), 0 8px 24px rgba(26, 24, 48, 0.12), 0 32px 80px rgba(26, 24, 48, 0.14)",
    "--border-DEFAULT": "rgba(255, 255, 255, 0.5)",
    "--border-subtle": "rgba(255, 255, 255, 0.3)",
    "--border-hover": "rgba(255, 255, 255, 0.85)",
    "--glow-color": "color-mix(in srgb, var(--theme-color) 30%, transparent)",
    "--text-primary": "#2A2360",
    "--text-secondary": "#5B4FC4",
    "--text-muted": "#8B82C9",
    "--orb-1": "color-mix(in srgb, var(--theme-color) 22%, transparent)",
    "--orb-2": "rgba(56, 189, 248, 0.22)",
    "--orb-3": "rgba(168, 130, 255, 0.2)",
  },
  dark: {
    "--theme-color": "#8B7FE8",
    "--bg-base": "#1A1830",
    "--bg-surface": "rgba(45, 40, 72, 0.32)",
    "--bg-elevated": "rgba(55, 48, 88, 0.48)",
    "--bg-hover": "rgba(139, 127, 232, 0.1)",
    "--bg-input": "rgba(30, 27, 50, 0.55)",
    "--glass-bg": "rgba(45, 40, 72, 0.28)",
    "--glass-bg-strong": "rgba(55, 48, 88, 0.42)",
    "--glass-border": "rgba(255, 255, 255, 0.12)",
    "--glass-highlight": "rgba(255, 255, 255, 0.1)",
    "--glass-shadow": "0 1px 3px rgba(0, 0, 0, 0.32), 0 8px 28px rgba(0, 0, 0, 0.42), 0 32px 80px rgba(0, 0, 0, 0.48)",
    "--border-DEFAULT": "rgba(255, 255, 255, 0.12)",
    "--border-subtle": "rgba(255, 255, 255, 0.07)",
    "--border-hover": "rgba(255, 255, 255, 0.26)",
    "--glow-color": "color-mix(in srgb, var(--theme-color) 45%, transparent)",
    "--text-primary": "#EAE6FF",
    "--text-secondary": "#B8B0E8",
    "--text-muted": "#7A72A8",
    "--orb-1": "color-mix(in srgb, var(--theme-color) 30%, transparent)",
    "--orb-2": "rgba(34, 211, 238, 0.14)",
    "--orb-3": "rgba(147, 96, 255, 0.16)",
  },
};

const STORAGE_KEY = "desktop-agent-themes";

export const useThemeStore = defineStore("theme", () => {
  const settingsStore = useSettingsStore();
  const themes = ref<ThemePack[]>([auroraGlassTheme]);
  const currentTheme = ref<ThemePack>(auroraGlassTheme);
  const isDark = ref(false);

  function load() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const custom = JSON.parse(stored) as ThemePack[];
        themes.value = [auroraGlassTheme, ...custom];
      }
    } catch (e) {
      console.error("Failed to load themes:", e);
    }
    const themeId = settingsStore.settings.theme.currentThemeId;
    const theme = themes.value.find((t) => t.id === themeId) ?? auroraGlassTheme;
    currentTheme.value = theme;
    applyTheme();
  }

  function applyTheme() {
    const root = document.documentElement;
    const vars = isDark.value
      ? currentTheme.value.dark
      : currentTheme.value.light;

    // 清除旧主题变量
    root.removeAttribute("data-theme");

    // 应用深浅色
    if (settingsStore.settings.theme.darkMode === "auto") {
      isDark.value = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } else {
      isDark.value = settingsStore.settings.theme.darkMode === "dark";
    }

    root.setAttribute("data-theme", isDark.value ? "dark" : "light");

    // 注入CSS变量
    const allVars = isDark.value
      ? { ...currentTheme.value.dark }
      : { ...currentTheme.value.light };

    // 合并用户自定义覆盖
    Object.assign(allVars, settingsStore.settings.theme.customOverrides);

    for (const [key, value] of Object.entries(allVars)) {
      root.style.setProperty(key, value);
    }

    // 应用字体（用引号包裹 family，避免多词字体名被解析为多个 family）
    if (settingsStore.settings.font.uiFont) {
      root.style.setProperty("--font-ui", `"${settingsStore.settings.font.uiFont}", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`);
    } else {
      root.style.setProperty("--font-ui", `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`);
    }
    if (settingsStore.settings.font.codeFont) {
      root.style.setProperty("--font-code", `"${settingsStore.settings.font.codeFont}", "JetBrains Mono", "Fira Code", Consolas, monospace`);
    } else {
      root.style.setProperty("--font-code", `"JetBrains Mono", "Fira Code", Consolas, monospace`);
    }
    root.style.setProperty("--font-size-ui", `${settingsStore.settings.font.uiFontSize}px`);
    root.style.setProperty("--font-size-code", `${settingsStore.settings.font.codeFontSize}px`);
    root.style.setProperty("--font-weight-ui", `${settingsStore.settings.font.uiFontWeight}`);
  }

  function switchTheme(themeId: string) {
    const theme = themes.value.find((t) => t.id === themeId);
    if (theme) {
      currentTheme.value = theme;
      settingsStore.updateTheme({ currentThemeId: themeId });
      applyTheme();
    }
  }

  function toggleDarkMode() {
    const newMode = isDark.value ? "light" : "dark";
    settingsStore.updateTheme({ darkMode: newMode });
    isDark.value = !isDark.value;
    applyTheme();
  }

  function setDarkMode(mode: "light" | "dark" | "auto") {
    settingsStore.updateTheme({ darkMode: mode });
    applyTheme();
  }

  function importTheme(pack: ThemePack) {
    const idx = themes.value.findIndex((t) => t.id === pack.id);
    if (idx !== -1) {
      themes.value[idx] = pack;
    } else {
      themes.value.push(pack);
    }
    saveCustomThemes();
  }

  function deleteTheme(themeId: string) {
    if (themeId === auroraGlassTheme.id) return;
    themes.value = themes.value.filter((t) => t.id !== themeId);
    if (currentTheme.value.id === themeId) {
      switchTheme(auroraGlassTheme.id);
    }
    saveCustomThemes();
  }

  function saveCustomThemes() {
    const custom = themes.value.filter((t) => t.id !== auroraGlassTheme.id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
  }

  function updateCustomOverrides(overrides: Record<string, string>) {
    settingsStore.updateTheme({ customOverrides: overrides });
    applyTheme();
  }

  // 监听系统深浅色变化
  if (typeof window !== "undefined") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (settingsStore.settings.theme.darkMode === "auto") {
        applyTheme();
      }
    });
  }

  return {
    themes,
    currentTheme,
    isDark,
    load,
    applyTheme,
    switchTheme,
    toggleDarkMode,
    setDarkMode,
    importTheme,
    deleteTheme,
    updateCustomOverrides,
  };
});
