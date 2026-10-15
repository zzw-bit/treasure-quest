/* ============================================================
 * scene.js —— 渲染层（全 Canvas 绘制，不依赖任何图片素材）
 *
 * 结构：
 *   Fx      背景星空 / 金尘 / 漂浮符文（独立画布）
 *   Stage   主舞台：地形、路径、站点、手绘探险家、守卫、镜头、粒子、特效
 *   Loop    单一 rAF 驱动两个画布
 *
 * 探险家是分段绘制的小人：躯干 + 头 + 双臂 + 双腿 + 火把，
 * 走路时四肢按正弦摆动，有上下起伏、影子收缩、朝向翻转；
 * 站点之间把贝塞尔曲线采样成点列，人是踩着路径走的。
 * ============================================================ */

/* ------------------------------------------------------------
 * 0. 通用工具
 * ---------------------------------------------------------- */
const REDUCED = typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const MOTION = REDUCED ? 0.35 : 1;   // 动效强度总开关（无障碍）

function resizeCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function hexA(hex, a) {
  if (!hex) return `rgba(255,255,255,${a})`;
  let h = String(hex).replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* 三次贝塞尔取点 */
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  };
}

/* ------------------------------------------------------------
 * 1. 场景配色 —— 随剧情推进整体换色（带交叉淡入）
 * ---------------------------------------------------------- */
const MOODS = {
  start:   { top: "#0b1233", bot: "#131d47", ridge: "#1c2a5e", ground: "#0a1030", accent: "#7fd7ff" },
  library: { top: "#2a1e14", bot: "#3a2a1a", ridge: "#4a3520", ground: "#1c1408", accent: "#ffc94a" },
  ruin:    { top: "#1a1830", bot: "#272344", ridge: "#332f56", ground: "#12101f", accent: "#a78bfa" },
  temple:  { top: "#3a1418", bot: "#4d1c20", ridge: "#5e2429", ground: "#1e0a0c", accent: "#ff7a85" },
  crown:   { top: "#3a2a08", bot: "#5c440f", ridge: "#7a5c16", ground: "#201704", accent: "#ffc94a" }
};

/* ------------------------------------------------------------
 * 2. 背景层
 * ---------------------------------------------------------- */
/* 全局暂停开关 —— Fx 与 Stage 共用，保证两层同时冻住 */
const Motion = { frozen: false };

const Fx = (() => {
  const canvas = document.getElementById("fx");
  let ctx, W, H;
  let stars = [], dust = [], runes = [];
  /* 自己的时间轴：暂停时不再累加，星光闪烁因此也会停住 */
  let tAcc = 0;

  function init() {
    const r = resizeCanvas(canvas);
    ctx = r.ctx; W = r.w; H = r.h;

    stars = Array.from({ length: 190 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.5 + 0.3,
      a: Math.random() * 0.6 + 0.2,
      sp: Math.random() * 0.018 + 0.004,
      ph: Math.random() * Math.PI * 2
    }));

    dust = Array.from({ length: 54 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.24,
      vy: -Math.random() * 0.16 - 0.04,
      r: Math.random() * 2 + 0.6,
      a: Math.random() * 0.3 + 0.1
    }));

    /* 漂浮的古老符文，呼应寻宝主题 */
    const GLYPHS = ["✦", "✧", "○", "△", "◇", "＋", "×"];
    runes = Array.from({ length: 14 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      s: Math.random() * 9 + 7,
      a: Math.random() * 0.10 + 0.03,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.003,
      vy: -Math.random() * 0.12 - 0.02,
      g: GLYPHS[(Math.random() * GLYPHS.length) | 0]
    }));
  }

  function frame(tRaw) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    /* 冻结时把时间轴钉住：星光不再闪、符文与金尘不再飘 */
    if (!Motion.frozen) tAcc += 0.016;
    const t = Motion.frozen ? tAcc : tRaw;
    const m = Motion.frozen ? 0 : MOTION;

    for (const s of stars) {
      const a = s.a + Math.sin(t * s.sp + s.ph) * 0.3;
      ctx.beginPath();
      ctx.fillStyle = `rgba(200, 222, 255, ${Math.max(0.05, a)})`;
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const r of runes) {
      r.y += r.vy * m;
      r.rot += r.vr * m;
      if (r.y < -20) { r.y = H + 20; r.x = Math.random() * W; }
      ctx.save();
      ctx.globalAlpha = r.a;
      ctx.fillStyle = "#cfe0ff";
      ctx.font = "13px sans-serif";
      ctx.translate(r.x, r.y);
      ctx.rotate(r.rot);
      ctx.fillText(r.g, 0, 0);
      ctx.restore();
    }

    for (const d of dust) {
      d.x += d.vx * m; d.y += d.vy * m;
      if (d.x < 0) d.x = W; if (d.x > W) d.x = 0;
      if (d.y < 0) d.y = H; if (d.y > H) d.y = 0;
      ctx.beginPath();
      ctx.fillStyle = `rgba(255, 205, 110, ${d.a})`;
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return { init, frame };
})();

/* ------------------------------------------------------------
 * 3. 主舞台
 * ---------------------------------------------------------- */
const Stage = (() => {
  const canvas = document.getElementById("scene");
  let ctx, W, H;

  const NODES = [
    { id: "start",  name: "出发",      color: "#93a4cc", mood: "start" },
    { id: "clue",   name: "古老图书馆", color: "#ffc94a", mood: "library" },
    { id: "script", name: "解读文字",   color: "#a5e88a", mood: "library" },
    { id: "key",    name: "神庙废墟",   color: "#ffc94a", mood: "ruin" },
    { id: "map",    name: "观星台",     color: "#52e0ff", mood: "ruin" },
    { id: "chest",  name: "神庙地宫",   color: "#a78bfa", mood: "temple" },
    { id: "crown",  name: "宝藏",      color: "#ff9d24", mood: "crown" }
  ];

  let nodes = [];
  let pathPts = [];          // 采样后的路径点列
  let segStart = [];         // 每个站点在 pathPts 中的起始下标
  let cur = 0, target = 0;
  let walker = { x: 0, y: 0 };
  let facing = 1;
  let walkPhase = 0;
  let moving = false;
  let totalT = 0;

  let guard = null;
  let progress = null;
  let burst = [];
  let sparks = [];
  let floats = [];
  let cracks = [];
  let flash = 0, flashColor = "#ffffff";
  let treasureRise = null;
  let trail = [];
  let nudgeX = 0, nudgeY = 0;

  /* 镜头 */
  const cam = { x: 0, y: 0, zoom: 1, tx: 0, ty: 0, tzoom: 1, shake: 0, _from: null, _t: 0, _dur: 800 };

  /* 场景配色交叉淡入 */
  let moodNow = MOODS.start, moodPrev = MOODS.start, moodMix = 1;

  /* ---- 初始化（重置到出发站）---- */
  function init() {
    const r = resizeCanvas(canvas);
    ctx = r.ctx; W = r.w; H = r.h;
    layout();
    walker = { x: nodes[0].x, y: nodes[0].y };
    trail = [{ x: walker.x, y: walker.y }];
    cur = target = 0;
    nudgeX = nudgeY = 0;
    cam.x = cam.tx = W / 2;
    cam.y = cam.ty = H / 2;
    cam.zoom = cam.tzoom = 1;
    cam._from = null;
  }

  /* ---- 尺寸变化后的重新布局 ----
     与 init() 的区别：**保留当前进度**。
     早期版本 resize 时直接调 init()，结果是"窗口一变，探险家秒回第一站、
     走过的站点全部变回未完成" —— 换窗口大小 / 平板转屏时特别明显。
     这里只重算几何位置，把 cur/target/done/walker 按站点索引原样搬过去。 */
  function reflow() {
    if (!W) { init(); return; }
    const r = resizeCanvas(canvas);
    ctx = r.ctx;

    /* 记下重排前"走到哪儿了"，用站点浮点索引而不是像素坐标 */
    const keepCur = cur, keepTarget = target;
    const keepDone = nodes.map((n) => !!n.done);
    const keepMood = moodNow, keepMix = moodMix, keepPrev = moodPrev;

    W = r.w; H = r.h;
    layout();                                   // 重建 nodes / pathPts（位置变了）

    nodes.forEach((n, i) => { n.done = keepDone[i] || false; });
    cur = keepCur; target = keepTarget;

    /* 探险家按新坐标重新落到同一站点上 */
    const p = pointAt(cur);
    walker = { x: p.x, y: p.y };
    trail = [{ x: walker.x, y: walker.y }];
    nudgeX = nudgeY = 0;

    /* 配色状态原样保留（重排不该让场景"闪一下"） */
    moodNow = keepMood; moodMix = keepMix; moodPrev = keepPrev;

    /* 镜头跟随：如果当前有镜头目标，按比例换算到新坐标系 */
    cam.x = cam.tx = W / 2;
    cam.y = cam.ty = H / 2;
    cam._from = null;
  }

  function layout() {
    nodes = NODES.map((n, i) => {
      const px = (i + 0.5) / NODES.length;
      const x = 60 + px * (W - 120);
      const wave = Math.sin((i / (NODES.length - 1)) * Math.PI * 1.5 + 0.3) * 0.16;
      const stagger = (i % 2 === 0 ? 0.085 : -0.045);
      const y = H * (0.34 + wave + stagger);
      return { ...n, x, y: Math.max(80, Math.min(H - 104, y)), index: i };
    });
    buildPath();
  }

  /* 把贝塞尔曲线采样成点列 —— 探险家沿这条线走，与画出的虚线完全重合 */
  function buildPath() {
    pathPts = [{ x: nodes[0].x, y: nodes[0].y }];
    segStart = [0];
    const STEPS = 34;
    for (let i = 1; i < nodes.length; i++) {
      const p = nodes[i - 1], q = nodes[i];
      const mx = (p.x + q.x) / 2;
      const c1 = { x: mx, y: p.y };
      const c2 = { x: mx, y: q.y };
      segStart.push(pathPts.length - 1);
      for (let s = 1; s <= STEPS; s++) {
        const pt = bezier(p, c1, c2, q, s / STEPS);
        pathPts.push({ x: pt.x, y: pt.y });
      }
    }
  }

  /** 按"站点浮点索引"取路径坐标：cur=2.5 表示第 2→3 站走了半程 */
  function pointAt(idx) {
    const fi = Math.max(0, Math.min(nodes.length - 1 - 1e-6, idx));
    const i0 = Math.floor(fi), i1 = Math.min(nodes.length - 1, i0 + 1);
    const f = fi - i0;
    const a = segStart[i0];
    const b = segStart[i1] == null ? pathPts.length - 1 : segStart[i1];
    const pos = a + (b - a) * f;
    const j0 = Math.floor(pos), j1 = Math.min(pathPts.length - 1, j0 + 1);
    const k = pos - j0;
    const p0 = pathPts[j0] || pathPts[0], p1 = pathPts[j1] || p0;
    return { x: lerp(p0.x, p1.x, k), y: lerp(p0.y, p1.y, k) };
  }

  /* ---- 对外接口 ---- */
  function goTo(id) {
    const i = nodes.findIndex((n) => n.id === id);
    if (i < 0) return;
    for (let k = 0; k < i; k++) nodes[k].done = true;
    if (target < i) target = i;
    progress = null;
    if (nodes[i].mood) setMood(nodes[i].mood);
  }

  function win() {
    target = nodes.length - 1;
    nodes.forEach((n) => { n.done = true; });
    setMood("crown");
    const n = nodes[nodes.length - 1];
    camTo(n.x, n.y - 10, 1.30, 900);
  }

  function setMood(name) {
    const m = MOODS[name];
    if (!m || m === moodNow) return;
    moodPrev = moodNow;
    moodNow = m;
    moodMix = 0;
  }

  /** 镜头缓动到 (x, y) 并缩放 */
  function camTo(x, y, zoom, ms) {
    cam._from = { x: cam.x, y: cam.y, zoom: cam.zoom };
    cam.tx = x; cam.ty = y;
    cam.tzoom = zoom == null ? 1 : zoom;
    cam._dur = ms || 800;
    cam._t = 0;
  }
  function camReset() { camTo(W / 2, H / 2, 1, 700); }

  function setProgress(p) { progress = p == null ? null : { value: Math.max(0, Math.min(1, p)) }; }
  function doShake(v) { cam.shake = Math.max(cam.shake, v); }

  function screenFlash(color, power) {
    flashColor = color || "#ffffff";
    flash = power == null ? 1 : power;
  }

  function guardOn() {
    const last = nodes[nodes.length - 1];
    const p = nodes[nodes.length - 2];
    guard = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 - 8, t: 0, alpha: 1 };
    camTo(guard.x, guard.y, 1.18, 700);
  }
  function guardOff() {
    if (guard) guard.fading = true;
    camTo(walker.x, walker.y, 1, 700);
  }

  function spawnBurst(x, y, count, color, style) {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = (Math.random() * 3.4 + 0.9) * MOTION;
      burst.push({
        x, y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 1.3 * MOTION,
        life: 1,
        decay: 1 / (700 + Math.random() * 500),
        color,
        r: Math.random() * 2.6 + 1,
        style: style || "dot",
        rot: Math.random() * Math.PI
      });
    }
  }

  function burstAt(nodeId, count, color) {
    const n = nodes.find((v) => v.id === nodeId) || nodes[target] || nodes[0];
    if (!n) return;
    spawnBurst(n.x, n.y, count || 22, color || n.color, "dot");
  }

  /** 每个道具的专属特效 */
  function itemFx(key, nodeId) {
    const n = nodes.find((v) => v.id === nodeId) || nodes[target] || nodes[0];
    if (!n) return;
    switch (key) {
      case "gem":
        spawnBurst(n.x, n.y, 26, "#7fd7ff", "spark");
        spawnBurst(n.x, n.y, 16, "#a5e88a", "dot");
        addFloat(n.x, n.y - 42, "✦ 守护宝石", "#a5e88a");
        break;
      case "clue":
        spawnBurst(n.x, n.y, 20, "#ffc94a", "ring");
        spawnBurst(n.x, n.y, 14, "#ffd977", "dot");
        addFloat(n.x, n.y - 42, "线索 +1", "#ffc94a");
        break;
      case "script":
      case "scholar":
        spawnBurst(n.x, n.y, 24, "#a5e88a", "spark");
        addFloat(n.x, n.y - 42, key === "scholar" ? "学者口述" : "古老文字", "#a5e88a");
        break;
      case "key":
      case "backupKey":
        spawnBurst(n.x, n.y, 22, "#ffc94a", "key");
        spawnBurst(n.x, n.y, 12, "#ffd977", "spark");
        addFloat(n.x, n.y - 42, key === "backupKey" ? "备用钥匙" : "铜钥匙", "#ffc94a");
        break;
      case "map":
        spawnBurst(n.x, n.y, 30, "#52e0ff", "ring");
        spawnBurst(n.x, n.y, 18, "#7fd7ff", "spark");
        addFloat(n.x, n.y - 42, "星象图读毕", "#52e0ff");
        break;
      case "chest":
        spawnBurst(n.x, n.y, 26, "#a78bfa", "box");
        spawnBurst(n.x, n.y, 16, "#c9b6ff", "dot");
        addFloat(n.x, n.y - 42, "发现宝箱", "#a78bfa");
        break;
      case "crown":
        spawnBurst(n.x, n.y, 80, "#ffc94a", "spark");
        spawnBurst(n.x, n.y, 40, "#ff9d24", "ring");
        break;
      default:
        spawnBurst(n.x, n.y, 20, "#8fb6ff", "dot");
    }
  }

  /** 宝藏从箱中升起 */
  function raiseTreasure(tier) {
    const n = nodes[nodes.length - 1];
    treasureRise = {
      x: n.x, y: n.y, t: 0,
      icon: tier === "legendary" ? "crown" : "trophy",
      color: tier === "legendary" ? "#ffc94a" : tier === "rare" ? "#52e0ff" : "#a78bfa"
    };
  }

  function addFloat(x, y, text, color) {
    floats.push({ x, y, text, color, life: 1, vy: -0.5 * MOTION });
  }

  /** 陷阱：屏幕裂纹 + 碎片 + 红闪 */
  function crack(atNodeId, count) {
    const n = nodes.find((v) => v.id === atNodeId) || nodes[target] || nodes[0];
    for (let i = 0; i < (count || 7); i++) {
      const ang = Math.random() * Math.PI * 2;
      const pts = [{ x: n.x, y: n.y }];
      let x = n.x, y = n.y;
      const segs = 4 + ((Math.random() * 3) | 0);
      for (let s = 0; s < segs; s++) {
        const a = ang + (Math.random() - 0.5) * 0.9;
        const len = 18 + Math.random() * 42;
        x += Math.cos(a) * len;
        y += Math.sin(a) * len;
        pts.push({ x, y });
      }
      cracks.push({ pts, life: 1 });
    }
    spawnBurst(n.x, n.y, 34, "#ff6b7a", "shard");
    screenFlash("#ff2d4d", 0.55);
    doShake(20);
  }

  function nudge(dx, dy) {
    nudgeX = Math.max(-70, Math.min(70, nudgeX + dx));
    nudgeY = Math.max(-46, Math.min(46, nudgeY + dy));
    spawnBurst(walker.x + nudgeX, walker.y + nudgeY, 4, "#8fb6ff", "dot");
  }

  function reset() {
    nodes.forEach((n) => { n.done = false; n.pulse = 0; });
    cur = target = 0;
    walker = { x: nodes[0].x, y: nodes[0].y };
    trail = [{ x: walker.x, y: walker.y }];
    guard = null; progress = null; burst = []; sparks = []; floats = [];
    cracks = []; flash = 0; treasureRise = null;
    cam.shake = 0;
    nudgeX = nudgeY = 0;
    walkPhase = 0;
    moodNow = moodPrev = MOODS.start; moodMix = 1;
    camTo(W / 2, H / 2, 1, 400);
  }

  /* ---- 绘制辅助 ---- */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function blendHex(a, b, t) {
    const pa = parseInt(String(a).slice(1), 16), pb = parseInt(String(b).slice(1), 16);
    const r = Math.round(lerp((pa >> 16) & 255, (pb >> 16) & 255, t));
    const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t));
    const bl = Math.round(lerp(pa & 255, pb & 255, t));
    return `rgb(${r},${g},${bl})`;
  }
  function mood(k) {
    const t = easeInOut(Math.min(1, moodMix));
    return blendHex(moodPrev[k] || moodNow[k], moodNow[k], t);
  }

  /* ---- 主绘制 ----
     暂停时"照常重绘、但把时间增量按 0 处理"：
       · 角色停在原地不动、粒子定住、镜头缓动停摆 —— 看着就是按下暂停了
       · 但仍然每帧重绘一次，所以窗口 resize 后画面不会糊掉或残留
     比"干脆不画"更稳妥，也不需要额外的恢复逻辑。
     冻结标志取自共享的 Motion，与背景层用同一个开关。 */
  function draw(dtRaw) {
    if (!ctx || !W) return;
    const dt = Motion.frozen ? 0 : dtRaw;   // 冻结时时间不再前进
    const dts = dt / 1000;
    totalT += dts;

    if (moodMix < 1) moodMix = Math.min(1, moodMix + dts / 1.1);

    /* 镜头缓动 */
    if (cam._from) {
      cam._t += dt;
      const t = Math.min(1, cam._t / (cam._dur || 800));
      const e = easeInOut(t);
      cam.x = lerp(cam._from.x, cam.tx, e);
      cam.y = lerp(cam._from.y, cam.ty, e);
      cam.zoom = lerp(cam._from.zoom, cam.tzoom, e);
      if (t >= 1) cam._from = null;
    }

    /* 震屏 */
    let sx = 0, sy = 0;
    if (cam.shake > 0.05) {
      sx = (Math.random() - 0.5) * cam.shake;
      sy = (Math.random() - 0.5) * cam.shake;
      cam.shake *= Math.pow(0.90, dt / 16.7);
    } else cam.shake = 0;

    ctx.clearRect(0, 0, W, H);

    /* ---- 镜头变换 ---- */
    ctx.save();
    ctx.translate(W / 2 + sx, H / 2 + sy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    drawSky();
    drawGround();
    drawPath();
    drawTrail();

    /* ---- 推进游标（帧率无关） ---- */
    if (Math.abs(target - cur) > 0.003) {
      moving = true;
      const speed = 0.0009;                     // 每秒推进的"站点"比例
      const step = speed * dt * Math.max(0.6, Math.min(1.6, Math.abs(target - cur)));
      if (cur < target) cur = Math.min(target, cur + step);
      else cur = Math.max(target, cur - step);
    } else {
      cur = target;
      moving = false;
    }

    /* 走路相位 */
    if (moving) { walkPhase += dts * 11 * MOTION; }
    else { walkPhase += dts * 1.1 * MOTION; }

    /* 探险家位置（沿真实路径） */
    const pp = pointAt(cur);
    nudgeX *= Math.pow(0.94, dt / 16.7);
    nudgeY *= Math.pow(0.94, dt / 16.7);
    facing = pp.x >= walker.x - 0.4 ? 1 : -1;
    if (Math.abs(pp.x - walker.x) > 0.6) walker.x = lerp(walker.x, pp.x, Math.min(1, dt / 130));
    if (Math.abs(pp.y - walker.y) > 0.6) walker.y = lerp(walker.y, pp.y, Math.min(1, dt / 130));

    /* 足迹 */
    const lastT = trail[trail.length - 1];
    if (!lastT || Math.hypot(walker.x - lastT.x, walker.y - lastT.y) > 8) {
      trail.push({ x: walker.x, y: walker.y });
      if (trail.length > 460) trail.shift();
    }

    drawSparks(dt);
    drawNodes();
    if (guard) drawGuard(dt);
    drawProgress();
    drawWalker();
    if (treasureRise) drawTreasureRise(dt);
    drawParticles(dt);
    drawCracks(dt);
    drawFloats(dt);

    ctx.restore();

    /* ---- 屏幕特效（不受镜头影响） ---- */
    if (flash > 0) {
      ctx.fillStyle = hexA(flashColor, flash * 0.5);
      ctx.fillRect(0, 0, W, H);
      flash = Math.max(0, flash - dts / 0.5);
    }
    drawVignette();
  }

  function drawSky() {
    /* 天空渐变：只在尺寸或配色变化时重建（配色混合期间每帧都要新颜色，故按色值做键） */
    const key = `${mood("top")}|${mood("bot")}|${mood("ground")}|${W}x${H}`;
    if (!drawSky._k || drawSky._k !== key) {
      const g = ctx.createLinearGradient(0, -H, 0, H * 1.2);
      g.addColorStop(0, mood("top"));
      g.addColorStop(0.55, mood("bot"));
      g.addColorStop(1, mood("ground"));
      drawSky._k = key;
      drawSky._g = g;
    }
    ctx.fillStyle = drawSky._g;
    ctx.fillRect(-W, -H, W * 3, H * 3);
  }

  function drawGround() {
    const g = ctx.createLinearGradient(0, H * 0.55, 0, H * 1.1);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, hexA(moodNow.accent, 0.10));
    ctx.fillStyle = g;
    ctx.fillRect(-W, 0, W * 3, H * 1.2);

    ctx.strokeStyle = hexA(moodNow.accent, 0.05);
    ctx.lineWidth = 1;
    for (let x = -W; x < W * 2; x += 46) {
      ctx.beginPath(); ctx.moveTo(x, -H); ctx.lineTo(x, H * 2); ctx.stroke();
    }
    for (let y = -H; y < H * 2; y += 46) {
      ctx.beginPath(); ctx.moveTo(-W, y); ctx.lineTo(W * 2, y); ctx.stroke();
    }

    /* 远景山脊，两层视差 —— 路径只与视口和 cam.x 有关，缓存点列避免每帧重算正弦 */
    const layers = [[30, 0.82, 0.55], [20, 0.92, 0.85]];
    for (let li = 0; li < layers.length; li++) {
      const amp = layers[li][0], off = layers[li][1], alpha = layers[li][2];
      const shift = Math.round((cam.x * 0.0006) * 40) / 40;   // 量化到 1/40，减少缓存失效频率
      const ck = `${li}|${W}|${H}|${shift}`;
      if (drawGround["_k" + li] !== ck) {
        const pts = [];
        for (let x = -W; x <= W * 2; x += 12) {
          const y = H * off
            + Math.sin(x * 0.0055 + shift + 0.6) * amp
            + Math.sin(x * 0.016) * amp * 0.42;
          pts.push(x, y);
        }
        drawGround["_k" + li] = ck;
        drawGround["_p" + li] = pts;
      }
      const pts = drawGround["_p" + li];
      ctx.beginPath();
      ctx.moveTo(-W, H * 2);
      ctx.lineTo(-W, H);
      for (let k = 0; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
      ctx.lineTo(W * 2, H * 2);
      ctx.closePath();
      ctx.fillStyle = hexA(moodNow.ridge, alpha);
      ctx.fill();
    }
  }

  function drawPath() {
    if (pathPts.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pathPts[0].x, pathPts[0].y);
    for (let i = 1; i < pathPts.length; i++) ctx.lineTo(pathPts[i].x, pathPts[i].y);
    ctx.strokeStyle = hexA(moodNow.accent, 0.16);
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 11]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawTrail() {
    if (trail.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      const t = i / trail.length;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255, 201, 74, ${0.04 + t * 0.40})`;
      ctx.lineWidth = 1.2 + t * 2.6;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 路径流光：金色火花沿路径飘动 */
  function drawSparks(dt) {
    const MAX = REDUCED ? 8 : 26;
    /* 冻结时不再补充新火花，否则暂停期间会悄悄把粒子池灌满 */
    if (!Motion.frozen && sparks.length < MAX && pathPts.length) {
      const p = pathPts[(Math.random() * pathPts.length) | 0];
      sparks.push({ x: p.x, y: p.y, life: 1, ph: Math.random() * 6.28 });
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt / 2200;
      s.y -= 0.22 * MOTION;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      const a = Math.sin(s.life * 3 + s.ph) * 0.5 + 0.5;
      ctx.beginPath();
      ctx.fillStyle = `rgba(255, 214, 120, ${s.life * 0.5 * a})`;
      ctx.arc(s.x, s.y, 1.6 * s.life + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawNodes() {
    for (const n of nodes) {
      const passed = n.index < cur + 0.35;
      const isCur = Math.abs(n.index - cur) < 0.5;
      n.pulse = (n.pulse || 0) + 0.028;

      if (passed || isCur) {
        const pr = 30 + Math.sin(n.pulse) * 4;
        const rg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, pr * 1.85);
        rg.addColorStop(0, hexA(n.color, isCur ? 0.40 : 0.18));
        rg.addColorStop(1, hexA(n.color, 0));
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(n.x, n.y, pr * 1.85, 0, Math.PI * 2);
        ctx.fill();
      }

      /* 六边形站台：比纯圆更有"古迹"感 */
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 - Math.PI / 2;
        const x = n.x + Math.cos(a) * 25, y = n.y + Math.sin(a) * 25;
        if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = passed ? "rgba(16, 24, 54, 0.94)" : "rgba(12, 18, 42, 0.78)";
      ctx.fill();
      ctx.lineWidth = isCur ? 2.4 : 1.5;
      ctx.strokeStyle = passed ? hexA(n.color, 0.92) : hexA("#7aa2ff", 0.26);
      ctx.stroke();

      drawNodeGlyph(n, passed);

      ctx.font = '500 11.5px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = passed ? hexA(n.color, 0.95) : "rgba(147, 164, 204, 0.55)";
      ctx.fillText(n.name, n.x, n.y + 43);
    }
  }

  /** 每个站点一个手绘小图形（替代 emoji） */
  function drawNodeGlyph(n, passed) {
    ctx.save();
    ctx.globalAlpha = passed ? 1 : 0.30;
    ctx.strokeStyle = passed ? n.color : "#7a8db8";
    ctx.fillStyle = passed ? n.color : "#7a8db8";
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    switch (n.id) {
      case "start":
        ctx.beginPath(); ctx.moveTo(n.x, n.y + 9); ctx.lineTo(n.x, n.y - 10); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(n.x, n.y - 10); ctx.lineTo(n.x + 10, n.y - 6); ctx.lineTo(n.x, n.y - 2);
        ctx.closePath(); ctx.fill();
        break;
      case "clue":
        ctx.beginPath();
        ctx.moveTo(n.x - 9, n.y - 7); ctx.lineTo(n.x - 1, n.y - 9);
        ctx.lineTo(n.x - 1, n.y + 8); ctx.lineTo(n.x - 9, n.y + 6);
        ctx.closePath(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(n.x + 1, n.y - 9); ctx.lineTo(n.x + 9, n.y - 7);
        ctx.lineTo(n.x + 9, n.y + 6); ctx.lineTo(n.x + 1, n.y + 8);
        ctx.closePath(); ctx.stroke();
        break;
      case "script":
        ctx.beginPath(); ctx.moveTo(n.x - 8, n.y); ctx.lineTo(n.x + 8, n.y); ctx.stroke();
        ctx.beginPath(); ctx.arc(n.x - 8, n.y, 4, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(n.x + 8, n.y, 4, 0, Math.PI * 2); ctx.stroke();
        break;
      case "key":
        ctx.beginPath(); ctx.arc(n.x - 5, n.y, 5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(n.x, n.y); ctx.lineTo(n.x + 10, n.y);
        ctx.moveTo(n.x + 7, n.y); ctx.lineTo(n.x + 7, n.y + 5);
        ctx.moveTo(n.x + 10, n.y); ctx.lineTo(n.x + 10, n.y + 4);
        ctx.stroke();
        break;
      case "map":
        ctx.beginPath();
        for (let k = 0; k < 10; k++) {
          const ang = (k / 10) * Math.PI * 2 - Math.PI / 2;
          const rr = k % 2 ? 4.5 : 10;
          const x = n.x + Math.cos(ang) * rr, y = n.y + Math.sin(ang) * rr;
          if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.closePath(); ctx.fill();
        break;
      case "chest":
        ctx.beginPath();
        ctx.moveTo(n.x - 10, n.y + 8); ctx.lineTo(n.x - 10, n.y - 4);
        ctx.lineTo(n.x - 5, n.y - 9); ctx.lineTo(n.x + 5, n.y - 9);
        ctx.lineTo(n.x + 10, n.y - 4); ctx.lineTo(n.x + 10, n.y + 8);
        ctx.closePath(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(n.x - 3, n.y + 8); ctx.lineTo(n.x - 3, n.y);
        ctx.moveTo(n.x + 3, n.y + 8); ctx.lineTo(n.x + 3, n.y);
        ctx.stroke();
        break;
      case "crown":
        ctx.beginPath();
        ctx.moveTo(n.x - 10, n.y + 7); ctx.lineTo(n.x - 10, n.y - 5);
        ctx.lineTo(n.x - 4, n.y + 1); ctx.lineTo(n.x, n.y - 8);
        ctx.lineTo(n.x + 4, n.y + 1); ctx.lineTo(n.x + 10, n.y - 5);
        ctx.lineTo(n.x + 10, n.y + 7);
        ctx.closePath(); ctx.fill();
        break;
    }
    ctx.restore();
  }

  /* ---- 手绘探险家 ---- */
  function drawWalker() {
    const x = walker.x + nudgeX;
    const y = walker.y + nudgeY;

    const bob = moving
      ? Math.abs(Math.sin(walkPhase)) * 3.2 * MOTION
      : Math.sin(walkPhase * 0.9) * 1.1 * MOTION;
    const by = y - bob;
    const swing = moving ? Math.sin(walkPhase) * 0.85 * MOTION : Math.sin(walkPhase * 0.9) * 0.10;

    /* 地面影子（起伏时缩小） */
    ctx.beginPath();
    ctx.fillStyle = `rgba(0,0,0,${0.34 - bob * 0.02})`;
    ctx.ellipse(x, y + 19, 15 - bob * 0.5, 4.6 - bob * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();

    /* 脚下光晕 */
    const rg = ctx.createRadialGradient(x, by, 0, x, by, 38);
    rg.addColorStop(0, "rgba(255, 218, 130, 0.32)");
    rg.addColorStop(1, "rgba(255, 218, 130, 0)");
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(x, by, 38, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.translate(x, by);
    ctx.scale(facing, 1);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const skin = "#f0c9a0";
    const cloth = "#3a5599";
    const clothDark = "#2a3f73";
    const hipY = 4, chestY = -8, headY = -15;

    /* 双腿 */
    for (const side of [-1, 1]) {
      const ph = side === 1 ? swing : -swing;
      const kneeX = Math.sin(ph) * 5;
      const kneeY = hipY + 7;
      const footX = kneeX + Math.sin(ph) * 2.5;
      const footY = kneeY + 7;

      ctx.beginPath();
      ctx.strokeStyle = side === 1 ? cloth : clothDark;
      ctx.lineWidth = 3.6;
      ctx.moveTo(0, hipY);
      ctx.quadraticCurveTo(kneeX * 0.7, kneeY, footX, footY);
      ctx.stroke();

      ctx.beginPath();
      ctx.strokeStyle = "#4a3520";
      ctx.lineWidth = 3.4;
      ctx.moveTo(footX, footY - 1);
      ctx.lineTo(footX + 2.4, footY + 1.4);
      ctx.stroke();
    }

    /* 躯干 */
    ctx.beginPath();
    ctx.fillStyle = cloth;
    ctx.moveTo(-5.4, hipY);
    ctx.lineTo(-4.2, chestY);
    ctx.quadraticCurveTo(0, chestY - 3.4, 4.2, chestY);
    ctx.lineTo(5.4, hipY);
    ctx.closePath();
    ctx.fill();

    /* 腰带 */
    ctx.beginPath();
    ctx.strokeStyle = "#c8873a";
    ctx.lineWidth = 2.2;
    ctx.moveTo(-5.2, hipY - 1.5);
    ctx.lineTo(5.2, hipY - 1.5);
    ctx.stroke();

    /* 背包 */
    ctx.beginPath();
    ctx.fillStyle = "rgba(107, 74, 34, 0.95)";
    roundRect(-8.8, chestY + 1, 4.6, 8, 2);
    ctx.fill();

    /* 手臂（右手举火把） */
    for (const side of [1, -1]) {
      const ph = side === 1 ? swing : -swing;
      const shoulderX = side * 5;
      const shoulderY = chestY + 3;
      const lift = side === 1 ? -5 : 0;
      const elbowX = shoulderX + Math.sin(ph) * 4 + side * 2;
      const elbowY = shoulderY + 5 + lift * 0.5;
      const handX = elbowX + Math.sin(ph * 0.7) * 2 + side * 2;
      const handY = elbowY + 4.5 + lift;

      ctx.beginPath();
      ctx.strokeStyle = side === 1 ? "#46629f" : clothDark;
      ctx.lineWidth = 3;
      ctx.moveTo(shoulderX, shoulderY);
      ctx.quadraticCurveTo(elbowX, elbowY, handX, handY);
      ctx.stroke();

      ctx.beginPath();
      ctx.fillStyle = skin;
      ctx.arc(handX, handY, 1.9, 0, Math.PI * 2);
      ctx.fill();

      if (side === 1) {
        const flick = Math.sin(totalT * 11) * 0.9;
        ctx.beginPath();
        ctx.strokeStyle = "#6b4a22";
        ctx.lineWidth = 1.8;
        ctx.moveTo(handX, handY);
        ctx.lineTo(handX + 1.5, handY - 7);
        ctx.stroke();

        const flameY = handY - 8.5;
        const fg = ctx.createRadialGradient(handX + 1.5, flameY, 0, handX + 1.5, flameY, 6.5);
        fg.addColorStop(0, "rgba(255, 245, 190, 0.95)");
        fg.addColorStop(0.45, "rgba(255, 180, 60, 0.75)");
        fg.addColorStop(1, "rgba(255, 120, 20, 0)");
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.arc(handX + 1.5, flameY + flick, 6.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* 头 */
    ctx.beginPath();
    ctx.fillStyle = skin;
    ctx.arc(0, headY, 5.2, 0, Math.PI * 2);
    ctx.fill();

    /* 探险帽 */
    ctx.beginPath();
    ctx.fillStyle = "#7a5a2a";
    ctx.arc(0, headY - 1.6, 5.4, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#8d6a33";
    ctx.ellipse(0.6, headY - 1.4, 8, 2.3, 0, 0, Math.PI * 2);
    ctx.fill();

    /* 眼睛 */
    ctx.beginPath();
    ctx.fillStyle = "#2a2036";
    ctx.arc(2, headY + 0.4, 0.85, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    /* 站立时脚下涟漪 */
    if (!moving) {
      const n = nodes[Math.max(0, Math.min(nodes.length - 1, Math.round(cur)))];
      if (n) {
        const t = (totalT * 0.9) % 1;
        ctx.beginPath();
        ctx.strokeStyle = hexA(n.color, (1 - t) * 0.45);
        ctx.lineWidth = 1.6;
        ctx.arc(n.x, n.y, 26 + t * 22, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function drawTreasureRise(dt) {
    treasureRise.t += dt / 900;
    const p = easeOut(Math.min(1, treasureRise.t));
    const x = treasureRise.x;
    const y = treasureRise.y + 26 - p * 104;
    const a = p < 0.88 ? 1 : Math.max(0, (1 - p) / 0.12);

    ctx.save();
    ctx.globalAlpha = a;

    const cg = ctx.createLinearGradient(x, y, x, y + 110);
    cg.addColorStop(0, hexA(treasureRise.color, 0));
    cg.addColorStop(1, hexA(treasureRise.color, 0.3));
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y);
    ctx.lineTo(x + 24, y + 110); ctx.lineTo(x - 24, y + 110);
    ctx.closePath(); ctx.fill();

    const rot = totalT * 0.9;
    for (let i = 0; i < 8; i++) {
      const ang = rot + (i / 8) * Math.PI * 2;
      const len = 20 + Math.sin(totalT * 3 + i) * 5;
      ctx.beginPath();
      ctx.strokeStyle = hexA(treasureRise.color, 0.4 * a);
      ctx.lineWidth = 1.6;
      ctx.moveTo(x + Math.cos(ang) * 12, y + Math.sin(ang) * 12);
      ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      ctx.stroke();
    }

    const rg = ctx.createRadialGradient(x, y, 0, x, y, 30);
    rg.addColorStop(0, hexA(treasureRise.color, 0.85));
    rg.addColorStop(1, hexA(treasureRise.color, 0));
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(x, y, 30, 0, Math.PI * 2); ctx.fill();

    ctx.translate(x, y);
    ctx.rotate(Math.sin(totalT * 1.6) * 0.18);
    ctx.fillStyle = treasureRise.color;
    ctx.strokeStyle = "#fff6cf";
    ctx.lineWidth = 1.4;

    if (treasureRise.icon === "crown") {
      ctx.beginPath();
      ctx.moveTo(-14, 8); ctx.lineTo(-14, -7); ctx.lineTo(-6, 0);
      ctx.lineTo(0, -12); ctx.lineTo(6, 0); ctx.lineTo(14, -7); ctx.lineTo(14, 8);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(-12, 9); ctx.lineTo(-12, -4); ctx.lineTo(-5, -9);
      ctx.lineTo(5, -9); ctx.lineTo(12, -4); ctx.lineTo(12, 9);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-4, 9); ctx.lineTo(-4, -2);
      ctx.moveTo(4, 9); ctx.lineTo(4, -2);
      ctx.stroke();
    }
    ctx.restore();

    if (treasureRise.t >= 1) treasureRise = null;
  }

  function drawGuard(dt) {
    guard.t += dt / 1000;
    const tr = Math.sin(guard.t * 3) * 5 * MOTION;
    const a = guard.fading ? Math.max(0, guard.alpha - dt / 380) : guard.alpha;
    guard.alpha = a;
    if (a <= 0) { guard = null; return; }

    ctx.save();
    ctx.globalAlpha = a;

    const rg = ctx.createRadialGradient(guard.x, guard.y, 0, guard.x, guard.y, 50);
    rg.addColorStop(0, "rgba(255, 90, 110, 0.42)");
    rg.addColorStop(1, "rgba(255, 90, 110, 0)");
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(guard.x, guard.y, 50, 0, Math.PI * 2); ctx.fill();

    const x = guard.x, y = guard.y + tr;
    ctx.fillStyle = "#4a4f63";
    ctx.strokeStyle = "#8b93a8";
    ctx.lineWidth = 1.6;

    ctx.beginPath(); roundRect(x - 13, y - 12, 26, 28, 4); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 10, y - 12); ctx.lineTo(x, y - 24); ctx.lineTo(x + 10, y - 12);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    const glow = 0.6 + Math.sin(guard.t * 6) * 0.4;
    for (const dx of [-5, 5]) {
      ctx.beginPath();
      ctx.fillStyle = `rgba(255, 70, 90, ${glow})`;
      ctx.arc(x + dx, y - 3, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.strokeStyle = "#6b7288";
    ctx.lineWidth = 3;
    ctx.moveTo(x + 13, y + 2); ctx.lineTo(x + 24, y - 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.fillStyle = "#8b93a8";
    roundRect(x + 20, y - 18, 12, 12, 2);
    ctx.fill();

    ctx.font = '500 11px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ff8090";
    ctx.fillText("神庙守卫", x, y + 40);
    ctx.restore();
  }

  function drawProgress() {
    if (!progress) return;
    const n = nodes[nodes.length - 1];
    const w = 176, h = 7;
    const x = n.x - w / 2, y = n.y - 56;

    ctx.save();
    ctx.beginPath(); roundRect(x, y, w, h, 4);
    ctx.fillStyle = "rgba(255,255,255,0.13)"; ctx.fill();

    ctx.beginPath(); roundRect(x, y, Math.max(6, w * progress.value), h, 4);
    const g = ctx.createLinearGradient(x, y, x + w, y);
    g.addColorStop(0, "#52e0ff");
    g.addColorStop(1, "#a78bfa");
    ctx.fillStyle = g; ctx.fill();

    ctx.font = '500 10.5px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = "#b9c8ee";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`解读星象图 ${Math.round(progress.value * 100)}%`, n.x, y - 9);
    ctx.restore();
  }

  function drawParticles(dt) {
    for (let i = burst.length - 1; i >= 0; i--) {
      const p = burst[i];
      const k = dt / 16.7;
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.vy += 0.075 * k;
      p.vx *= Math.pow(0.985, k);
      p.life -= (p.decay || 1 / 900) * dt;
      p.rot += 0.1 * k;
      if (p.life <= 0) { burst.splice(i, 1); continue; }

      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life) * 0.88;
      ctx.fillStyle = p.color;

      switch (p.style) {
        case "spark":
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(p.x - p.r * 2.6, p.y); ctx.lineTo(p.x + p.r * 2.6, p.y);
          ctx.moveTo(p.x, p.y - p.r * 2.6); ctx.lineTo(p.x, p.y + p.r * 2.6);
          ctx.stroke();
          break;
        case "ring":
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 1.8 * p.life + 1, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case "shard":
          ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillRect(-p.r * 0.8, -p.r * 0.35, p.r * 1.8, p.r * 0.7);
          break;
        case "key":
          ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillRect(-3, -1.2, 5, 2.4);
          break;
        case "box":
          ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillRect(-p.r, -p.r, p.r * 2, p.r * 2);
          break;
        default:
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
          ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawCracks(dt) {
    for (let i = cracks.length - 1; i >= 0; i--) {
      const c = cracks[i];
      c.life -= dt / 1400;
      if (c.life <= 0) { cracks.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, c.life);
      ctx.strokeStyle = "#ff8090";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(c.pts[0].x, c.pts[0].y);
      for (let k = 1; k < c.pts.length; k++) ctx.lineTo(c.pts[k].x, c.pts[k].y);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawFloats(dt) {
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.life -= dt / 1600;
      f.y += f.vy * (dt / 16.7);
      if (f.life <= 0) { floats.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.6));
      ctx.font = '500 13px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(6, 10, 26, 0.85)";
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
      ctx.restore();
    }
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(
      W / 2, H / 2, Math.min(W, H) * 0.32,
      W / 2, H / 2, Math.max(W, H) * 0.78
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.42)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  return {
    init, layout, reflow, draw, goTo, win, guardOn, guardOff, burstAt, nudge, reset,
    setProgress, doShake, itemFx, raiseTreasure, crack, screenFlash,
    camTo, camReset, setMood,
    /* 暂停 / 继续：切共享开关即可，Fx 与 Stage 同时冻住 */
    setPaused(on) { Motion.frozen = !!on; },
    get paused() { return Motion.frozen; },
    get pos() { return { x: walker.x, y: walker.y }; },
    /* 粒子池大小（供测试断言"暂停时不再灌粒子"） */
    get sparkCount() { return sparks.length; }
  };
})();

/* ------------------------------------------------------------
 * 4. 单一动画循环
 * ---------------------------------------------------------- */
const Loop = (() => {
  let last = 0, running = false;
  /* 切到后台标签页时暂停绘制：省电、省 CPU，回来时重置时间基准避免"抽搐" */
  let awake = !document.hidden;
  /* 在途 rAF 的句柄。任何时刻最多只有一个：
     ① 恢复时先 cancel 掉可能残存的旧句柄，再排新的；
     ② tick 里用"当前句柄是否等于自己的句柄"判断这一帧是否已被取消。
     这样既不会两条链并行，也不会因旧回调在途而把链断掉。 */
  let rafId = 0;

  function tick(t) {
    if (!awake) { rafId = 0; return; }            // 后台静默
    if (!last) last = t;
    const dt = Math.min(64, t - last);            // 夹住 dt，防止切回来后一帧跳太远
    last = t;
    Fx.frame(t / 1000);
    Stage.draw(dt);
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(tick);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      awake = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }   // 停掉在途帧
    } else if (!awake) {
      awake = true;
      last = 0;                                   // 重置基准，避免 dt 突变
      if (running) {
        if (rafId) cancelAnimationFrame(rafId);   // 双保险：确保没有残留
        rafId = requestAnimationFrame(tick);      // 且只排一条新链
      }
    }
  });

  return { start };
})();

/* ------------------------------------------------------------
 * 5. 启动
 * ---------------------------------------------------------- */
Fx.init();
Stage.init();
Loop.start();

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    /* Fx 是纯背景，重建没有副作用；Stage 必须用 reflow 保住进度，
       否则"窗一变、人回起点"。 */
    Fx.init();
    Stage.reflow();
  }, 150);
});
