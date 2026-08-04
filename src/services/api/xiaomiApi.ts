// api/xiaomiApi.ts - 小米 MiMo API
// ASR 语音识别（流式）+ MiMo 对话补全

import type { XiaomiApiConfig } from "@/types";
import { RateLimiter, type RateLimitConfig } from "./rateLimiter";

// ========================= 常量 =========================

const XIAOMI_ASR_URL = "https://mimo-api.mimi.baidu.com/v1/asr/stream";
const XIAOMI_CHAT_URL = "https://mimo-api.mimi.baidu.com/v1/chat/completions";

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxConcurrent: 3,
  requestsPerMinute: 30,
  retryAttempts: 5,
  retryBaseDelay: 1000,
  retryMaxDelay: 32000,
  queueMaxSize: 100,
};

// ========================= 类型定义 =========================

/** ASR 流式识别片段 */
export interface AsrChunk {
  /** 增量识别文本（中间结果可能变化） */
  text: string;
  /** 是否为最终结果 */
  isFinal: boolean;
  /** 置信度 0-1 */
  confidence?: number;
  /** 句子序号 */
  utteranceId?: number;
  raw?: any;
}

export type AsrCallback = (chunk: AsrChunk) => void;

/** ASR 请求参数 */
export interface AsrRequest {
  /** 音频格式：pcm16 / wav / mp3 */
  format: "pcm16" | "wav" | "mp3";
  /** 采样率 */
  sampleRate: number;
  /** 通道数 */
  channels?: number;
  /** 语言 */
  language?: string;
  /** 是否启用标点 */
  enablePunctuation?: boolean;
}

// ========================= 客户端 =========================

export class XiaomiApiClient {
  private config: XiaomiApiConfig;
  private limiter: RateLimiter;
  private asrWs: WebSocket | null = null;

  constructor(config: XiaomiApiConfig, rateLimit?: RateLimitConfig) {
    this.config = config;
    this.limiter = new RateLimiter(rateLimit ?? DEFAULT_RATE_LIMIT);
  }

  updateConfig(config: Partial<XiaomiApiConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): XiaomiApiConfig {
    return this.config;
  }

  // ============== 流式 ASR ==============

  /**
   * 流式 ASR：通过 WebSocket 持续推送音频，实时返回识别结果
   * @param req ASR 配置
   * @param onChunk 识别结果回调
   * @returns 关闭函数（停止识别）
   */
  async startStreamingAsr(
    req: AsrRequest,
    onChunk: AsrCallback,
  ): Promise<{
    /** 推送 PCM 音频片段（base64） */
    pushAudio: (base64Audio: string) => void;
    /** 结束识别 */
    stop: () => void;
  }> {
    await this.limiter.run(async () => undefined);

    const url = `${XIAOMI_ASR_URL}?app_id=${encodeURIComponent(this.config.appId)}&format=${req.format}&sample_rate=${req.sampleRate}`;
    const ws = new WebSocket(url, ["bearer", this.config.apiKey]);
    this.asrWs = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    // 发送初始配置
    this._sendAsr({
      type: "config",
      format: req.format,
      sample_rate: req.sampleRate,
      channels: req.channels ?? 1,
      language: req.language ?? "zh-CN",
      enable_punctuation: req.enablePunctuation ?? true,
    });

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string);
        onChunk({
          text: data.text ?? data.result ?? "",
          isFinal: data.is_final ?? data.type === "final",
          confidence: data.confidence,
          utteranceId: data.utterance_id,
          raw: data,
        });
      } catch (e) {
        console.warn("ASR parse error:", e);
      }
    };

    return {
      pushAudio: (base64Audio: string) => {
        this._sendAsr({ type: "audio", audio: base64Audio });
      },
      stop: () => {
        this._sendAsr({ type: "stop" });
        if (this.asrWs) {
          this.asrWs.close();
          this.asrWs = null;
        }
      },
    };
  }

  private _sendAsr(payload: any) {
    if (this.asrWs && this.asrWs.readyState === WebSocket.OPEN) {
      this.asrWs.send(JSON.stringify(payload));
    }
  }

  // ============== 一次性 ASR（整段音频） ==============

  /**
   * 一次性识别整段音频
   * @param audioBase64 完整音频的 base64
   * @param req 配置
   */
  async recognizeOnce(audioBase64: string, req: AsrRequest): Promise<string> {
    return this.limiter.run(() => this._recognizeOnce(audioBase64, req));
  }

  private async _recognizeOnce(audioBase64: string, req: AsrRequest): Promise<string> {
    const url = `${XIAOMI_ASR_URL.replace("/stream", "")}`;
    const body = {
      app_id: this.config.appId,
      format: req.format,
      sample_rate: req.sampleRate,
      channels: req.channels ?? 1,
      language: req.language ?? "zh-CN",
      enable_punctuation: req.enablePunctuation ?? true,
      audio: audioBase64,
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
      throw new Error(`ASR failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    return data.text ?? data.result ?? "";
  }

  // ============== MiMo 对话（可选） ==============

  async chat(messages: Array<{ role: string; content: string }>, model = "mimo-7b"): Promise<string> {
    return this.limiter.run(() => this._chat(messages, model));
  }

  private async _chat(messages: Array<{ role: string; content: string }>, model: string): Promise<string> {
    const resp = await fetch(XIAOMI_CHAT_URL, {
      method: "POST",
      headers: this._buildHeaders(),
      body: JSON.stringify({ model, messages }),
    });
    if (resp.status === 429) {
      this.limiter.on429();
      throw new Error("rate limited (429)");
    }
    if (!resp.ok) {
      throw new Error(`chat failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  // ============== 工具方法 ==============

  private _buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      "X-App-Id": this.config.appId,
    };
  }
}

// ========================= 默认导出 =========================

let _defaultClient: XiaomiApiClient | null = null;

export function getDefaultXiaomiClient(config?: XiaomiApiConfig): XiaomiApiClient {
  if (!_defaultClient || (config && _defaultClient.getConfig() !== config)) {
    if (!config) {
      throw new Error("XiaomiApiClient not initialized: config required on first call");
    }
    _defaultClient = new XiaomiApiClient(config);
  }
  return _defaultClient;
}

export function resetDefaultXiaomiClient() {
  _defaultClient = null;
}
