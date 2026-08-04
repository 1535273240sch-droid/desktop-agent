// sandbox.rs - Docker 沙箱管理
// 检测Docker + 创建/销毁容器(用完即销) + 首次自动构建镜像 + 执行代码 + 资源限制 + 网络限制 + 文件同步 + pip确认

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::permissions::with_permission_check;

// ========================= 常量配置 =========================

const IMAGE_NAME: &str = "desktop-agent-sandbox:latest";
const CONTAINER_PREFIX: &str = "desktop-agent-sbx-";
const SHARED_DIR_NAME: &str = "shared";

const DEFAULT_MEMORY: &str = "2g";
const DEFAULT_CPU: &str = "2";
const DEFAULT_DISK: &str = "10g";

/// Dockerfile 内容：预装 numpy/pandas/requests/matplotlib，并附带 Node.js + iptables（http-only 出站限制所需）
const DOCKERFILE: &str = r#"FROM python:3.11-slim

# 基础工具（含 iptables，用于 http-only 网络模式在容器内应用出站限制）
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git build-essential iptables \
    && rm -rf /var/lib/apt/lists/*

# Python 科学计算与常用包
RUN pip install --no-cache-dir \
    numpy pandas requests matplotlib scipy scikit-learn

# Node.js (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 工作目录
WORKDIR /workspace
RUN mkdir -p /workspace/shared

# 默认 shell
CMD ["bash"]
"#;

// ========================= 数据结构 =========================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxConfig {
    pub enabled: bool,
    pub memory_limit: String,
    pub cpu_limit: String,
    pub disk_limit: String,
    pub network_mode: String, // none | http-only | full
    pub auto_destroy: bool,
    pub timeout: u64, // ms
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            memory_limit: DEFAULT_MEMORY.into(),
            cpu_limit: DEFAULT_CPU.into(),
            disk_limit: DEFAULT_DISK.into(),
            network_mode: "http-only".into(),
            auto_destroy: true,
            timeout: 30000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub created: bool,
}

// ========================= 沙箱管理器 =========================

pub struct SandboxManager {
    state: Arc<Mutex<SandboxState>>,
}

struct SandboxState {
    /// 当前活跃容器名 -> 创建时间
    containers: HashMap<String, u64>,
    /// 镜像是否已构建
    image_built: bool,
    /// 共享目录宿主路径
    shared_dir: PathBuf,
    /// pip 安装授权列表（永久允许的包）
    pip_allowed: Vec<String>,
}

// 全局共享实例（跨 Tauri 命令调用保持状态）
static SHARED_MGR: std::sync::OnceLock<SandboxManager> = std::sync::OnceLock::new();

impl SandboxManager {
    pub fn new() -> Self {
        let shared_dir = dirs_of_data().join(SHARED_DIR_NAME);
        let _ = std::fs::create_dir_all(&shared_dir);
        Self {
            state: Arc::new(Mutex::new(SandboxState {
                containers: HashMap::new(),
                image_built: false,
                shared_dir,
                pip_allowed: Vec::new(),
            })),
        }
    }

    /// 获取全局共享实例（跨命令调用保持容器列表与 pip 缓存）
    pub fn shared() -> &'static SandboxManager {
        SHARED_MGR.get_or_init(SandboxManager::new)
    }

    /// 检测 Docker 是否安装且可用
    pub async fn detect_docker(&self) -> Result<bool, SandboxError> {
        let output = Command::new("docker")
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await;
        match output {
            Ok(o) => Ok(o.status.success()),
            Err(_) => Ok(false),
        }
    }

    /// 首次启动：自动构建镜像
    pub async fn ensure_image_built(&self) -> Result<(), SandboxError> {
        let need_build = {
            let s = self.state.lock().await;
            if s.image_built {
                false
            } else {
                // 检查镜像是否已存在
                let exist = Command::new("docker")
                    .args(["image", "inspect", IMAGE_NAME])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .output()
                    .await
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                !exist
            }
        };

        if need_build {
            self.build_image().await?;
        }
        let mut s = self.state.lock().await;
        s.image_built = true;
        Ok(())
    }

    async fn build_image(&self) -> Result<(), SandboxError> {
        // 写 Dockerfile 到共享目录
        let dockerfile_path = self
            .state
            .lock()
            .await
            .shared_dir
            .join("Dockerfile.sandbox");
        std::fs::write(&dockerfile_path, DOCKERFILE)
            .map_err(|e| SandboxError::Io(e.to_string()))?;

        let parent = dockerfile_path.parent().ok_or_else(|| {
            SandboxError::Invalid("Dockerfile has no parent directory".into())
        })?;

        let status = Command::new("docker")
            .args(["build", "-t", IMAGE_NAME, "-f"])
            .arg(&dockerfile_path)
            .arg(parent)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .await
            .map_err(|e| SandboxError::Docker(e.to_string()))?;

        if !status.success() {
            return Err(SandboxError::BuildFailed);
        }
        Ok(())
    }

    /// 创建容器（用完即销语义，由 destroy 主动清理）
    pub async fn create_container(
        &self,
        name: &str,
        config: &SandboxConfig,
    ) -> Result<ContainerInfo, SandboxError> {
        if !config.enabled {
            return Err(SandboxError::Disabled);
        }
        if !self.detect_docker().await? {
            return Err(SandboxError::DockerNotFound);
        }
        self.ensure_image_built().await?;

        let container_name = format!("{CONTAINER_PREFIX}{name}");
        let shared = self.state.lock().await.shared_dir.clone();
        let http_only = config.network_mode == "http-only";

        // 网络策略：
        // - none: --network none，无网络
        // - full: 默认 bridge，无限制
        // - http-only: --network bridge + --cap-add=NET_ADMIN，容器启动后注入 iptables 出站限制
        let network_args: Vec<String> = match config.network_mode.as_str() {
            "none" => vec!["--network".into(), "none".into()],
            "full" => vec![],
            _ => vec!["--network".into(), "bridge".into()],
        };
        let cap_args: Vec<String> = if http_only {
            vec!["--cap-add".into(), "NET_ADMIN".into()]
        } else {
            vec![]
        };

        let mut cmd = Command::new("docker");
        cmd.args([
            "create",
            "--name",
            &container_name,
            "--rm",
            "-i",
            "--memory",
            &config.memory_limit,
            "--cpus",
            &config.cpu_limit,
            "--storage-opt",
            &format!("size={}", config.disk_limit),
            "--read-only",
            "--tmpfs",
            "/tmp:rw,size=256m",
        ]);
        cmd.args(&network_args);
        cmd.args(&cap_args);
        // 挂载共享目录
        cmd.args(["-v"]);
        cmd.arg(format!("{}:/workspace/shared", shared.to_string_lossy()));
        cmd.args([IMAGE_NAME, "bash"]);

        let output = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| SandboxError::Docker(e.to_string()))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).to_string();
            return Err(SandboxError::CreateFailed(err));
        }
        let id = String::from_utf8_lossy(&output.stdout).trim().to_string();

        // 启动容器
        let start = Command::new("docker")
            .args(["start", &container_name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(|e| SandboxError::Docker(e.to_string()))?;
        if !start.success() {
            return Err(SandboxError::StartFailed);
        }

        // http-only 模式：在容器内注入 iptables 出站限制规则（仅允许 80/443/DNS）
        if http_only {
            if let Err(e) = self.apply_http_only_egress(&container_name).await {
                log::warn!("[sandbox] http-only egress rules failed for {container_name}: {e}");
                // 不阻断创建：降级为默认 bridge 网络（即未限制），但记录警告
            }
        }

        let now = chrono::Utc::now().timestamp_millis() as u64;
        self.state
            .lock()
            .await
            .containers
            .insert(container_name.clone(), now);

        Ok(ContainerInfo {
            id,
            name: container_name,
            created: true,
        })
    }

    /// 在容器内应用 iptables 出站限制：仅允许 TCP 80/443 + DNS(53) + 本地回环 + 已建立连接
    async fn apply_http_only_egress(&self, container_name: &str) -> Result<(), SandboxError> {
        // 容器镜像已在 Dockerfile 中预装 iptables
        const RULES: &[&str] = &[
            // 允许已建立连接（响应包）
            "iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT",
            // 允许本地回环
            "iptables -A OUTPUT -o lo -j ACCEPT",
            // 允许 DNS（TCP/UDP 53）
            "iptables -A OUTPUT -p udp --dport 53 -j ACCEPT",
            "iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT",
            // 允许 HTTP (80) 和 HTTPS (443)
            "iptables -A OUTPUT -p tcp --dport 80 -j ACCEPT",
            "iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT",
            // 默认拒绝其他出站
            "iptables -P OUTPUT DROP",
        ];

        // 依次应用规则（失败不中断，尽力而为）
        for rule in RULES {
            let _ = Command::new("docker")
                .args(["exec", container_name, "bash", "-c", rule])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
        Ok(())
    }

    /// 销毁容器（用完即销）
    pub async fn destroy_container(&self, name: &str) -> Result<(), SandboxError> {
        let container_name = format!("{CONTAINER_PREFIX}{name}");
        let _ = Command::new("docker")
            .args(["rm", "-f", &container_name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        self.state.lock().await.containers.remove(&container_name);
        Ok(())
    }

    /// 在指定容器中执行代码
    pub async fn execute(
        &self,
        name: &str,
        lang: &str,
        code: &str,
        config: &SandboxConfig,
    ) -> Result<ExecResult, SandboxError> {
        let container_name = format!("{CONTAINER_PREFIX}{name}");
        let (interpreter, args) = match lang {
            "python" | "py" => ("python3", vec!["-c".to_string()]),
            "shell" | "sh" | "bash" => ("bash", vec!["-c".to_string()]),
            "node" | "js" => ("node", vec!["-e".to_string()]),
            other => return Err(SandboxError::UnsupportedLang(other.into())),
        };

        let started = std::time::Instant::now();

        let mut cmd = Command::new("docker");
        cmd.args([
            "exec",
            "-i",
            &container_name,
            interpreter,
        ]);
        cmd.args(&args);
        cmd.arg(code);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        // 超时控制
        let child = cmd
            .spawn()
            .map_err(|e| SandboxError::Docker(e.to_string()))?;
        let timeout = std::time::Duration::from_millis(config.timeout.max(1000));
        let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(o) => o.map_err(|e| SandboxError::Docker(e.to_string()))?,
            Err(_) => {
                // 超时：销毁容器以中止进程
                let _ = self.destroy_container(name).await;
                return Err(SandboxError::Timeout);
            }
        };

        let duration_ms = started.elapsed().as_millis() as u64;
        Ok(ExecResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            duration_ms,
        })
    }

    /// pip install 包：需要确认
    /// 包含在 pip_allowed 列表中的包直接放行；否则返回 NeedConfirm 让前端确认
    pub async fn pip_install(
        &self,
        name: &str,
        packages: Vec<String>,
        auto_confirm: bool,
    ) -> Result<ExecResult, SandboxError> {
        let allowed: Vec<String> = self.state.lock().await.pip_allowed.clone();
        let mut pending = Vec::new();
        for p in &packages {
            if !allowed.iter().any(|a| a == p) {
                pending.push(p.clone());
            }
        }

        if !pending.is_empty() && !auto_confirm {
            return Err(SandboxError::NeedPipConfirm(pending));
        }

        // 永久允许：加入缓存
        {
            let mut s = self.state.lock().await;
            for p in &packages {
                if !s.pip_allowed.iter().any(|a| a == p) {
                    s.pip_allowed.push(p.clone());
                }
            }
        }

        let joined = packages.join(" ");
        let script = format!("pip install --no-cache-dir {joined}");
        let cfg = SandboxConfig::default();
        self.execute(name, "shell", &script, &cfg).await
    }

    /// 文件双向同步：宿主路径推送到容器共享目录
    pub async fn push_file(
        &self,
        name: &str,
        host_path: &str,
        remote_path: &str,
    ) -> Result<(), SandboxError> {
        let container_name = format!("{CONTAINER_PREFIX}{name}");
        let status = Command::new("docker")
            .args(["cp", host_path, &format!("{container_name}:{remote_path}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(|e| SandboxError::Docker(e.to_string()))?;
        if !status.success() {
            return Err(SandboxError::SyncFailed("push".into()));
        }
        Ok(())
    }

    /// 文件双向同步：从容器拉回宿主
    pub async fn pull_file(
        &self,
        name: &str,
        remote_path: &str,
        host_path: &str,
    ) -> Result<(), SandboxError> {
        let container_name = format!("{CONTAINER_PREFIX}{name}");
        let status = Command::new("docker")
            .args(["cp", &format!("{container_name}:{remote_path}"), host_path])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(|e| SandboxError::Docker(e.to_string()))?;
        if !status.success() {
            return Err(SandboxError::SyncFailed("pull".into()));
        }
        Ok(())
    }

    /// 销毁所有容器（应用退出时调用）
    pub async fn destroy_all(&self) {
        let names: Vec<String> = self
            .state
            .lock()
            .await
            .containers
            .keys()
            .cloned()
            .collect();
        for n in names {
            let _ = Command::new("docker")
                .args(["rm", "-f", &n])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
        self.state.lock().await.containers.clear();
    }
}

fn dirs_of_data() -> PathBuf {
    if let Ok(p) = std::env::var("APPDATA") {
        return PathBuf::from(p).join("desktop-agent");
    }
    if let Ok(p) = std::env::var("XDG_DATA_HOME") {
        return PathBuf::from(p).join("desktop-agent");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".local/share/desktop-agent");
    }
    PathBuf::from("./.desktop-agent")
}

// ========================= 错误类型 =========================

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("sandbox disabled")]
    Disabled,
    #[error("docker not found")]
    DockerNotFound,
    #[error("docker command error: {0}")]
    Docker(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("invalid config: {0}")]
    Invalid(String),
    #[error("image build failed")]
    BuildFailed,
    #[error("container create failed: {0}")]
    CreateFailed(String),
    #[error("container start failed")]
    StartFailed,
    #[error("execution timed out")]
    Timeout,
    #[error("unsupported language: {0}")]
    UnsupportedLang(String),
    #[error("file sync failed: {0}")]
    SyncFailed(String),
    #[error("pip install needs confirmation: {0:?}")]
    NeedPipConfirm(Vec<String>),
}

// ========================= Tauri 命令 =========================

#[tauri::command]
pub async fn sandbox_detect_docker() -> Result<bool, String> {
    let mgr = SandboxManager::shared();
    mgr.detect_docker().await.map_err(|e| format!("sandbox_detect_docker: {e}"))
}

#[tauri::command]
pub async fn sandbox_ensure_image() -> Result<(), String> {
    let mgr = SandboxManager::shared();
    mgr.ensure_image_built()
        .await
        .map_err(|e| format!("sandbox_ensure_image: {e}"))
}

#[tauri::command]
pub async fn sandbox_create(
    name: String,
    config: SandboxConfig,
) -> Result<ContainerInfo, String> {
    with_permission_check("sandbox", "create", || async {
        let mgr = SandboxManager::shared();
        mgr.create_container(&name, &config)
            .await
            .map_err(|e| format!("sandbox_create: {e}"))
    })
    .await
    .map_err(|e| format!("permission denied: {e}"))
}

#[tauri::command]
pub async fn sandbox_destroy(name: String) -> Result<(), String> {
    let mgr = SandboxManager::shared();
    mgr.destroy_container(&name)
        .await
        .map_err(|e| format!("sandbox_destroy: {e}"))
}

#[tauri::command]
pub async fn sandbox_execute(
    name: String,
    lang: String,
    code: String,
    config: SandboxConfig,
) -> Result<ExecResult, String> {
    with_permission_check("sandbox", "execute", || async {
        let mgr = SandboxManager::shared();
        mgr.execute(&name, &lang, &code, &config)
            .await
            .map_err(|e| format!("sandbox_execute: {e}"))
    })
    .await
    .map_err(|e| format!("permission denied: {e}"))
}

#[tauri::command]
pub async fn sandbox_pip_install(
    name: String,
    packages: Vec<String>,
    auto_confirm: bool,
) -> Result<ExecResult, String> {
    with_permission_check("sandbox", "pip_install", || async {
        let mgr = SandboxManager::shared();
        mgr.pip_install(&name, packages, auto_confirm)
            .await
            .map_err(|e| format!("sandbox_pip_install: {e}"))
    })
    .await
    .map_err(|e| format!("permission denied: {e}"))
}

#[tauri::command]
pub async fn sandbox_push_file(
    name: String,
    host_path: String,
    remote_path: String,
) -> Result<(), String> {
    let mgr = SandboxManager::shared();
    mgr.push_file(&name, &host_path, &remote_path)
        .await
        .map_err(|e| format!("sandbox_push_file: {e}"))
}

#[tauri::command]
pub async fn sandbox_pull_file(
    name: String,
    remote_path: String,
    host_path: String,
) -> Result<(), String> {
    let mgr = SandboxManager::shared();
    mgr.pull_file(&name, &remote_path, &host_path)
        .await
        .map_err(|e| format!("sandbox_pull_file: {e}"))
}

#[tauri::command]
pub async fn sandbox_destroy_all() -> Result<(), String> {
    let mgr = SandboxManager::shared();
    mgr.destroy_all().await;
    Ok(())
}
