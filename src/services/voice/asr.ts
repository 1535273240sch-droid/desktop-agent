// voice/asr.ts - ASR 语音识别服务
// 阶跃 ASR（主流式） + 小米 MiMo（备） + 流式实时识别 + 中英自动识别
// 录音：浏览器 getUserMedia 获取麦克风 → PCM16 16kHz → 推流
// 自动切换主备：阶跃失败时自动切小米

import type { StepApiConfig, XiaomiApiConfig } from "@/types";
import type { AsrChunk, AsrRequest } from "@/services/api/xiaomiApi";

// ========================= 常量 =========================

/** 目标采样率（PCM16 16kHz，主流 ASR 标准输入） */
const TARGET_SAMPLE_RATE = 16000;
/** 每帧采样数（约 32ms @16kHz） */
const FRAME_SIZE = 1024;
/** 阶跃 ASR 流式端点（可被 config.realtimeUrl 覆盖） */
const STEP_ASR_DEFAULT_URL = "wss://api.stepfun.com/v1/asr/stream";

// ========================= 类型定义 =========================

export type AsrEngine = "step" | "xiaomi";

export interface AsrStreamHandlers {
  /** 中间结果（边说边出文字） */
  onPartial?: (text: string, engine: AsrEngine) => void;
  /** 最终结果（一句话结束） */
  onFinal?: (text: string, engine: AsrEngine) => void;
  /** 引擎切换通知 */
  onEngineSwitch?: (from: AsrEngine, to: AsrEngine, reason: string) => void;
  /** 错误通知（非致命，会触发降级） */
  onError?: (error: Error, engine: AsrEngine) => void;
  /** VAD 静音检测（可选） */
  onSilence?: () => void;
}

export interface AsrServiceConfig {
  step: StepApiConfig;
  xiaomi: XiaomiApiConfig;
  /** 首选引擎（默认 step） */
  preferredEngine?: AsrEngine;
  /** 语言：'zh' / 'en' / 'auto'（默认 auto 自动识别中英） */
  language?: string;
  /** 是否启用标点 */
  enablePunctuation?: boolean;
  /** VAD 静音阈值（RMS 低于此值视为静音，0-1，默认 0.01） */
  silenceThreshold?: number;
  /** 静音多久后提交一句（毫秒，默认 800） */
  silenceCommitMs?: number;
}

export interface AsrSession {
  /** 当前激活引擎 */
  engine: AsrEngine;
  /** 推送 PCM16 音频（base64） */
  pushAudio: (base64Pcm16: string) => void;
  /** 主动提交当前缓冲（触发 final） */
  commit: () => void;
  /** 关闭会话 */
  close: () => void;
}

// ========================= 服务 =========================

export class AsrService {
  private config: AsrServiceConfig;
  /** 当前激活引擎 */
  private activeEngine: AsrEngine;
  /** 麦克风流 */
  private mediaStream: MediaStream | null = null;
  /** 音频上下文 */
  private audioContext: AudioContext | null = null;
  /** 音频处理节点 */
  private processor: ScriptProcessorNode | null = null;
  /** 录音中 */
  private recording = false;
  /** 当前会话 */
  private session: AsrSession | null = null;
  /** 累计最终文本（用于填入输入框） */
  private accumulatedText = "";
  /** 当前 partial 文本 */
  private currentPartial = "";
  /** 静音计时 */
  private silenceStart = 0;

  constructor(config: AsrServiceConfig) {
    this.config = config;
    this.activeEngine = config.preferredEngine ?? "step";
  }

  /** 更新配置（运行时可切换 API Key 等） */
  updateConfig(config: Partial<AsrServiceConfig>) {
    this.config = { ...this.config, ...config };
  }

  /** 获取当前配置（供单例比较） */
  getConfig(): AsrServiceConfig {
    return this.config;
  }

  /** 当前激活引擎 */
  getActiveEngine(): AsrEngine {
    return this.activeEngine;
  }

  /** 是否录音中 */
  isRecording(): boolean {
    return this.recording;
  }

  /** 累计的最终文本 */
  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  /** 当前 partial 文本 */
  getCurrentPartial(): string {
    return this.currentPartial;
  }

  // ============== 录音 + 流式识别入口 ==============

  /**
   * 开始录音 + 流式 ASR
   * - getUserMedia 获取麦克风
   * - 启动首选引擎，失败自动切换备引擎
   * - 边说边通过 onPartial 回调返回中间结果
   */
  async start(handlers: AsrStreamHandlers): Promise<void> {
    if (this.recording) {
      throw new Error("ASR already recording");
    }

    // 1. 获取麦克风
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // 2. 启动音频处理
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    // ScriptProcessorNode 虽然已废弃但兼容性最好；生产可换 AudioWorklet
    this.processor = this.audioContext.createScriptProcessor(FRAME_SIZE, 1, 1);
    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    // 3. 启动 ASR 会话（首选引擎，失败降级）
    this.session = await this._startSession(handlers);

    this.recording = true;
    this.accumulatedText = "";
    this.currentPartial = "";

    // 4. 音频处理回调：重采样 → 推流
    this.processor.onaudioprocess = (ev: AudioProcessingEvent) => {
      if (!this.recording) return;
      const input = ev.inputBuffer.getChannelData(0);
      // VAD：检测静音
      const rms = this._rms(input);
      const threshold = this.config.silenceThreshold ?? 0.01;
      if (rms < threshold) {
        if (this.silenceStart === 0) this.silenceStart = Date.now();
        const commitMs = this.config.silenceCommitMs ?? 800;
        if (Date.now() - this.silenceStart > commitMs && this.currentPartial) {
          handlers.onSilence?.();
          this.session?.commit();
          this.silenceStart = 0;
        }
      } else {
        this.silenceStart = 0;
      }

      // 重采样到 16kHz PCM16
      const pcm16 = this._resampleToPcm16(input, this.audioContext!.sampleRate);
      const base64 = this._arrayBufferToBase64(pcm16.buffer as ArrayBuffer);
      this.session?.pushAudio(base64);
    };
  }

  /**
   * 停止录音，返回完整转写文本
   * @returns 累计的最终文本（适合填入输入框）
   */
  async stop(): Promise<string> {
    if (!this.recording) return this.accumulatedText;
    this.recording = false;

    // 提交最后一帧
    try {
      this.session?.commit();
    } catch (e) {
      console.warn("[ASR] final commit failed:", e);
    }

    // 等待短暂时间获取最后结果
    await new Promise((r) => setTimeout(r, 300));

    // 关闭会话
    this.session?.close();
    this.session = null;

    // 释放音频资源
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

    return this.accumulatedText;
  }

  /** 主动切换引擎 */
  async switchEngine(engine: AsrEngine, handlers?: AsrStreamHandlers): Promise<void> {
    if (this.activeEngine === engine) return;
    const from = this.activeEngine;
    this.activeEngine = engine;
    handlers?.onEngineSwitch?.(from, engine, "manual switch");

    // 若正在录音，重启会话使用新引擎
    if (this.recording && handlers) {
      this.session?.close();
      this.session = await this._startSession(handlers);
    }
  }

  // ============== 会话启动（含自动降级） ==============

  /**
   * 启动 ASR 会话：先试首选引擎，失败则降级到另一个
   */
  private async _startSession(handlers: AsrStreamHandlers): Promise<AsrSession> {
    const order: AsrEngine[] =
      this.activeEngine === "step" ? ["step", "xiaomi"] : ["xiaomi", "step"];

    let lastError: Error | null = null;
    for (const engine of order) {
      try {
        const session = await this._createSession(engine, handlers);
        if (this.activeEngine !== engine) {
          const from = this.activeEngine;
          this.activeEngine = engine;
          handlers.onEngineSwitch?.(from, engine, `primary "${from}" unavailable`);
        }
        return session;
      } catch (e) {
        lastError = e as Error;
        handlers.onError?.(e as Error, engine);
        console.warn(`[ASR] engine "${engine}" failed, trying fallback:`, e);
      }
    }
    throw new Error(
      `all ASR engines failed. last error: ${lastError?.message ?? "unknown"}`,
    );
  }

  /** 创建指定引擎的会话 */
  private async _createSession(
    engine: AsrEngine,
    handlers: AsrStreamHandlers,
  ): Promise<AsrSession> {
    if (engine === "step") return this._createStepSession(handlers);
    return this._createXiaomiSession(handlers);
  }

  // ============== 阶跃 ASR 会话 ==============

  private async _createStepSession(handlers: AsrStreamHandlers): Promise<AsrSession> {
    const url = this.config.step.realtimeUrl
      ? this.config.step.realtimeUrl.replace(/\/realtime.*$/, "/asr/stream")
      : STEP_ASR_DEFAULT_URL;

    return new Promise<AsrSession>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, ["bearer", this.config.step.apiKey]);
      } catch (e) {
        reject(e);
        return;
      }
      let opened = false;

      ws.onopen = () => {
        opened = true;
        // 发送初始配置：中英自动识别
        this._send(ws, {
          type: "config",
          format: "pcm16",
          sample_rate: TARGET_SAMPLE_RATE,
          channels: 1,
          language: this.config.language ?? "auto",
          enable_punctuation: this.config.enablePunctuation ?? true,
        });
        resolve({
          engine: "step",
          pushAudio: (b64) => this._send(ws, { type: "audio", audio: b64 }),
          commit: () => this._send(ws, { type: "commit" }),
          close: () => {
            try {
              this._send(ws, { type: "stop" });
              ws.close();
            } catch {
              /* noop */
            }
          },
        });
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string);
          this._handleAsrChunk(data, "step", handlers);
        } catch (e) {
          console.debug("[ASR:step] non-json message:", ev.data);
        }
      };

      ws.onerror = () => {
        if (!opened) reject(new Error("step ASR websocket connect failed"));
        else handlers.onError?.(new Error("step ASR websocket error"), "step");
      };

      ws.onclose = () => {
        if (!opened) reject(new Error("step ASR websocket closed before open"));
      };

      // 连接超时保护
      setTimeout(() => {
        if (!opened) reject(new Error("step ASR connect timeout"));
      }, 8000);
    });
  }

  // ============== 小米 MiMo ASR 会话 ==============

  private async _createXiaomiSession(handlers: AsrStreamHandlers): Promise<AsrSession> {
    const { getDefaultXiaomiClient } = await import("@/services/api/xiaomiApi");
    const client = getDefaultXiaomiClient(this.config.xiaomi);

    const req: AsrRequest = {
      format: "pcm16",
      sampleRate: TARGET_SAMPLE_RATE,
      channels: 1,
      language: this._mapLanguage(this.config.language ?? "auto"),
      enablePunctuation: this.config.enablePunctuation ?? true,
    };

    const stream = await client.startStreamingAsr(req, (chunk: AsrChunk) => {
      this._handleAsrChunk(
        {
          text: chunk.text,
          is_final: chunk.isFinal,
          confidence: chunk.confidence,
          utterance_id: chunk.utteranceId,
        },
        "xiaomi",
        handlers,
      );
    });

    return {
      engine: "xiaomi",
      pushAudio: stream.pushAudio,
      commit: stream.stop, // 小米无显式 commit，stop 触发 final
      close: stream.stop,
    };
  }

  // ============== ASR 结果处理 ==============

  private _handleAsrChunk(
    data: any,
    engine: AsrEngine,
    handlers: AsrStreamHandlers,
  ) {
    const text: string = data.text ?? data.result ?? "";
    const isFinal: boolean = data.is_final ?? data.type === "final";
    if (!text) return;

    if (isFinal) {
      // 最终结果：累加到完整文本
      this.currentPartial = "";
      this.accumulatedText = (this.accumulatedText + " " + text).trim();
      handlers.onFinal?.(this.accumulatedText, engine);
    } else {
      // 中间结果：实时显示
      this.currentPartial = text;
      handlers.onPartial?.(
        this.accumulatedText ? `${this.accumulatedText} ${text}` : text,
        engine,
      );
    }
  }

  // ============== 音频处理工具 ==============

  /** 计算 RMS（用于 VAD） */
  private _rms(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  /**
   * 重采样到 16kHz 并转为 PCM16
   * - 输入：Float32Array（AudioContext 采样率，通常 44100/48000）
   * - 输出：Int16Array（16kHz mono）
   */
  private _resampleToPcm16(input: Float32Array, inputRate: number): Int16Array {
    if (inputRate === TARGET_SAMPLE_RATE) {
      return this._float32ToInt16(input);
    }
    const ratio = inputRate / TARGET_SAMPLE_RATE;
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

  /** ArrayBuffer → base64（分块避免栈溢出） */
  private _arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000; // 32KB
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return btoa(binary);
  }

  /** 语言映射：'auto' → 'zh-CN'（小米不支持 auto，阶跃支持） */
  private _mapLanguage(lang: string): string {
    if (lang === "auto") return "zh-CN";
    if (lang === "zh") return "zh-CN";
    if (lang === "en") return "en-US";
    return lang;
  }

  /** 安全发送 WebSocket 消息 */
  private _send(ws: WebSocket, payload: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }
}

// ========================= 单例导出 =========================

let _defaultService: AsrService | null = null;

export function getDefaultAsrService(config?: AsrServiceConfig): AsrService {
  if (!_defaultService || (config && _defaultService.getConfig() !== config)) {
    if (!config) {
      throw new Error("AsrService not initialized: config required on first call");
    }
    _defaultService = new AsrService(config);
  }
  return _defaultService;
}

export function resetDefaultAsrService() {
  if (_defaultService && _defaultService.isRecording()) {
    _defaultService.stop().catch(() => undefined);
  }
  _defaultService = null;
}
