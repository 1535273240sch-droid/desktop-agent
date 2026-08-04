// api/rateLimiter.ts - 限流引擎（前端）
// 令牌桶 + 并发控制 + 指数退避 + 排队（与 Rust 端 api_client.rs 同策略）

import type { RateLimitConfig } from "@/types";

export type { RateLimitConfig };

// ========================= 默认配置 =========================

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxConcurrent: 3,
  requestsPerMinute: 60,
  retryAttempts: 5,
  retryBaseDelay: 1000,
  retryMaxDelay: 32000,
  queueMaxSize: 100,
};

// ========================= 令牌桶 =========================

class TokenBucket {
  private capacity: number;
  private tokens: number;
  private refillPerSec: number;
  private lastRefill: number;

  constructor(capacity: number, refillPerMin: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSec = refillPerMin / 60;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }

  /** 尝试获取一个令牌，返回需要等待的毫秒数（0 表示立即获取） */
  tryAcquire(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const need = 1 - this.tokens;
    return (need / this.refillPerSec) * 1000;
  }

  /** 429 自适应降速：扣除额外令牌 */
  throttle(factor: number) {
    this.refill();
    this.tokens = Math.max(0, this.tokens - factor);
  }
}

// ========================= 限流器 =========================

export class RateLimiter {
  private bucket: TokenBucket;
  private config: RateLimitConfig;
  /** 当前活跃请求数 */
  private active = 0;
  /** 当前排队数 */
  private waiting = 0;
  /** 排队等待的 resolver 队列 */
  private queue: Array<() => void> = [];
  /** 429 降速等级 */
  private throttleLevel = 0;

  constructor(config: RateLimitConfig = DEFAULT_RATE_LIMIT) {
    this.config = config;
    this.bucket = new TokenBucket(config.requestsPerMinute, config.requestsPerMinute);
  }

  /**
   * 限流执行：先排队 → 等待并发许可 → 等待令牌桶 → 执行任务
   * 自动包含指数退避重试逻辑（由任务内部抛出错误时触发）
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await this.retry(task);
    } finally {
      this.release();
    }
  }

  /** 排队 + 并发许可 + 令牌桶 */
  private async acquire(): Promise<void> {
    // 1. 排队上限
    if (this.waiting >= this.config.queueMaxSize) {
      throw new Error("rate limiter: queue is full");
    }
    this.waiting++;

    try {
      // 2. 等待并发许可：有空闲槽则占用，否则排队
      if (this.active < this.config.maxConcurrent) {
        this.active++;
      } else {
        // 等待被唤醒；唤醒时由 release 把槽位移交给我们（已 active++）
        await new Promise<void>((resolve) => this.queue.push(resolve));
      }

      // 3. 等待令牌桶
      let wait = this.bucket.tryAcquire();
      while (wait > 0) {
        await sleep(wait);
        wait = this.bucket.tryAcquire();
      }
    } finally {
      this.waiting--;
    }
  }

  /** 释放并发许可，唤醒队首 */
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // 槽位直接移交给队首（不增不减），保持 active 不变
      next();
    } else {
      // 没人排队，释放槽位
      this.active--;
    }
  }

  /** 指数退避重试：1s → 2s → 4s → 8s → 16s（封顶 retryMaxDelay） */
  private async retry<T>(task: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.config.retryAttempts) {
      try {
        const result = await task();
        // 成功：逐步恢复降速等级
        if (this.throttleLevel > 0) this.throttleLevel--;
        return result;
      } catch (e: any) {
        lastErr = e;
        const msg = (e?.message ?? "").toLowerCase();
        const is429 = msg.includes("429") || msg.includes("rate limit");
        const is5xx = /\b5\d{2}\b/.test(msg) || msg.includes("server error");
        const isNetwork = msg.includes("network") || msg.includes("fetch");

        // 仅对可重试错误进行退避
        if (!is429 && !is5xx && !isNetwork) throw e;
        if (attempt >= this.config.retryAttempts) throw e;

        if (is429) {
          this.on429();
        }
        const delay = this.backoffDelay(attempt);
        await sleep(delay);
        attempt++;
      }
    }
    throw lastErr;
  }

  /** 指数退避：1s → 2s → 4s → 8s → 16s */
  private backoffDelay(attempt: number): number {
    const exp = Math.pow(2, attempt);
    const delay = this.config.retryBaseDelay * exp;
    return Math.min(delay, this.config.retryMaxDelay);
  }

  /** 429 自适应降速：提高 throttle 等级，扣除额外令牌 */
  on429(): void {
    this.throttleLevel = Math.min(5, this.throttleLevel + 1);
    const factor = 1 + this.throttleLevel;
    this.bucket.throttle(factor);
  }

  /** 当前排队数（监控用） */
  getWaitingCount(): number {
    return this.waiting;
  }

  /** 当前活跃请求数 */
  getActiveCount(): number {
    return this.active;
  }

  /** 更新配置（重置令牌桶） */
  updateConfig(config: Partial<RateLimitConfig>): void {
    this.config = { ...this.config, ...config };
    this.bucket = new TokenBucket(this.config.requestsPerMinute, this.config.requestsPerMinute);
  }
}

// ========================= 工具函数 =========================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
