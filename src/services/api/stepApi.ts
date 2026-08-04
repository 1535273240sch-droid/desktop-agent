// api/stepApi.ts - 阶跃星辰 API
// 识图(step-1o-turbo-vision) + 生图(step-image-edit-2 文生图+图生图) + TTS(StepAudio 2.5) + Realtime(WebSocket) + 音色列表

import type { StepApiConfig } from "@/types";
import { RateLimiter, type RateLimitConfig } from "./rateLimiter";

// ========================= 常量 =========================

const STEP_BASE_URL = "https://api.stepfun.com/v1";
const STEP_REALTIME_URL = "wss://api.stepfun.com/v1/realtime";

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxConcurrent: 3,
  requestsPerMinute: 30,
  retryAttempts: 5,
  retryBaseDelay: 1000,
  retryMaxDelay: 32000,
  queueMaxSize: 100,
};

// ========================= 类型定义 =========================

/** 识图结果 */
export interface VisionResult {
  description: string;
  objects?: Array<{ name: string; confidence: number; bbox?: [number, number, number, number] }>;
  text?: string; // OCR 文本
  raw: any;
}

/** 生图请求 */
export interface ImageGenRequest {
  prompt: string;
  /** 图生图时的参考图（base64 或 URL） */
  referenceImage?: string;
  /** 负向提示词 */
  negativePrompt?: string;
  width?: number;
  height?: number;
  /** 1-10，越大越贴近 prompt */
  guidanceScale?: number;
  /** 1-50 */
  steps?: number;
  seed?: number;
}

export interface ImageGenResult {
  images: string[]; // base64 或 URL
  raw: any;
}

/** TTS 请求 */
export interface TtsRequest {
  text: string;
  voiceId?: string;
  speed?: number; // 0.5 - 2.0
  volume?: number; // 0 - 100
  pitch?: number; // -10 - 10
  format?: "mp3" | "wav" | "pcm";
}

export interface TtsResult {
  audioBase64: string;
  format: string;
  durationMs: number;
  raw: any;
}

/** 音色信息 */
export interface VoiceInfo {
  id: string;
  name: string;
  gender: "male" | "female" | "unknown";
  language: string;
  description?: string;
  previewUrl?: string;
}

/** Realtime 事件 */
export type RealtimeEvent =
  | { type: "session.created"; sessionId: string }
  | { type: "session.updated"; config: any }
  | { type: "input_audio_buffer.appended" }
  | { type: "input_audio_buffer.committed" }
  | { type: "response.audio.delta"; delta: string } // base64 音频片段
  | { type: "response.audio.done" }
  | { type: "response.text.delta"; delta: string }
  | { type: "response.text.done"; text: string }
  | { type: "response.done" }
  | { type: "error"; error: { message: string; code?: string } }
  | { type: "raw"; data: any };

export type RealtimeCallback = (event: RealtimeEvent) => void;

// ========================= 客户端 =========================

export class StepApiClient {
  private config: StepApiConfig;
  private limiter: RateLimiter;
  private realtimeWs: WebSocket | null = null;

  constructor(config: StepApiConfig, rateLimit?: RateLimitConfig) {
    this.config = config;
    this.limiter = new RateLimiter(rateLimit ?? DEFAULT_RATE_LIMIT);
  }

  updateConfig(config: Partial<StepApiConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): StepApiConfig {
    return this.config;
  }

  // ============== 识图 (step-1o-turbo-vision) ==============

  /**
   * 使用 step-1o-turbo-vision 模型识别图片
   * @param image base64 或 URL
   * @param prompt 询问内容
   */
  async recognizeImage(image: string, prompt: string): Promise<VisionResult> {
    return this.limiter.run(() => this._recognizeImage(image, prompt));
  }

  private async _recognizeImage(image: string, prompt: string): Promise<VisionResult> {
    const url = `${STEP_BASE_URL}/chat/completions`;
    const isDataUrl = image.startsWith("data:") || image.startsWith("http");
    const imageUrl = isDataUrl ? image : `data:image/png;base64,${image}`;

    const body = {
      model: this.config.visionModel || "step-1o-turbo-vision",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      max_tokens: 1024,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: this._buildHeaders(),
      body: JSON.stringify(body),
    });
    if (resp.status === 429) {
      this.limiter.on429();
      throw new Error("rate limited (429)");
    }
    if (!resp.ok) {
      throw new Error(`vision failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    const text: string = data.choices?.[0]?.message?.content ?? "";

    // 尝试从回复中解析结构化结果
    let objects: VisionResult["objects"];
    let ocr: string | undefined;
    try {
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        objects = parsed.objects;
        ocr = parsed.text;
      }
    } catch {
      // 解析失败保持纯文本
    }

    return {
      description: text,
      objects,
      text: ocr,
      raw: data,
    };
  }

  // ============== 生图 (step-image-edit-2) ==============

  /** 文生图 */
  async textToImage(prompt: string, opts?: Omit<ImageGenRequest, "prompt" | "referenceImage">): Promise<ImageGenResult> {
    return this.imageEdit({ prompt, ...opts });
  }

  /** 图生图（带参考图） */
  async imageToImage(prompt: string, referenceImage: string, opts?: Omit<ImageGenRequest, "prompt" | "referenceImage">): Promise<ImageGenResult> {
    return this.imageEdit({ prompt, referenceImage, ...opts });
  }

  /** step-image-edit-2 通用入口 */
  async imageEdit(req: ImageGenRequest): Promise<ImageGenResult> {
    return this.limiter.run(() => this._imageEdit(req));
  }

  private async _imageEdit(req: ImageGenRequest): Promise<ImageGenResult> {
    const url = `${STEP_BASE_URL}/images/generations`;
    const body: Record<string, any> = {
      model: this.config.imageModel || "step-image-edit-2",
      prompt: req.prompt,
      n: 1,
      size: `${req.width ?? 1024}x${req.height ?? 1024}`,
      response_format: "b64_json",
    };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
    if (req.guidanceScale) body.guidance_scale = req.guidanceScale;
    if (req.steps) body.steps = req.steps;
    if (typeof req.seed === "number") body.seed = req.seed;
    if (req.referenceImage) {
      // 图生图：通过 images 字段传入参考图
      const isDataUrl = req.referenceImage.startsWith("data:") || req.referenceImage.startsWith("http");
      body.image = isDataUrl ? req.referenceImage : `data:image/png;base64,${req.referenceImage}`;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: this._buildHeaders(),
      body: JSON.stringify(body),
    });
    if (resp.status === 429) {
      this.limiter.on429();
      throw new Error("rate limited (429)");
    }
    if (!resp.ok) {
      throw new Error(`image gen failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    const images: string[] = (data.data ?? []).map((d: any) => d.b64_json ?? d.url).filter(Boolean);
    return { images, raw: data };
  }

  // ============== TTS (StepAudio 2.5) ==============

  async tts(req: TtsRequest): Promise<TtsResult> {
    return this.limiter.run(() => this._tts(req));
  }

  private async _tts(req: TtsRequest): Promise<TtsResult> {
    const url = `${STEP_BASE_URL}/audio/speech`;
    const body: Record<string, any> = {
      model: this.config.ttsModel || "step-tts-mini",
      input: req.text,
      voice: req.voiceId || "default",
      response_format: req.format ?? "mp3",
    };
    if (typeof req.speed === "number") body.speed = req.speed;
    if (typeof req.volume === "number") body.volume = req.volume;
    if (typeof req.pitch === "number") body.pitch = req.pitch;

    const started = Date.now();
    const resp = await fetch(url, {
      method: "POST",
      headers: this._buildHeaders(),
      body: JSON.stringify(body),
    });
    if (resp.status === 429) {
      this.limiter.on429();
      throw new Error("rate limited (429)");
    }
    if (!resp.ok) {
      throw new Error(`tts failed: ${resp.status} ${await resp.text()}`);
    }

    // 响应可能是二进制音频或 base64 JSON
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = await resp.json();
      return {
        audioBase64: data.audio ?? data.data ?? "",
        format: req.format ?? "mp3",
        durationMs: Date.now() - started,
        raw: data,
      };
    }
    // 二进制音频
    const buf = await resp.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return {
      audioBase64: base64,
      format: req.format ?? "mp3",
      durationMs: Date.now() - started,
      raw: { contentType, size: buf.byteLength },
    };
  }

  // ============== 音色列表 ==============

  async listVoices(): Promise<VoiceInfo[]> {
    return this.limiter.run(() => this._listVoices());
  }

  private async _listVoices(): Promise<VoiceInfo[]> {
    const url = `${STEP_BASE_URL}/audio/voices`;
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: this._buildHeaders(),
      });
      if (resp.status === 429) {
        this.limiter.on429();
        throw new Error("rate limited (429)");
      }
      if (!resp.ok) {
        // 部分供应商无此端点，返回内置默认音色
        return DEFAULT_VOICES;
      }
      const data = await resp.json();
      const list = data.voices ?? data.data ?? [];
      return list.map((v: any) => ({
        id: v.id ?? v.voice_id ?? v.name,
        name: v.name ?? v.id,
        gender: v.gender ?? "unknown",
        language: v.language ?? "zh",
        description: v.description,
        previewUrl: v.preview_url ?? v.preview,
      }));
    } catch (e) {
      console.warn("list voices failed, fallback to defaults:", e);
      return DEFAULT_VOICES;
    }
  }

  // ============== Realtime (WebSocket) ==============

  /** 建立 Realtime WebSocket 连接 */
  connectRealtime(onEvent: RealtimeCallback, config?: Record<string, any>): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.config.realtimeUrl || STEP_REALTIME_URL;
      const ws = new WebSocket(url, ["bearer", this.config.apiKey]);
      this.realtimeWs = ws;

      ws.onopen = () => {
        // 发送 session.update 配置
        this._sendRealtime({
          type: "session.update",
          session: {
            voice: config?.voice ?? "default",
            modalities: ["text", "audio"],
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            ...config,
          },
        });
        onEvent({ type: "session.created", sessionId: crypto.randomUUID() });
        resolve();
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string);
          this._dispatchRealtime(data, onEvent);
        } catch (e) {
          onEvent({ type: "raw", data: ev.data });
        }
      };

      ws.onerror = (e) => {
        onEvent({ type: "error", error: { message: "websocket error" } });
        reject(e);
      };

      ws.onclose = () => {
        this.realtimeWs = null;
      };
    });
  }

  /** 追加音频输入（流式 ASR 输入） */
  sendAudioChunk(base64Pcm16: string) {
    this._sendRealtime({
      type: "input_audio_buffer.append",
      audio: base64Pcm16,
    });
  }

  /** 提交音频输入缓冲（触发模型响应） */
  commitAudioBuffer() {
    this._sendRealtime({ type: "input_audio_buffer.commit" });
  }

  /** 中断当前响应 */
  interruptResponse() {
    this._sendRealtime({ type: "response.cancel" });
  }

  /** 关闭 Realtime 连接 */
  disconnectRealtime() {
    if (this.realtimeWs) {
      this.realtimeWs.close();
      this.realtimeWs = null;
    }
  }

  private _sendRealtime(payload: any) {
    if (this.realtimeWs && this.realtimeWs.readyState === WebSocket.OPEN) {
      this.realtimeWs.send(JSON.stringify(payload));
    }
  }

  private _dispatchRealtime(data: any, cb: RealtimeCallback) {
    switch (data.type) {
      case "session.updated":
        cb({ type: "session.updated", config: data.session });
        break;
      case "input_audio_buffer.appended":
        cb({ type: "input_audio_buffer.appended" });
        break;
      case "input_audio_buffer.committed":
        cb({ type: "input_audio_buffer.committed" });
        break;
      case "response.audio.delta":
        cb({ type: "response.audio.delta", delta: data.delta });
        break;
      case "response.audio.done":
        cb({ type: "response.audio.done" });
        break;
      case "response.text.delta":
        cb({ type: "response.text.delta", delta: data.delta });
        break;
      case "response.text.done":
        cb({ type: "response.text.done", text: data.text });
        break;
      case "response.done":
        cb({ type: "response.done" });
        break;
      case "error":
        cb({ type: "error", error: { message: data.error?.message ?? "unknown", code: data.error?.code } });
        break;
      default:
        cb({ type: "raw", data });
    }
  }

  // ============== 工具方法 ==============

  private _buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }
}

// ========================= 默认音色 =========================

const DEFAULT_VOICES: VoiceInfo[] = [
  { id: "default", name: "默认女声", gender: "female", language: "zh", description: "通用女声" },
  { id: "male-1", name: "沉稳男声", gender: "male", language: "zh", description: "成熟男声" },
  { id: "female-1", name: "甜美女声", gender: "female", language: "zh", description: "年轻女声" },
  { id: "child-1", name: "童声", gender: "unknown", language: "zh", description: "儿童音色" },
  { id: "english-1", name: "English Voice", gender: "female", language: "en", description: "Native English" },
];

// ========================= 默认导出 =========================

let _defaultClient: StepApiClient | null = null;

export function getDefaultStepClient(config?: StepApiConfig): StepApiClient {
  if (!_defaultClient || (config && _defaultClient.getConfig() !== config)) {
    if (!config) {
      throw new Error("StepApiClient not initialized: config required on first call");
    }
    _defaultClient = new StepApiClient(config);
  }
  return _defaultClient;
}

export function resetDefaultStepClient() {
  _defaultClient = null;
}
