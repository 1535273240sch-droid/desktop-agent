// memory.rs - 记忆系统后端
// 记忆节点CRUD + 自动关联计算 + 关键词检索(1层关联扩展,最多20条) + d3-force力导向布局 + JSON持久化

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

// ========================= 数据结构 =========================

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MemoryNodeType {
    #[serde(rename = "user-info")]
    UserInfo,
    #[serde(rename = "knowledge")]
    Knowledge,
    #[serde(rename = "task-record")]
    TaskRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: MemoryNodeType,
    pub title: String,
    pub summary: String,
    pub details: String,
    pub tags: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryLink {
    pub source: String,
    pub target: String,
    pub strength: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MemoryGraph {
    pub nodes: Vec<MemoryNode>,
    pub links: Vec<MemoryLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub node: MemoryNode,
    pub score: f64,
    pub matched_via: MatchVia,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MatchVia {
    Direct,    // 直接匹配
    Linked,    // 通过 1 层关联扩展命中
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForceLayoutNode {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForceLayoutResult {
    pub nodes: Vec<ForceLayoutNode>,
    pub links: Vec<MemoryLink>,
    pub iterations: u32,
}

// ========================= 记忆管理器 =========================

pub struct MemoryManager {
    state: Arc<Mutex<MemoryState>>,
}

struct MemoryState {
    graph: MemoryGraph,
    path: PathBuf,
    /// 是否已加载
    loaded: bool,
}

impl MemoryManager {
    pub fn new() -> Self {
        let path = data_dir().join("memory.json");
        Self {
            state: Arc::new(Mutex::new(MemoryState {
                graph: MemoryGraph::default(),
                path,
                loaded: false,
            })),
        }
    }

    pub fn with_path(path: PathBuf) -> Self {
        Self {
            state: Arc::new(Mutex::new(MemoryState {
                graph: MemoryGraph::default(),
                path,
                loaded: false,
            })),
        }
    }

    /// 加载 JSON 持久化数据
    pub async fn load(&self) -> Result<(), MemoryError> {
        let mut s = self.state.lock().await;
        if s.loaded {
            return Ok(());
        }
        if s.path.exists() {
            let data = std::fs::read_to_string(&s.path)
                .map_err(|e| MemoryError::Io(e.to_string()))?;
            if !data.trim().is_empty() {
                s.graph = serde_json::from_str(&data)
                    .map_err(|e| MemoryError::Decode(e.to_string()))?;
            }
        }
        s.loaded = true;
        Ok(())
    }

    /// 保存
    async fn save(&self) -> Result<(), MemoryError> {
        let s = self.state.lock().await;
        if let Some(parent) = s.path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| MemoryError::Io(e.to_string()))?;
            }
        }
        let json = serde_json::to_string_pretty(&s.graph)
            .map_err(|e| MemoryError::Encode(e.to_string()))?;
        std::fs::write(&s.path, json).map_err(|e| MemoryError::Io(e.to_string()))?;
        Ok(())
    }

    // ============== CRUD ==============

    pub async fn create_node(&self, mut node: MemoryNode) -> Result<MemoryNode, MemoryError> {
        self.load().await?;
        let now = chrono::Utc::now().timestamp_millis() as u64;
        if node.id.is_empty() {
            node.id = uuid::Uuid::new_v4().to_string();
        }
        node.created_at = now;
        node.updated_at = now;

        let mut s = self.state.lock().await;
        // 同 ID 冲突时重新生成
        while s.graph.nodes.iter().any(|n| n.id == node.id) {
            node.id = uuid::Uuid::new_v4().to_string();
        }
        s.graph.nodes.push(node.clone());
        drop(s);
        self.recompute_links().await;
        self.save().await?;
        Ok(node)
    }

    pub async fn update_node(&self, node: MemoryNode) -> Result<MemoryNode, MemoryError> {
        self.load().await?;
        let mut s = self.state.lock().await;
        let now = chrono::Utc::now().timestamp_millis() as u64;
        let idx = s
            .graph
            .nodes
            .iter()
            .position(|n| n.id == node.id)
            .ok_or(MemoryError::NotFound)?;
        let mut updated = node.clone();
        updated.created_at = s.graph.nodes[idx].created_at;
        updated.updated_at = now;
        s.graph.nodes[idx] = updated.clone();
        drop(s);
        self.recompute_links().await;
        self.save().await?;
        Ok(updated)
    }

    pub async fn delete_node(&self, id: &str) -> Result<(), MemoryError> {
        self.load().await?;
        let mut s = self.state.lock().await;
        s.graph.nodes.retain(|n| n.id != id);
        s.graph.links.retain(|l| l.source != id && l.target != id);
        drop(s);
        self.save().await?;
        Ok(())
    }

    pub async fn get_node(&self, id: &str) -> Result<Option<MemoryNode>, MemoryError> {
        self.load().await?;
        let s = self.state.lock().await;
        Ok(s.graph.nodes.iter().find(|n| n.id == id).cloned())
    }

    pub async fn list_nodes(&self) -> Result<Vec<MemoryNode>, MemoryError> {
        self.load().await?;
        let s = self.state.lock().await;
        Ok(s.graph.nodes.clone())
    }

    pub async fn get_graph(&self) -> Result<MemoryGraph, MemoryError> {
        self.load().await?;
        let s = self.state.lock().await;
        Ok(s.graph.clone())
    }

    // ============== 自动关联计算 ==============

    /// 重新计算所有节点间的关联：基于标签重合 + 标题/摘要关键词重合
    pub async fn recompute_links(&self) {
        let mut s = self.state.lock().await;
        let nodes = s.graph.nodes.clone();
        let mut links: Vec<MemoryLink> = Vec::new();

        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                let a = &nodes[i];
                let b = &nodes[j];
                let score = association_score(a, b);
                if score >= 0.3 {
                    links.push(MemoryLink {
                        source: a.id.clone(),
                        target: b.id.clone(),
                        strength: score,
                        label: None,
                    });
                }
            }
        }
        s.graph.links = links;
    }

    // ============== 关键词检索（1层关联扩展，最多20条） ==============

    pub async fn search(&self, query: &str, limit: Option<usize>) -> Result<Vec<SearchResult>, MemoryError> {
        self.load().await?;
        let s = self.state.lock().await;
        let max = limit.unwrap_or(20);
        let q = query.to_lowercase();
        let mut results: Vec<SearchResult> = Vec::new();

        // 直接匹配
        let mut direct_ids: HashSet<String> = HashSet::new();
        for n in &s.graph.nodes {
            let score = match_score(n, &q);
            if score > 0.0 {
                results.push(SearchResult {
                    node: n.clone(),
                    score,
                    matched_via: MatchVia::Direct,
                });
                direct_ids.insert(n.id.clone());
            }
        }

        // 1层关联扩展
        let mut linked: HashMap<String, f64> = HashMap::new();
        for l in &s.graph.links {
            let (other, strength) = if direct_ids.contains(&l.source) {
                (l.target.clone(), l.strength * 0.5)
            } else if direct_ids.contains(&l.target) {
                (l.source.clone(), l.strength * 0.5)
            } else {
                continue;
            };
            if direct_ids.contains(&other) {
                continue; // 直接命中已收录
            }
            let entry = linked.entry(other).or_insert(0.0);
            *entry = entry.max(strength);
        }

        for (id, score) in linked {
            if let Some(n) = s.graph.nodes.iter().find(|n| n.id == id) {
                results.push(SearchResult {
                    node: n.clone(),
                    score,
                    matched_via: MatchVia::Linked,
                });
            }
        }

        // 按得分降序
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(max);
        Ok(results)
    }

    // ============== d3-force 力导向布局计算 ==============

    /// 简化的 d3-force 布局：电荷斥力 + 链接弹簧 + 中心引力
    pub async fn compute_layout(
        &self,
        iterations: u32,
    ) -> Result<ForceLayoutResult, MemoryError> {
        self.load().await?;
        let s = self.state.lock().await;
        let graph = s.graph.clone();
        drop(s);

        let layout = run_force_layout(&graph, iterations);
        Ok(layout)
    }
}

// ========================= 关联评分 =========================

fn association_score(a: &MemoryNode, b: &MemoryNode) -> f64 {
    let mut score = 0.0;
    // 标签重合（Jaccard）
    let set_a: HashSet<&String> = a.tags.iter().collect();
    let set_b: HashSet<&String> = b.tags.iter().collect();
    if !set_a.is_empty() || !set_b.is_empty() {
        let inter = set_a.intersection(&set_b).count() as f64;
        let union = set_a.union(&set_b).count() as f64;
        if union > 0.0 {
            score += 0.6 * (inter / union);
        }
    }
    // 标题/摘要关键词重合
    let kw_a = keywords(&format!("{} {}", a.title, a.summary));
    let kw_b = keywords(&format!("{} {}", b.title, b.summary));
    if !kw_a.is_empty() && !kw_b.is_empty() {
        let common = kw_a.intersection(&kw_b).count() as f64;
        let total = kw_a.union(&kw_b).count() as f64;
        if total > 0.0 {
            score += 0.4 * (common / total);
        }
    }
    score.min(1.0)
}

fn match_score(n: &MemoryNode, q: &str) -> f64 {
    let title = n.title.to_lowercase();
    let summary = n.summary.to_lowercase();
    let details = n.details.to_lowercase();
    let tags: String = n.tags.iter().map(|t| t.to_lowercase()).collect::<Vec<_>>().join(" ");

    let mut score = 0.0;
    if title.contains(q) {
        score += 1.0;
    }
    if summary.contains(q) {
        score += 0.6;
    }
    if tags.contains(q) {
        score += 0.8;
    }
    if details.contains(q) {
        score += 0.3;
    }
    // 多词匹配
    for w in q.split_whitespace() {
        if w.len() < 2 {
            continue;
        }
        if title.contains(w) {
            score += 0.1;
        }
        if summary.contains(w) {
            score += 0.05;
        }
    }
    score
}

fn keywords(text: &str) -> HashSet<String> {
    let stop: &[&str] = &[
        "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are",
        "was", "were", "be", "been", "的", "了", "是", "在", "和", "与", "或", "但",
    ];
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.len() >= 2 && !stop.contains(s))
        .map(|s| s.to_string())
        .collect()
}

// ========================= d3-force 布局 =========================

fn run_force_layout(graph: &MemoryGraph, iterations: u32) -> ForceLayoutResult {
    let n = graph.nodes.len();
    if n == 0 {
        return ForceLayoutResult {
            nodes: vec![],
            links: graph.links.clone(),
            iterations,
        };
    }

    // 初始化位置：圆环分布
    let mut positions: HashMap<String, ForceLayoutNode> = HashMap::new();
    let radius = 200.0;
    for (i, node) in graph.nodes.iter().enumerate() {
        let angle = (i as f64) / (n as f64) * std::f64::consts::TAU;
        positions.insert(
            node.id.clone(),
            ForceLayoutNode {
                id: node.id.clone(),
                x: node.x.unwrap_or_else(|| radius * angle.cos()),
                y: node.y.unwrap_or_else(|| radius * angle.sin()),
                vx: 0.0,
                vy: 0.0,
            },
        );
    }

    // 参数（与 d3-force 默认值近似）
    let charge_strength = -300.0; // 斥力
    let link_distance = 80.0;
    let link_strength = 0.3;
    let center_strength = 0.02;
    let center_x = 0.0;
    let center_y = 0.0;
    let alpha_decay = 0.0228;
    let velocity_decay = 0.6;
    let mut alpha = 1.0_f64;

    for _ in 0..iterations {
        if alpha < 0.005 {
            break;
        }

        // 1. 电荷斥力（O(n²)）
        let ids: Vec<String> = positions.keys().cloned().collect();
        for i in 0..ids.len() {
            for j in (i + 1)..ids.len() {
                let a = positions.get(&ids[i]).unwrap();
                let b = positions.get(&ids[j]).unwrap();
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                let dist2 = dx * dx + dy * dy + 0.01;
                let dist = dist2.sqrt();
                let force = charge_strength / dist2;
                let fx = force * dx / dist;
                let fy = force * dy / dist;
                let a_node = positions.get_mut(&ids[i]).unwrap();
                a_node.vx += fx * alpha;
                a_node.vy += fy * alpha;
                let b_node = positions.get_mut(&ids[j]).unwrap();
                b_node.vx -= fx * alpha;
                b_node.vy -= fy * alpha;
            }
        }

        // 2. 链接弹簧
        for link in &graph.links {
            let (Some(a), Some(b)) = (positions.get(&link.source), positions.get(&link.target))
            else {
                continue;
            };
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = (dx * dx + dy * dy).sqrt().max(0.01);
            let diff = (dist - link_distance) / dist;
            let force = diff * link_strength * link.strength;
            let fx = dx * force;
            let fy = dy * force;
            let a_node = positions.get_mut(&link.source).unwrap();
            a_node.vx += fx * alpha;
            a_node.vy += fy * alpha;
            let b_node = positions.get_mut(&link.target).unwrap();
            b_node.vx -= fx * alpha;
            b_node.vy -= fy * alpha;
        }

        // 3. 中心引力
        for node in positions.values_mut() {
            node.vx += (center_x - node.x) * center_strength * alpha;
            node.vy += (center_y - node.y) * center_strength * alpha;
        }

        // 4. 应用速度并衰减
        for node in positions.values_mut() {
            node.vx *= velocity_decay;
            node.vy *= velocity_decay;
            node.x += node.vx;
            node.y += node.vy;
        }

        alpha *= 1.0 - alpha_decay;
    }

    let nodes: Vec<ForceLayoutNode> = graph
        .nodes
        .iter()
        .filter_map(|n| positions.get(&n.id).cloned())
        .collect();

    ForceLayoutResult {
        nodes,
        links: graph.links.clone(),
        iterations,
    }
}

fn data_dir() -> PathBuf {
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
pub enum MemoryError {
    #[error("io error: {0}")]
    Io(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("encode error: {0}")]
    Encode(String),
    #[error("node not found")]
    NotFound,
}

// ========================= Tauri 命令 =========================

#[tauri::command]
pub async fn memory_create(node: MemoryNode) -> Result<MemoryNode, String> {
    let mgr = MemoryManager::new();
    mgr.create_node(node)
        .await
        .map_err(|e| format!("memory_create: {e}"))
}

#[tauri::command]
pub async fn memory_update(node: MemoryNode) -> Result<MemoryNode, String> {
    let mgr = MemoryManager::new();
    mgr.update_node(node)
        .await
        .map_err(|e| format!("memory_update: {e}"))
}

#[tauri::command]
pub async fn memory_delete(id: String) -> Result<(), String> {
    let mgr = MemoryManager::new();
    mgr.delete_node(&id)
        .await
        .map_err(|e| format!("memory_delete: {e}"))
}

#[tauri::command]
pub async fn memory_get(id: String) -> Result<Option<MemoryNode>, String> {
    let mgr = MemoryManager::new();
    mgr.get_node(&id)
        .await
        .map_err(|e| format!("memory_get: {e}"))
}

#[tauri::command]
pub async fn memory_list() -> Result<Vec<MemoryNode>, String> {
    let mgr = MemoryManager::new();
    mgr.list_nodes()
        .await
        .map_err(|e| format!("memory_list: {e}"))
}

#[tauri::command]
pub async fn memory_graph() -> Result<MemoryGraph, String> {
    let mgr = MemoryManager::new();
    mgr.get_graph()
        .await
        .map_err(|e| format!("memory_graph: {e}"))
}

#[tauri::command]
pub async fn memory_search(query: String, limit: Option<usize>) -> Result<Vec<SearchResult>, String> {
    let mgr = MemoryManager::new();
    mgr.search(&query, limit)
        .await
        .map_err(|e| format!("memory_search: {e}"))
}

#[tauri::command]
pub async fn memory_layout(iterations: Option<u32>) -> Result<ForceLayoutResult, String> {
    let iters = iterations.unwrap_or(300);
    let mgr = MemoryManager::new();
    mgr.compute_layout(iters)
        .await
        .map_err(|e| format!("memory_layout: {e}"))
}
