/* ============================================================
 * main.js —— 显示层 / 控制器
 *
 *   treasure.js  只管剧情和异步，用 Bus.emit 广播"发生了什么"
 *   main.js      订阅这些事件，负责把状态渲染成界面
 *   两者之间只有事件契约，没有直接引用。
 * ============================================================ */

/* ------------------------------------------------------------
 * 1. 全局状态
 * ---------------------------------------------------------- */
const State = {
  running: false,
  paused: false,
  mode: "async/await",
  difficulty: "normal",
  gold: 100,
  stamina: 3,
  hero: { hp: 100 },
  startTime: 0,
  pausedMs: 0,            // 累计暂停时长 —— 结算时要扣掉
  pauseAt: 0,             // 本次暂停的起点
  gateAt: null,           // 当前卡在哪道闸口（分关模式）
  gateCount: 0,           // 本局已通过几关
  items: {},
  flags: {},              // trapped / fought / usedScholar / usedBackupKey
  tier: null,
  legendaryCount: 0,
  logCount: 0,
  scaleIndex: 0
};

/* 成就 & 图鉴的持久化键 */
const STORE_KEY = "treasure-quest-v2";

const Store = (() => {
  let data = { bestGold: 0, bestTime: null, legendary: 0, plays: 0, gallery: [], achievements: [] };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) data = Object.assign(data, JSON.parse(raw));
  } catch (e) { /* 隐私模式等场景下静默降级为内存存储 */ }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {}
  }
  return {
    get: () => data,
    save,
    bump(fn) { fn(data); save(); },
    reset() {
      data = { bestGold: 0, bestTime: null, legendary: 0, plays: 0, gallery: [], achievements: [] };
      save();
    }
  };
})();

/* ------------------------------------------------------------
 * 2. DOM 引用
 * ---------------------------------------------------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const DOM = {
  console: $("#console"), logCount: $("#log-count"),
  bag: $("#bag"), bagCount: $("#bag-count"),
  achList: $("#ach-list"), achCount: $("#ach-count"),
  galList: $("#gal-list"), galCount: $("#gal-count"),
  gold: $("#hud-gold"), stamina: $("#hud-stamina"), time: $("#hud-time"), best: $("#hud-best"),
  caption: $("#caption"), capText: $("#caption .cap-text"), capIcon: $("#caption .cap-icon"),
  btnStart: $("#btn-start"), btnAgain: $("#btn-again"), btnPause: $("#btn-pause"),
  btnNext: $("#btn-next"),
  btnSkip: $("#btn-skip"), btnSound: $("#btn-sound"),
  chkMode: $("#chk-mode"), chkStep: $("#chk-step"),
  modal: $("#modal"), modalIcon: $("#modal-icon"), modalTitle: $("#modal-title"),
  modalDesc: $("#modal-desc"), modalStats: $("#modal-stats"), modalAch: $("#modal-ach"),
  btnModalClose: $("#btn-modal-close"),
  toastWrap: $("#toast-wrap")
};

/* 背包槽位定义（含分支路线道具，共 9 格） */
const SLOTS = ["clue", "script", "scholar", "key", "backupKey", "map", "chest", "gem", "crown"];
const SLOT_ICONS = { clue: "🧭", script: "📜", scholar: "🧙", key: "🗝️", backupKey: "🔑",
                     map: "🗺️", chest: "🎁", gem: "💎", crown: "👑" };

/* 可被"剧情自动调用"的消耗型道具。
   真正的用武之地在寻宝过程中（见 treasure.js 里的 askAid）：
     · gem   —— 陷阱里金币不够时抵账脱困（抵 25 金币 + 换回 1 点体力）
     · chest —— 守卫战血线告急时回 45 点生命值
     · map   —— 开箱前对照星象图，把陷阱率压到 0
   下面这些 apply() 只是"非寻宝态手动点击"的兜底效果。
   effect 文案要与剧情里的真实效果对得上 —— 以前宝箱写"体力 +1"，
   但战斗里实际回的是 45 点生命值，两个"体力"含义不同，玩家会对不上账。
   现在统一说明两套口径。 */
const USABLE = {
  gem:   { label: "变卖守护宝石", cost: "消耗此道具",
           effect: "金币 +25（剧情里则用于抵账脱困）",
           apply() { State.gold += 25; } },
  chest: { label: "撬开随身宝箱", cost: "消耗此道具",
           effect: "体力 +1（剧情里则回 45 点生命值）",
           apply() { State.stamina += 1; } },
  map:   { label: "摊开星象图",   cost: "消耗此道具",
           effect: "金币 +10（剧情里则压掉陷阱）",
           apply() { State.gold += 10; } }
};

/* ------------------------------------------------------------
 * 3. 日志
 * ---------------------------------------------------------- */
function writeLog(text, kind = "info") {
  const now = new Date();
  const t = `${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  const line = document.createElement("div");
  line.className = `log-line k-${kind}`;
  line.innerHTML = `<span class="log-time">[${t}]</span><span class="log-text"></span>`;
  line.querySelector(".log-text").textContent = text;
  DOM.console.appendChild(line);
  DOM.console.scrollTop = DOM.console.scrollHeight;

  State.logCount++;
  DOM.logCount.textContent = `${State.logCount} 条`;
  while (DOM.console.children.length > 300) DOM.console.removeChild(DOM.console.firstChild);
}

/* ------------------------------------------------------------
 * 4. HUD
 * ---------------------------------------------------------- */
function syncHud(payload) {
  if (payload) {
    if (typeof payload.gold === "number") State.gold = payload.gold;
    if (typeof payload.stamina === "number") State.stamina = payload.stamina;
  }
  DOM.gold.textContent = State.gold;
  DOM.stamina.textContent = State.stamina;
  pulse(DOM.gold); pulse(DOM.stamina);
}

function pulse(el) {
  const box = el.closest(".hud-item");
  if (!box) return;
  box.classList.remove("pulse");
  void box.offsetWidth;
  box.classList.add("pulse");
}

function refreshBest() {
  const d = Store.get();
  DOM.best.textContent = d.bestGold ? d.bestGold : "—";
}

/* ------------------------------------------------------------
 * 5. 背包 / 成就 / 图鉴
 * ---------------------------------------------------------- */
function lightUpSlot(item) {
  const slot = DOM.bag.querySelector(`.bag-slot[data-key="${item.key}"]`);
  if (!slot || slot.classList.contains("filled")) return;
  slot.classList.remove("empty");
  slot.classList.add("filled", "pop");
  /* 可被剧情调用的道具，加上高亮样式 —— 让玩家一眼看出"这个有用" */
  if (USABLE[item.key]) slot.classList.add("usable");
  if (item.icon) slot.querySelector(".slot-icon").textContent = item.icon;
  setTimeout(() => slot.classList.remove("pop"), 700);

  const filled = DOM.bag.querySelectorAll(".bag-slot.filled").length;
  DOM.bagCount.textContent = `${filled} / ${SLOTS.length}`;

  /* 道具专属电影化特效：宝石/钥匙/地图/宝箱各有不同粒子与飘字 */
  Stage.itemFx(item.key, item.node || null);
}

function renderAchievements() {
  DOM.achList.innerHTML = "";
  Achievements.LIST.forEach((a) => {
    const li = document.createElement("li");
    const on = Achievements.has(a.id);
    li.className = "ach-item" + (on ? " on" : "");
    li.innerHTML = `<span class="ach-icon">${a.icon}</span>
      <span class="ach-body"><b>${a.name}</b><i>${a.desc}</i></span>
      <span class="ach-flag">${on ? "✅" : "🔒"}</span>`;
    DOM.achList.appendChild(li);
  });
  DOM.achCount.textContent = `${Achievements.count()} / ${Achievements.LIST.length}`;
}

const GALLERY = [
  { id: "common",    icon: "🥈", name: "普通宝藏", desc: "一小袋金币与一枚旧徽章" },
  { id: "rare",      icon: "🏆", name: "稀有宝藏", desc: "金币、宝石，以及下一张地图" },
  { id: "legendary", icon: "👑", name: "传说宝藏", desc: "传说中的星辰王冠" }
];

function renderGallery() {
  const d = Store.get();
  DOM.galList.innerHTML = "";
  GALLERY.forEach((g) => {
    const li = document.createElement("li");
    const on = (d.gallery || []).includes(g.id);
    li.className = "gal-item" + (on ? " on" : "");
    li.innerHTML = `<span class="gal-icon">${on ? g.icon : "❔"}</span>
      <span class="gal-body"><b>${on ? g.name : "未解锁"}</b><i>${on ? g.desc : "尚未寻得此等级宝藏"}</i></span>`;
    DOM.galList.appendChild(li);
  });
  DOM.galCount.textContent = `${(d.gallery || []).length} / ${GALLERY.length}`;

  /* 显示前统一格式化：
     · 金币取整（结算里算出来的是整数，但历史记录可能是旧版本写进去的小数）
     · 用时保留 1 位小数 —— 与结算弹窗的 `33.3s` 口径一致，
       否则这里会原样打印 `33.2738219s`，看着像没做完的中间值 */
  $("#rec-gold").textContent = d.bestGold ? `${Math.round(d.bestGold)} 枚` : "—";
  $("#rec-time").textContent = d.bestTime ? `${Number(d.bestTime).toFixed(1)}s` : "—";
  $("#rec-legend").textContent = d.legendary ? `${d.legendary} 次` : "—";
  $("#rec-plays").textContent = d.plays ? `${d.plays} 局` : "—";
}

/* ------------------------------------------------------------
 * 6. 成就飘条
 * ---------------------------------------------------------- */
function showToast(a) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="toast-icon">${a.icon}</span>
    <span class="toast-body"><b>成就解锁 · ${a.name}</b><i>${a.desc}</i></span>`;
  DOM.toastWrap.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 400); }, 2600);
}

/* ------------------------------------------------------------
 * 7. 订阅事件总线 —— 逻辑层的"广播"在这里变成"界面变化"
 * ---------------------------------------------------------- */
Bus.on(Bus.EVT.LOG,          (d) => writeLog(d.text, d.kind));
Bus.on(Bus.EVT.SFX,          (d) => Sfx.play(d.name));
Bus.on(Bus.EVT.HUD,          (d) => syncHud(d));
Bus.on(Bus.EVT.ITEM_FOUND,   (d) => lightUpSlot(d));
Bus.on(Bus.EVT.SHAKE,        (d) => Stage.doShake(d.power || 9));
Bus.on(Bus.EVT.GUARD_ON,     () => { Stage.guardOn(); });
Bus.on(Bus.EVT.GUARD_OFF,    () => { Stage.guardOff(); });
Bus.on(Bus.EVT.PROGRESS,     (d) => Stage.setProgress(d ? d.value : null));
Bus.on(Bus.EVT.NARRATE_BEAT, (d) => { Stage.goTo(d.id); Stage.burstAt(d.id, 14, "#8fb6ff"); });
Bus.on(Bus.EVT.PHASE,        (d) => { document.title = `寻宝奇缘 · ${d.name}`; });

/* 陷阱：屏幕裂纹 + 碎片 + 红闪（由 SHAKE 强度 >= 12 触发，只在踩陷阱时出现） */
Bus.on(Bus.EVT.SHAKE, (d) => {
  if ((d.power || 0) >= 12) Stage.crack("gem", 8);
});

Bus.on(Bus.EVT.NARRATE, (d) => {
  DOM.capText.textContent = d.detail ? `${d.text}  ${d.detail}` : d.text;
  DOM.caption.classList.remove("flash");
  void DOM.caption.offsetWidth;
  DOM.caption.classList.add("flash");
});

Bus.on(Bus.EVT.ACHIEVE, (a) => { showToast(a); renderAchievements(); });

/* 宝藏到手：镜头推近 + 宝藏升起 + 粒子雨 */
Bus.on(Bus.EVT.TREASURE_WIN, (t) => {
  State.tier = t.tier;
  Stage.win();
  Stage.raiseTreasure(t.tier);
  Stage.burstAt("crown", 90, t.tier === "legendary" ? "#ffc94a" : "#52e0ff");
  if (t.tier === "legendary") Stage.screenFlash("#ffc94a", 0.45);
  DOM.capIcon.textContent = t.icon || "👑";
  Sfx.play(t.tier === "legendary" ? "legendary" : "win");
});

/* 整轮结算：弹窗 + 记录落盘 */
Bus.on(Bus.EVT.RESULT, (r) => showResultModal(r));

/* ------------------------------------------------------------
 * 8. 结算弹窗
 * ---------------------------------------------------------- */
function showResultModal(r) {
  DOM.modalIcon.textContent = r.icon || (r.ok ? "👑" : "💀");
  DOM.modalTitle.textContent = r.title;
  DOM.modalDesc.innerHTML = r.desc || "";

  DOM.modalStats.innerHTML = "";
  const stats = r.ok
    ? [
        ["最终金币", `${r.gold}`],
        ["宝藏等级", `${r.icon} ${r.tierName}`],
        ["收集道具", `${r.items} / ${SLOTS.length}`],
        ["总耗时", `${r.used.toFixed(1)}s`],
        ["使用写法", r.mode],
        ["难度", (DIFFICULTY[r.difficulty] || {}).icon + " " + (DIFFICULTY[r.difficulty] || {}).name]
      ]
    : [["结局", "失败 💀"]];

  stats.forEach(([k, v]) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${k}</span><b>${v}</b>`;
    DOM.modalStats.appendChild(li);
  });

  /* 结算弹窗只显示本局新解锁的成就，直接用逻辑层发来的清单。 */
  DOM.modalAch.innerHTML = "";
  if (r.ok && r.achievements && r.achievements.length) {
    const wrap = document.createElement("div");
    wrap.className = "modal-ach-box";
    wrap.innerHTML = `<span class="mab-title">本轮新解锁成就</span>` +
      r.achievements.map((id) => {
        const a = Achievements.LIST.find((x) => x.id === id);
        return a ? `<span class="mab-item">${a.icon} ${a.name}</span>` : "";
      }).join("");
    DOM.modalAch.appendChild(wrap);
  }

  /* 记录落盘 */
  if (r.ok) {
    Store.bump((d) => {
      d.plays = (d.plays || 0) + 1;
      d.bestGold = Math.max(d.bestGold || 0, r.gold);
      d.bestTime = d.bestTime == null ? r.used : Math.min(d.bestTime, r.used);
      if (r.tier === "legendary") d.legendary = (d.legendary || 0) + 1;
      d.gallery = d.gallery || [];
      if (!d.gallery.includes(r.tier)) d.gallery.push(r.tier);
      d.achievements = [...new Set([...(d.achievements || []), ...(r.achievements || [])])];
    });
    refreshBest();
    renderGallery();
  }

  DOM.modal.classList.remove("hidden");
}

/* ------------------------------------------------------------
 * 9. 计时器
 * ---------------------------------------------------------- */
let timerId = null;

/* HUD 上的计时必须与"实际寻宝时长"一致 —— 暂停期间数字要停住，
   否则玩家一眼就能看出"我明明暂停了，计时还在跑"。 */
function elapsedSec() {
  const now = State.paused ? State.pauseAt : Date.now();
  return (now - State.startTime - State.pausedMs) / 1000;
}

function startTimer() {
  State.startTime = Date.now();
  State.pausedMs = 0;
  State.pauseAt = 0;
  clearInterval(timerId);
  timerId = setInterval(() => {
    if (!State.running) return;
    DOM.time.textContent = `${elapsedSec().toFixed(1)}s`;
  }, 100);
}
function stopTimer() { clearInterval(timerId); timerId = null; }

/* ------------------------------------------------------------
 * 10. 一局寻宝
 * ---------------------------------------------------------- */
async function runQuest() {
  if (State.running) return;

  Sfx.unlock();          // 用户手势里初始化音频（浏览器策略要求）
  Timers.cancelAll();    // 取消上一局残留的等待

  /* --- 重置 --- */
  State.running = true;
  State.gold = DIFFICULTY[State.difficulty].startGold;
  State.stamina = 3;
  State.hero = { hp: 100 };
  State.items = {};
  State.flags = {};
  State.tier = null;
  State.logCount = 0;
  State.paused = false;
  State.pausedMs = 0;
  State.pauseAt = 0;
  State.gateAt = null;
  State.gateCount = 0;
  Timers.setPaused(false);
  Timers.setStepMode(DOM.chkStep.checked);   // 同步分关开关
  if (Stage.setPaused) Stage.setPaused(false);
  Sfx.setEnabled(soundOn);
  DOM.btnNext.classList.add("hidden");
  DOM.btnNext.classList.remove("attract");

  DOM.console.innerHTML = "";
  DOM.logCount.textContent = "0 条";
  DOM.bagCount.textContent = `0 / ${SLOTS.length}`;
  DOM.time.textContent = "0.0s";
  DOM.bag.querySelectorAll(".bag-slot").forEach((s) => {
    s.classList.remove("filled", "pop", "usable", "used");
    s.classList.add("empty");
  });
  DOM.bag.querySelectorAll(".bag-slot").forEach((s) => {
    const icon = s.querySelector(".slot-icon");
    if (icon) icon.textContent = SLOT_ICONS[s.dataset.key] || "✨";
  });

  Stage.reset();
  Stage.layout();
  Stage.setMood("start");
  syncHud();
  DOM.capIcon.textContent = "🌌";

  DOM.btnStart.disabled = true;
  DOM.btnAgain.disabled = true;
  DOM.chkMode.disabled = true;
  DOM.chkStep.disabled = true;
  DOM.btnPause.disabled = false;
  DOM.btnPause.innerHTML = `<span class="btn-icon">⏸️</span> 暂停寻宝`;
  DOM.btnPause.classList.remove("active");
  document.body.classList.remove("quest-paused");
  DOM.modal.classList.add("hidden");

  startTimer();

  /* --- 调用异步主线（两条路，剧情一致） --- */
  let result;
  try {
    /* 分关模式下，剧情可能长时间停在闸口等玩家 —— 这不是卡死。
       给一个"已到站"的提示，玩家没点也不会被当成超时。 */
    result = State.mode === "Promise 链式"
      ? await findTreasureWithPromises()
      : await findTreasure();
  } catch (err) {
    writeLog(`未捕获的异常：${err.message || err}`, "err");
    Sfx.play("fail");
    Bus.emit(Bus.EVT.RESULT, {
      ok: false, title: "寻宝失败", icon: "💀",
      desc: `${err.message || err}`
    });
    result = { ok: false, error: err };
  }

  stopTimer();

  /* 万一是在暂停状态下收尾的（异常 / 外部中断），先解冻再拆场 */
  if (State.paused) {
    State.pausedMs += Date.now() - State.pauseAt;
    State.pauseAt = 0;
    State.paused = false;
    Timers.setPaused(false);
  }
  if (Stage.setPaused) Stage.setPaused(false);
  Sfx.setEnabled(soundOn);
  document.body.classList.remove("quest-paused");
  /* 清掉可能还挂着的闸门按钮 —— 免得结算后还留个「进入下一关」 */
  State.gateAt = null;
  DOM.btnNext.classList.add("hidden");
  DOM.btnNext.classList.remove("attract");

  DOM.btnStart.disabled = false;
  DOM.btnAgain.disabled = false;
  DOM.chkMode.disabled = false;
  DOM.chkStep.disabled = false;
  DOM.btnPause.disabled = true;
  DOM.btnPause.innerHTML = `<span class="btn-icon">⏸️</span> 暂停寻宝`;
  DOM.btnPause.classList.remove("active");
  State.running = false;
  document.title = "寻宝奇缘 · JavaScript 异步之寻宝";

  /* 只在成功时统计成就数（失败不刷成就列表） */
  if (result && result.ok) renderAchievements();

  return result;
}

/* ------------------------------------------------------------
 * 11. 交互绑定
 * ---------------------------------------------------------- */
DOM.btnStart.addEventListener("click", runQuest);
DOM.btnAgain.addEventListener("click", runQuest);

/* 难度切换 */
$$("#diff-group .diff-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (State.running) return;
    $$("#diff-group .diff-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    State.difficulty = btn.dataset.diff;
    State.gold = DIFFICULTY[State.difficulty].startGold;
    syncHud();
    Sfx.play("click");
    const d = DIFFICULTY[State.difficulty];
    writeLog(`难度切换为「${d.icon} ${d.name}」：守卫率 ${(d.guardFightRate * 100) | 0}%、` +
             `陷阱率 ${(d.trapRate * 100) | 0}%、复活费 ${d.reviveCost} 金币、初始金币 ${d.startGold}`,
             "warn");
  });
});

/* 倍速 */
const SCALES = [1, 2, 4];
DOM.btnSkip.addEventListener("click", () => {
  State.scaleIndex = (State.scaleIndex + 1) % SCALES.length;
  CONFIG.timeScale = SCALES[State.scaleIndex];
  DOM.btnSkip.innerHTML = `<span class="btn-icon">⏩</span> 倍速 ×${CONFIG.timeScale}`;
  Sfx.play("click");
  writeLog(`时间倍速 ×${CONFIG.timeScale}（对正在进行的等待立即生效）`, "warn");
});

/* ------------------------------------------------------------
 * 10.5 暂停 / 继续
 *
 * 暂停要停住的东西一共四样，少一样玩家就会觉得"没真停"：
 *   ① 剧情等待（Timers）—— 否则 await 还在走，剧情会自己往下跑
 *   ② 动画（Stage）    —— 否则画面还在动，看着像没暂停
 *   ③ HUD 计时         —— 否则秒数还在跳
 *   ④ 音效             —— 否则恢复前还在响
 * ---------------------------------------------------------- */
function setPaused(on) {
  if (!State.running) return;
  on = !!on;
  if (on === State.paused) return;      // 状态没变就不重复操作

  if (on) {
    State.pauseAt = Date.now();         // 记下暂停起点，用于扣除时长
  } else {
    State.pausedMs += Date.now() - State.pauseAt;
    State.pauseAt = 0;
  }
  State.paused = on;

  Timers.setPaused(on);                 // ① 冻结所有 await 中的等待
  if (Stage.setPaused) Stage.setPaused(on);   // ② 冻结动画
  Sfx.setEnabled(on ? false : soundOn); // ④ 暂停期间静音

  DOM.btnPause.innerHTML = on
    ? `<span class="btn-icon">▶️</span> 继续寻宝`
    : `<span class="btn-icon">⏸️</span> 暂停寻宝`;
  DOM.btnPause.classList.toggle("active", on);

  document.body.classList.toggle("quest-paused", on);
  DOM.capIcon.textContent = on ? "⏸️" : "🧭";

  writeLog(on ? "⏸️ 已暂停 —— 剧情、动画与计时都已冻结。" : "▶️ 已继续寻宝。", "warn");
  Sfx.play("click");
}

DOM.btnPause.addEventListener("click", () => setPaused(!State.paused));

/* ------------------------------------------------------------
 * 10.6 分关推进 —— 每站停下，等玩家点「进入下一关」
 *
 * 逻辑层在站点之间 await 一道"闸门"，这里只负责显示按钮、
 * 玩家点了就开闸。逻辑层完全不知道按钮长什么样。
 * ---------------------------------------------------------- */
function refreshGate(payload) {
  const waiting = payload && payload.action === "waiting";
  if (waiting) {
    State.gateAt = payload;
    DOM.btnNext.classList.remove("hidden");
    DOM.btnNext.innerHTML = `<span class="btn-icon">▶️</span> 进入下一关：${payload.label}`;
    DOM.btnNext.classList.add("attract");
    /* 到站时如果玩家正在暂停，先把暂停解开 —— 否则会"暂停未解除、
       又卡在闸口"的双重停止状态，看起来像卡死了。 */
    if (State.paused) setPaused(false);
    writeLog(`🚩 第 ${State.gateCount + 1} 关完成：${payload.label} —— 点「进入下一关」继续。`, "title");
    State.gateCount++;
    Sfx.play("achieve");
  } else {
    State.gateAt = null;
    DOM.btnNext.classList.add("hidden");
    DOM.btnNext.classList.remove("attract");
  }
}

Bus.on(Bus.EVT.GATE, refreshGate);

DOM.btnNext.addEventListener("click", () => {
  if (!Timers.isGated()) return;
  Sfx.play("click");
  writeLog("▶ 继续前进……", "warn");
  Timers.openGate();
});

/* 分关模式开关 */
DOM.chkStep.addEventListener("change", (e) => {
  const on = e.target.checked;
  Timers.setStepMode(on);
  writeLog(on
    ? "已开启「分关推进」—— 每完成一站会停下来等你确认。"
    : "已关闭「分关推进」—— 剧情会一口气跑完。", "warn");
  Sfx.play("click");
  /* 关掉时若正卡在闸口，立刻放行，避免卡死 */
  if (!on && Timers.isGated()) Timers.openGate();
});

/* 切到别的标签页时自动暂停（与动画层的后台停帧配合） */
document.addEventListener("visibilitychange", () => {
  if (document.hidden && State.running && !State.paused) setPaused(true);
});

/* 音效开关 */
let soundOn = true;
DOM.btnSound.addEventListener("click", () => {
  soundOn = !soundOn;
  Sfx.setEnabled(soundOn);
  DOM.btnSound.classList.toggle("off", !soundOn);
  DOM.btnSound.innerHTML = `<span class="btn-icon">${soundOn ? "🔊" : "🔇"}</span> 音效`;
  if (soundOn) Sfx.play("click");
});
DOM.btnSound.addEventListener("mouseenter", () => Sfx.play("click"));

/* async/await ↔ Promise 模式 */
function setMode(isPromise) {
  State.mode = isPromise ? "Promise 链式" : "async/await";
  DOM.chkMode.checked = isPromise;
  $$(".code-tab").forEach((t) => {
    const on = (t.dataset.tab === "promise") === isPromise && t.dataset.tab !== "bus";
    t.classList.toggle("active", on);
  });
  $("#code-await").classList.toggle("hidden", isPromise);
  $("#code-promise").classList.toggle("hidden", !isPromise);
  $("#code-bus").classList.add("hidden");
}
DOM.chkMode.addEventListener("change", (e) => setMode(e.target.checked));

/* 代码标签 */
$$(".code-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".code-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    $("#code-await").classList.toggle("hidden", which !== "await");
    $("#code-promise").classList.toggle("hidden", which !== "promise");
    $("#code-bus").classList.toggle("hidden", which !== "bus");
    if (which !== "bus") setMode(which === "promise");
  });
});

/* 左卡片标签页切换 */
$$(".card-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".card-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    ["bag", "ach", "gallery"].forEach((p) => {
      $(`#pane-${p}`).classList.toggle("hidden", p !== tab.dataset.pane);
    });
    Sfx.play("click");
  });
});

/* ------------------------------------------------------------
 * 9.5 道具"救命"供货方 —— 逻辑层求助时，显示层在这里作答
 *
 * 设计要点：逻辑层只说"我遇到麻烦了，有没有 X 可以用"，
 * 显示层负责判断背包里有没有、标出那个格子、再回报用没用。
 * 两边都不需要知道对方的内部结构。
 *
 * 关于"背包里到底有没有 X"这个问题，以前有两个数据源：
 *     · State.items         —— 逻辑层 gather() 写入的
 *     · .bag-slot.filled    —— 显示层 lightUpSlot() 写入的
 *   两边各写各的，恰好一直同步所以没出事，但只要有一边漏写
 *   （例如道具没有 key、或某条分支只发事件没 gather），
 *   就会出现"格子亮着但剧情说没货"或者反过来的错位。
 *   现在统一以 DOM 格子为准 —— 因为玩家看到的就是它，
 *   显示层怎么说，逻辑层就怎么认，从根上杜绝两套账。
 * ---------------------------------------------------------- */

/** 背包里是否真的有这个道具（以格子状态为准） */
function bagHas(key) {
  const slot = DOM.bag.querySelector(`.bag-slot[data-key="${key}"]`);
  return !!(slot && slot.classList.contains("filled"));
}

function consumeItem(key) {
  const slot = DOM.bag.querySelector(`.bag-slot[data-key="${key}"]`);
  if (!slot || !slot.classList.contains("filled")) return false;
  slot.classList.remove("filled", "usable", "pop");
  slot.classList.add("empty", "used");
  delete State.items[key];          // 同步内存账（供其它地方只读引用）
  DOM.bagCount.textContent = `${DOM.bag.querySelectorAll(".bag-slot.filled").length} / ${SLOTS.length}`;
  Sfx.play("item");
  return true;
}

/* 三个求助通道：宝箱续命 / 宝石抵账 / 星图勘察 */
const AID_CHANNELS = {
  "aid:chest": { item: "chest", label: "撬开随身宝箱补充体力" },
  "aid:gem":   { item: "gem",   label: "用守护宝石抵账脱困" },
  "aid:map":   { item: "map",   label: "对照星象图勘察宝箱" }
};

Object.entries(AID_CHANNELS).forEach(([channel, cfg]) => {
  Bus.provide(channel, (q) => {
    /* 只认格子状态，不认 State.items —— 见上方说明 */
    if (!bagHas(cfg.item)) return false;
    /* 有货才提示。用的是同步 confirm 之外的轻量方式：
       高亮背包格子 + 写日志，然后按"有就自动用"处理 ——
       游戏节奏快，不该被弹窗打断。
       注意顺序：先消耗（内部会清掉 filled/usable 并挂上 used），
       再补一个 pop 动画 —— 否则刚加的 pop 会被 consumeItem 一起抹掉，
       "我用掉了"这个反馈玩家完全看不到。 */
    writeLog(`💡 触发道具「${cfg.label}」—— 已自动替你使用。`, "warn");
    const ok = consumeItem(cfg.item);
    if (ok) {
      const slot = DOM.bag.querySelector(`.bag-slot[data-key="${cfg.item}"]`);
      if (slot) {
        slot.classList.add("pop");
        setTimeout(() => slot.classList.remove("pop"), 700);
      }
    }
    return ok;
  });
});

/* 「累计传说次数」的查询通道。
   逻辑层判定「三连传说」成就时需要这个值，但它只活在 localStorage 里
   （Store.legendary）—— 逻辑层不该知道 localStorage 的存在，所以走
   这条和道具求助同样的 provide/request 通道问一句。
   这样"累计次数"就只有一个真正的来源，不会出现两个计数器各算各的。 */
Bus.provide("stat:legendary", () => Store.get().legendary || 0);

/* 道具主动使用（事件委托）—— 仅在非寻宝态可用，作为"重开前热身" */
DOM.bag.addEventListener("click", (e) => {
  const slot = e.target.closest(".bag-slot");
  if (!slot || !slot.classList.contains("filled")) return;
  const key = slot.dataset.key;
  const use = USABLE[key];
  if (!use) return;
  if (State.running) { writeLog("寻宝进行中，道具会在需要时自动被剧情调用。", "warn"); return; }

  consumeItem(key);
  use.apply();
  syncHud();
  writeLog(`使用了「${use.label}」：${use.effect}`, "ok");
});

/* 清空记录 */
$("#btn-clear-record").addEventListener("click", () => {
  Store.reset();
  /* 存档和内存各有一份成就状态，要一起清。 */
  Achievements.clearAll();
  refreshBest();
  renderGallery();
  renderAchievements();
  writeLog("本地记录已清空（含成就进度）。", "warn");
  Sfx.play("click");
});

/* 弹窗关闭 */
DOM.btnModalClose.addEventListener("click", () => DOM.modal.classList.add("hidden"));
DOM.modal.addEventListener("click", (e) => { if (e.target === DOM.modal) DOM.modal.classList.add("hidden"); });

/* 键盘：空格开始/暂停/进入下一关 / ESC 关弹窗 / 方向键操控探险家 */
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement === document.body) {
    e.preventDefault();
    if (!State.running) {            // 空闲态：空格 = 开始
      DOM.modal.classList.add("hidden");
      runQuest();
    } else if (Timers.isGated()) {   // 卡在闸口：空格 = 进入下一关（比暂停优先）
      Sfx.play("click");
      Timers.openGate();
    } else {                         // 寻宝中：空格 = 暂停 / 继续
      setPaused(!State.paused);
    }
    return;
  }
  if (e.key === "Escape") { DOM.modal.classList.add("hidden"); return; }

  /* 探险家手动移动（在 Stage 里做偏移） */
  const step = 14;
  const drift = Stage.nudge || null;
  if (drift) {
    switch (e.key) {
      case "ArrowLeft": case "a": case "A": drift(-step, 0); break;
      case "ArrowRight": case "d": case "D": drift(step, 0); break;
      case "ArrowUp": case "w": case "W": drift(0, -step); break;
      case "ArrowDown": case "s": case "S": drift(0, step); break;
    }
  }
});

/* 首次交互解锁音频 */
["click", "keydown", "touchstart"].forEach((ev) =>
  window.addEventListener(ev, () => Sfx.unlock(), { once: true })
);

/* ------------------------------------------------------------
 * 12. 首屏渲染
 * ---------------------------------------------------------- */
/* 先用水落石出的历史记录充上成就，再渲染 ——
   否则刷新页面后，localStorage 里明明有成就，面板却是 0/10 全锁。 */
Achievements.hydrate(Store.get().achievements);
/* 累计传说次数同理：从存档恢复进内存。
   以前这个字段只活在内存里，刷新就归零 —— 于是"累计 3 次传说"的成就
   在刷新后被悄悄重置，玩家明明已经累计过却还要重新数。
   现在它与 Store.legendary 同源，两边永远一致。 */
State.legendaryCount = Store.get().legendary || 0;

renderAchievements();
renderGallery();
refreshBest();
syncHud();

writeLog("欢迎来到「寻宝奇缘」—— 一场由 Promise 与 async/await 驱动的寻宝", "title");
writeLog("点击「开始寻宝」或直接按空格键，即可跟随探险家出发。", "info");
writeLog("三种难度可选；右上角「图鉴」可查看历史最佳记录。", "info");
writeLog("所有剧情均由事件总线驱动：逻辑层只广播，显示层负责渲染。", "info");

/* ------------------------------------------------------------
 * 13. 暴露到 window —— 供控制台调试 / 演示 / 自动化测试
 * ---------------------------------------------------------- */
window.Bus = Bus;
window.Sfx = Sfx;
window.TreasureMap = TreasureMap;
window.Achievements = Achievements;
window.Stage = Stage;
window.Timers = Timers;
window.Store = Store;
window.State = State;
window.CONFIG = CONFIG;
window.DIFFICULTY = DIFFICULTY;
window.findTreasure = findTreasure;
window.findTreasureWithPromises = findTreasureWithPromises;
window.runQuest = runQuest;
/* 供自动化测试直接验证渲染（有些断言要在"点了某按钮之后"再画一次） */
window.renderAchievements = renderAchievements;
window.renderGallery = renderGallery;
window.refreshBest = refreshBest;
window.elapsedSec = elapsedSec;
