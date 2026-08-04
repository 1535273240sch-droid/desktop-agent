// voice/tts.ts - TTS 语音合成服务
// 阶跃 StepAudio TTS + 音色列表动态获取 + 试听 + 参数(音色/语速/音量/音调) + 自动播报/手动播报

import type { StepApiConfig, VoiceSettings } from "@/types";
import {
  StepApiClient,
  type VoiceInfo,
  type TtsRequest,
} from "@/services/api/stepApi";

// ========================= 类型定义 =========================

export interface TtsParams {
  text: string;
  voiceId?: string;
  speed?: number; // 0.5 - 2.0
  volume?: number; // 0 - 100
  pitch?: number; // -10 - 10
  format?: "mp3" | "wav" | "pcm";
}

export type TtsPlaybackState = "idle" | "loading" | "playing" | "paused" | "error";

export interface TtsStateCallbacks {
  onStateChange?: (state: TtsPlaybackState) => void;
  onProgress?: (currentMs: number, totalMs: number) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

// ========================= 服务 =========================

export class TtsService {
  private client: StepApiClient;
  private audio: HTMLAudioElement | null = null;
  private state: TtsPlaybackState = "idle";
  private callbacks: TtsStateCallbacks = {};
  /** 缓存的音色列表 */
  private voicesCache: VoiceInfo[] | null = null;
  /** 音色列表缓存时间 */
  private voicesCachedAt = 0;
  /** 音色列表缓存 TTL（10 分钟） */
  private static VOICES_CACHE_TTL = 10 * 60 * 1000;
  /** 自动播报队列（自动模式下文本排队播放） */
  private autoPlayQueue: TtsParams[] = [];
  /** 是否正在处理队列 */
  private processingQueue = false;
  /** 自动播报开关 */
  private autoPlayEnabled = false;

  constructor(config: StepApiConfig) {
    this.client = new StepApiClient(config);
  }

  /** 更新配置 */
  updateConfig(config: Partial<StepApiConfig>) {
    this.client.updateConfig(config);
    // 配置变更后清空音色缓存
    this.voicesCache = null;
  }

  /** 获取底层客户端（供外部复用） */
  getClient(): StepApiClient {
    return this.client;
  }

  /** 当前播放状态 */
  getState(): TtsPlaybackState {
    return this.state;
  }

  // ============== 音色列表 ==============

  /**
   * 获取音色列表（从 API 动态获取，带缓存）
   * - 失败时返回阶跃内置默认音色
   */
  async listVoices(forceRefresh = false): Promise<VoiceInfo[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.voicesCache &&
      now - this.voicesCachedAt < TtsService.VOICES_CACHE_TTL
    ) {
      return this.voicesCache;
    }
    try {
      const voices = await this.client.listVoices();
      this.voicesCache = voices;
      this.voicesCachedAt = now;
      return voices;
    } catch (e) {
      console.warn("[TTS] listVoices failed, using cache or defaults:", e);
      return this.voicesCache ?? [];
    }
  }

  /** 清空音色缓存，下次 listVoices 重新拉取 */
  invalidateVoicesCache() {
    this.voicesCache = null;
    this.voicesCachedAt = 0;
  }

  // ============== 单次合成 ==============

  /**
   * 合成语音（不播放，返回 base64 音频）
   * @param params 文本与音色/语速/音量/音调参数
   */
  async synthesize(params: TtsParams): Promise<{
    audioBase64: string;
    format: string;
    dataUrl: string;
    durationMs: number;
  }> {
    this._validateParams(params);
    const req: TtsRequest = {
      text: params.text,
      voiceId: params.voiceId,
      speed: params.speed,
      volume: params.volume,
      pitch: params.pitch,
      format: params.format ?? "mp3",
    };
    const result = await this.client.tts(req);
    const dataUrl = `audio/${result.format};base64,${result.audioBase64}`;
    return {
      audioBase64: result.audioBase64,
      format: result.format,
      dataUrl,
      durationMs: result.durationMs,
    };
  }

  // ============== 试听 / 播放 ==============

  /**
   * 试听：实时调用 API 生成并立即播放
   * @param params 文本与音色参数
   * @param callbacks 状态回调
   */
  async preview(
    params: TtsParams,
    callbacks?: TtsStateCallbacks,
  ): Promise<void> {
    this._validateParams(params);
    this._setCallbacks(callbacks);
    this._setState("loading");

    try {
      const { dataUrl } = await this.synthesize(params);
      await this._play(dataUrl);
    } catch (e) {
      this._setState("error");
      this.callbacks.onError?.(e as Error);
      throw e;
    }
  }

  /**
   * 播放已合成的音频（dataUrl 或 base64）
   * @param audioSource dataUrl 或 base64 字符串
   */
  async play(audioSource: string, callbacks?: TtsStateCallbacks): Promise<void> {
    this._setCallbacks(callbacks);
    const dataUrl = audioSource.startsWith("audio/") || audioSource.startsWith("data:")
      ? audioSource
      : `audio/mp3;base64,${audioSource}`;
    this._setState("loading");
    try {
      await this._play(dataUrl);
    } catch (e) {
      this._setState("error");
      this.callbacks.onError?.(e as Error);
      throw e;
    }
  }

  /** 内部播放实现 */
  private async _play(dataUrl: string): Promise<void> {
    // 停止当前播放
    this._stopInternal();

    const audio = new Audio(dataUrl);
    this.audio = audio;

    return new Promise<void>((resolve, reject) => {
      audio.onplay = () => {
        this._setState("playing");
        this.callbacks.onStart?.();
      };
      audio.onended = () => {
        this._setState("idle");
        this.callbacks.onEnd?.();
        this._cleanupAudio();
        resolve();
      };
      audio.onerror = () => {
        this._setState("error");
        const err = new Error("audio playback failed");
        this.callbacks.onError?.(err);
        this._cleanupAudio();
        reject(err);
      };
      audio.onpause = () => {
        if (this.state === "playing") this._setState("paused");
      };
      // 进度回调
      audio.ontimeupdate = () => {
        this.callbacks.onProgress?.(
          Math.floor(audio.currentTime * 1000),
          Math.floor((audio.duration || 0) * 1000),
        );
      };
      audio.play().catch((e) => {
        this._setState("error");
        this.callbacks.onError?.(e);
        reject(e);
      });
    });
  }

  /** 暂停 */
  pause(): void {
    if (this.audio && this.state === "playing") {
      this.audio.pause();
    }
  }

  /** 恢复播放 */
  async resume(): Promise<void> {
    if (this.audio && this.state === "paused") {
      await this.audio.play();
    }
  }

  /** 停止播放 */
  stop(): void {
    this._stopInternal();
    this._setState("idle");
  }

  private _stopInternal() {
    if (this.audio) {
      this.audio.onplay = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.onpause = null;
      this.audio.ontimeupdate = null;
      this.audio.pause();
      this.audio.src = "";
      this._cleanupAudio();
    }
  }

  private _cleanupAudio() {
    this.audio = null;
  }

  // ============== 自动播报 ==============

  /** 启用/禁用自动播报 */
  setAutoPlay(enabled: boolean) {
    this.autoPlayEnabled = enabled;
    if (!enabled) {
      // 关闭时清空队列
      this.autoPlayQueue = [];
    }
  }

  /** 是否启用自动播报 */
  isAutoPlayEnabled(): boolean {
    return this.autoPlayEnabled;
  }

  /**
   * 自动播报：若开启自动播报则入队播放，否则仅合成不入队
   * @param params 文本与音色参数
   */
  async speakAuto(params: TtsParams): Promise<void> {
    if (!this.autoPlayEnabled) {
      // 手动模式：不自动播放，仅合成供调用方处理
      return;
    }
    this.autoPlayQueue.push(params);
    this._processQueue();
  }

  /** 处理自动播报队列 */
  private async _processQueue() {
    if (this.processingQueue) return;
    this.processingQueue = true;
    try {
      while (this.autoPlayQueue.length > 0) {
        const params = this.autoPlayQueue.shift()!;
        try {
          await this.preview(params);
        } catch (e) {
          console.warn("[TTS] autoplay item failed, skipping:", e);
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  /** 清空自动播报队列 */
  clearQueue() {
    this.autoPlayQueue = [];
    this.stop();
  }

  // ============== 工具方法 ==============

  /** 校验参数 */
  private _validateParams(params: TtsParams) {
    if (!params.text || !params.text.trim()) {
      throw new Error("TTS: text is required");
    }
    if (params.speed !== undefined && (params.speed < 0.5 || params.speed > 2.0)) {
      throw new Error("TTS: speed must be between 0.5 and 2.0");
    }
    if (params.volume !== undefined && (params.volume < 0 || params.volume > 100)) {
      throw new Error("TTS: volume must be between 0 and 100");
    }
    if (params.pitch !== undefined && (params.pitch < -10 || params.pitch > 10)) {
      throw new Error("TTS: pitch must be between -10 and 10");
    }
  }

  private _setState(state: TtsPlaybackState) {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private _setCallbacks(callbacks?: TtsStateCallbacks) {
    this.callbacks = callbacks ?? {};
  }

  /** 从 VoiceSettings 构造 TtsParams */
  static paramsFromSettings(text: string, settings: VoiceSettings): TtsParams {
    return {
      text,
      voiceId: settings.voiceId || undefined,
      speed: settings.speed,
      volume: settings.volume,
      pitch: settings.pitch,
    };
  }
}

// ========================= 单例导出 =========================

let _defaultService: TtsService | null = null;

export function getDefaultTtsService(config?: StepApiConfig): TtsService {
  if (!_defaultService || (config && _defaultService.getClient().getConfig() !== config)) {
    if (!config) {
      throw new Error("TtsService not initialized: config required on first call");
    }
    _defaultService = new TtsService(config);
  }
  return _defaultService;
}

export function resetDefaultTtsService() {
  if (_defaultService) {
    _defaultService.stop();
    _defaultService.clearQueue();
  }
  _defaultService = null;
}
