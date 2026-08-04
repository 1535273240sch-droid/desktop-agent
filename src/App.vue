<template>
  <div class="app-container" :class="{ 'theme-transition': isTransitioning }">
    <!-- 极光背景 -->
    <div v-if="settings.settings.theme.auroraOrbs" class="aurora-bg">
      <div class="aurora-orb" />
      <div class="aurora-orb" />
      <div class="aurora-orb" />
    </div>

    <!-- 开机动画 -->
    <BootAnimation
      v-if="showBootAnimation"
      @complete="onBootComplete"
      @skip="onBootComplete"
    />

    <!-- 引导配置 -->
    <OnboardingWizard
      v-else-if="showOnboarding"
      @complete="onOnboardingComplete"
      @skip="onOnboardingComplete"
    />

    <!-- 主界面 -->
    <template v-else>
      <!-- 标题栏 -->
      <TitleBar />

      <!-- 三栏布局 -->
      <div class="main-layout">
        <Sidebar />
        <ChatView />
        <MemoryPanel v-if="memoryPanelVisible" />
      </div>

      <!-- 任务规划浮层（活动计划存在时显示） -->
      <TaskPlanOverlay v-if="taskPlanVisible" />

      <!-- 状态栏 -->
      <StatusBar />

      <!-- 语音模式覆盖层 -->
      <VoiceOverlay
        v-if="voiceMode"
        :state="voice.overallState"
        :user-transcript="voice.realtimeUserTranscript"
        :ai-transcript="voice.realtimeAiTranscript"
        :audio-stream="null"
        @on-end="endVoiceMode"
        @on-mute="voice.toggleMute"
        @on-interrupt="voice.interruptRealtime"
      />
    </template>

    <!-- 设置面板 -->
    <SettingsPanel v-if="settingsPanelVisible" />
  </div>
</template>

<script setup lang="ts">
import { ref, defineAsyncComponent, onMounted, onUnmounted, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { useThemeStore } from "@/stores/theme";
import { useChatStore } from "@/stores/chat";
import { useVoiceStore } from "@/stores/voice";
import { useTaskPlanStore } from "@/stores/taskPlan";
import { startChatController } from "@/services/chatController";
import BootAnimation from "@/components/BootAnimation.vue";
import TitleBar from "@/components/TitleBar.vue";
import Sidebar from "@/components/Sidebar.vue";
import ChatView from "@/components/chat/ChatView.vue";
import StatusBar from "@/components/StatusBar.vue";

// 懒加载非首屏必需的重型组件（减小首屏 bundle 体积）
const OnboardingWizard = defineAsyncComponent({
  loader: () => import("@/components/OnboardingWizard.vue"),
  delay: 200,
});
const MemoryPanel = defineAsyncComponent({
  loader: () => import("@/components/memory/MemoryPanel.vue"),
  delay: 200,
});
const VoiceOverlay = defineAsyncComponent({
  loader: () => import("@/components/voice/VoiceOverlay.vue"),
  delay: 200,
});
const SettingsPanel = defineAsyncComponent({
  loader: () => import("@/components/settings/SettingsPanel.vue"),
  delay: 200,
});
const TaskPlanOverlay = defineAsyncComponent({
  loader: () => import("@/components/chat/TaskPlanOverlay.vue"),
  delay: 200,
});

const settings = useSettingsStore();
const theme = useThemeStore();
const chat = useChatStore();
const voice = useVoiceStore();

const showBootAnimation = ref(true);
const showOnboarding = ref(false);
const isTransitioning = ref(false);
const memoryPanelVisible = ref(true);
const voiceMode = ref(false);
const settingsPanelVisible = ref(false);
const taskPlanVisible = ref(false);

const taskPlanStore = useTaskPlanStore();
let stopChatController: (() => void) | null = null;

// 进入语音模式时启动实时语音对话；退出时停止
watch(voiceMode, async (on) => {
  if (on) {
    try {
      voice.init();
      await voice.startRealtime();
    } catch (e) {
      console.warn("[voice] start realtime failed:", e);
      voiceMode.value = false;
    }
  } else {
    await voice.stopRealtime();
  }
});

function endVoiceMode() {
  voiceMode.value = false;
}

function onBootComplete() {
  showBootAnimation.value = false;
  if (settings.settings.firstRun && !settings.settings.onboardingCompleted) {
    showOnboarding.value = true;
  }
}

function onOnboardingComplete() {
  showOnboarding.value = false;
  settings.completeOnboarding();
}

onMounted(async () => {
  await settings.load();
  await theme.load();
  await chat.load();
  theme.applyTheme();

  // 若开机动画被禁用，直接进入主流程
  if (!settings.settings.bootAnimation?.enabled) {
    showBootAnimation.value = false;
    if (settings.settings.firstRun && !settings.settings.onboardingCompleted) {
      showOnboarding.value = true;
    }
  }

  // 加载任务计划
  taskPlanStore.load();
  // 有进行中的计划则显示浮层
  taskPlanVisible.value = taskPlanStore.activePlans.length > 0;

  // 启动核心聊天流程控制器（监听 chat:send 事件）
  stopChatController = startChatController();

  // 监听全局事件
  window.addEventListener("toggle-memory-panel", () => {
    memoryPanelVisible.value = !memoryPanelVisible.value;
  });
  window.addEventListener("toggle-voice-mode", () => {
    voiceMode.value = !voiceMode.value;
  });
  window.addEventListener("toggle-settings", () => {
    settingsPanelVisible.value = !settingsPanelVisible.value;
  });
  window.addEventListener("toggle-dark-mode", () => {
    theme.toggleDarkMode();
  });
  window.addEventListener("toggle-task-plan", () => {
    taskPlanVisible.value = !taskPlanVisible.value;
  });
  window.addEventListener("emergency-stop", () => {
    voiceMode.value = false;
    chat.stopStreaming(chat.activeConversationId ?? "");
  });
});

onUnmounted(() => {
  window.removeEventListener("toggle-memory-panel", () => {});
  window.removeEventListener("toggle-voice-mode", () => {});
  window.removeEventListener("toggle-settings", () => {});
  window.removeEventListener("toggle-dark-mode", () => {});
  window.removeEventListener("toggle-task-plan", () => {});
  window.removeEventListener("emergency-stop", () => {});
  stopChatController?.();
});
</script>

<style scoped>
.app-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

.main-layout {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
  z-index: 1;
}
</style>
