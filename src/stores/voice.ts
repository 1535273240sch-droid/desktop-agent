// stores/voice.ts - 语音 Pinia store
// ASR 状态(录音中/识别中) + 实时语音状态(听/思考/说) + TTS 播放状态
// + 音色列表和当前选择 + 转写文本管理

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { VoiceInfo } from "@/services/api/stepApi";
import {
  AsrService,
  type AsrEngine,
  type AsrStreamHandlers,
} from "@/services/voice/asr";
import {
  TtsService,
  type TtsParams,
  type TtsPlaybackState,
} from "@/services/voice/tts";
import {
  RealtimeService,
  type RealtimeState,
  type RealtimeHandlers,
} from "@/services/voice/realtime";
import { useSettingsStore } from "@/stores/settings";

// ========================= Store =========================

export const useVoiceStore = defineStore("voice", () => {
  const settingsStore = useSettingsStore();

  // ============== ASR 状态 ==============
  /** 是否正在录音 */
  const isRecording = ref(false);
  /** 是否正在识别（录音结束后的短暂处理窗口） */
  const isRecognizing = ref(false);
  /** 当前激活的 ASR 引擎 */
  const activeAsrEngine = ref<AsrEngine>("step");
  /** ASR 转写文本（实时，含 partial） */
  const asrTranscript = ref("");
  /** ASR 最终累计文本 */
  const asrFinalText = ref("");
  /** ASR 错误信息 */
  const asrError = ref<string | null>(null);

  // ============== 实时语音状态 ==============
  /** 实时语音是否已连接 */
  const realtimeConnected = ref(false);
  /** 实时语音状态：idle/listening/thinking/speaking */
  const realtimeState = ref<RealtimeState>("idle");
  /** 是否静音 */
  const realtimeMuted = ref(false);
  /** 用户转写（实时对话） */
  const realtimeUserTranscript = ref("");
  /** AI 转写（实时对话） */
  const realtimeAiTranscript = ref("");
  /** 实时语音错误 */
  const realtimeError = ref<string | null>(null);

  // ============== TTS 状态 ==============
  /** TTS 播放状态 */
  const ttsState = ref<TtsPlaybackState>("idle");
  /** 是否启用自动播报 */
  const ttsAutoPlay = ref(false);
  /** TTS 错误 */
  const ttsError = ref<string | null>(null);

  // ============== 音色列表 ==============
  /** 音色列表 */
  const voiceList = ref<VoiceInfo[]>([]);
  /** 当前选中的音色 id */
  const currentVoiceId = ref<string>("");
  /** 音色列表是否加载中 */
  const voicesLoading = ref(false);

  // ============== 服务实例 ==============
  let asrService: AsrService | null = null;
  let ttsService: TtsService | null = null;
  let realtimeService: RealtimeService | null = null;

  // ============== 计算属性 ==============
  const currentVoice = computed(
    () => voiceList.value.find((v) => v.id === currentVoiceId.value) ?? null,
  );

  /** 语音整体状态：综合 ASR/realtime/TTS 给 UI 一个统一视图 */
  const overallState = computed<"idle" | "listening" | "thinking" | "speaking" | "recording">(() => {
    if (realtimeConnected.value) return realtimeState.value;
    if (isRecording.value) return "recording";
    if (ttsState.value === "playing") return "speaking";
    return "idle";
  });

  // ============== 初始化 ==============

  /** 初始化语音服务（使用 settings 中的配置） */
  function init() {
    const settings = settingsStore.settings;
    // TTS 服务
    if (!ttsService) {
      ttsService = new TtsService(settings.apiKeys.step);
      ttsAutoPlay.value = settings.voice.ttsAutoPlay;
      ttsService.setAutoPlay(settings.voice.ttsAutoPlay);
      currentVoiceId.value = settings.voice.voiceId || "default";
    } else {
      ttsService.updateConfig(settings.apiKeys.step);
    }

    // ASR 服务（懒初始化，startRecording 时再创建）
    if (asrService) {
      asrService.updateConfig({
        step: settings.apiKeys.step,
        xiaomi: settings.apiKeys.xiaomi,
      });
    }
  }

  /** 配置变更时同步 */
  function syncConfig() {
    const settings = settingsStore.settings;
    if (ttsService) {
      ttsService.updateConfig(settings.apiKeys.step);
      ttsService.setAutoPlay(settings.voice.ttsAutoPlay);
    }
    if (asrService) {
      asrService.updateConfig({
        step: settings.apiKeys.step,
        xiaomi: settings.apiKeys.xiaomi,
      });
    }
    if (realtimeService) {
      realtimeService.updateConfig({
        step: settings.apiKeys.step,
        voice: settings.voice,
        realtimeEngineUrl: settings.voice.realtimeEngineUrl,
        autoInterrupt: settings.voice.autoInterrupt,
      });
    }
    currentVoiceId.value = settings.voice.voiceId || currentVoiceId.value;
  }

  // ============== 音色列表 ==============

  /** 加载音色列表（从 API 动态获取） */
  async function loadVoices(forceRefresh = false): Promise<VoiceInfo[]> {
    if (!ttsService) init();
    voicesLoading.value = true;
    try {
      const list = await ttsService!.listVoices(forceRefresh);
      voiceList.value = list;
      // 若当前未选中音色，选第一个
      if (!currentVoiceId.value && list.length > 0) {
        await selectVoice(list[0].id);
      }
      return list;
    } catch (e) {
      ttsError.value = (e as Error).message;
      return [];
    } finally {
      voicesLoading.value = false;
    }
  }

  /** 选择音色 */
  async function selectVoice(voiceId: string) {
    currentVoiceId.value = voiceId;
    await settingsStore.updateVoice({ voiceId });
  }

  /** 试听音色 */
  async function previewVoice(voiceId: string, sampleText = "你好，这是音色试听。") {
    if (!ttsService) init();
    const settings = settingsStore.settings;
    try {
      await ttsService!.preview(
        {
          text: sampleText,
          voiceId,
          speed: settings.voice.speed,
          volume: settings.voice.volume,
          pitch: settings.voice.pitch,
        },
        {
          onStateChange: (s) => (ttsState.value = s),
          onError: (e) => (ttsError.value = e.message),
        },
      );
    } catch (e) {
      ttsError.value = (e as Error).message;
    }
  }

  // ============== ASR 录音 ==============

  /** 开始录音 + 流式 ASR */
  async function startRecording(): Promise<void> {
    if (isRecording.value) return;
    const settings = settingsStore.settings;
    if (!asrService) {
      asrService = new AsrService({
        step: settings.apiKeys.step,
        xiaomi: settings.apiKeys.xiaomi,
        preferredEngine: "step",
        language: "auto",
        enablePunctuation: true,
      });
    } else {
      asrService.updateConfig({
        step: settings.apiKeys.step,
        xiaomi: settings.apiKeys.xiaomi,
      });
    }

    asrError.value = null;
    asrTranscript.value = "";
    asrFinalText.value = "";

    const handlers: AsrStreamHandlers = {
      onPartial: (text, engine) => {
        asrTranscript.value = text;
        activeAsrEngine.value = engine;
      },
      onFinal: (text, engine) => {
        asrFinalText.value = text;
        asrTranscript.value = text;
        activeAsrEngine.value = engine;
      },
      onEngineSwitch: (from, to, reason) => {
        activeAsrEngine.value = to;
        console.info(`[voice] ASR engine switched: ${from} → ${to} (${reason})`);
      },
      onError: (e, engine) => {
        console.warn(`[voice] ASR error on ${engine}:`, e.message);
      },
    };

    try {
      isRecording.value = true;
      isRecognizing.value = true;
      await asrService.start(handlers);
    } catch (e) {
      isRecording.value = false;
      isRecognizing.value = false;
      asrError.value = (e as Error).message;
      throw e;
    }
  }

  /** 停止录音，返回最终转写文本 */
  async function stopRecording(): Promise<string> {
    if (!asrService || !isRecording.value) return asrFinalText.value;
    isRecording.value = false;
    try {
      const text = await asrService.stop();
      asrFinalText.value = text;
      asrTranscript.value = text;
      return text;
    } catch (e) {
      asrError.value = (e as Error).message;
      return asrFinalText.value;
    } finally {
      isRecognizing.value = false;
    }
  }

  /** 切换 ASR 引擎 */
  async function switchAsrEngine(engine: AsrEngine): Promise<void> {
    activeAsrEngine.value = engine;
    if (asrService && isRecording.value) {
      const handlers: AsrStreamHandlers = {
        onPartial: (text) => (asrTranscript.value = text),
        onFinal: (text) => {
          asrFinalText.value = text;
          asrTranscript.value = text;
        },
        onEngineSwitch: (from, to) => (activeAsrEngine.value = to),
        onError: (e) => console.warn("[voice] ASR error:", e.message),
      };
      await asrService.switchEngine(engine, handlers);
    }
  }

  /** 清空转写文本 */
  function clearTranscript() {
    asrTranscript.value = "";
    asrFinalText.value = "";
  }

  // ============== TTS 播放 ==============

  /** 合成并播放语音 */
  async function speak(text: string, params?: Partial<TtsParams>): Promise<void> {
    if (!ttsService) init();
    const settings = settingsStore.settings;
    ttsError.value = null;
    try {
      await ttsService!.preview(
        {
          text,
          voiceId: params?.voiceId ?? currentVoiceId.value,
          speed: params?.speed ?? settings.voice.speed,
          volume: params?.volume ?? settings.voice.volume,
          pitch: params?.pitch ?? settings.voice.pitch,
          format: params?.format,
        },
        {
          onStateChange: (s) => (ttsState.value = s),
          onError: (e) => (ttsError.value = e.message),
        },
      );
    } catch (e) {
      ttsError.value = (e as Error).message;
    }
  }

  /** 自动播报（若启用） */
  async function speakAuto(text: string): Promise<void> {
    if (!ttsService) init();
    const settings = settingsStore.settings;
    await ttsService!.speakAuto({
      text,
      voiceId: currentVoiceId.value,
      speed: settings.voice.speed,
      volume: settings.voice.volume,
      pitch: settings.voice.pitch,
    });
  }

  /** 停止 TTS 播放 */
  function stopSpeaking() {
    ttsService?.stop();
  }

  /** 暂停 TTS */
  function pauseSpeaking() {
    ttsService?.pause();
  }

  /** 恢复 TTS */
  async function resumeSpeaking() {
    await ttsService?.resume();
  }

  /** 切换自动播报 */
  async function toggleAutoPlay(): Promise<void> {
    ttsAutoPlay.value = !ttsAutoPlay.value;
    ttsService?.setAutoPlay(ttsAutoPlay.value);
    await settingsStore.updateVoice({ ttsAutoPlay: ttsAutoPlay.value });
  }

  // ============== 实时语音对话 ==============

  /** 启动实时语音对话 */
  async function startRealtime(): Promise<void> {
    if (realtimeConnected.value) return;
    const settings = settingsStore.settings;
    if (!realtimeService) {
      realtimeService = new RealtimeService({
        step: settings.apiKeys.step,
        voice: settings.voice,
        realtimeEngineUrl: settings.voice.realtimeEngineUrl,
        autoInterrupt: settings.voice.autoInterrupt,
      });
    } else {
      realtimeService.updateConfig({
        step: settings.apiKeys.step,
        voice: settings.voice,
        realtimeEngineUrl: settings.voice.realtimeEngineUrl,
        autoInterrupt: settings.voice.autoInterrupt,
      });
    }

    realtimeError.value = null;
    realtimeUserTranscript.value = "";
    realtimeAiTranscript.value = "";

    const handlers: RealtimeHandlers = {
      onStateChange: (s) => (realtimeState.value = s),
      onUserTranscript: (text, isFinal) => {
        realtimeUserTranscript.value = text;
        if (isFinal) {
          realtimeService?.handleUserUtterance(text);
        }
      },
      onAiTranscript: (text, isFinal) => {
        realtimeAiTranscript.value = text;
        // 若启用自动播报且为最终文本，由 realtime 自身音频处理；此处仅记录
        if (isFinal && ttsAutoPlay.value) {
          // realtime 已自带音频播放，此处无需重复 TTS
        }
      },
      onVoiceCommand: (command) => {
        console.info(`[voice] voice command: ${command}`);
        if (command === "stop") stopSpeaking();
        if (command === "clear") {
          realtimeUserTranscript.value = "";
          realtimeAiTranscript.value = "";
        }
        if (command === "mute") realtimeMuted.value = realtimeService?.toggleMute() ?? false;
        if (command === "end") stopRealtime();
      },
      onDesktopControl: (intent, args) => {
        console.info(`[voice] desktop control: ${intent} ${args ?? ""}`);
        // 桌面操控由上层 chat store 通过工具执行
      },
      onToolCallRequired: async (userText) => {
        // 工具调用由上层注入（通过 chat store 的 function calling 引擎）
        console.debug("[voice] tool call required for:", userText);
        return "";
      },
      onError: (e) => (realtimeError.value = e.message),
    };

    try {
      await realtimeService.start(handlers);
      realtimeConnected.value = true;
    } catch (e) {
      realtimeError.value = (e as Error).message;
      throw e;
    }
  }

  /** 停止实时语音对话 */
  async function stopRealtime(): Promise<void> {
    if (!realtimeService || !realtimeConnected.value) return;
    await realtimeService.stop();
    realtimeConnected.value = false;
    realtimeMuted.value = false;
    realtimeState.value = "idle";
  }

  /** 静音切换 */
  function toggleMute(): boolean {
    if (!realtimeService) return false;
    realtimeMuted.value = realtimeService.toggleMute();
    return realtimeMuted.value;
  }

  /** 手动打断 AI */
  function interruptRealtime(): void {
    realtimeService?.interrupt();
  }

  /** 设置可替换的实时语音引擎 URL */
  async function setRealtimeEngineUrl(url: string): Promise<void> {
    await settingsStore.updateVoice({ realtimeEngineUrl: url });
    realtimeService?.setEngineUrl(url);
  }

  return {
    // ============== 状态 ==============
    // ASR
    isRecording,
    isRecognizing,
    activeAsrEngine,
    asrTranscript,
    asrFinalText,
    asrError,
    // Realtime
    realtimeConnected,
    realtimeState,
    realtimeMuted,
    realtimeUserTranscript,
    realtimeAiTranscript,
    realtimeError,
    // TTS
    ttsState,
    ttsAutoPlay,
    ttsError,
    // 音色
    voiceList,
    currentVoiceId,
    voicesLoading,
    // 计算
    currentVoice,
    overallState,
    // ============== 初始化 ==============
    init,
    syncConfig,
    // ============== 音色 ==============
    loadVoices,
    selectVoice,
    previewVoice,
    // ============== ASR ==============
    startRecording,
    stopRecording,
    switchAsrEngine,
    clearTranscript,
    // ============== TTS ==============
    speak,
    speakAuto,
    stopSpeaking,
    pauseSpeaking,
    resumeSpeaking,
    toggleAutoPlay,
    // ============== Realtime ==============
    startRealtime,
    stopRealtime,
    toggleMute,
    interruptRealtime,
    setRealtimeEngineUrl,
  };
});
