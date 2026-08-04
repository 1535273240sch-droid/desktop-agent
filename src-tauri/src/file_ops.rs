// file_ops.rs - 文件操作
// 读取文件(图片/PDF/文本) + 写入文件 + 搜索文件 + 拖拽处理 + DPAPI加密存储Key

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::permissions::{with_permission_check, RestorePoint};

// ========================= 数据结构 =========================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub kind: FileKind,
    /// 文本内容（text 类文件）
    pub text: Option<String>,
    /// base64 编码（图片/PDF等二进制）
    pub base64: Option<String>,
    pub mime: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileKind {
    Text,
    Image,
    Pdf,
    Binary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DroppedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
}

// ========================= 工具函数 =========================

const SUPPORTED_TEXT_EXT: &[&str] = &[
    "txt", "md", "markdown", "rs", "go", "py", "js", "ts", "tsx", "jsx", "vue", "json", "yaml",
    "yml", "toml", "ini", "cfg", "conf", "sh", "bash", "zsh", "c", "cc", "cpp", "h", "hpp", "java",
    "kt", "swift", "rb", "php", "html", "htm", "css", "scss", "less", "xml", "sql", "csv", "log",
    "lock", "gitignore", "env", "gradle", "lua", "r", "scala", "pl", "proto",
];

const SUPPORTED_IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg"];

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

fn classify(path: &Path) -> FileKind {
    let ext = ext_of(path);
    if SUPPORTED_IMAGE_EXT.contains(&ext.as_str()) {
        FileKind::Image
    } else if ext == "pdf" {
        FileKind::Pdf
    } else if SUPPORTED_TEXT_EXT.contains(&ext.as_str()) {
        FileKind::Text
    } else {
        FileKind::Binary
    }
}

fn mime_of(path: &Path) -> String {
    let ext = ext_of(path);
    match ext.as_str() {
        "txt" => "text/plain".into(),
        "md" | "markdown" => "text/markdown".into(),
        "json" => "application/json".into(),
        "html" | "htm" => "text/html".into(),
        "css" => "text/css".into(),
        "js" => "application/javascript".into(),
        "ts" => "application/typescript".into(),
        "xml" => "application/xml".into(),
        "csv" => "text/csv".into(),
        "yaml" | "yml" => "application/yaml".into(),
        "toml" => "application/toml".into(),
        "pdf" => "application/pdf".into(),
        "png" => "image/png".into(),
        "jpg" | "jpeg" => "image/jpeg".into(),
        "gif" => "image/gif".into(),
        "bmp" => "image/bmp".into(),
        "webp" => "image/webp".into(),
        "svg" => "image/svg+xml".into(),
        _ => "application/octet-stream".into(),
    }
}

/// 读取文件大小限制：50 MB
const MAX_READ_SIZE: u64 = 50 * 1024 * 1024;

// ========================= 核心操作 =========================

/// 读取文件：自动识别文本/图片/PDF/二进制
pub async fn read_file(path: &str) -> Result<FileContent, FileError> {
    let path_buf = PathBuf::from(path);
    if !path_buf.exists() {
        return Err(FileError::NotFound(path.into()));
    }
    let meta = std::fs::metadata(&path_buf).map_err(|e| FileError::Io(e.to_string()))?;
    if meta.is_dir() {
        return Err(FileError::IsDirectory(path.into()));
    }
    if meta.len() > MAX_READ_SIZE {
        return Err(FileError::TooLarge(meta.len()));
    }

    let kind = classify(&path_buf);
    let mime = mime_of(&path_buf);
    let name = path_buf
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let (text, base64) = match kind {
        FileKind::Text => {
            let content =
                std::fs::read_to_string(&path_buf).map_err(|e| FileError::Io(e.to_string()))?;
            (Some(content), None)
        }
        FileKind::Image | FileKind::Pdf | FileKind::Binary => {
            let bytes =
                std::fs::read(&path_buf).map_err(|e| FileError::Io(e.to_string()))?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            (None, Some(b64))
        }
    };

    Ok(FileContent {
        path: path.to_string(),
        name,
        size: meta.len(),
        kind,
        text,
        base64,
        mime,
    })
}

/// 写入文件（自动创建父目录）
pub async fn write_file(path: &str, content: &str) -> Result<(), FileError> {
    let path_buf = PathBuf::from(path);
    if let Some(parent) = path_buf.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| FileError::Io(e.to_string()))?;
        }
    }
    // 先备份原文件（如果存在）
    if path_buf.exists() {
        let _ = RestorePoint::create("file_ops.write", path);
    }
    std::fs::write(&path_buf, content).map_err(|e| FileError::Io(e.to_string()))?;
    Ok(())
}

/// 写入二进制（base64 解码后写入）
pub async fn write_file_binary(path: &str, base64_data: &str) -> Result<(), FileError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .map_err(|e| FileError::Decode(e.to_string()))?;
    let path_buf = PathBuf::from(path);
    if let Some(parent) = path_buf.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| FileError::Io(e.to_string()))?;
        }
    }
    if path_buf.exists() {
        let _ = RestorePoint::create("file_ops.write_binary", path);
    }
    std::fs::write(&path_buf, &bytes).map_err(|e| FileError::Io(e.to_string()))?;
    Ok(())
}

/// 文件搜索：递归匹配 glob 模式
pub async fn search_files(
    root: &str,
    pattern: &str,
    max_results: usize,
) -> Result<Vec<FileSearchResult>, FileError> {
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err(FileError::NotFound(root.into()));
    }
    let glob_pattern = format!("{}/**/{}", root.trim_end_matches('/'), pattern);
    let mut results = Vec::new();

    // 先尝试 glob
    if let Ok(paths) = glob::glob(&glob_pattern) {
        for entry in paths.flatten() {
            if results.len() >= max_results {
                break;
            }
            if let Ok(meta) = std::fs::metadata(&entry) {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                results.push(FileSearchResult {
                    path: entry.to_string_lossy().to_string(),
                    name: entry
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string(),
                    is_dir: meta.is_dir(),
                    size: meta.len(),
                    modified,
                });
            }
        }
    }

    // glob 没匹配到则按文件名包含做递归扫描
    if results.is_empty() {
        let needle = pattern.to_lowercase();
        let mut stack = vec![root_path.clone()];
        while let Some(dir) = stack.pop() {
            if results.len() >= max_results {
                break;
            }
            let read = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in read.flatten() {
                if results.len() >= max_results {
                    break;
                }
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_lowercase();
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if name.contains(&needle) {
                    let modified = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    results.push(FileSearchResult {
                        path: path.to_string_lossy().to_string(),
                        name: entry.file_name().to_string_lossy().to_string(),
                        is_dir: meta.is_dir(),
                        size: meta.len(),
                        modified,
                    });
                }
                if meta.is_dir() {
                    stack.push(path);
                }
            }
        }
    }

    Ok(results)
}

/// 拖拽文件处理：将外部拖入的文件路径批量转为 DroppedFile
pub async fn handle_dropped_files(paths: Vec<String>) -> Result<Vec<DroppedFile>, FileError> {
    let mut dropped = Vec::with_capacity(paths.len());
    for p in paths {
        let path_buf = PathBuf::from(&p);
        let meta = std::fs::metadata(&path_buf).map_err(|e| FileError::Io(e.to_string()))?;
        if meta.is_dir() {
            continue; // 暂不处理文件夹
        }
        dropped.push(DroppedFile {
            path: p.clone(),
            name: path_buf
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string(),
            size: meta.len(),
            mime: mime_of(&path_buf),
        });
    }
    Ok(dropped)
}

// ========================= DPAPI / Keyring 安全存储 =========================

const KEYRING_SERVICE: &str = "desktop-agent";
const KEYRING_USER: &str = "api-keys";

/// 安全存储 API Key（Windows 走 DPAPI/Credential Manager，macOS 走 Keychain，Linux 走 Secret Service）
pub fn secure_store(key: &str, value: &str) -> Result<(), FileError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| FileError::Keyring(e.to_string()))?;
    entry.set_password(value).map_err(|e| FileError::Keyring(e.to_string()))
}

pub fn secure_load(key: &str) -> Result<String, FileError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| FileError::Keyring(e.to_string()))?;
    entry.get_password().map_err(|e| FileError::Keyring(e.to_string()))
}

pub fn secure_delete(key: &str) -> Result<(), FileError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| FileError::Keyring(e.to_string()))?;
    entry.delete_credential().map_err(|e| FileError::Keyring(e.to_string()))
}

/// 一次存取整个 API Keys 集合（JSON 序列化）
pub fn secure_store_keys(keys: &HashMap<String, String>) -> Result<(), FileError> {
    let json = serde_json::to_string(keys).map_err(|e| FileError::Encode(e.to_string()))?;
    secure_store(KEYRING_USER, &json)
}

pub fn secure_load_keys() -> Result<HashMap<String, String>, FileError> {
    match secure_load(KEYRING_USER) {
        Ok(json) => serde_json::from_str(&json).map_err(|e| FileError::Decode(e.to_string())),
        Err(FileError::Keyring(_)) => Ok(HashMap::new()),
        Err(e) => Err(e),
    }
}

// ========================= 错误类型 =========================

#[derive(Debug, thiserror::Error)]
pub enum FileError {
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("is a directory: {0}")]
    IsDirectory(String),
    #[error("file too large: {0} bytes")]
    TooLarge(u64),
    #[error("io error: {0}")]
    Io(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("encode error: {0}")]
    Encode(String),
    #[error("keyring error: {0}")]
    Keyring(String),
}

// ========================= Tauri 命令 =========================

#[tauri::command]
pub async fn file_read(path: String) -> Result<FileContent, String> {
    with_permission_check("file", "read", || async {
        read_file(&path).await.map_err(|e| format!("file_read: {e}"))
    })
    .await
    .map_err(|e| format!("permission denied: {e}"))
}

#[tauri::command]
pub async fn file_write(path: String, content: String) -> Result<(), String> {
    with_permission_check("file", "write", || async {
        write_file(&path, &content)
            .await
            .map_err(|e| format!("file_write: {e}"))
    })
    .await
    .map_err(|e| format!("permission denied: {e}"))
}

#[tauri::command]
pub async fn file_write_binary(path: String, base64_data: String) -> Result<(), String> {
    with_permission_check("file", "write_binary", || async {
        write_file_binary(&path, &base64_data)
            .await
            .map_err(|e| format!("file_write_binary: {e}"))
    })
    .await
    .map_err(|e| format!("permission denied: {e}"))
}

#[tauri::command]
pub async fn file_search(
    root: String,
    pattern: String,
    max_results: Option<usize>,
) -> Result<Vec<FileSearchResult>, String> {
    let max = max_results.unwrap_or(200);
    search_files(&root, &pattern, max)
        .await
        .map_err(|e| format!("file_search: {e}"))
}

#[tauri::command]
pub async fn file_handle_dropped(paths: Vec<String>) -> Result<Vec<DroppedFile>, String> {
    handle_dropped_files(paths)
        .await
        .map_err(|e| format!("file_handle_dropped: {e}"))
}

#[tauri::command]
pub fn file_secure_store(key: String, value: String) -> Result<(), String> {
    secure_store(&key, &value).map_err(|e| format!("file_secure_store: {e}"))
}

#[tauri::command]
pub fn file_secure_load(key: String) -> Result<String, String> {
    secure_load(&key).map_err(|e| format!("file_secure_load: {e}"))
}

#[tauri::command]
pub fn file_secure_delete(key: String) -> Result<(), String> {
    secure_delete(&key).map_err(|e| format!("file_secure_delete: {e}"))
}

#[tauri::command]
pub fn file_secure_store_keys(keys: HashMap<String, String>) -> Result<(), String> {
    secure_store_keys(&keys).map_err(|e| format!("file_secure_store_keys: {e}"))
}

#[tauri::command]
pub fn file_secure_load_keys() -> Result<HashMap<String, String>, String> {
    secure_load_keys().map_err(|e| format!("file_secure_load_keys: {e}"))
}

/// 读取字体文件并以 base64 返回（用于 FontFace 动态加载）
/// 字体文件单独走此命令，避免 file_read 的 50MB 限制和文本误识别
const MAX_FONT_SIZE: u64 = 32 * 1024 * 1024; // 32MB
const SUPPORTED_FONT_EXT: &[&str] = &["ttf", "otf", "woff", "woff2"];

#[tauri::command]
pub async fn read_font_file(path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("font file not found: {path}"));
    }
    let meta = std::fs::metadata(&path_buf).map_err(|e| format!("metadata: {e}"))?;
    if meta.is_dir() {
        return Err(format!("path is a directory: {path}"));
    }
    if meta.len() > MAX_FONT_SIZE {
        return Err(format!("font file too large: {} bytes (max {})", meta.len(), MAX_FONT_SIZE));
    }
    // 校验扩展名，避免被恶意路径读取其他敏感文件
    let ext = ext_of(&path_buf);
    if !SUPPORTED_FONT_EXT.contains(&ext.as_str()) {
        return Err(format!("unsupported font format: .{ext} (supported: ttf/otf/woff/woff2)"));
    }
    let bytes = std::fs::read(&path_buf).map_err(|e| format!("read: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
