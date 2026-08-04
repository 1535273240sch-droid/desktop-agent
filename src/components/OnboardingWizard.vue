<template>
  <div class="onboard-mask">
    <!-- 半透明 glass 背景 -->
    <div class="onboard-backdrop" />

    <div class="onboard-card glass-panel">
      <!-- 步骤指示器 -->
      <div class="steps-indicator">
        <div
          v-for="(s, i) in stepsMeta"
          :key="s.key"
          class="step-dot"
          :class="{
            active: i === current,
            done: i < current,
          }"
        >
          <span class="step-num">{{ i < current ? "✓" : i + 1 }}</span>
          <span class="step-name">{{ s.label }}</span>
        </div>
      </div>

      <!-- 步骤内容 -->
      <div class="step-body">
        <!-- 步骤1: 任务 API -->
        <div v-show="current === 0" class="step-pane">
          <h2 class="step-title">配置任务 API</h2>
          <p class="step-desc">用于 Agent 的核心对话与推理能力，支持 OpenAI 兼容接口。</p>
          <div class="form-grid">
            <label class="field">
              <span class="field-label">Base URL</span>
              <input
                v-model="local.task.baseUrl"
                class="input"
                type="text"
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label class="field">
              <span class="field-label">API Key</span>
              <input
                v-model="local.task.apiKey"
                class="input"
                type="password"
                placeholder="sk-..."
              />
            </label>
            <label class="field">
              <span class="field-label">Model</span>
              <input
                v-model="local.task.model"
                class="input"
                type="text"
                placeholder="gpt-4o / claude-3.5-sonnet / ..."
              />
            </label>
          </div>
        </div>

        <!-- 步骤2: 阶跃 API -->
        <div v-show="current === 1" class="step-pane">
          <h2 class="step-title">配置阶跃 API Key</h2>
          <p class="step-desc">用于识图、生图、TTS 与实时语音能力。</p>
          <div class="form-grid">
            <label class="field">
              <span class="field-label">API Key</span>
              <input
                v-model="local.step.apiKey"
                class="input"
                type="password"
                placeholder="阶跃 API Key"
              />
            </label>
            <label class="field">
              <span class="field-label">识图模型</span>
              <input
                v-model="local.step.visionModel"
                class="input"
                type="text"
                placeholder="step-1o-turbo-vision"
              />
            </label>
            <label class="field">
              <span class="field-label">生图模型</span>
              <input
                v-model="local.step.imageModel"
                class="input"
                type="text"
                placeholder="step-image-edit-2"
              />
            </label>
            <label class="field">
              <span class="field-label">TTS 模型</span>
              <input
                v-model="local.step.ttsModel"
                class="input"
                type="text"
                placeholder="step-tts-mini"
              />
            </label>
          </div>
        </div>

        <!-- 步骤3: 小米 API -->
        <div v-show="current === 2" class="step-pane">
          <h2 class="step-title">配置小米 API</h2>
          <p class="step-desc">用于小米 IoT 设备控制能力。</p>
          <div class="form-grid">
            <label class="field">
              <span class="field-label">API Key</span>
              <input
                v-model="local.xiaomi.apiKey"
                class="input"
                type="password"
                placeholder="小米 API Key"
              />
            </label>
            <label class="field">
              <span class="field-label">App ID</span>
              <input
                v-model="local.xiaomi.appId"
                class="input"
                type="text"
                placeholder="ioi.app.xxx"
              />
            </label>
          </div>
        </div>

        <!-- 步骤4: 主题和字体 -->
        <div v-show="current === 3" class="step-pane">
          <h2 class="step-title">外观与字体</h2>
          <p class="step-desc">选择主题与字体，可在设置中随时调整。</p>

          <div class="section-block">
            <div class="block-label">主题</div>
            <div class="theme-grid">
              <div
                v-for="t in themeStore.themes"
                :key="t.id"
                class="theme-card"
                :class="{ active: local.themeId === t.id }"
                @click="local.themeId = t.id"
              >
                <div class="theme-preview" :style="themePreviewStyle(t)" />
                <div class="theme-name">{{ t.name }}</div>
              </div>
            </div>
          </div>

          <div class="section-block">
            <div class="block-label">深浅模式</div>
            <div class="seg-toggle">
              <button
                v-for="m in ['light', 'dark', 'auto'] as const"
                :key="m"
                class="seg-opt"
                :class="{ active: local.darkMode === m }"
                type="button"
                @click="local.darkMode = m"
              >
                {{ m === "light" ? "浅色" : m === "dark" ? "深色" : "跟随系统" }}
              </button>
            </div>
          </div>

          <div class="section-block">
            <div class="block-label">字体</div>
            <div class="form-grid form-grid-2">
              <label class="field">
                <span class="field-label">界面字体</span>
                <input
                  v-model="local.uiFont"
                  class="input"
                  type="text"
                  placeholder="默认系统字体"
                />
              </label>
              <label class="field">
                <span class="field-label">代码字体</span>
                <input
                  v-model="local.codeFont"
                  class="input"
                  type="text"
                  placeholder="Fira Code / JetBrains Mono"
                />
              </label>
              <label class="field">
                <span class="field-label">界面字号 (px)</span>
                <input
                  v-model.number="local.uiFontSize"
                  class="input"
                  type="number"
                  min="11"
                  max="20"
                />
              </label>
              <label class="field">
                <span class="field-label">代码字号 (px)</span>
                <input
                  v-model.number="local.codeFontSize"
                  class="input"
                  type="number"
                  min="11"
                  max="20"
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部操作 -->
      <div class="step-footer">
        <button class="btn-ghost" type="button" @click="skipAll">
          全部跳过
        </button>
        <div class="footer-right">
          <button
            v-if="current > 0"
            class="btn-secondary"
            type="button"
            @click="prev"
          >
            上一步
          </button>
          <button class="btn-link" type="button" @click="skipStep">
            跳过此步
          </button>
          <button
            v-if="current < stepsMeta.length - 1"
            class="btn-primary"
            type="button"
            @click="next"
          >
            下一步
          </button>
          <button
            v-else
            class="btn-primary"
            type="button"
            @click="finish"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { useThemeStore } from "@/stores/theme";
import type { ThemePack } from "@/types";

const settings = useSettingsStore();
const themeStore = useThemeStore();

const emit = defineEmits<{
  (e: "complete"): void;
  (e: "skip"): void;
}>();

const stepsMeta = [
  { key: "task", label: "任务 API" },
  { key: "step", label: "阶跃 API" },
  { key: "xiaomi", label: "小米 API" },
  { key: "appearance", label: "外观字体" },
] as const;

const current = ref(0);

// 本地表单副本, 完成时统一写入 store
const local = reactive({
  task: {
    baseUrl: settings.settings.apiKeys.task.baseUrl,
    apiKey: settings.settings.apiKeys.task.apiKey,
    model: settings.settings.apiKeys.task.model,
  },
  step: {
    apiKey: settings.settings.apiKeys.step.apiKey,
    visionModel: settings.settings.apiKeys.step.visionModel,
    imageModel: settings.settings.apiKeys.step.imageModel,
    ttsModel: settings.settings.apiKeys.step.ttsModel,
  },
  xiaomi: {
    apiKey: settings.settings.apiKeys.xiaomi.apiKey,
    appId: settings.settings.apiKeys.xiaomi.appId,
  },
  themeId: settings.settings.theme.currentThemeId,
  darkMode: settings.settings.theme.darkMode,
  uiFont: settings.settings.font.uiFont,
  codeFont: settings.settings.font.codeFont,
  uiFontSize: settings.settings.font.uiFontSize,
  codeFontSize: settings.settings.font.codeFontSize,
});

function themePreviewStyle(t: ThemePack): Record<string, string> {
  return {
    background: `linear-gradient(135deg, ${t.light["--theme-color"]} 0%, ${t.dark["--theme-color"]} 100%)`,
    boxShadow: `0 0 0 1px ${t.light["--glass-border"]}`,
  };
}

function next() {
  if (current.value < stepsMeta.length - 1) {
    current.value++;
  }
}

function prev() {
  if (current.value > 0) {
    current.value--;
  }
}

function skipStep() {
  if (current.value < stepsMeta.length - 1) {
    next();
  } else {
    finish();
  }
}

function skipAll() {
  emit("skip");
}

async function finish() {
  // 写入设置
  await settings.updateTaskApi({
    baseUrl: local.task.baseUrl,
    apiKey: local.task.apiKey,
    model: local.task.model,
  });
  await settings.updateStepApi({
    apiKey: local.step.apiKey,
    visionModel: local.step.visionModel,
    imageModel: local.step.imageModel,
    ttsModel: local.step.ttsModel,
  });
  await settings.updateXiaomiApi({
    apiKey: local.xiaomi.apiKey,
    appId: local.xiaomi.appId,
  });
  await settings.updateTheme({
    currentThemeId: local.themeId,
    darkMode: local.darkMode,
  });
  await settings.updateFont({
    uiFont: local.uiFont,
    codeFont: local.codeFont,
    uiFontSize: local.uiFontSize,
    codeFontSize: local.codeFontSize,
  });
  themeStore.switchTheme(local.themeId);
  themeStore.setDarkMode(local.darkMode);
  emit("complete");
}
</script>

<style scoped>
.onboard-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.onboard-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(20, 18, 40, 0.45);
  backdrop-filter: blur(10px) saturate(140%);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
}

.onboard-card {
  position: relative;
  z-index: 1;
  width: 640px;
  max-width: 92vw;
  max-height: 88vh;
  border-radius: var(--radius-xl);
  padding: 28px 32px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow: hidden;
}

/* 步骤指示器 */
.steps-indicator {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.step-dot {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  position: relative;
  color: var(--text-muted);
}

.step-dot::before {
  content: "";
  position: absolute;
  top: 11px;
  left: -50%;
  width: 100%;
  height: 2px;
  background: var(--border-DEFAULT);
  z-index: 0;
}

.step-dot:first-child::before {
  display: none;
}

.step-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-input);
  border: 2px solid var(--border-DEFAULT);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  z-index: 1;
  transition: all 0.2s var(--ease-ios);
}

.step-dot.active .step-num {
  background: var(--theme-color);
  border-color: var(--theme-color);
  color: #fff;
}

.step-dot.done .step-num {
  background: var(--theme-color);
  border-color: var(--theme-color);
  color: #fff;
}

.step-dot.active .step-name {
  color: var(--text-primary);
  font-weight: 500;
}

.step-name {
  font-size: 11px;
  color: var(--text-muted);
}

/* 步骤内容 */
.step-body {
  flex: 1;
  min-height: 280px;
  overflow-y: auto;
  padding: 4px 2px;
}

.step-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.step-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.step-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 6px;
  line-height: 1.5;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.form-grid-2 {
  grid-template-columns: 1fr 1fr;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.input {
  height: 34px;
  padding: 0 10px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s var(--ease-ios);
}

.input:focus {
  border-color: var(--theme-color);
}

/* 第1步表单默认单列 */
.step-pane:first-child .form-grid {
  grid-template-columns: 1fr;
}

.section-block {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.block-label {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 500;
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
}

.theme-card {
  padding: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-ios), transform 0.12s var(--ease-ios);
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}

.theme-card:hover {
  border-color: var(--border-hover);
}

.theme-card.active {
  border-color: var(--theme-color);
  box-shadow: 0 0 0 1px var(--theme-color);
}

.theme-preview {
  width: 100%;
  height: 36px;
  border-radius: var(--radius-sm);
}

.theme-name {
  font-size: 11px;
  color: var(--text-secondary);
}

.seg-toggle {
  display: inline-flex;
  background: var(--bg-input);
  border: 1px solid var(--border-DEFAULT);
  border-radius: var(--radius-sm);
  padding: 2px;
  gap: 1px;
  align-self: flex-start;
}

.seg-opt {
  height: 26px;
  padding: 0 12px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s var(--ease-ios), color 0.15s var(--ease-ios);
}

.seg-opt:hover {
  color: var(--text-secondary);
}

.seg-opt.active {
  background: var(--theme-color);
  color: #fff;
}

/* 底部操作 */
.step-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 14px;
  border-top: 1px solid var(--border-subtle);
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-ghost,
.btn-secondary,
.btn-primary,
.btn-link {
  height: 32px;
  padding: 0 14px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s var(--ease-ios), color 0.15s var(--ease-ios);
}

.btn-ghost {
  background: transparent;
  color: var(--text-muted);
}

.btn-ghost:hover {
  color: var(--text-secondary);
}

.btn-link {
  background: transparent;
  color: var(--text-muted);
}

.btn-link:hover {
  color: var(--theme-color);
  text-decoration: underline;
}

.btn-secondary {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.btn-secondary:hover {
  background: var(--bg-elevated);
}

.btn-primary {
  background: var(--theme-color);
  color: #fff;
}

.btn-primary:hover {
  background: var(--theme-accent-hover, var(--theme-color));
}
</style>
