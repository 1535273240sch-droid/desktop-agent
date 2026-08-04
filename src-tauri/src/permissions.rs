// permissions.rs - 权限管理
// 安全模式/完全访问模式 + 操作确认三选项 + 还原点管理 + 操作日志审计

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

// ========================= 数据结构 =========================

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AccessMode {
    #[serde(rename = "safe")]
    Safe,
    #[serde(rename = "full")]
    Full,
}

impl Default for AccessMode {
    fn default() -> Self {
        AccessMode::Safe
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PermissionAction {
    #[serde(rename = "allow-once")]
    AllowOnce,
    #[serde(rename = "allow-always")]
    AllowAlways,
    #[serde(rename = "deny")]
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub category: String,
    pub action: String,
    pub decision: PermissionAction,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationLog {
    pub id: String,
    pub timestamp: u64,
    pub tool: String,
    pub action: String,
    pub details: String,
    pub mode: AccessMode,
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePoint {
    pub id: String,
    pub timestamp: u64,
    pub operation: String,
    pub file_path: String,
    pub backup_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub category: String,
    pub action: String,
    pub description: String,
    pub mode: AccessMode,
}

impl std::fmt::Display for PermissionRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {} ({})", self.category, self.action, self.description)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionDecision {
    pub action: PermissionAction,
    pub remember: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PermissionState {
    pub mode: AccessMode,
    /// 永久允许规则：key = "category:action"
    pub allow_rules: HashMap<String, PermissionRule>,
    /// 操作日志（最多保留 1000 条）
    pub logs: Vec<OperationLog>,
    /// 还原点列表
    pub restore_points: Vec<RestorePoint>,
}

// ========================= 错误类型 =========================

#[derive(Debug, thiserror::Error)]
pub enum PermissionError {
    #[error("permission denied: {0}")]
    Denied(String),
    #[error("permission needed: {0}")]
    NeedConfirmation(PermissionRequest),
    #[error("io error: {0}")]
    Io(String),
    #[error("encode error: {0}")]
    Encode(String),
    #[error("decode error: {0}")]
    Decode(String),
}

// ========================= 全局状态 =========================

static STATE: once_lock_state::State = once_lock_state::State::new();

mod once_lock_state {
    use super::PermissionState;
    use std::sync::OnceLock;
    use tokio::sync::Mutex;

    pub struct State {
        inner: OnceLock<Mutex<PermissionState>>,
    }

    impl State {
        pub const fn new() -> Self {
            Self {
                inner: OnceLock::new(),
            }
        }

        pub fn get(&self) -> &Mutex<PermissionState> {
            self.inner.get_or_init(|| Mutex::new(PermissionState::default()))
        }
    }
}

async fn with_state<F, R>(f: F) -> R
where
    F: FnOnce(&mut PermissionState) -> R,
{
    let mut guard = STATE.get().lock().await;
    f(&mut guard)
}

/// 初始化权限状态
pub async fn init_state(mode: AccessMode) {
    with_state(|s| s.mode = mode).await;
}

pub async fn get_mode() -> AccessMode {
    with_state(|s| s.mode).await
}

pub async fn set_mode(mode: AccessMode) {
    with_state(|s| s.mode = mode).await;
}

// ========================= 安全模式判断 =========================

/// 安全模式下需要确认的操作类别
const SENSITIVE_CATEGORIES: &[&str] = &["file", "system", "sandbox", "mcp"];

fn is_sensitive(category: &str) -> bool {
    SENSITIVE_CATEGORIES.contains(&category)
}

/// 查找匹配的永久规则
async fn find_rule(category: &str, action: &str) -> Option<PermissionAction> {
    let key = format!("{category}:{action}");
    with_state(|s| s.allow_rules.get(&key).map(|r| r.decision)).await
}

/// 记录操作日志
async fn log_operation(tool: &str, action: &str, details: &str, approved: bool) {
    let entry = OperationLog {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: chrono::Utc::now().timestamp_millis() as u64,
        tool: tool.into(),
        action: action.into(),
        details: details.chars().take(500).collect(),
        mode: get_mode().await,
        approved,
    };
    with_state(|s| {
        s.logs.push(entry);
        if s.logs.len() > 1000 {
            let drop_n = s.logs.len() - 1000;
            s.logs.drain(0..drop_n);
        }
    })
    .await;
}

/// 保存永久允许规则
pub async fn remember_decision(category: &str, action: &str, decision: PermissionAction) {
    let key = format!("{category}:{action}");
    let rule = PermissionRule {
        category: category.into(),
        action: action.into(),
        decision,
        created_at: chrono::Utc::now().timestamp_millis() as u64,
    };
    with_state(|s| {
        s.allow_rules.insert(key, rule);
    })
    .await;
}

// ========================= 权限检查入口 =========================

/// 权限检查 + 操作执行包装
///
/// - 完全访问模式：直接执行，记录审计日志
/// - 安全模式：敏感操作需要确认；存在永久允许规则则放行；否则返回 NeedConfirmation
///
/// 用法：
/// ```ignore
/// with_permission_check("file", "read", || async {
///     // 实际操作
///     Ok(result)
/// }).await
/// ```
pub async fn with_permission_check<F, Fut, T, E>(category: &str, action: &str, f: F) -> Result<T, PermissionError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mode = get_mode().await;
    let approved = match mode {
        AccessMode::Full => {
            // 完全访问：无限制，记录审计
            true
        }
        AccessMode::Safe => {
            if !is_sensitive(category) {
                true
            } else if let Some(decision) = find_rule(category, action).await {
                matches!(decision, PermissionAction::AllowOnce | PermissionAction::AllowAlways)
            } else {
                // 安全模式下首次出现的敏感操作 → 返回需确认
                let req = PermissionRequest {
                    category: category.into(),
                    action: action.into(),
                    description: format!("应用请求执行敏感操作: {category}/{action}"),
                    mode,
                };
                log_operation(category, action, "需要确认（被拒绝执行）", false).await;
                return Err(PermissionError::NeedConfirmation(req));
            }
        }
    };

    // 执行操作
    let result = f().await;
    match result {
        Ok(v) => {
            log_operation(
                category,
                action,
                &format!("OK: {category}/{action}"),
                approved,
            )
            .await;
            Ok(v)
        }
        Err(e) => {
            log_operation(
                category,
                action,
                &format!("ERROR: {e}"),
                false,
            )
            .await;
            Err(PermissionError::Denied(e.to_string()))
        }
    }
}

/// 显式应用一个用户决策（前端确认后回调）
pub async fn apply_decision(
    category: &str,
    action: &str,
    decision: PermissionDecision,
) -> Result<(), PermissionError> {
    match decision.action {
        PermissionAction::Deny => {
            if decision.remember {
                remember_decision(category, action, PermissionAction::Deny).await;
            }
            Err(PermissionError::Denied(format!(
                "user denied {category}/{action}"
            )))
        }
        PermissionAction::AllowOnce => {
            // 一次性放行：不记录永久规则
            Ok(())
        }
        PermissionAction::AllowAlways => {
            remember_decision(category, action, PermissionAction::AllowAlways).await;
            Ok(())
        }
    }
}

// ========================= 还原点管理 =========================

impl RestorePoint {
    /// 创建还原点：备份指定文件到 restore 目录
    pub fn create(operation: &str, file_path: &str) -> Result<Self, PermissionError> {
        let source = Path::new(file_path);
        if !source.exists() {
            return Err(PermissionError::Io(format!(
                "file not found: {file_path}"
            )));
        }
        let restore_dir = restore_dir();
        std::fs::create_dir_all(&restore_dir).map_err(|e| PermissionError::Io(e.to_string()))?;

        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = chrono::Utc::now().timestamp_millis() as u64;
        let file_name = source
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let backup_name = format!("{timestamp}_{id}_{file_name}");
        let backup_path = restore_dir.join(backup_name);

        std::fs::copy(source, &backup_path).map_err(|e| PermissionError::Io(e.to_string()))?;

        let rp = RestorePoint {
            id,
            timestamp,
            operation: operation.into(),
            file_path: file_path.into(),
            backup_path: backup_path.to_string_lossy().to_string(),
        };

        // 异步记录到状态（不阻塞当前调用）
        let rp_clone = rp.clone();
        tokio::spawn(async move {
            with_state(|s| s.restore_points.push(rp_clone)).await;
        });

        Ok(rp)
    }

    /// 从还原点恢复文件
    pub fn restore(&self) -> Result<(), PermissionError> {
        let backup = Path::new(&self.backup_path);
        if !backup.exists() {
            return Err(PermissionError::Io(format!(
                "backup not found: {}",
                self.backup_path
            )));
        }
        let target = Path::new(&self.file_path);
        if let Some(parent) = target.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| PermissionError::Io(e.to_string()))?;
            }
        }
        std::fs::copy(backup, target).map_err(|e| PermissionError::Io(e.to_string()))?;
        Ok(())
    }
}

pub async fn list_restore_points() -> Vec<RestorePoint> {
    with_state(|s| s.restore_points.clone()).await
}

pub async fn restore_from_point(id: &str) -> Result<(), PermissionError> {
    let rp = with_state(|s| {
        s.restore_points
            .iter()
            .find(|r| r.id == id)
            .cloned()
    })
    .await
    .ok_or_else(|| PermissionError::Denied(format!("restore point not found: {id}")))?;
    rp.restore()
}

pub async fn delete_restore_point(id: &str) -> Result<(), PermissionError> {
    let rp = with_state(|s| {
        s.restore_points
            .iter()
            .position(|r| r.id == id)
            .map(|i| s.restore_points.remove(i))
    })
    .await;
    if let Some(rp) = rp {
        let _ = std::fs::remove_file(&rp.backup_path);
    }
    Ok(())
}

pub async fn list_logs(limit: Option<usize>) -> Vec<OperationLog> {
    with_state(|s| {
        let limit = limit.unwrap_or(100);
        s.logs.iter().rev().take(limit).cloned().collect()
    })
    .await
}

fn restore_dir() -> PathBuf {
    if let Ok(p) = std::env::var("APPDATA") {
        return PathBuf::from(p).join("desktop-agent/restore");
    }
    if let Ok(p) = std::env::var("XDG_DATA_HOME") {
        return PathBuf::from(p).join("desktop-agent/restore");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".local/share/desktop-agent/restore");
    }
    PathBuf::from("./.desktop-agent/restore")
}

// ========================= Tauri 命令 =========================

#[tauri::command]
pub async fn permission_get_mode() -> Result<AccessMode, String> {
    Ok(get_mode().await)
}

#[tauri::command]
pub async fn permission_set_mode(mode: AccessMode) -> Result<(), String> {
    set_mode(mode).await;
    Ok(())
}

#[tauri::command]
pub async fn permission_apply_decision(
    category: String,
    action: String,
    decision: PermissionDecision,
) -> Result<(), String> {
    apply_decision(&category, &action, decision)
        .await
        .map_err(|e| format!("permission_apply_decision: {e}"))
}

#[tauri::command]
pub async fn permission_list_rules() -> Result<Vec<PermissionRule>, String> {
    Ok(with_state(|s| s.allow_rules.values().cloned().collect()).await)
}

#[tauri::command]
pub async fn permission_clear_rule(category: String, action: String) -> Result<(), String> {
    let key = format!("{category}:{action}");
    with_state(|s| {
        s.allow_rules.remove(&key);
    })
    .await;
    Ok(())
}

#[tauri::command]
pub async fn permission_list_logs(limit: Option<usize>) -> Result<Vec<OperationLog>, String> {
    Ok(list_logs(limit).await)
}

#[tauri::command]
pub async fn permission_list_restore_points() -> Result<Vec<RestorePoint>, String> {
    Ok(list_restore_points().await)
}

#[tauri::command]
pub async fn permission_restore(id: String) -> Result<(), String> {
    restore_from_point(&id)
        .await
        .map_err(|e| format!("permission_restore: {e}"))
}

#[tauri::command]
pub async fn permission_delete_restore(id: String) -> Result<(), String> {
    delete_restore_point(&id)
        .await
        .map_err(|e| format!("permission_delete_restore: {e}"))
}
