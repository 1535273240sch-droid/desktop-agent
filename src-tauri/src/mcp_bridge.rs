// mcp_bridge.rs - nuphus-mcp 进程桥接
// stdio 启动 nuphus-mcp + JSON-RPC 通信 + 36个工具分组 + 操作日志 + 自动还原点(仅文件操作)
// 单例模式：状态跨 Tauri 命令保持；首次启动支持 git clone + cargo build 自动部署

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, oneshot};

use crate::permissions::{with_permission_check, RestorePoint};

// ========================= 工具分组与定义 =========================

/// 工具分组
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum ToolGroup {
    FileOps,
    WindowOps,
    System,
    Input,
    Vision,
    Clipboard,
    Process,
    Network,
    Browser,
    Other,
}

/// 工具定义
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub name: &'static str,
    pub group: ToolGroup,
    pub description: &'static str,
    /// 是否文件类操作（触发还原点）
    pub is_file_op: bool,
}

/// 36 个工具按分组（与 nuphus-mcp 协议对齐）
pub fn all_tools() -> Vec<ToolDef> {
    use ToolGroup::*;
    vec![
        // === 文件操作（8）===
        ToolDef { name: "fs.read", group: FileOps, description: "读取文件内容", is_file_op: false },
        ToolDef { name: "fs.write", group: FileOps, description: "写入文件", is_file_op: true },
        ToolDef { name: "fs.append", group: FileOps, description: "追加写入文件", is_file_op: true },
        ToolDef { name: "fs.delete", group: FileOps, description: "删除文件", is_file_op: true },
        ToolDef { name: "fs.move", group: FileOps, description: "移动/重命名文件", is_file_op: true },
        ToolDef { name: "fs.copy", group: FileOps, description: "复制文件", is_file_op: false },
        ToolDef { name: "fs.list", group: FileOps, description: "列出目录", is_file_op: false },
        ToolDef { name: "fs.mkdir", group: FileOps, description: "创建目录", is_file_op: true },
        // === 窗口操作（6）===
        ToolDef { name: "window.list", group: WindowOps, description: "列出所有窗口", is_file_op: false },
        ToolDef { name: "window.focus", group: WindowOps, description: "聚焦窗口", is_file_op: false },
        ToolDef { name: "window.minimize", group: WindowOps, description: "最小化窗口", is_file_op: false },
        ToolDef { name: "window.maximize", group: WindowOps, description: "最大化窗口", is_file_op: false },
        ToolDef { name: "window.close", group: WindowOps, description: "关闭窗口", is_file_op: false },
        ToolDef { name: "window.resize", group: WindowOps, description: "调整窗口大小", is_file_op: false },
        // === 系统设置（5）===
        ToolDef { name: "sys.volume", group: System, description: "设置音量", is_file_op: false },
        ToolDef { name: "sys.brightness", group: System, description: "设置亮度", is_file_op: false },
        ToolDef { name: "sys.notify", group: System, description: "发送系统通知", is_file_op: false },
        ToolDef { name: "sys.screenshot", group: System, description: "系统截图", is_file_op: false },
        ToolDef { name: "sys.shell", group: System, description: "执行 shell 命令", is_file_op: false },
        // === 输入控制（4）===
        ToolDef { name: "input.mouse_move", group: Input, description: "移动鼠标", is_file_op: false },
        ToolDef { name: "input.mouse_click", group: Input, description: "鼠标点击", is_file_op: false },
        ToolDef { name: "input.mouse_scroll", group: Input, description: "鼠标滚动", is_file_op: false },
        ToolDef { name: "input.keyboard", group: Input, description: "键盘输入", is_file_op: false },
        // === 视觉（3）===
        ToolDef { name: "vision.capture", group: Vision, description: "截图", is_file_op: false },
        ToolDef { name: "vision.ocr", group: Vision, description: "OCR 识别", is_file_op: false },
        ToolDef { name: "vision.locate", group: Vision, description: "定位屏幕元素", is_file_op: false },
        // === 剪贴板（2）===
        ToolDef { name: "clipboard.read", group: Clipboard, description: "读取剪贴板", is_file_op: false },
        ToolDef { name: "clipboard.write", group: Clipboard, description: "写入剪贴板", is_file_op: false },
        // === 进程（3）===
        ToolDef { name: "process.list", group: Process, description: "列出进程", is_file_op: false },
        ToolDef { name: "process.kill", group: Process, description: "结束进程", is_file_op: false },
        ToolDef { name: "process.spawn", group: Process, description: "启动进程", is_file_op: false },
        // === 网络（2）===
        ToolDef { name: "net.http", group: Network, description: "HTTP 请求", is_file_op: false },
        ToolDef { name: "net.download", group: Network, description: "下载文件", is_file_op: false },
        // === 浏览器（2）===
        ToolDef { name: "browser.open", group: Browser, description: "打开 URL", is_file_op: false },
        ToolDef { name: "browser.scrape", group: Browser, description: "抓取页面内容", is_file_op: false },
        // === 其他（1）===
        ToolDef { name: "misc.sleep", group: Other, description: "延时等待", is_file_op: false },
    ]
}

// ========================= JSON-RPC =========================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: i64,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

// ========================= 操作日志 =========================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpLogEntry {
    pub id: String,
    pub timestamp: u64,
    pub tool: String,
    pub group: String,
    pub args: Value,
    pub status: String,
    pub result_preview: String,
    pub restore_point: Option<String>,
}

// 共享 pending 表：reader 任务与 call 任务共享
type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<JsonRpcResponse>>>>;

// ========================= 桥接管理器 =========================

pub struct McpBridge {
    inner: Arc<Mutex<BridgeInner>>,
    pending: PendingMap,
    next_id: Arc<AtomicI64>,
}

struct BridgeInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    log: Vec<OpLogEntry>,
    log_max: usize,
    ready: bool,
    /// 已部署的 nuphus-mcp 可执行文件路径（None=未部署）
    deployed_exe: Option<String>,
}

// 全局共享实例（跨 Tauri 命令调用保持子进程与日志状态）
static SHARED_BRIDGE: std::sync::OnceLock<McpBridge> = std::sync::OnceLock::new();

impl McpBridge {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(BridgeInner {
                child: None,
                stdin: None,
                log: Vec::new(),
                log_max: 1000,
                ready: false,
                deployed_exe: None,
            })),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicI64::new(1)),
        }
    }

    /// 获取全局共享实例
    pub fn shared() -> &'static McpBridge {
        SHARED_BRIDGE.get_or_init(McpBridge::new)
    }

    /// 启动 nuphus-mcp 子进程（stdio 通信）
    pub async fn start(&self, exe_path: &str) -> Result<(), BridgeError> {
        let mut inner = self.inner.lock().await;
        if inner.ready {
            return Ok(());
        }
        let mut child = Command::new(exe_path)
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| BridgeError::Spawn(e.to_string()))?;

        let stdin = child.stdin.take().ok_or(BridgeError::NoStdin)?;
        let stdout = child.stdout.take().ok_or(BridgeError::NoStdout)?;

        tokio::spawn(reader_loop(stdout, self.pending.clone()));

        inner.child = Some(child);
        inner.stdin = Some(stdin);
        inner.ready = true;
        inner.deployed_exe = Some(exe_path.to_string());
        Ok(())
    }

    /// 停止子进程
    pub async fn stop(&self) -> Result<(), BridgeError> {
        let mut inner = self.inner.lock().await;
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        inner.stdin = None;
        inner.ready = false;
        Ok(())
    }

    pub async fn is_ready(&self) -> bool {
        self.inner.lock().await.ready
    }

    /// 已部署的可执行文件路径
    pub async fn deployed_exe(&self) -> Option<String> {
        self.inner.lock().await.deployed_exe.clone()
    }

    /// 自动部署 nuphus-mcp：检测可执行文件是否存在；不存在则 git clone + cargo build
    /// 返回最终的可执行文件路径
    pub async fn auto_deploy(&self) -> Result<String, BridgeError> {
        // 已部署：直接返回
        if let Some(p) = self.deployed_exe().await {
            if std::path::Path::new(&p).exists() {
                return Ok(p);
            }
        }

        let data_dir = nuphus_data_dir();
        let _ = std::fs::create_dir_all(&data_dir);
        let repo_dir = data_dir.join("nuphus-mcp");
        // 子crate 路径：crates/nuphus-mcp（与上游仓库结构对齐）
        let crate_dir = repo_dir.join("crates").join("nuphus-mcp");
        let exe_name = if cfg!(windows) { "nuphus-mcp.exe" } else { "nuphus-mcp" };
        let exe_path = crate_dir.join("target").join("release").join(exe_name);

        // 已编译：直接返回
        if exe_path.exists() {
            let p = exe_path.to_string_lossy().to_string();
            self.inner.lock().await.deployed_exe = Some(p.clone());
            return Ok(p);
        }

        // 仓库不存在则 git clone
        if !repo_dir.exists() {
            log::info!("[mcp] cloning nuphus-mcp into {:?}", repo_dir);
            let status = Command::new("git")
                .arg("clone")
                .arg("--depth")
                .arg("1")
                .arg("https://github.com/mrpulor-gh/nuphus-mcp.git")
                .arg(&repo_dir)
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .status()
                .await
                .map_err(|e| BridgeError::Deploy(format!("git clone failed: {e}")))?;
            if !status.success() {
                return Err(BridgeError::Deploy(format!(
                    "git clone exited with {status}"
                )));
            }
        }

        // cargo build --release
        log::info!("[mcp] building nuphus-mcp (release) at {:?}", crate_dir);
        let cargo = which_cargo();
        let status = Command::new(&cargo)
            .arg("build")
            .arg("--release")
            .current_dir(&crate_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .await
            .map_err(|e| BridgeError::Deploy(format!("cargo build failed: {e}")))?;
        if !status.success() {
            return Err(BridgeError::Deploy(format!(
                "cargo build exited with {status}"
            )));
        }
        if !exe_path.exists() {
            return Err(BridgeError::Deploy(format!(
                "build finished but {:?} not found",
                exe_path
            )));
        }
        let p = exe_path.to_string_lossy().to_string();
        self.inner.lock().await.deployed_exe = Some(p.clone());
        Ok(p)
    }

    /// 自动部署 + 启动（一站式）
    pub async fn ensure_running(&self) -> Result<(), BridgeError> {
        if self.is_ready().await {
            return Ok(());
        }
        let exe = self.auto_deploy().await?;
        self.start(&exe).await
    }

    /// 调用一个工具
    pub async fn call_tool(&self, tool: &str, args: Value) -> Result<Value, BridgeError> {
        let tool_def = all_tools()
            .into_iter()
            .find(|t| t.name == tool)
            .ok_or_else(|| BridgeError::UnknownTool(tool.into()))?;

        let result = with_permission_check("mcp", tool, || async {
            self.rpc_call(
                "tools/call",
                Some(serde_json::json!({
                    "name": tool,
                    "arguments": args,
                })),
            )
            .await
        })
        .await
        .map_err(|e| BridgeError::Rpc(-1, format!("permission: {e}")))?;

        // 文件操作自动备份还原点
        let restore = if tool_def.is_file_op {
            if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
                RestorePoint::create(&format!("mcp.{tool}"), path).ok()
            } else {
                None
            }
        } else {
            None
        };

        // 记录日志
        let preview = result.to_string();
        let entry = OpLogEntry {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
            tool: tool.into(),
            group: format!("{:?}", tool_def.group),
            args: args.clone(),
            status: "ok".into(),
            result_preview: preview.chars().take(200).collect(),
            restore_point: restore.as_ref().map(|r| r.id.clone()),
        };
        self.push_log(entry).await;

        Ok(result)
    }

    /// 通用 JSON-RPC 调用
    async fn rpc_call(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, BridgeError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        };
        let mut line = serde_json::to_string(&req).map_err(|e| BridgeError::Encode(e.to_string()))?;
        line.push('\n');

        // 注册 pending
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        // 写入 stdin
        {
            let mut inner = self.inner.lock().await;
            if !inner.ready {
                self.pending.lock().await.remove(&id);
                return Err(BridgeError::NotReady);
            }
            let stdin = inner.stdin.as_mut().ok_or(BridgeError::NoStdin)?;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| BridgeError::Io(e.to_string()))?;
            stdin
                .flush()
                .await
                .map_err(|e| BridgeError::Io(e.to_string()))?;
        }

        // 等待响应（30s 超时）
        let resp = match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(r) => r.map_err(|_| BridgeError::ChannelClosed)?,
            Err(_) => {
                // 超时：尽力清理 pending 项（best-effort，不阻塞）
                if let Ok(mut m) = self.pending.try_lock() {
                    m.remove(&id);
                }
                return Err(BridgeError::Timeout);
            }
        };

        if let Some(err) = resp.error {
            return Err(BridgeError::Rpc(err.code, err.message));
        }
        resp.result.ok_or(BridgeError::EmptyResult)
    }

    async fn push_log(&self, entry: OpLogEntry) {
        let mut inner = self.inner.lock().await;
        inner.log.push(entry);
        if inner.log.len() > inner.log_max {
            let drop_n = inner.log.len() - inner.log_max;
            inner.log.drain(0..drop_n);
        }
    }

    pub async fn get_logs(&self, limit: Option<usize>) -> Vec<OpLogEntry> {
        let inner = self.inner.lock().await;
        let limit = limit.unwrap_or(100);
        inner.log.iter().rev().take(limit).cloned().collect()
    }

    pub async fn list_tools(&self) -> Vec<ToolDef> {
        all_tools()
    }
}

/// reader 循环：读取子进程 stdout 的每行 JSON-RPC 响应
async fn reader_loop(stdout: ChildStdout, pending: PendingMap) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // EOF
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<JsonRpcResponse>(trimmed) {
                    Ok(resp) => {
                        let mut map = pending.lock().await;
                        if let Some(tx) = map.remove(&resp.id) {
                            let _ = tx.send(resp);
                        }
                    }
                    Err(e) => {
                        log::warn!("MCP reader: parse error: {e} | line: {trimmed}");
                    }
                }
            }
            Err(e) => {
                log::error!("MCP reader error: {e}");
                break;
            }
        }
    }
}

// ========================= 错误类型 =========================

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("spawn error: {0}")]
    Spawn(String),
    #[error("no stdin")]
    NoStdin,
    #[error("no stdout")]
    NoStdout,
    #[error("io error: {0}")]
    Io(String),
    #[error("encode error: {0}")]
    Encode(String),
    #[error("not ready")]
    NotReady,
    #[error("unknown tool: {0}")]
    UnknownTool(String),
    #[error("rpc timeout")]
    Timeout,
    #[error("channel closed")]
    ChannelClosed,
    #[error("rpc error {0}: {1}")]
    Rpc(i64, String),
    #[error("empty result")]
    EmptyResult,
    #[error("deploy error: {0}")]
    Deploy(String),
}

// ========================= 部署辅助 =========================

/// nuphus-mcp 数据目录（源码 + 编译产物）
fn nuphus_data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("APPDATA") {
        return PathBuf::from(p).join("desktop-agent").join("nuphus-mcp-home");
    }
    if let Ok(p) = std::env::var("XDG_DATA_HOME") {
        return PathBuf::from(p).join("desktop-agent").join("nuphus-mcp-home");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("desktop-agent")
            .join("nuphus-mcp-home");
    }
    PathBuf::from("./.desktop-agent/nuphus-mcp-home")
}

/// 找到 cargo 可执行文件（CARGO_HOME / PATH / ~/.cargo/bin）
fn which_cargo() -> String {
    if let Ok(c) = std::env::var("CARGO_HOME") {
        let cand = PathBuf::from(c).join("bin").join("cargo");
        if cand.exists() {
            return cand.to_string_lossy().to_string();
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let cand = PathBuf::from(home).join(".cargo").join("bin").join("cargo");
        if cand.exists() {
            return cand.to_string_lossy().to_string();
        }
    }
    "cargo".to_string()
}

// ========================= Tauri 命令 =========================

#[tauri::command]
pub async fn mcp_start(exe_path: String) -> Result<(), String> {
    let bridge = McpBridge::shared();
    bridge
        .start(&exe_path)
        .await
        .map_err(|e| format!("mcp_start: {e}"))
}

#[tauri::command]
pub async fn mcp_stop() -> Result<(), String> {
    let bridge = McpBridge::shared();
    bridge.stop().await.map_err(|e| format!("mcp_stop: {e}"))
}

#[tauri::command]
pub async fn mcp_call_tool(tool: String, args: Value) -> Result<Value, String> {
    let bridge = McpBridge::shared();
    bridge
        .call_tool(&tool, args)
        .await
        .map_err(|e| format!("mcp_call_tool: {e}"))
}

#[tauri::command]
pub async fn mcp_list_tools() -> Result<Vec<ToolDef>, String> {
    let bridge = McpBridge::shared();
    Ok(bridge.list_tools().await)
}

#[tauri::command]
pub async fn mcp_get_logs(limit: Option<usize>) -> Result<Vec<OpLogEntry>, String> {
    let bridge = McpBridge::shared();
    Ok(bridge.get_logs(limit).await)
}

/// 自动部署 nuphus-mcp：git clone + cargo build（若未部署），返回 exe 路径
#[tauri::command]
pub async fn mcp_auto_deploy() -> Result<String, String> {
    let bridge = McpBridge::shared();
    bridge
        .auto_deploy()
        .await
        .map_err(|e| format!("mcp_auto_deploy: {e}"))
}

/// 自动部署 + 启动子进程（应用启动时调用）
#[tauri::command]
pub async fn mcp_ensure_running() -> Result<(), String> {
    let bridge = McpBridge::shared();
    bridge
        .ensure_running()
        .await
        .map_err(|e| format!("mcp_ensure_running: {e}"))
}

/// 桥接状态查询
#[tauri::command]
pub async fn mcp_status() -> Result<serde_json::Value, String> {
    let bridge = McpBridge::shared();
    let ready = bridge.is_ready().await;
    let exe = bridge.deployed_exe().await;
    Ok(serde_json::json!({
        "ready": ready,
        "deployedExe": exe,
        "dataDir": nuphus_data_dir().to_string_lossy(),
    }))
}
