/**
 * 知识图谱推理引擎
 * 包含：图谱构建、多跳推理、路径搜索、关联推理、激活扩散
 */
(function () {
  "use strict";

  /** 反向关系名映射，用于生成可读的反向边描述 */
  const INVERSE_REL = {
    "属于": "包含",
    "包含": "属于",
    "提出者": "提出了",
    "创立者": "创立了",
    "发明者": "发明了",
    "组成部分": "由其组成",
    "代表人物": "是其代表人物",
    "代表作": "是其代表作",
    "应用于": "应用了",
    "前置知识": "是其前置知识",
    "导致": "由其导致",
    "影响": "受其影响",
    "位于": "坐落着",
    "使用": "被其使用",
    "相关": "相关"
  };

  class KnowledgeGraph {
    constructor() {
      this.nodes = new Map();      // id -> node
      this.nameIndex = new Map();  // 名称/同义词 -> [nodeId]
      this.edges = [];             // {source, target, rel}
      this.adj = new Map();        // nodeId -> [{to, rel, dir, edgeIndex}]
      this.domainCount = 0;
      this.categoryCount = 0;
    }

    /** 从 window.KG_PARTS 构建图谱 */
    build(parts) {
      for (const part of parts) {
        const catId = this._ensureNode(part.category, {
          type: "category",
          desc: part.category + "类别，包含 " + part.domains.length + " 个领域",
          domain: part.category,
          category: part.category
        });
        this.categoryCount++;
        for (const dom of part.domains) {
          const domId = this._ensureNode(dom.name, {
            type: "domain",
            desc: dom.desc || "",
            domain: dom.name,
            category: part.category
          });
          this.domainCount++;
          this._addEdge(domId, catId, "属于");
          for (const c of dom.concepts) {
            const cid = this._ensureNode(c.n, {
              type: "concept",
              desc: c.d || "",
              domain: dom.name,
              category: part.category,
              synonyms: c.syn || []
            });
            this._addEdge(cid, domId, "属于");
            for (const s of c.syn || []) this._indexName(s, cid);
          }
        }
      }
      // 第二遍：处理概念间关系（此时所有节点已注册，便于按名称连接）
      for (const part of parts) {
        for (const dom of part.domains) {
          for (const c of dom.concepts) {
            const fromIds = this.nameIndex.get(c.n) || [];
            const fromId = fromIds.find(id => {
              const n = this.nodes.get(id);
              return n.domain === dom.name;
            }) || fromIds[0];
            if (fromId === undefined) continue;
            for (const [rel, target] of c.rel || []) {
              let toId = this._resolveName(target, part.category, dom.name);
              if (toId === undefined) {
                // 目标不存在则创建实体节点（如著名人物）
                toId = this._ensureNode(target, {
                  type: "entity",
                  desc: "知识图谱中的关联实体",
                  domain: dom.name,
                  category: part.category
                });
              }
              if (toId !== fromId) this._addEdge(fromId, toId, rel);
            }
          }
        }
      }
    }

    _ensureNode(name, props) {
      const existing = this._resolveExact(name, props.domain);
      if (existing !== undefined) {
        const node = this.nodes.get(existing);
        // 实体节点升级为更具体的类型
        if (node.type === "entity" && props.type !== "entity") {
          Object.assign(node, props, { name: node.name, id: node.id });
        }
        return existing;
      }
      const id = this.nodes.size;
      const node = Object.assign({ id, name, synonyms: [] }, props);
      this.nodes.set(id, node);
      this._indexName(name, id);
      this.adj.set(id, []);
      return id;
    }

    _indexName(name, id) {
      const key = name.toLowerCase();
      if (!this.nameIndex.has(key)) this.nameIndex.set(key, []);
      const arr = this.nameIndex.get(key);
      if (!arr.includes(id)) arr.push(id);
    }

    _resolveExact(name, domain) {
      const ids = this.nameIndex.get(name.toLowerCase());
      if (!ids || ids.length === 0) return undefined;
      if (domain) {
        const inDomain = ids.find(i => this.nodes.get(i).domain === domain);
        if (inDomain !== undefined) return inDomain;
      }
      return ids[0];
    }

    _resolveName(name, category, domain) {
      const ids = this.nameIndex.get(name.toLowerCase());
      if (!ids || ids.length === 0) return undefined;
      // 优先同领域 > 同类别 > 任意
      let best = ids.find(i => this.nodes.get(i).domain === domain);
      if (best === undefined) best = ids.find(i => this.nodes.get(i).category === category);
      return best !== undefined ? best : ids[0];
    }

    _addEdge(from, to, rel) {
      // 去重
      const dup = this.adj.get(from).some(e => e.to === to && e.rel === rel && e.dir === 1);
      if (dup) return;
      const idx = this.edges.length;
      this.edges.push({ source: from, target: to, rel });
      this.adj.get(from).push({ to, rel, dir: 1, edgeIndex: idx });
      this.adj.get(to).push({ to: from, rel, dir: -1, edgeIndex: idx });
    }

    /** 按名称查找节点，返回所有同名候选（用于词义消歧） */
    findByName(name) {
      const ids = this.nameIndex.get(name.toLowerCase()) || [];
      return ids.map(id => this.nodes.get(id));
    }

    /** 模糊查找：子串匹配 */
    fuzzyFind(text, limit) {
      const results = [];
      const t = text.toLowerCase();
      for (const [key, ids] of this.nameIndex) {
        if (key.includes(t) || t.includes(key)) {
          for (const id of ids) {
            results.push({ node: this.nodes.get(id), score: key === t ? 2 : 1 });
          }
        }
        if (results.length >= (limit || 20) * 3) break;
      }
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit || 20).map(r => r.node);
    }

    neighbors(id) {
      return this.adj.get(id) || [];
    }

    describeEdge(e) {
      return e.dir === 1 ? e.rel : (INVERSE_REL[e.rel] || "被" + e.rel);
    }

    stats() {
      let conceptCount = 0, entityCount = 0;
      for (const n of this.nodes.values()) {
        if (n.type === "concept") conceptCount++;
        else if (n.type === "entity") entityCount++;
      }
      return {
        nodes: this.nodes.size,
        edges: this.edges.length,
        domains: this.domainCount,
        categories: this.categoryCount,
        concepts: conceptCount,
        entities: entityCount
      };
    }
  }

  class ReasoningEngine {
    constructor(graph) {
      this.g = graph;
    }

    /**
     * 多跳推理：从起点出发沿关系链扩展，返回推理链集合
     * 每条链形如 [{node, rel}] ，并附带可读解释
     */
    multiHop(startId, maxHops, maxChains) {
      maxHops = maxHops || 3;
      maxChains = maxChains || 12;
      const chains = [];
      const startNode = this.g.nodes.get(startId);
      const visitedPaths = new Set();

      const dfs = (id, path, hops, visited) => {
        if (chains.length >= maxChains) return;
        if (hops >= maxHops) return;
        const neigh = this.g.neighbors(id);
        // 优先非"属于"边，使推理链更有信息量
        const sorted = neigh.slice().sort((a, b) => {
          const av = a.rel === "属于" ? 1 : 0, bv = b.rel === "属于" ? 1 : 0;
          return av - bv;
        });
        for (const e of sorted) {
          if (visited.has(e.to)) continue;
          if (chains.length >= maxChains) return;
          const next = path.concat([{ nodeId: e.to, rel: e.rel, dir: e.dir }]);
          const key = next.map(p => p.nodeId + ":" + (p.rel || "")).join(">");
          if (visitedPaths.has(key)) continue;
          visitedPaths.add(key);
          if (next.length >= 2) {
            chains.push(this._explainChain(startId, next));
          }
          visited.add(e.to);
          dfs(e.to, next, hops + 1, visited);
          visited.delete(e.to);
        }
      };
      dfs(startId, [], 0, new Set([startId]));
      // 单跳结果（保证至少有结果）
      if (chains.length === 0) {
        for (const e of this.g.neighbors(startId).slice(0, maxChains)) {
          chains.push(this._explainChain(startId, [{ nodeId: e.to, rel: e.rel, dir: e.dir }]));
        }
      }
      return { start: startNode, chains };
    }

    _explainChain(startId, path) {
      const parts = [this.g.nodes.get(startId).name];
      const nodeIds = [startId];
      let text = this.g.nodes.get(startId).name;
      for (const step of path) {
        const relText = step.dir === 1 ? step.rel : (INVERSE_REL[step.rel] || "被" + step.rel);
        const name = this.g.nodes.get(step.nodeId).name;
        text += " —[" + relText + "]→ " + name;
        parts.push(relText, name);
        nodeIds.push(step.nodeId);
      }
      return { text, nodeIds, hops: path.length, path };
    }

    /**
     * 路径搜索：双向 BFS 找到两节点间的最短路径，再 DFS 枚举若干条不超过 maxDepth 的路径
     */
    findPaths(aId, bId, maxDepth, maxPaths) {
      maxDepth = maxDepth || 4;
      maxPaths = maxPaths || 5;
      const paths = [];
      const visited = new Set([aId]);

      const dfs = (id, path) => {
        if (paths.length >= maxPaths) return;
        if (path.length > maxDepth) return;
        for (const e of this.g.neighbors(id)) {
          if (paths.length >= maxPaths) return;
          if (e.to === bId) {
            paths.push(this._explainChain(aId, path.concat([{ nodeId: e.to, rel: e.rel, dir: e.dir }])));
          } else if (!visited.has(e.to) && path.length + 1 < maxDepth) {
            visited.add(e.to);
            dfs(e.to, path.concat([{ nodeId: e.to, rel: e.rel, dir: e.dir }]));
            visited.delete(e.to);
          }
        }
      };
      dfs(aId, []);
      paths.sort((x, y) => x.hops - y.hops);
      return paths;
    }

    /**
     * 关联推理：寻找两个节点的共同邻居、共同领域/类别，给出关联解释
     */
    associate(aId, bId) {
      const a = this.g.nodes.get(aId), b = this.g.nodes.get(bId);
      const aNeigh = new Map(this.g.neighbors(aId).map(e => [e.to, e]));
      const common = [];
      for (const e of this.g.neighbors(bId)) {
        if (aNeigh.has(e.to)) {
          const ea = aNeigh.get(e.to);
          common.push({
            node: this.g.nodes.get(e.to),
            relA: this.g.describeEdge(ea),
            relB: this.g.describeEdge(e)
          });
        }
      }
      const findings = [];
      if (a.domain === b.domain) {
        findings.push("两者同属「" + a.domain + "」领域");
      } else if (a.category === b.category) {
        findings.push("两者同属「" + a.category + "」大类（领域分别为「" + a.domain + "」与「" + b.domain + "」）");
      }
      for (const c of common.slice(0, 6)) {
        findings.push("「" + a.name + "」" + c.relA + "「" + c.node.name + "」，而「" + b.name + "」" + c.relB + "「" + c.node.name + "」");
      }
      return { a, b, common, findings };
    }

    /**
     * 激活扩散：从一组种子节点扩散激活值，返回相关度最高的节点
     * 用于开放性问题的相关概念推荐
     */
    spreadActivation(seedIds, decay, iterations, topK) {
      decay = decay || 0.5;
      iterations = iterations || 2;
      topK = topK || 10;
      let activation = new Map();
      for (const id of seedIds) activation.set(id, 1.0);
      for (let it = 0; it < iterations; it++) {
        const next = new Map(activation);
        for (const [id, val] of activation) {
          if (val < 0.05) continue;
          const neigh = this.g.neighbors(id);
          const share = (val * decay) / Math.max(1, Math.sqrt(neigh.length));
          for (const e of neigh) {
            next.set(e.to, (next.get(e.to) || 0) + share);
          }
        }
        activation = next;
      }
      const results = [];
      for (const [id, val] of activation) {
        if (!seedIds.includes(id)) results.push({ node: this.g.nodes.get(id), score: val });
      }
      results.sort((x, y) => y.score - x.score);
      return results.slice(0, topK);
    }

    /** 围绕若干中心节点抽取子图（用于可视化） */
    subgraph(centerIds, radius, maxNodes) {
      radius = radius || 1;
      maxNodes = maxNodes || 40;
      const included = new Set(centerIds);
      let frontier = centerIds.slice();
      for (let r = 0; r < radius && included.size < maxNodes; r++) {
        const next = [];
        for (const id of frontier) {
          for (const e of this.g.neighbors(id)) {
            if (!included.has(e.to) && included.size < maxNodes) {
              included.add(e.to);
              next.push(e.to);
            }
          }
        }
        frontier = next;
      }
      const nodes = Array.from(included).map(id => this.g.nodes.get(id));
      const edges = [];
      for (const e of this.g.edges) {
        if (included.has(e.source) && included.has(e.target)) edges.push(e);
      }
      return { nodes, edges };
    }
  }

  window.KnowledgeGraph = KnowledgeGraph;
  window.ReasoningEngine = ReasoningEngine;
})();
