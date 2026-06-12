/**
 * 语义分析器
 * 包含：基于图谱词典的中文分词（正向最大匹配）、词义消歧、同义词扩展、意图识别
 */
(function () {
  "use strict";

  /** 意图模式表：按优先级匹配 */
  const INTENT_PATTERNS = [
    { intent: "path",       label: "路径推理", re: /(.+?)(?:和|与|跟|到)(.+?)(?:之间)?(?:有什么|存在什么|的)?(?:关系|联系|关联)/ },
    { intent: "compare",    label: "对比分析", re: /(.+?)(?:和|与|跟)(.+?)(?:的)?(?:区别|不同|差异|对比|比较)/ },
    { intent: "definition", label: "定义查询", re: /(?:什么是|何为|啥是)(.+)|(.+?)(?:是什么|是啥|的定义|的含义|指的是什么)/ },
    { intent: "list",       label: "列举查询", re: /(.+?)(?:领域|方面|下面|中)?(?:有哪些|包括哪些|包含哪些|包含什么|有什么内容)/ },
    { intent: "cause",      label: "因果推理", re: /(?:为什么|为何)(.+)|(.+?)(?:的原因|的成因|是怎么来的|导致了什么|有什么影响)/ },
    { intent: "domain",     label: "归属查询", re: /(.+?)(?:属于|归于)(?:什么|哪个|哪些)?(?:领域|学科|类别|分类)/ },
    { intent: "explore",    label: "联想探索", re: /(?:介绍|讲讲|说说|聊聊|了解)(?:一下)?(.+)|(.+?)(?:相关|关联)(?:的)?(?:知识|概念|内容)/ }
  ];

  class SemanticAnalyzer {
    constructor(graph) {
      this.g = graph;
      this._buildLexicon();
    }

    /** 词典 = 所有节点名 + 同义词；同义词映射到规范名 */
    _buildLexicon() {
      this.lexicon = new Set();
      this.synToCanonical = new Map();
      this.maxWordLen = 2;
      for (const node of this.g.nodes.values()) {
        const name = node.name.toLowerCase();
        this.lexicon.add(name);
        this.maxWordLen = Math.max(this.maxWordLen, name.length);
        for (const s of node.synonyms || []) {
          const sl = s.toLowerCase();
          this.lexicon.add(sl);
          this.synToCanonical.set(sl, node.name);
          this.maxWordLen = Math.max(this.maxWordLen, sl.length);
        }
      }
      this.maxWordLen = Math.min(this.maxWordLen, 12);
    }

    /** 正向最大匹配分词，未命中的连续字符聚合为普通词 */
    tokenize(text) {
      const tokens = [];
      const clean = text.trim();
      let i = 0, buffer = "";
      const flush = () => {
        if (buffer) {
          tokens.push({ word: buffer, inGraph: false });
          buffer = "";
        }
      };
      while (i < clean.length) {
        let matched = null;
        const maxLen = Math.min(this.maxWordLen, clean.length - i);
        for (let len = maxLen; len >= 2; len--) {
          const cand = clean.substr(i, len).toLowerCase();
          if (this.lexicon.has(cand)) { matched = clean.substr(i, len); break; }
        }
        if (matched) {
          flush();
          const canonical = this.synToCanonical.get(matched.toLowerCase()) || matched;
          tokens.push({
            word: matched,
            canonical,
            inGraph: true,
            isSynonym: this.synToCanonical.has(matched.toLowerCase())
          });
          i += matched.length;
        } else {
          buffer += clean[i];
          i++;
        }
      }
      flush();
      return tokens;
    }

    /**
     * 词义消歧：同名节点存在于多个领域时，依据上下文其他词条的领域/类别打分
     * 返回 {node, score, reason, candidates}
     */
    disambiguate(canonical, contextTokens) {
      const candidates = this.g.findByName(canonical);
      if (candidates.length === 0) return null;
      if (candidates.length === 1) {
        return { node: candidates[0], score: 1, candidates, reason: "唯一匹配，无歧义" };
      }
      // 收集上下文领域/类别
      const ctxDomains = new Map(), ctxCats = new Map();
      for (const t of contextTokens) {
        if (!t.inGraph || t.canonical === canonical) continue;
        for (const n of this.g.findByName(t.canonical)) {
          ctxDomains.set(n.domain, (ctxDomains.get(n.domain) || 0) + 1);
          ctxCats.set(n.category, (ctxCats.get(n.category) || 0) + 1);
        }
      }
      let best = candidates[0], bestScore = -1;
      const scored = candidates.map(c => {
        let score = 0.1;
        if (ctxDomains.has(c.domain)) score += 2 * ctxDomains.get(c.domain);
        if (ctxCats.has(c.category)) score += 1 * ctxCats.get(c.category);
        // 概念/领域节点优先于附属实体节点
        if (c.type === "domain") score += 0.5;
        if (c.type === "concept") score += 0.3;
        if (score > bestScore) { bestScore = score; best = c; }
        return { node: c, score };
      });
      const reason = bestScore > 0.9
        ? "依据上下文领域「" + best.domain + "」选定该义项（候选 " + candidates.length + " 个）"
        : "无强上下文信号，按节点类型优先级选定（候选 " + candidates.length + " 个）";
      return { node: best, score: bestScore, candidates: scored.map(s => s.node), reason };
    }

    /** 同义词扩展：给出一个词的所有等价表达与近邻概念 */
    expandSynonyms(canonical) {
      const expansions = new Set();
      for (const node of this.g.findByName(canonical)) {
        for (const s of node.synonyms || []) expansions.add(s);
        if (node.name !== canonical) expansions.add(node.name);
      }
      // 反查：哪些同义词映射到这个名字
      for (const [syn, canon] of this.synToCanonical) {
        if (canon === canonical) expansions.add(syn);
      }
      expansions.delete(canonical);
      return Array.from(expansions);
    }

    /** 意图识别：返回 {intent, label, slots} */
    recognizeIntent(text, tokens) {
      const graphWords = tokens.filter(t => t.inGraph).map(t => t.canonical);
      for (const p of INTENT_PATTERNS) {
        const m = text.match(p.re);
        if (m) {
          const slots = m.slice(1).filter(Boolean).map(s => s.trim().replace(/[？?。！!，,]/g, ""));
          return { intent: p.intent, label: p.label, slots, graphWords };
        }
      }
      if (graphWords.length >= 2) {
        return { intent: "path", label: "路径推理（隐式）", slots: graphWords.slice(0, 2), graphWords };
      }
      if (graphWords.length === 1) {
        return { intent: "explore", label: "联想探索（隐式）", slots: [graphWords[0]], graphWords };
      }
      return { intent: "fallback", label: "开放查询", slots: [], graphWords };
    }

    /** 从槽位文本中抽取图谱实体（先精确再模糊） */
    extractEntity(slotText, contextTokens) {
      if (!slotText) return null;
      const slotTokens = this.tokenize(slotText);
      const inGraph = slotTokens.filter(t => t.inGraph);
      if (inGraph.length > 0) {
        // 取最长的命中词
        inGraph.sort((a, b) => b.word.length - a.word.length);
        const dis = this.disambiguate(inGraph[0].canonical, contextTokens || slotTokens);
        return dis ? { node: dis.node, disambiguation: dis, matchedWord: inGraph[0].word } : null;
      }
      const fuzzy = this.g.fuzzyFind(slotText.trim(), 1);
      if (fuzzy.length > 0) {
        return { node: fuzzy[0], disambiguation: null, matchedWord: slotText.trim(), fuzzy: true };
      }
      return null;
    }

    /** 完整分析管线：分词 → 意图 → 实体抽取 → 消歧 → 同义词扩展 */
    analyze(text) {
      const tokens = this.tokenize(text);
      const intent = this.recognizeIntent(text, tokens);
      const entities = [];
      const seen = new Set();
      // 优先从槽位抽实体，槽位为空时从全句图谱词抽取
      const sources = intent.slots.length > 0 ? intent.slots : [text];
      for (const slot of sources) {
        const ent = this.extractEntity(slot, tokens);
        if (ent && !seen.has(ent.node.id)) {
          seen.add(ent.node.id);
          ent.synonyms = this.expandSynonyms(ent.node.name);
          entities.push(ent);
        }
      }
      // 补充：句中其他图谱词
      for (const t of tokens) {
        if (entities.length >= 3) break;
        if (t.inGraph) {
          const dis = this.disambiguate(t.canonical, tokens);
          if (dis && !seen.has(dis.node.id)) {
            seen.add(dis.node.id);
            entities.push({
              node: dis.node, disambiguation: dis, matchedWord: t.word,
              synonyms: this.expandSynonyms(dis.node.name)
            });
          }
        }
      }
      return { text, tokens, intent, entities };
    }
  }

  window.SemanticAnalyzer = SemanticAnalyzer;
})();
