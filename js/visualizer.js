/**
 * 推理过程可视化组件
 * Canvas 力导向布局，高亮显示推理路径，支持拖拽、缩放与节点悬停
 */
(function () {
  "use strict";

  const CAT_COLORS = {
    "自然科学": "#4f8ef7",
    "技术与工程": "#34c77b",
    "人文社科": "#f7a440",
    "生活与文化": "#e8636f"
  };
  const DEFAULT_COLOR = "#9b8cf7";

  class GraphVisualizer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.nodes = [];
      this.edges = [];
      this.highlightPath = [];   // 节点 id 序列
      this.highlightSet = new Set();
      this.highlightEdges = new Set(); // "a-b" 键
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.dragging = null;
      this.panning = false;
      this.hovered = null;
      this.animT = 0;
      this._bindEvents();
      this._running = false;
    }

    /** 加载子图并启动布局动画；pathNodeIds 为需要高亮的推理路径 */
    load(subgraph, pathNodeIds) {
      const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
      const old = new Map(this.nodes.map(n => [n.id, n]));
      this.nodes = subgraph.nodes.map((n, i) => {
        const prev = old.get(n.id);
        const angle = (i / subgraph.nodes.length) * Math.PI * 2;
        const r = 80 + Math.random() * 120;
        return {
          id: n.id, name: n.name, type: n.type, category: n.category, domain: n.domain,
          desc: n.desc,
          x: prev ? prev.x : cx + Math.cos(angle) * r,
          y: prev ? prev.y : cy + Math.sin(angle) * r,
          vx: 0, vy: 0
        };
      });
      this.nodeMap = new Map(this.nodes.map(n => [n.id, n]));
      this.edges = subgraph.edges
        .filter(e => this.nodeMap.has(e.source) && this.nodeMap.has(e.target))
        .map(e => ({ s: e.source, t: e.target, rel: e.rel }));
      this.setHighlight(pathNodeIds || []);
      this.scale = 1; this.offsetX = 0; this.offsetY = 0;
      this.iterations = 0;
      if (!this._running) { this._running = true; this._loop(); }
    }

    setHighlight(pathNodeIds) {
      this.highlightPath = pathNodeIds || [];
      this.highlightSet = new Set(this.highlightPath);
      this.highlightEdges = new Set();
      for (let i = 0; i + 1 < this.highlightPath.length; i++) {
        const a = this.highlightPath[i], b = this.highlightPath[i + 1];
        this.highlightEdges.add(a + "-" + b);
        this.highlightEdges.add(b + "-" + a);
      }
    }

    _bindEvents() {
      const pos = (ev) => {
        const rect = this.canvas.getBoundingClientRect();
        const sx = this.canvas.width / rect.width, sy = this.canvas.height / rect.height;
        return {
          x: ((ev.clientX - rect.left) * sx - this.offsetX) / this.scale,
          y: ((ev.clientY - rect.top) * sy - this.offsetY) / this.scale
        };
      };
      this.canvas.addEventListener("mousedown", ev => {
        const p = pos(ev);
        const hit = this._hitTest(p.x, p.y);
        if (hit) this.dragging = hit;
        else { this.panning = true; this._panStart = { x: ev.clientX, y: ev.clientY, ox: this.offsetX, oy: this.offsetY }; }
      });
      this.canvas.addEventListener("mousemove", ev => {
        const p = pos(ev);
        if (this.dragging) {
          this.dragging.x = p.x; this.dragging.y = p.y;
          this.dragging.vx = 0; this.dragging.vy = 0;
          this.iterations = Math.min(this.iterations, 200);
        } else if (this.panning) {
          const rect = this.canvas.getBoundingClientRect();
          const sx = this.canvas.width / rect.width;
          this.offsetX = this._panStart.ox + (ev.clientX - this._panStart.x) * sx;
          this.offsetY = this._panStart.oy + (ev.clientY - this._panStart.y) * sx;
        } else {
          this.hovered = this._hitTest(p.x, p.y);
          this.canvas.style.cursor = this.hovered ? "pointer" : "grab";
        }
      });
      window.addEventListener("mouseup", () => { this.dragging = null; this.panning = false; });
      this.canvas.addEventListener("wheel", ev => {
        ev.preventDefault();
        const factor = ev.deltaY < 0 ? 1.1 : 0.9;
        this.scale = Math.max(0.3, Math.min(3, this.scale * factor));
      }, { passive: false });
    }

    _hitTest(x, y) {
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        const n = this.nodes[i];
        const r = this._radius(n) + 4;
        if ((n.x - x) ** 2 + (n.y - y) ** 2 < r * r) return n;
      }
      return null;
    }

    _radius(n) {
      if (this.highlightSet.has(n.id)) return 16;
      if (n.type === "domain") return 13;
      if (n.type === "category") return 15;
      return 9;
    }

    /** 力导向布局一步 */
    _layoutStep() {
      if (this.iterations > 300) return;
      this.iterations++;
      const nodes = this.nodes;
      const k = 90; // 理想边长
      // 斥力
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const d = Math.sqrt(d2);
          const f = (k * k) / d2 * 2;
          dx /= d; dy /= d;
          a.vx += dx * f; a.vy += dy * f;
          b.vx -= dx * f; b.vy -= dy * f;
        }
      }
      // 引力（沿边）
      for (const e of this.edges) {
        const a = this.nodeMap.get(e.s), b = this.nodeMap.get(e.t);
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - k) * 0.02;
        dx /= d; dy /= d;
        a.vx += dx * f * d * 0.02; a.vy += dy * f * d * 0.02;
        b.vx -= dx * f * d * 0.02; b.vy -= dy * f * d * 0.02;
      }
      // 向心力 + 阻尼
      const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
      const cool = Math.max(0.2, 1 - this.iterations / 300);
      for (const n of nodes) {
        n.vx += (cx - n.x) * 0.002;
        n.vy += (cy - n.y) * 0.002;
        if (n !== this.dragging) {
          n.x += Math.max(-8, Math.min(8, n.vx * cool));
          n.y += Math.max(-8, Math.min(8, n.vy * cool));
        }
        n.vx *= 0.5; n.vy *= 0.5;
      }
    }

    _loop() {
      this._layoutStep();
      this.animT += 0.03;
      this._draw();
      requestAnimationFrame(() => this._loop());
    }

    _draw() {
      const ctx = this.ctx;
      const W = this.canvas.width, H = this.canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#101522";
      ctx.fillRect(0, 0, W, H);
      ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

      // 普通边
      ctx.lineWidth = 1;
      for (const e of this.edges) {
        const a = this.nodeMap.get(e.s), b = this.nodeMap.get(e.t);
        const hl = this.highlightEdges.has(e.s + "-" + e.t);
        if (hl) continue;
        ctx.strokeStyle = "rgba(140,160,200,0.25)";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // 高亮路径边（流动效果）
      for (const e of this.edges) {
        if (!this.highlightEdges.has(e.s + "-" + e.t)) continue;
        const a = this.nodeMap.get(e.s), b = this.nodeMap.get(e.t);
        const glow = 0.6 + 0.4 * Math.sin(this.animT * 3);
        ctx.strokeStyle = "rgba(255,210,80," + glow + ")";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // 关系标签
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.font = "11px sans-serif";
        ctx.fillStyle = "rgba(255,220,120,0.95)";
        ctx.textAlign = "center";
        ctx.fillText(e.rel, mx, my - 4);
        // 流动粒子
        const t = (this.animT * 0.5) % 1;
        const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        ctx.fillStyle = "#ffd24e";
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      // 节点
      for (const n of this.nodes) {
        const r = this._radius(n);
        const hl = this.highlightSet.has(n.id);
        const color = CAT_COLORS[n.category] || DEFAULT_COLOR;
        if (hl) {
          ctx.shadowColor = "#ffd24e";
          ctx.shadowBlur = 14 + 6 * Math.sin(this.animT * 3);
        } else {
          ctx.shadowBlur = 0;
        }
        ctx.fillStyle = hl ? "#ffd24e" : color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (n.type === "domain" || n.type === "category") {
          ctx.strokeStyle = "rgba(255,255,255,0.8)";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        // 标签
        ctx.font = (hl ? "bold 13px" : "11px") + " sans-serif";
        ctx.fillStyle = hl ? "#fff" : "rgba(230,235,245,0.85)";
        ctx.textAlign = "center";
        ctx.fillText(n.name, n.x, n.y + r + 13);
      }
      // 悬停提示
      if (this.hovered) {
        const n = this.hovered;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const lines = [n.name + "（" + (n.domain || "") + "）", n.desc || ""];
        ctx.font = "12px sans-serif";
        const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16;
        const sx = n.x * this.scale + this.offsetX, sy = n.y * this.scale + this.offsetY;
        const bx = Math.min(W - w - 8, Math.max(8, sx + 12));
        const by = Math.max(8, sy - 50);
        ctx.fillStyle = "rgba(20,26,40,0.95)";
        ctx.strokeStyle = "rgba(255,210,80,0.6)";
        ctx.beginPath();
        ctx.roundRect(bx, by, w, 40, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#ffd24e";
        ctx.textAlign = "left";
        ctx.fillText(lines[0], bx + 8, by + 16);
        ctx.fillStyle = "#cdd6e8";
        ctx.fillText(lines[1], bx + 8, by + 32);
      }
    }
  }

  window.GraphVisualizer = GraphVisualizer;
})();
