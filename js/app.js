/**
 * 应用主逻辑：聊天交互、答案生成、推理详情面板渲染
 */
(function () {
  "use strict";

  let graph, engine, analyzer, viz;

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function init() {
    graph = new KnowledgeGraph();
    graph.build(window.KG_PARTS || []);
    engine = new ReasoningEngine(graph);
    analyzer = new SemanticAnalyzer(graph);
    viz = new GraphVisualizer(document.getElementById("graph-canvas"));

    const s = graph.stats();
    document.getElementById("stats-bar").innerHTML =
      '<span class="stat"><b>' + s.nodes + "</b> 节点</span>" +
      '<span class="stat"><b>' + s.edges + "</b> 关系边</span>" +
      '<span class="stat"><b>' + s.domains + "</b> 领域</span>" +
      '<span class="stat"><b>' + s.categories + "</b> 大类</span>";

    document.getElementById("send-btn").addEventListener("click", onSend);
    document.getElementById("user-input").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
    });
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    document.querySelectorAll(".example").forEach(el => {
      el.addEventListener("click", () => {
        document.getElementById("user-input").value = el.textContent;
        onSend();
      });
    });

    // 初始展示一个示例子图
    const seedNode = graph.findByName("知识图谱")[0] || graph.nodes.get(0);
    if (seedNode) {
      viz.load(engine.subgraph([seedNode.id], 2, 30), [seedNode.id]);
    }
    addMessage("bot", "你好！我是基于知识图谱推理的智能问答助手，知识库覆盖 <b>" + s.domains +
      "</b> 个领域、<b>" + s.nodes + "</b> 个节点。你可以问我概念定义、两个事物的关系、领域内容等，" +
      "右侧面板会实时展示<b>语义分析</b>与<b>多跳推理</b>的完整过程。");
  }

  function switchTab(name) {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === "tab-" + name));
  }

  function addMessage(role, html) {
    const wrap = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.innerHTML = '<div class="bubble">' + html + "</div>";
    wrap.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
    return div;
  }

  function onSend() {
    const input = document.getElementById("user-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    addMessage("user", esc(text));
    const thinking = addMessage("bot", '<span class="thinking">图谱推理中…</span>');
    setTimeout(() => {
      const result = processQuery(text);
      thinking.querySelector(".bubble").innerHTML = result.answer;
      renderReasoningPanel(result);
    }, 250);
  }

  /** 核心问答管线 */
  function processQuery(text) {
    const sem = analyzer.analyze(text);
    const steps = [];
    steps.push({
      title: "语义分析",
      detail: "分词得到 " + sem.tokens.length + " 个词条，其中 " +
        sem.tokens.filter(t => t.inGraph).length + " 个命中图谱词典；识别意图为「" + sem.intent.label + "」"
    });
    for (const ent of sem.entities) {
      if (ent.disambiguation && ent.disambiguation.candidates.length > 1) {
        steps.push({ title: "词义消歧", detail: "「" + ent.matchedWord + "」" + ent.disambiguation.reason });
      }
      if (ent.synonyms && ent.synonyms.length > 0) {
        steps.push({ title: "同义词扩展", detail: "「" + ent.node.name + "」≈ " + ent.synonyms.join("、") });
      }
    }

    let answer, pathIds = [], centers = [];
    const e0 = sem.entities[0], e1 = sem.entities[1];

    switch (sem.intent.intent) {
      case "path":
        if (e0 && e1) {
          const r = answerRelation(e0.node, e1.node, steps);
          answer = r.answer; pathIds = r.pathIds; centers = [e0.node.id, e1.node.id];
        } else {
          answer = answerFallback(sem, steps); centers = sem.entities.map(e => e.node.id);
        }
        break;
      case "compare":
        if (e0 && e1) {
          const r = answerCompare(e0.node, e1.node, steps);
          answer = r.answer; pathIds = r.pathIds; centers = [e0.node.id, e1.node.id];
        } else {
          answer = answerFallback(sem, steps); centers = sem.entities.map(e => e.node.id);
        }
        break;
      case "definition":
      case "domain":
        if (e0) {
          const r = answerDefinition(e0.node, steps);
          answer = r.answer; pathIds = r.pathIds; centers = [e0.node.id];
        } else {
          answer = answerFallback(sem, steps);
        }
        break;
      case "list":
        if (e0) {
          const r = answerList(e0.node, steps);
          answer = r.answer; pathIds = r.pathIds; centers = [e0.node.id];
        } else {
          answer = answerFallback(sem, steps);
        }
        break;
      case "cause":
      case "explore":
        if (e0) {
          const r = answerExplore(e0.node, steps);
          answer = r.answer; pathIds = r.pathIds; centers = [e0.node.id];
        } else {
          answer = answerFallback(sem, steps);
        }
        break;
      default:
        answer = answerFallback(sem, steps);
        centers = sem.entities.map(e => e.node.id);
    }

    if (centers.length === 0 && sem.entities.length > 0) centers = [sem.entities[0].node.id];
    return { answer, steps, sem, pathIds, centers };
  }

  /** 定义/归属类问题 */
  function answerDefinition(node, steps) {
    const hop = engine.multiHop(node.id, 2, 8);
    steps.push({
      title: "多跳推理",
      detail: "以「" + node.name + "」为起点扩展 2 跳，得到 " + hop.chains.length + " 条推理链"
    });
    const related = engine.spreadActivation([node.id], 0.5, 2, 6);
    steps.push({
      title: "激活扩散",
      detail: "相关度最高的概念：" + related.map(r => r.node.name).join("、")
    });
    let html = "<b>" + esc(node.name) + "</b>：" + esc(node.desc || "（暂无描述）") + "<br>";
    html += "📂 所属领域：<b>" + esc(node.domain) + "</b>（" + esc(node.category) + "）<br>";
    const belongs = hop.chains.filter(c => c.text.includes("属于")).slice(0, 2);
    if (belongs.length) {
      html += "🧭 归属链：" + belongs.map(c => esc(c.text)).join("；") + "<br>";
    }
    if (related.length) {
      html += "🔗 相关概念：" + related.map(r => esc(r.node.name)).join("、");
    }
    const pathIds = hop.chains.length > 0 ? hop.chains[0].nodeIds : [node.id];
    return { answer: html, pathIds };
  }

  /** 两实体关系问题 */
  function answerRelation(a, b, steps) {
    const paths = engine.findPaths(a.id, b.id, 5, 5);
    steps.push({
      title: "路径搜索",
      detail: "在「" + a.name + "」与「" + b.name + "」之间搜索（深度≤5），找到 " + paths.length + " 条路径"
    });
    const assoc = engine.associate(a.id, b.id);
    if (assoc.findings.length) {
      steps.push({ title: "关联推理", detail: assoc.findings.join("；") });
    }
    let html;
    if (paths.length > 0) {
      const best = paths[0];
      steps.push({ title: "最优路径", detail: best.text + "（" + best.hops + " 跳）" });
      html = "<b>" + esc(a.name) + "</b> 与 <b>" + esc(b.name) + "</b> 在图谱中通过 <b>" +
        best.hops + " 跳</b>连通：<br>";
      html += '<div class="path-box">' + esc(best.text) + "</div>";
      if (paths.length > 1) {
        html += "其他路径：<br>" + paths.slice(1, 3).map(p => '<div class="path-box alt">' + esc(p.text) + "</div>").join("");
      }
      if (assoc.findings.length) {
        html += "💡 " + esc(assoc.findings[0]);
      }
      return { answer: html, pathIds: best.nodeIds };
    }
    html = "图谱中暂未找到「" + esc(a.name) + "」与「" + esc(b.name) + "」的直接连通路径。";
    if (assoc.findings.length) {
      html += "<br>不过关联推理发现：" + esc(assoc.findings.join("；"));
    }
    return { answer: html, pathIds: [a.id, b.id] };
  }

  /** 对比类问题 */
  function answerCompare(a, b, steps) {
    const assoc = engine.associate(a.id, b.id);
    steps.push({
      title: "关联推理",
      detail: "比较两者的领域归属与共同邻居，找到 " + assoc.common.length + " 个共同关联节点"
    });
    let html = "<b>" + esc(a.name) + "</b>：" + esc(a.desc || "") + "（领域：" + esc(a.domain) + "）<br>" +
      "<b>" + esc(b.name) + "</b>：" + esc(b.desc || "") + "（领域：" + esc(b.domain) + "）<br>";
    if (assoc.findings.length) {
      html += "🔍 共同点：" + assoc.findings.map(esc).join("；") + "<br>";
    }
    html += "🆚 差异：" + (a.domain === b.domain
      ? "两者同属一个领域，差异主要体现在概念定义上"
      : "「" + esc(a.name) + "」属于「" + esc(a.domain) + "」，而「" + esc(b.name) + "」属于「" + esc(b.domain) + "」");
    const paths = engine.findPaths(a.id, b.id, 4, 1);
    const pathIds = paths.length ? paths[0].nodeIds : [a.id, b.id];
    return { answer: html, pathIds };
  }

  /** 列举类问题 */
  function answerList(node, steps) {
    const neigh = graph.neighbors(node.id);
    const members = neigh.filter(e => e.dir === -1 && e.rel === "属于").map(e => graph.nodes.get(e.to));
    const contains = neigh.filter(e => e.dir === 1 && e.rel === "包含").map(e => graph.nodes.get(e.to));
    const all = members.concat(contains);
    steps.push({
      title: "图谱检索",
      detail: "沿「属于/包含」反向边检索「" + node.name + "」的下位节点，共 " + all.length + " 个"
    });
    let html;
    if (all.length > 0) {
      html = "<b>" + esc(node.name) + "</b> 包含以下内容：<br>" +
        all.slice(0, 15).map(n => "• <b>" + esc(n.name) + "</b>：" + esc(n.desc || "")).join("<br>");
      if (all.length > 15) html += "<br>……等共 " + all.length + " 项";
    } else {
      const related = engine.spreadActivation([node.id], 0.5, 2, 8);
      html = "「" + esc(node.name) + "」没有直接的下位概念，相关概念有：" +
        related.map(r => esc(r.node.name)).join("、");
    }
    const pathIds = [node.id].concat(all.slice(0, 5).map(n => n.id));
    return { answer: html, pathIds };
  }

  /** 探索/因果类问题 */
  function answerExplore(node, steps) {
    const hop = engine.multiHop(node.id, 3, 10);
    steps.push({
      title: "多跳推理",
      detail: "以「" + node.name + "」为起点进行 3 跳推理，生成 " + hop.chains.length + " 条推理链"
    });
    const causal = hop.chains.filter(c => /导致|影响|应用|提出|发明|创立/.test(c.text));
    if (causal.length) {
      steps.push({ title: "因果/影响链", detail: causal[0].text });
    }
    let html = "<b>" + esc(node.name) + "</b>：" + esc(node.desc || "") +
      "（" + esc(node.domain) + " · " + esc(node.category) + "）<br>推理发现：<br>";
    const shown = (causal.length ? causal : hop.chains).slice(0, 4);
    html += shown.map(c => '<div class="path-box alt">' + esc(c.text) + "</div>").join("");
    const pathIds = shown.length ? shown[0].nodeIds : [node.id];
    return { answer: html, pathIds };
  }

  /** 兜底：激活扩散推荐 */
  function answerFallback(sem, steps) {
    if (sem.entities.length > 0) {
      const seeds = sem.entities.map(e => e.node.id);
      const related = engine.spreadActivation(seeds, 0.5, 2, 8);
      steps.push({
        title: "激活扩散",
        detail: "从 " + sem.entities.map(e => "「" + e.node.name + "」").join("") +
          " 扩散激活，找到 " + related.length + " 个相关概念"
      });
      return "我从你的问题中识别到了 " +
        sem.entities.map(e => "<b>" + esc(e.node.name) + "</b>").join("、") +
        "。相关概念有：" + related.map(r => esc(r.node.name)).join("、") +
        "。<br>你可以试着问：「" + esc(sem.entities[0].node.name) + "是什么」或「" +
        esc(sem.entities[0].node.name) + "和" + esc(related[0] ? related[0].node.name : "某概念") + "有什么关系」";
    }
    const fuzzy = graph.fuzzyFind(sem.text.replace(/[？?。！!，,是什么的]/g, ""), 5);
    if (fuzzy.length > 0) {
      steps.push({ title: "模糊匹配", detail: "未精确命中图谱词典，按子串匹配到 " + fuzzy.length + " 个候选" });
      return "没有精确匹配到图谱实体，你是想问这些吗：" +
        fuzzy.map(n => "<b>" + esc(n.name) + "</b>（" + esc(n.domain) + "）").join("、");
    }
    steps.push({ title: "检索失败", detail: "分词结果未命中任何图谱节点" });
    return "抱歉，我的知识图谱里暂时没有找到相关概念。可以试试问具体的学科概念，例如「量子力学是什么」「牛顿和微积分有什么关系」。";
  }

  /** 渲染右侧推理详情面板 */
  function renderReasoningPanel(result) {
    // 1. 推理步骤
    const stepsEl = document.getElementById("reasoning-steps");
    stepsEl.innerHTML = result.steps.map((s, i) =>
      '<div class="step"><div class="step-num">' + (i + 1) + '</div>' +
      '<div class="step-body"><div class="step-title">' + esc(s.title) + "</div>" +
      '<div class="step-detail">' + esc(s.detail) + "</div></div></div>"
    ).join("");

    // 2. 语义分析
    const sem = result.sem;
    const semEl = document.getElementById("semantic-detail");
    let html = '<div class="sem-section"><h4>分词结果</h4><div class="token-list">' +
      sem.tokens.map(t =>
        '<span class="token' + (t.inGraph ? " hit" : "") + (t.isSynonym ? " syn" : "") + '">' +
        esc(t.word) + (t.isSynonym ? " → " + esc(t.canonical) : "") + "</span>"
      ).join("") + "</div></div>";
    html += '<div class="sem-section"><h4>意图识别</h4><div class="intent-badge">' +
      esc(sem.intent.label) + "</div>" +
      (sem.intent.slots.length ? '<div class="sem-line">槽位：' + sem.intent.slots.map(esc).join(" | ") + "</div>" : "") +
      "</div>";
    if (sem.entities.length) {
      html += '<div class="sem-section"><h4>实体链接与消歧</h4>' + sem.entities.map(e => {
        let s = '<div class="sem-line">「' + esc(e.matchedWord) + "」→ <b>" + esc(e.node.name) +
          "</b>（" + esc(e.node.domain) + "）";
        if (e.disambiguation && e.disambiguation.candidates.length > 1) {
          s += "<br><span class='dim'>消歧：" + esc(e.disambiguation.reason) + "</span>";
        }
        if (e.synonyms && e.synonyms.length) {
          s += "<br><span class='dim'>同义词：" + e.synonyms.map(esc).join("、") + "</span>";
        }
        return s + "</div>";
      }).join("") + "</div>";
    }
    semEl.innerHTML = html;

    // 3. 图谱可视化
    if (result.centers.length > 0) {
      const sub = engine.subgraph(result.centers.concat(result.pathIds), result.pathIds.length > 2 ? 1 : 2, 36);
      viz.load(sub, result.pathIds);
    }
    switchTab("steps");
  }

  document.addEventListener("DOMContentLoaded", init);
  window.__APP__ = { get graph() { return graph; }, get engine() { return engine; }, get analyzer() { return analyzer; } };
})();
