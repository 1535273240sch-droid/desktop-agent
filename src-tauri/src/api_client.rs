// api_client.rs - API网络层
// OpenAI兼容格式请求 + 流式输出(SSE) + 限流引擎 + Token统计

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

// ========================= 数据结构 =========================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default = "default_top_p")]
    pub top_p: f64,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub custom_headers: HashMap<String, String>,
    #[serde(default)]
    pub advanced_params: serde_json::Value,
}

fn default_temperature() -> f64 {
    0.7
}
fn default_top_p() -> f64 {
    1.0
}
fn default_max_tokens() -> u32 {
    4096
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    pub delta: String,
    pub finish_reason: Option<String>,
    pub tool_calls: Option<Vec<serde_json::Value>>,
    pub usage: Option<TokenUsage>,
}

// ========================= 限流引擎 =========================

/// 令牌桶：以固定速率补充令牌，容量上限 = requests_per_minute
struct TokenBucket {
    capacity: u32,
    tokens: f64,
    refill_per_sec: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(capacity: u32, refill_per_min: u32) -> Self {
        Self {
            capacity,
            tokens: capacity as f64,
            refill_per_sec: refill_per_min as f64 / 60.0,
            last_refill: Instant::now(),
        }
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity as f64);
        self.last_refill = now;
    }

    /// 尝试获取一个令牌，返回需要等待的时间
    fn try_acquire(&mut self) -> Option<Duration> {
        self.refill();
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            None
        } else {
            let need = 1.0 - self.tokens;
            let wait = need / self.refill_per_sec;
            Some(Duration::from_secs_f64(wait))
        }
    }

    /// 429自适应降速：扣除额外令牌（让后续请求等更久）
    fn throttle(&mut self, factor: f64) {
        self.refill();
        self.tokens = (self.tokens - factor).max(0.0);
    }
}

/// 限流引擎：令牌桶 + 并发控制 + 指数退避 + 排队
pub struct RateLimiter {
    bucket: Mutex<TokenBucket>,
    semaphore: Arc<Semaphore>,
    /// 当前排队中的请求数（Atomic，便于在 Drop 中递减）
    waiting: AtomicU32,
    queue_max: u32,
    retry_attempts: u32,
    retry_base_delay: Duration,
    retry_max_delay: Duration,
    /// 429降速等级（越大越保守）
    throttle_level: Mutex<u32>,
}

impl RateLimiter {
    pub fn new(max_concurrent: usize, requests_per_minute: u32) -> Self {
        Self::with_config(max_concurrent, requests_per_minute, 5, 1000, 32000, 100)
    }

    pub fn with_config(
        max_concurrent: usize,
        requests_per_minute: u32,
        retry_attempts: u32,
        retry_base_delay_ms: u64,
        retry_max_delay_ms: u64,
        queue_max: u32,
    ) -> Self {
        Self {
            bucket: Mutex::new(TokenBucket::new(requests_per_minute, requests_per_minute)),
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            waiting: AtomicU32::new(0),
            queue_max,
            retry_attempts,
            retry_base_delay: Duration::from_millis(retry_base_delay_ms),
            retry_max_delay: Duration::from_millis(retry_max_delay_ms),
            throttle_level: Mutex::new(0),
        }
    }

    /// 排队等待 + 令牌桶 + 并发许可
    async fn acquire(&self) -> Result<OwnedPermit, RateLimitError> {
        // 1. 排队上限检查（CAS）
        loop {
            let cur = self.waiting.load(Ordering::Acquire);
            if cur >= self.queue_max {
                return Err(RateLimitError::QueueFull);
            }
            if self
                .waiting
                .compare_exchange(cur, cur + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                break;
            }
        }

        // RAII 守护：无论成败，退出 acquire 时把 waiting 减一
        struct WaitingGuard<'a>(&'a RateLimiter);
        impl Drop for WaitingGuard<'_> {
            fn drop(&mut self) {
                self.0.waiting.fetch_sub(1, Ordering::Release);
            }
        }
        let _waiting_guard = WaitingGuard(self);

        // 2. 等待并发许可
        let permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| RateLimitError::Closed)?;

        // 3. 令牌桶：必要时等待补充
        loop {
            let wait = {
                let mut bucket = self.bucket.lock().await;
                bucket.try_acquire()
            };
            match wait {
                None => break,
                Some(d) => {
                    tokio::time::sleep(d).await;
                }
            }
        }

        // 拿到 permit 后释放 waiting 守护（_waiting_guard drop），并返回 permit
        drop(_waiting_guard);
        Ok(OwnedPermit { _permit: permit })
    }

    /// 指数退避延迟：1s → 2s → 4s → 8s → 16s（封顶 retry_max_delay）
    fn backoff_delay(&self, attempt: u32) -> Duration {
        let exp = 2u32.saturating_pow(attempt);
        let delay = self.retry_base_delay.saturating_mul(exp as u32);
        delay.min(self.retry_max_delay)
    }

    /// 429 自适应降速：提高throttle等级，下次获取令牌时扣除更多
    async fn on_429(&self) {
        let mut level = self.throttle_level.lock().await;
        *level = (*level + 1).min(5);
        let factor = 1.0 + *level as f64;
        drop(level);
        let mut bucket = self.bucket.lock().await;
        bucket.throttle(factor);
    }

    /// 成功后逐步恢复
    async fn on_success(&self) {
        let mut level = self.throttle_level.lock().await;
        if *level > 0 {
            *level -= 1;
        }
    }

    /// 当前排队数量（监控用）
    pub fn waiting_count(&self) -> u32 {
        self.waiting.load(Ordering::Acquire)
    }
}

pub struct OwnedPermit {
    _permit: tokio::sync::OwnedSemaphorePermit,
}

#[derive(Debug, thiserror::Error)]
pub enum RateLimitError {
    #[error("queue is full")]
    QueueFull,
    #[error("limiter closed")]
    Closed,
}

// ========================= API 客户端 =========================

pub struct ApiClient {
    http: reqwest::Client,
    config: Arc<Mutex<ApiConfig>>,
    limiter: Arc<RateLimiter>,
    usage: Arc<Mutex<TokenUsage>>,
}

impl ApiClient {
    pub fn new(config: ApiConfig, limiter: RateLimiter) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("failed to build reqwest client");
        Self {
            http,
            config: Arc::new(Mutex::new(config)),
            limiter: Arc::new(limiter),
            usage: Arc::new(Mutex::new(TokenUsage::default())),
        }
    }

    pub async fn update_config(&self, config: ApiConfig) {
        *self.config.lock().await = config;
    }

    pub async fn get_usage(&self) -> TokenUsage {
        self.usage.lock().await.clone()
    }

    /// 列出可用模型 (GET /v1/models)
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ApiError> {
        let cfg = self.config.lock().await.clone();
        let url = format!("{}/v1/models", cfg.base_url.trim_end_matches('/'));

        let permit = self.limiter.acquire().await.map_err(ApiError::RateLimit)?;

        let resp = self
            .http
            .get(&url)
            .bearer_auth(&cfg.api_key)
            .headers(build_headers(&cfg)?)
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        drop(permit);

        if resp.status() == 429 {
            self.limiter.on_429().await;
            return Err(ApiError::RateLimited);
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(ApiError::Status(status.as_u16(), body));
        }

        let body: ModelsResponse =
            resp.json().await.map_err(|e| ApiError::Decode(e.to_string()))?;
        Ok(body.data)
    }

    /// 非流式对话
    pub async fn chat(&self, req: ChatRequest) -> Result<ChatCompletion, ApiError> {
        let cfg = self.config.lock().await.clone();
        let url = format!("{}/v1/chat/completions", cfg.base_url.trim_end_matches('/'));

        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let permit = self.limiter.acquire().await.map_err(ApiError::RateLimit)?;

            let body = serde_json::to_value(&req).map_err(|e| ApiError::Encode(e.to_string()))?;
            let resp = self
                .http
                .post(&url)
                .bearer_auth(&cfg.api_key)
                .headers(build_headers(&cfg)?)
                .json(&body)
                .send()
                .await
                .map_err(|e| ApiError::Network(e.to_string()))?;

            drop(permit);

            let status = resp.status();
            if status == 429 {
                self.limiter.on_429().await;
                if attempt <= self.limiter.retry_attempts {
                    tokio::time::sleep(self.limiter.backoff_delay(attempt - 1)).await;
                    continue;
                }
                return Err(ApiError::RateLimited);
            }

            if status.is_server_error() && attempt <= self.limiter.retry_attempts {
                let _ = resp.text().await;
                tokio::time::sleep(self.limiter.backoff_delay(attempt - 1)).await;
                continue;
            }

            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Err(ApiError::Status(status.as_u16(), body));
            }

            let completion: ChatCompletion =
                resp.json().await.map_err(|e| ApiError::Decode(e.to_string()))?;

            // 累计token统计
            if let Some(u) = completion.usage.clone() {
                let mut usage = self.usage.lock().await;
                usage.prompt_tokens += u.prompt_tokens;
                usage.completion_tokens += u.completion_tokens;
                usage.total_tokens += u.total_tokens;
            }

            self.limiter.on_success().await;
            return Ok(completion);
        }
    }

    /// 流式对话 (SSE)
    /// 通过 mpsc channel 向调用方推送 StreamChunk
    pub async fn chat_stream(
        &self,
        req: ChatRequest,
        cancel: CancellationToken,
    ) -> Result<mpsc::Receiver<Result<StreamChunk, ApiError>>, ApiError> {
        let cfg = self.config.lock().await.clone();
        let url = format!("{}/v1/chat/completions", cfg.base_url.trim_end_matches('/'));

        let mut req = req;
        req.stream = Some(true);

        let (tx, rx) = mpsc::channel(64);

        let http = self.http.clone();
        let limiter = self.limiter.clone();
        let usage = self.usage.clone();

        tokio::spawn(async move {
            let mut attempt = 0u32;
            loop {
                attempt += 1;

                let permit = match limiter.acquire().await {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = tx.send(Err(ApiError::RateLimit(e))).await;
                        return;
                    }
                };

                let body = match serde_json::to_value(&req) {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = tx.send(Err(ApiError::Encode(e.to_string()))).await;
                        return;
                    }
                };

                let resp = match http
                    .post(&url)
                    .bearer_auth(&cfg.api_key)
                    .headers(build_headers(&cfg).unwrap_or_default())
                    .json(&body)
                    .send()
                    .await
                {
                    Ok(r) => r,
                    Err(e) => {
                        if attempt <= limiter.retry_attempts {
                            tokio::time::sleep(limiter.backoff_delay(attempt - 1)).await;
                            continue;
                        }
                        let _ = tx.send(Err(ApiError::Network(e.to_string()))).await;
                        return;
                    }
                };

                drop(permit);

                let status = resp.status();
                if status == 429 {
                    limiter.on_429().await;
                    if attempt <= limiter.retry_attempts {
                        tokio::time::sleep(limiter.backoff_delay(attempt - 1)).await;
                        continue;
                    }
                    let _ = tx.send(Err(ApiError::RateLimited)).await;
                    return;
                }

                if !status.is_success() {
                    let body = resp.text().await.unwrap_or_default();
                    let _ = tx.send(Err(ApiError::Status(status.as_u16(), body))).await;
                    return;
                }

                // 解析 SSE 流
                let mut stream = resp.bytes_stream();
                let mut buf = String::new();
                let mut last_usage: Option<TokenUsage> = None;
                let mut had_chunk = false;

                while let Some(chunk_result) = stream.next().await {
                    if cancel.is_cancelled() {
                        let _ = tx.send(Err(ApiError::Cancelled)).await;
                        return;
                    }
                    let chunk = match chunk_result {
                        Ok(c) => c,
                        Err(e) => {
                            let _ = tx.send(Err(ApiError::Network(e.to_string()))).await;
                            return;
                        }
                    };
                    buf.push_str(&String::from_utf8_lossy(&chunk));

                    // 按行解析 SSE
                    while let Some(idx) = buf.find('\n') {
                        let line = buf[..idx].trim_end_matches('\r').to_string();
                        buf = buf[idx + 1..].to_string();

                        if line.is_empty() {
                            continue;
                        }
                        if let Some(data) = line.strip_prefix("data: ") {
                            let data = data.trim();
                            if data == "[DONE]" {
                                if let Some(u) = last_usage.take() {
                                    let mut usage_g = usage.lock().await;
                                    usage_g.prompt_tokens += u.prompt_tokens;
                                    usage_g.completion_tokens += u.completion_tokens;
                                    usage_g.total_tokens += u.total_tokens;
                                }
                                limiter.on_success().await;
                                return;
                            }
                            match serde_json::from_str::<SseChunk>(data) {
                                Ok(parsed) => {
                                    had_chunk = true;
                                    let chunk = StreamChunk {
                                        delta: parsed
                                            .choices
                                            .first()
                                            .and_then(|c| c.delta.content.clone())
                                            .unwrap_or_default(),
                                        finish_reason: parsed
                                            .choices
                                            .first()
                                            .and_then(|c| c.finish_reason.clone()),
                                        tool_calls: parsed
                                            .choices
                                            .first()
                                            .and_then(|c| c.delta.tool_calls.clone()),
                                        usage: parsed.usage.clone(),
                                    };
                                    if let Some(u) = &parsed.usage {
                                        last_usage = Some(u.clone());
                                    }
                                    if tx.send(Ok(chunk)).await.is_err() {
                                        return;
                                    }
                                }
                                Err(e) => {
                                    log::warn!("SSE parse error: {} | line: {}", e, data);
                                }
                            }
                        }
                    }
                }

                // 流结束但没收到 [DONE]
                if had_chunk {
                    if let Some(u) = last_usage.take() {
                        let mut usage_g = usage.lock().await;
                        usage_g.prompt_tokens += u.prompt_tokens;
                        usage_g.completion_tokens += u.completion_tokens;
                        usage_g.total_tokens += u.total_tokens;
                    }
                    limiter.on_success().await;
                    return;
                }

                // 没收到任何 chunk，可能是临时故障，重试
                if attempt <= limiter.retry_attempts {
                    tokio::time::sleep(limiter.backoff_delay(attempt - 1)).await;
                    continue;
                }
                let _ = tx.send(Err(ApiError::EmptyStream)).await;
                return;
            }
        });

        Ok(rx)
    }
}

fn build_headers(cfg: &ApiConfig) -> Result<reqwest::header::HeaderMap, ApiError> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("application/json"),
    );
    for (k, v) in &cfg.custom_headers {
        let name =
            HeaderName::from_bytes(k.as_bytes()).map_err(|e| ApiError::Encode(e.to_string()))?;
        let val = HeaderValue::from_str(v).map_err(|e| ApiError::Encode(e.to_string()))?;
        headers.insert(name, val);
    }
    Ok(headers)
}

// ========================= 响应数据结构 =========================

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub object: Option<String>,
    pub owned_by: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelInfo>,
}

#[derive(Debug, Clone, Deserialize)]
struct SseChunk {
    choices: Vec<SseChoice>,
    #[serde(default)]
    usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Deserialize)]
struct SseChoice {
    delta: SseDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SseDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatCompletion {
    pub id: String,
    pub choices: Vec<ChatChoice>,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatChoice {
    pub index: u32,
    pub message: ChatChoiceMessage,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatChoiceMessage {
    pub role: String,
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<serde_json::Value>>,
}

// ========================= 错误类型 =========================

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("network error: {0}")]
    Network(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("encode error: {0}")]
    Encode(String),
    #[error("http status {0}: {1}")]
    Status(u16, String),
    #[error("rate limited (429)")]
    RateLimited,
    #[error("rate limit error: {0}")]
    RateLimit(#[from] RateLimitError),
    #[error("cancelled")]
    Cancelled,
    #[error("empty stream")]
    EmptyStream,
}

// ========================= Tauri 命令 =========================

#[tauri::command]
pub async fn api_chat(
    config: ApiConfig,
    messages: Vec<ChatMessage>,
    tools: Option<Vec<serde_json::Value>>,
) -> Result<ChatCompletion, String> {
    let limiter = RateLimiter::new(3, 60);
    let client = ApiClient::new(config, limiter);
    let model = client.config.lock().await.model.clone();
    let (temperature, top_p, max_tokens) = {
        let c = client.config.lock().await;
        (c.temperature, c.top_p, c.max_tokens)
    };
    let req = ChatRequest {
        model,
        messages,
        temperature: Some(temperature),
        top_p: Some(top_p),
        max_tokens: Some(max_tokens),
        stream: None,
        tools,
        tool_choice: None,
        extra: HashMap::new(),
    };
    client.chat(req).await.map_err(|e| format!("api_chat: {e}"))
}

#[tauri::command]
pub async fn api_list_models(config: ApiConfig) -> Result<Vec<ModelInfo>, String> {
    let limiter = RateLimiter::new(3, 60);
    let client = ApiClient::new(config, limiter);
    client
        .list_models()
        .await
        .map_err(|e| format!("api_list_models: {e}"))
}

#[tauri::command]
pub async fn api_get_usage() -> Result<TokenUsage, String> {
    // 单进程实例化由调用方决定；这里仅返回零值示意
    Ok(TokenUsage::default())
}
