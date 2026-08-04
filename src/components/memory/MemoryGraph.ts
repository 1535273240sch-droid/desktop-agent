import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { select } from "d3-selection";
import {
  zoom,
  zoomIdentity,
  type ZoomBehavior,
  type D3ZoomEvent,
  type ZoomTransform,
} from "d3-zoom";
import { drag } from "d3-drag";
import type { MemoryNode, MemoryLink, MemoryNodeType } from "@/types";

interface GNode extends SimulationNodeDatum, MemoryNode {}

interface GLink extends SimulationLinkDatum<GNode> {
  strength: number;
  label?: string;
  // d3-force 在初始化 forceLink 后会把 source/target 替换成节点对象引用
  source: GNode;
  target: GNode;
}

const NODE_RADIUS = 16;
const FOCUS_EXPANSION_LIMIT = 20;

const COLOR_VAR: Record<MemoryNodeType, string> = {
  "user-info": "--memory-user-info",
  knowledge: "--memory-knowledge",
  "task-record": "--memory-task-record",
};

const COLOR_FALLBACK: Record<MemoryNodeType, string> = {
  "user-info": "#3b82f6",
  knowledge: "#22c55e",
  "task-record": "#f97316",
};

export const MEMORY_TYPE_LABEL: Record<MemoryNodeType, string> = {
  "user-info": "用户信息",
  knowledge: "知识点",
  "task-record": "任务记录",
};

function resolveColor(type: MemoryNodeType): string {
  if (typeof window === "undefined") return COLOR_FALLBACK[type];
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(COLOR_VAR[type])
    .trim();
  return v || COLOR_FALLBACK[type];
}

export interface MemoryGraphOptions {
  canvas: HTMLCanvasElement;
  onNodeEdit?: (node: MemoryNode) => void;
  onNodeSelect?: (node: MemoryNode | null) => void;
}

/**
 * 记忆图谱引擎：d3-force 计算布局，Canvas 渲染节点与连线。
 * 支持：滚轮缩放、拖拽平移、节点拖拽、双击编辑、搜索 + 1 层关联扩展(最多 20 条)。
 */
export class MemoryGraphEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private opts: MemoryGraphOptions;

  private nodes: GNode[] = [];
  private links: GLink[] = [];
  private nodeById = new Map<string, GNode>();

  private sim: Simulation<GNode, GLink> | null = null;
  private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> | null = null;
  private transform: ZoomTransform = zoomIdentity;

  private width = 0;
  private height = 0;
  private dpr = 1;

  private hovered: GNode | null = null;
  private focusedId: string | null = null;
  private highlightedSet = new Set<string>();

  private resizeObserver: ResizeObserver | null = null;

  constructor(opts: MemoryGraphOptions) {
    this.opts = opts;
    this.canvas = opts.canvas;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D 上下文不可用");
    this.ctx = ctx;

    this.setupCanvas();
    this.setupZoom();
    this.setupInteraction();
    this.observeResize();
  }

  // ========== 画布尺寸 ==========
  private setupCanvas() {
    this.resize();
  }

  private observeResize() {
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width || this.canvas.clientWidth || 300;
    this.height = rect.height || this.canvas.clientHeight || 200;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // 重设向心力到新中心
    if (this.sim) {
      this.sim.force("center", forceCenter(this.width / 2, this.height / 2));
    }
    this.render();
  }

  // ========== 缩放与平移 ==========
  private setupZoom() {
    this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.2, 4])
      .on("zoom", (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        this.transform = event.transform;
        this.render();
      });
    select<HTMLCanvasElement, unknown>(this.canvas).call(this.zoomBehavior);
  }

  // ========== 节点拖拽 / 双击 / 悬停 ==========
  private setupInteraction() {
    const dragBehavior = drag<HTMLCanvasElement, unknown>()
      .subject((event) => this.pickNodeLocal(event.x, event.y))
      .on("start", (event) => {
        if (!event.active && this.sim) this.sim.alphaTarget(0.3).restart();
        const n = event.subject as GNode | null;
        if (n) {
          n.fx = n.x;
          n.fy = n.y;
        }
      })
      .on("drag", (event) => {
        const n = event.subject as GNode | null;
        if (n) {
          n.fx = this.transform.invertX(event.x);
          n.fy = this.transform.invertY(event.y);
        }
      })
      .on("end", (event) => {
        if (!event.active && this.sim) this.sim.alphaTarget(0);
        const n = event.subject as GNode | null;
        if (n) {
          n.fx = null;
          n.fy = null;
        }
      });

    select<HTMLCanvasElement, unknown>(this.canvas)
      .call(dragBehavior)
      .on("mousemove", (event: MouseEvent) => {
        const local = this.toLocal(event);
        const prev = this.hovered;
        const node = this.pickNodeLocal(local.x, local.y);
        if (node !== prev) {
          this.hovered = node;
          this.canvas.style.cursor = node ? "pointer" : "default";
          this.render();
        }
      })
      .on("dblclick", (event: MouseEvent) => {
        const local = this.toLocal(event);
        const node = this.pickNodeLocal(local.x, local.y);
        if (node) {
          this.focusNode(node.id);
          this.opts.onNodeEdit?.(node);
        }
      })
      .on("click", (event: MouseEvent) => {
        const local = this.toLocal(event);
        const node = this.pickNodeLocal(local.x, local.y);
        this.opts.onNodeSelect?.(node ?? null);
        if (!node) {
          this.clearFocus();
        }
      });
  }

  /** 将 DOM MouseEvent 的视口坐标转换为画布本地坐标 */
  private toLocal(event: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * 按画布本地坐标查找命中的节点。
   * @param localX 相对画布的 x
   * @param localY 相对画布的 y
   */
  private pickNodeLocal(localX: number, localY: number): GNode | null {
    const wx = this.transform.invertX(localX);
    const wy = this.transform.invertY(localY);
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (n.x == null || n.y == null) continue;
      const dx = n.x - wx;
      const dy = n.y - wy;
      if (dx * dx + dy * dy <= NODE_RADIUS * NODE_RADIUS) {
        return n;
      }
    }
    return null;
  }

  // ========== 数据 ==========
  setData(nodes: MemoryNode[], links: MemoryLink[]) {
    // 保留已有坐标，避免每次重置抖动
    const oldPos = new Map<string, { x: number; y: number; vx?: number; vy?: number }>();
    for (const n of this.nodes) {
      if (n.x != null && n.y != null) oldPos.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy });
    }

    this.nodes = nodes.map((n) => {
      const g: GNode = { ...n };
      const old = oldPos.get(n.id);
      if (n.x != null && n.y != null) {
        g.x = n.x;
        g.y = n.y;
      } else if (old) {
        g.x = old.x;
        g.y = old.y;
        g.vx = old.vx;
        g.vy = old.vy;
      } else {
        g.x = this.width / 2 + (Math.random() - 0.5) * 200;
        g.y = this.height / 2 + (Math.random() - 0.5) * 200;
      }
      return g;
    });
    this.nodeById = new Map(this.nodes.map((n) => [n.id, n]));

    this.links = links
      .map((l) => {
        const source = this.nodeById.get(l.source);
        const target = this.nodeById.get(l.target);
        if (!source || !target) return null;
        return {
          source,
          target,
          strength: l.strength,
          label: l.label,
        } as GLink;
      })
      .filter((l): l is GLink => l !== null);

    this.buildSimulation();
    this.render();
  }

  private buildSimulation() {
    if (this.sim) this.sim.stop();
    const link = forceLink<GNode, GLink>(this.links)
      .id((d) => d.id)
      .distance((d) => 80 + (1 - Math.min(d.strength, 1)) * 60)
      .strength((d) => 0.1 + d.strength * 0.4);

    this.sim = forceSimulation<GNode, GLink>(this.nodes)
      .force("charge", forceManyBody().strength(-220))
      .force("link", link)
      .force("center", forceCenter(this.width / 2, this.height / 2))
      .force("collide", forceCollide<GNode>().radius(NODE_RADIUS + 6))
      .alpha(1)
      .alphaDecay(0.03)
      .on("tick", () => this.render());
  }

  // ========== 增删改 ==========
  addNode(node: MemoryNode) {
    if (this.nodeById.has(node.id)) {
      this.updateNode(node);
      return;
    }
    const g: GNode = {
      ...node,
      x: node.x ?? this.width / 2 + (Math.random() - 0.5) * 120,
      y: node.y ?? this.height / 2 + (Math.random() - 0.5) * 120,
    };
    this.nodes.push(g);
    this.nodeById.set(g.id, g);
    this.sim?.nodes(this.nodes);
    this.sim?.alpha(0.8).restart();
    this.render();
  }

  updateNode(node: MemoryNode) {
    const existing = this.nodeById.get(node.id);
    if (!existing) {
      this.addNode(node);
      return;
    }
    Object.assign(existing, node);
    this.render();
  }

  deleteNode(id: string) {
    const idx = this.nodes.findIndex((n) => n.id === id);
    if (idx === -1) return;
    this.nodes.splice(idx, 1);
    this.nodeById.delete(id);
    this.links = this.links.filter((l) => l.source.id !== id && l.target.id !== id);
    if (this.focusedId === id) this.focusedId = null;
    this.highlightedSet.delete(id);
    this.rebuildLinkForce();
    this.sim?.nodes(this.nodes);
    this.sim?.alpha(0.6).restart();
    this.render();
  }

  addLink(link: MemoryLink) {
    const source = this.nodeById.get(link.source);
    const target = this.nodeById.get(link.target);
    if (!source || !target) return;
    const exists = this.links.some(
      (l) =>
        (l.source.id === link.source && l.target.id === link.target) ||
        (l.source.id === link.target && l.target.id === link.source)
    );
    if (exists) return;
    this.links.push({
      source,
      target,
      strength: link.strength,
      label: link.label,
    } as GLink);
    this.rebuildLinkForce();
    this.sim?.alpha(0.6).restart();
  }

  removeLink(sourceId: string, targetId: string) {
    this.links = this.links.filter(
      (l) =>
        !(
          (l.source.id === sourceId && l.target.id === targetId) ||
          (l.source.id === targetId && l.target.id === sourceId)
        )
    );
    this.rebuildLinkForce();
    this.sim?.alpha(0.4).restart();
  }

  /** 用当前 links 重建 link 力（避免操作 force 内部 API 的类型问题） */
  private rebuildLinkForce() {
    if (!this.sim) return;
    const link = forceLink<GNode, GLink>(this.links)
      .id((d) => d.id)
      .distance((d) => 80 + (1 - Math.min(d.strength, 1)) * 60)
      .strength((d) => 0.1 + d.strength * 0.4);
    this.sim.force("link", link);
  }

  getLinksOf(nodeId: string): MemoryLink[] {
    return this.links
      .filter((l) => l.source.id === nodeId || l.target.id === nodeId)
      .map((l) => ({
        source: l.source.id,
        target: l.target.id,
        strength: l.strength,
        label: l.label,
      }));
  }

  // ========== 搜索与聚焦 ==========
  search(query: string): MemoryNode[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.nodes.slice();
    return this.nodes.filter((n) => {
      return (
        n.title.toLowerCase().includes(q) ||
        n.summary.toLowerCase().includes(q) ||
        n.details.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }

  /**
   * 聚焦节点：将视图平移缩放到该节点，并高亮其 1 层关联节点(最多 20 条)。
   */
  focusNode(id: string) {
    const node = this.nodeById.get(id);
    if (!node) return;
    this.focusedId = id;
    this.highlightedSet = new Set([id]);
    const neighbors = this.links
      .filter((l) => l.source.id === id || l.target.id === id)
      .map((l) => (l.source.id === id ? l.target.id : l.source.id));
    for (const nid of neighbors) {
      if (this.highlightedSet.size - 1 >= FOCUS_EXPANSION_LIMIT) break;
      this.highlightedSet.add(nid);
    }
    if (node.x != null && node.y != null) {
      const scale = 1.4;
      const tx = this.width / 2 - scale * node.x;
      const ty = this.height / 2 - scale * node.y;
      const next = zoomIdentity.translate(tx, ty).scale(scale);
      if (this.zoomBehavior) {
        select<HTMLCanvasElement, unknown>(this.canvas).call(
          this.zoomBehavior.transform,
          next
        );
      } else {
        this.transform = next;
      }
    }
    this.render();
  }

  clearFocus() {
    this.focusedId = null;
    this.highlightedSet = new Set();
    this.render();
  }

  // ========== 渲染 ==========
  private render() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, this.width, this.height);

    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(this.transform.k, this.transform.k);

    this.drawLinks(ctx);
    this.drawNodes(ctx);

    ctx.restore();
  }

  private drawLinks(ctx: CanvasRenderingContext2D) {
    const dimmed = this.focusedId != null;
    ctx.lineWidth = 1.2;
    for (const l of this.links) {
      const sx = l.source.x ?? 0;
      const sy = l.source.y ?? 0;
      const tx = l.target.x ?? 0;
      const ty = l.target.y ?? 0;
      const inFocus =
        !dimmed ||
        (this.highlightedSet.has(l.source.id) && this.highlightedSet.has(l.target.id));
      ctx.strokeStyle = inFocus
        ? "rgba(120, 110, 180, 0.55)"
        : "rgba(120, 110, 180, 0.15)";
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      if (inFocus && l.label) {
        const mx = (sx + tx) / 2;
        const my = (sy + ty) / 2;
        ctx.fillStyle = "rgba(90, 80, 150, 0.85)";
        ctx.font = "10px sans-serif";
        ctx.fillText(l.label, mx + 2, my - 2);
      }
    }
  }

  private drawNodes(ctx: CanvasRenderingContext2D) {
    const dimmed = this.focusedId != null;
    for (const n of this.nodes) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const color = resolveColor(n.type);
      const inFocus = !dimmed || this.highlightedSet.has(n.id);
      const isFocused = this.focusedId === n.id;
      const isHovered = this.hovered?.id === n.id;

      ctx.globalAlpha = inFocus ? 1 : 0.25;

      // 光晕
      if (isFocused || isHovered) {
        ctx.beginPath();
        ctx.arc(x, y, NODE_RADIUS + 8, 0, Math.PI * 2);
        ctx.fillStyle = color + "33";
        ctx.fill();
      }

      // 节点圆
      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = isFocused ? 3 : 1.5;
      ctx.strokeStyle = isFocused ? "#ffffff" : "rgba(255,255,255,0.7)";
      ctx.stroke();

      // 首字图标
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 13px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const ch = (n.title || "?").trim().charAt(0).toUpperCase();
      ctx.fillText(ch, x, y);

      // 标题
      if (inFocus) {
        ctx.fillStyle = "rgba(40, 35, 80, 0.95)";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = n.title.length > 10 ? n.title.slice(0, 10) + "…" : n.title;
        ctx.fillText(label, x, y + NODE_RADIUS + 4);
      }
      ctx.globalAlpha = 1;
    }
  }

  // ========== 导出 ==========
  exportJSON(): string {
    const graph = {
      nodes: this.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        summary: n.summary,
        details: n.details,
        tags: n.tags,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        x: n.x,
        y: n.y,
      })),
      links: this.links.map((l) => ({
        source: l.source.id,
        target: l.target.id,
        strength: l.strength,
        label: l.label,
      })),
    };
    return JSON.stringify(graph, null, 2);
  }

  exportPNG(): string {
    return this.canvas.toDataURL("image/png");
  }

  // ========== 生命周期 ==========
  destroy() {
    this.sim?.stop();
    this.sim = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    select<HTMLCanvasElement, unknown>(this.canvas)
      .on(".zoom", null)
      .on(".drag", null);
  }
}
