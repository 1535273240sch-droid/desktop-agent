// voice/realtime.ts - 实时语音对话服务
// 阶跃 StepAudio Realtime WebSocket + 可替换引擎 + 自动打断 + 语音控制指令
// + 桌面操控 + 工具调用(语音对话中) + 过渡语(调用工具前)

import type { StepApiConfig, VoiceSettings } from "@/types";
import {
  StepApiClient,
  type RealtimeEvent,
  type RealtimeCallback,
} from "@/services/api/stepApi";

// ========================= 常量 =========================

/** 默认 StepAudio Realtime 端点 */
const DEFAULT_REALTIME_URL = "wss://api.stepfun.com/v1/realtime";
/** PCM 播放采样率 */
const PLAYBACK_SAMPLE_RATE = 24000;

// ========================= 类型定义 =========================

export type RealtimeState = "idle" | "listening" | "thinking" | "speaking";

export interface RealtimeConfig {
  step: StepApiConfig;
  voice: VoiceSettings;
  /** 可替换的实时语音引擎 URL（覆盖 step.realtimeUrl） */
  realtimeEngineUrl?: string;
  /** 是否启用自动打断（检测用户说话时打断 AI） */
  autoInterrupt?: boolean;
}

export interface RealtimeHandlers {
  onStateChange?: (state: RealtimeState) => void;
  /** 用户语音转写（增量） */
  onUserTranscript?: (text: string, isFinal: boolean) => void;
  /** AI 回复转写（增量） */
  onAiTranscript?: (text: string, isFinal: boolean) => void;
  /** AI 音频片段（base64 PCM16）—— 用于自定义播放 */
  onAiAudio?: (base64Pcm16: string) => void;
  /** 语音控制指令触发（停止/清除等） */
  onVoiceCommand?: (command: string, args?: string) => void;
  /** 桌面操控指令触发 */
  onDesktopControl?: (intent: string, args?: string) => void;
  /** 需要调用工具（返回工具调用结果，由调用方执行 function calling） */
  onToolCallRequired?: (userText: string) => Promise<string>;
  /** 错误 */
  onError?: (error: Error) => void;
  /** 静音/取消静音 */
  onMute?: () => void;
}

// ========================= 语音指令定义 =========================

/** 语音控制指令：识别关键词 → 触发动作 */
const VOICE_COMMANDS: Array<{
  command: string;
  keywords: string[];
  description: string;
}> = [
  { command: "stop", keywords: ["停止", "停下", "别说了", "stop"], description: "停止当前播放" },
  { command: "clear", keywords: ["清除", "清空", "重置", "clear"], description: "清空对话" },
  { command: "mute", keywords: ["静音", "mute"], description: "静音" },
  { command: "end", keywords: ["结束", "退出", "再见", "bye", "goodbye"], description: "结束对话" },
];

/** 桌面操控指令：识别意图 → 触发桌面工具 */
const DESKTOP_CONTROL_INTENTS: Array<{
  intent: string;
  keywords: string[];
  description: string;
}> = [
  { intent: "screenshot", keywords: ["截图", "截屏", "screenshot"], description: "截取屏幕" },
  { intent: "open_app", keywords: ["打开", "启动", "open"], description: "打开应用" },
  { intent: "close_app", keywords: ["关闭", "退出应用", "close"], description: "关闭应用" },
  { intent: "volume_up", keywords: ["音量调大", "大声点", "volume up"], description: "音量调大" },
  { intent: "volume_down", keywords: ["音量调小", "小声点", "volume down"], description: "音量调小" },
  { intent: "scroll", keywords: ["滚动", "下滑", "上滑", "scroll"], description: "滚动页面" },
];

/** 工具调用过渡语 */
const TRANSITION_PHRASES = [
  "好的，我来处理",
  "好的，马上为您操作",
  "稍等，我帮您查一下",
  "好的，正在执行",
];

// ========================= 服务 =========================

export class RealtimeService {
  private config: RealtimeConfig;
  private client: StepApiClient;
  private handlers: RealtimeHandlers = {};

  /** 是否连接中 */
  private connected = false;
  /** 是否静音（不发送音频） */
  private muted = false;
  /** 当前状态 */
  private state: RealtimeState = "idle";

  /** 麦克风流 */
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;

  /** AI 音频播放队列 */
  private playQueue: Float32Array[] = [];
  private playing = false;
  private nextPlayTime = 0;
  private playbackContext: AudioContext | null = null;

  /** 用户最近一段转写（用于指令检测） */
  private recentUserText = "";
  /** AI 最近一段转写 */
  private recentAiText = "";

  /** 自动打断：检测到用户说话时是否已打断 */
  private interruptTriggered = false;
  /** 用户说话 RMS 阈值（触发打断） */
  private static INTERRUPT_RMS_THRESHOLD = 0.015;

  constructor(config: RealtimeConfig) {
    this.config = config;
    this.client = new StepApiClient({
      ...config.step,
      realtimeUrl: config.realtimeEngineUrl ?? config.step.realtimeUrl,
    });
  }

  /** 更新配置 */
  updateConfig(config: Partial<RealtimeConfig>) {
    this.config = { ...this.config, ...config };
    if (config.realtimeEngineUrl || config.step) {
      this.client.updateConfig({
        ...this.config.step,
        realtimeUrl: this.config.realtimeEngineUrl ?? this.config.step.realtimeUrl,
      });
    }
  }

  /** 获取当前配置（供单例比较） */
  getConfig(): RealtimeConfig {
    return this.config;
  }

  /** 设置可替换的实时语音引擎 URL */
  setEngineUrl(url: string) {
    this.config.realtimeEngineUrl = url;
    this.client.updateConfig({ realtimeUrl: url });
  }

  /** 当前状态 */
  getState(): RealtimeState {
    return this.state;
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.connected;
  }

  /** 是否静音 */
  isMuted(): boolean {
    return this.muted;
  }

  // ============== 启动 / 停止 ==============

  /**
   * 启动实时语音对话
   * - 建立 WebSocket 连接
   * - 获取麦克风并推流
   * - 监听 AI 音频并播放
   */
  async start(handlers: RealtimeHandlers): Promise<void> {
    if (this.connected) {
      throw new Error("realtime already connected");
    }
    this.handlers = handlers;

    // 1. 建立 Realtime 连接
    await this.client.connectRealtime(
      this._onRealtimeEvent,
      {
        voice: this.config.voice.voiceId || "default",
        // 自动打断由本服务在前端实现（更可控）
        turn_detection: this.config.autoInterrupt !== false ? { type: "server_vad" } : undefined,
      },
    );

    // 2. 获取麦克风
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // 3. 启动音频采集 → 推流
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(1024, 1, 1);
    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    this.processor.onaudioprocess = (ev: AudioProcessingEvent) => {
      if (!this.connected || this.muted) return;
      const input = ev.inputBuffer.getChannelData(0);

      // 自动打断检测：当 AI 正在说话且用户开始说话时打断
      if (
        this.config.autoInterrupt !== false &&
        this.state === "speaking" &&
        !this.interruptTriggered
      ) {
        const rms = this._rms(input);
        if (rms > RealtimeService.INTERRUPT_RMS_THRESHOLD) {
          this._triggerInterrupt();
        }
      }

      // 重采样为 PCM16 → base64 → 推流
      const pcm16 = this._resampleToPcm16(input, this.audioContext!.sampleRate);
      const base64 = this._arrayBufferToBase64(pcm16.buffer as ArrayBuffer);
      this.client.sendAudioChunk(base64);
    };

    // 4. 播放上下文
    this.playbackContext = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });

    this.connected = true;
    this._setState("listening");
  }

  /** 停止实时语音对话 */
  async stop(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;

    // 停止采集
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    // 停止播放
    this.playQueue = [];
    this.playing = false;
    if (this.playbackContext) {
      await this.playbackContext.close();
      this.playbackContext = null;
    }

    // 关闭连接
    this.client.disconnectRealtime();
    this._setState("idle");
    this.recentUserText = "";
    this.recentAiText = "";
  }

  /** 静音/取消静音 */
  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.muted) {
      // 静音时提交当前缓冲，避免半句话
      this.client.commitAudioBuffer();
    }
    this.handlers.onMute?.();
    return this.muted;
  }

  /** 手动触发打断 */
  interrupt(): void {
    this._triggerInterrupt();
  }

  // ============== Realtime 事件处理 ==============

  private _onRealtimeEvent: RealtimeCallback = (event: RealtimeEvent) => {
    switch (event.type) {
      case "session.created":
        console.info("[realtime] session created:", event.sessionId);
        break;
      case "session.updated":
        console.debug("[realtime] session updated:", event.config);
        break;
      case "input_audio_buffer.committed":
        // 用户说完一句，提交给模型
        this._setState("thinking");
        this.interruptTriggered = false;
        break;
      case "response.text.delta":
        // AI 回复文本（增量）
        this.recentAiText += event.delta;
        this.handlers.onAiTranscript?.(this.recentAiText, false);
        break;
      case "response.text.done":
        this.handlers.onAiTranscript?.(event.text || this.recentAiText, true);
        this.recentAiText = "";
        // 检测 AI 回复中是否需要调用工具
        this._maybeRequireToolCall(event.text || "").catch((e) =>
          this.handlers.onError?.(e as Error),
        );
        break;
      case "response.audio.delta":
        // AI 音频片段（base64 PCM16）
        this.handlers.onAiAudio?.(event.delta);
        this._enqueueAudio(event.delta);
        if (this.state !== "speaking") this._setState("speaking");
        break;
      case "response.audio.done":
        // 当前回复音频结束
        break;
      case "response.done":
        // 完整回复结束
        if (this.state === "speaking" && this.playQueue.length === 0) {
          this._setState("listening");
        }
        break;
      case "error":
        this.handlers.onError?.(new Error(event.error.message));
        break;
      default:
        break;
    }
  };

  // ============== 语音指令检测 ==============

  /**
   * 检测用户转写文本中的语音控制指令
   * @returns 是否匹配到指令
   */
  private _detectVoiceCommand(text: string): boolean {
    const lower = text.toLowerCase().trim();
    if (!lower) return false;
    for (const cmd of VOICE_COMMANDS) {
      for (const kw of cmd.keywords) {
        if (lower.includes(kw.toLowerCase())) {
          // 提取指令后的参数（如 "清除" 后的内容）
          const args = text.slice(text.indexOf(kw) + kw.length).trim();
          this.handlers.onVoiceCommand?.(cmd.command, args || undefined);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 检测桌面操控指令
   * @returns intent 或 null
   */
  private _detectDesktopControl(text: string): string | null {
    const lower = text.toLowerCase().trim();
    if (!lower) return null;
    for (const intent of DESKTOP_CONTROL_INTENTS) {
      for (const kw of intent.keywords) {
        if (lower.includes(kw.toLowerCase())) {
          const args = text.slice(text.indexOf(kw) + kw.length).trim();
          this.handlers.onDesktopControl?.(intent.intent, args || undefined);
          return intent.intent;
        }
      }
    }
    return null;
  }

  /** 用户说出一句话时的处理（由上层调用，结合 ASR） */
  handleUserUtterance(text: string): void {
    if (!text.trim()) return;
    this.recentUserText = text;

    // 1. 先检测语音控制指令
    if (this._detectVoiceCommand(text)) {
      return;
    }
    // 2. 检测桌面操控指令
    if (this._detectDesktopControl(text)) {
      return;
    }
    // 3. 否则正常对话（realtime 服务端处理）
  }

  // ============== 工具调用 + 过渡语 ==============

  /**
   * 检测 AI 回复是否需要调用工具
   * - 简单启发式：当回复包含"我来帮你/正在/查询/搜索/执行"等动作词时触发
   * - 真实场景下应由服务端通过 function calling 协议下发
   */
  private async _maybeRequireToolCall(aiText: string): Promise<void> {
    if (!this.handlers.onToolCallRequired) return;
    const actionKeywords = ["搜索", "查询", "执行", "打开", "运行", "计算", "转换", "截图"];
    const needsTool = actionKeywords.some((k) => aiText.includes(k));
    if (!needsTool) return;

    // 1. 说过渡语（打断当前 AI 音频）
    await this._speakTransition();

    // 2. 请求上层执行工具调用
    try {
      const result = await this.handlers.onToolCallRequired(this.recentUserText);
      // 3. 把工具结果作为新输入提交给 realtime
      if (result) {
        // 通过 commit + 文本输入让模型继续对话
        // 注：StepAudio Realtime 主要走音频，文本结果可由 TTS 播报后回灌
        console.debug("[realtime] tool result:", result.slice(0, 100));
      }
    } catch (e) {
      this.handlers.onError?.(e as Error);
    }
  }

  /** 播报过渡语（调用工具前） */
  private async _speakTransition(): Promise<void> {
    const phrase = TRANSITION_PHRASES[Math.floor(Math.random() * TRANSITION_PHRASES.length)];
    // 打断当前 AI 播放
    this._triggerInterrupt();
    this._clearPlayQueue();

    // 通过 TTS 播报过渡语
    try {
      const { getDefaultTtsService } = await import("./tts");
      const tts = getDefaultTtsService();
      await tts.preview({
        text: phrase,
        voiceId: this.config.voice.voiceId || undefined,
        speed: this.config.voice.speed,
        volume: this.config.voice.volume,
        pitch: this.config.voice.pitch,
      });
    } catch (e) {
      console.warn("[realtime] transition phrase TTS failed:", e);
    }
  }

  // ============== 自动打断 ==============

  /** 触发打断：取消当前 AI 响应 */
  private _triggerInterrupt(): void {
    if (!this.connected) return;
    this.interruptTriggered = true;
    this.client.interruptResponse();
    this._clearPlayQueue();
    this._setState("listening");
    console.debug("[realtime] auto-interrupt triggered");
  }

  // ============== 音频播放 ==============

  /** 入队 AI 音频片段并播放 */
  private _enqueueAudio(base64Pcm16: string) {
    const samples = this._decodePcm16Base64(base64Pcm16);
    this.playQueue.push(samples);
    if (!this.playing) this._playNext();
  }

  /** 顺序播放队列中的音频 */
  private _playNext() {
    if (!this.playbackContext || this.playQueue.length === 0) {
      this.playing = false;
      if (this.state === "speaking") this._setState("listening");
      return;
    }
    this.playing = true;
    const samples = this.playQueue.shift()!;
    const ctx = this.playbackContext;
    const buffer = ctx.createBuffer(1, samples.length, PLAYBACK_SAMPLE_RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, this.nextPlayTime);
    src.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;

    src.onended = () => this._playNext();
  }

  /** 清空播放队列（打断时调用） */
  private _clearPlayQueue() {
    this.playQueue = [];
    this.playing = false;
    this.nextPlayTime = 0;
  }

  // ============== 音频工具 ==============

  private _rms(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  /** 重采样到 16kHz PCM16（用于上行推流） */
  private _resampleToPcm16(input: Float32Array, inputRate: number): Int16Array {
    const targetRate = 16000;
    if (inputRate === targetRate) return this._float32ToInt16(input);
    const ratio = inputRate / targetRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const idx0 = Math.floor(srcIdx);
      const idx1 = Math.min(idx0 + 1, input.length - 1);
      const frac = srcIdx - idx0;
      const sample = input[idx0] * (1 - frac) + input[idx1] * frac;
      out[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
    }
    return out;
  }

  private _float32ToInt16(input: Float32Array): Int16Array {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff;
    }
    return out;
  }

  /** 解码 base64 PCM16 → Float32Array（用于下行播放） */
  private _decodePcm16Base64(base64: string): Float32Array {
    const binary = atob(base64);
    const len = binary.length / 2;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const lo = binary.charCodeAt(i * 2);
      const hi = binary.charCodeAt(i * 2 + 1);
      const int16 = (hi << 8) | lo;
      // 有符号转换
      const signed = int16 > 0x7fff ? int16 - 0x10000 : int16;
      out[i] = signed / 0x7fff;
    }
    return out;
  }

  /** ArrayBuffer → base64 */
  private _arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return btoa(binary);
  }

  // ============== 状态 ==============

  private _setState(state: RealtimeState) {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onStateChange?.(state);
  }

  // ============== 静态：指令列表（供 UI 展示） ==============

  static listVoiceCommands() {
    return VOICE_COMMANDS;
  }

  static listDesktopIntents() {
    return DESKTOP_CONTROL_INTENTS;
  }
}

// ========================= 单例导出 =========================

let _defaultService: RealtimeService | null = null;

export function getDefaultRealtimeService(config?: RealtimeConfig): RealtimeService {
  if (!_defaultService || (config && _defaultService.getConfig() !== config)) {
    if (!config) {
      throw new Error("RealtimeService not initialized: config required on first call");
    }
    _defaultService = new RealtimeService(config);
  }
  return _defaultService;
}

export function resetDefaultRealtimeService() {
  if (_defaultService && _defaultService.isConnected()) {
    _defaultService.stop().catch(() => undefined);
  }
  _defaultService = null;
}
