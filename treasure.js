/* ============================================================
 * treasure.js —— 寻宝剧情（纯逻辑层，事件驱动，零 DOM 依赖）
 *
 * 需要展示的效果一律通过 Bus.emit 广播，由 main.js 订阅后渲染。
 * 本文件不引用 document / window，可以脱离浏览器单独运行。
 * ============================================================ */

/* ------------------------------------------------------------
 * 一、难度配置
 * ---------------------------------------------------------- */
const DIFFICULTY = {
  easy: {
    name: "简单", icon: "🌱",
    guardFightRate: 0.20,   // 遇守卫概率
    trapRate:       0.12,   // 踩陷阱概率
    decodeFailRate: 0.08,   // 解码失败概率
    keyFailRate:    0.15,   // 找钥匙失败概率
    reviveCost:     20,     // 复活花费
    startGold:      150
  },
  normal: {
    name: "普通", icon: "⚔️",
    guardFightRate: 0.45,
    trapRate:       0.28,
    decodeFailRate: 0.18,
    keyFailRate:    0.30,
    reviveCost:     30,
    startGold:      100
  },
  hard: {
    name: "地狱", icon: "💀",
    guardFightRate: 0.75,
    trapRate:       0.45,
    decodeFailRate: 0.32,
    keyFailRate:    0.50,
    reviveCost:     50,
    startGold:      60
  }
};

/* 可变的运行时配置（timeScale 由倍速按钮改） */
const CONFIG = {
  timeScale: 1,
  get diff() { return DIFFICULTY[State.difficulty] || DIFFICULTY.normal; }
};

/* ------------------------------------------------------------
 * 二、可中断的定时器
 *    · 可被倍速改动立即影响 —— 改了 timeScale 立刻生效，不用等下一段
 *    · 可被"暂停"冻结 —— 挂起时不消耗等待时间，恢复后接着走
 * ---------------------------------------------------------- */
const Timers = (() => {
  /* 每 40ms 醒一次，把「这一段真实时间 × 当前倍速」累加进 virtual。
     virtual >= ms 才算等完 —— 这样倍速一变，下一片就自动按新倍速计时。 */
  const active = new Set();
  const TICK = 40;

  let paused = false;

  function delay(ms) {
    const handle = { cancel: null, rebase: null };
    const p = new Promise((resolve) => {
      let virtual = 0;                 // 已累积的"虚拟"毫秒
      let last = performance.now();
      let done = false;
      /* 恢复时把基准拉回"现在"，防止暂停期间的真实时长被算进等待 */
      handle.rebase = (now) => { last = now; };

      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        active.delete(handle);
        resolve();
      };

      /* cancel 与 finish 必须分开：cancel 是"这一局作废了"，
         绝不能调用 resolve() —— 否则被取消的 await 会正常返回，
         剧情照旧往下走；调用方还会以为一切正常，错误被静默吞掉。
         正确做法是让 Promise 永久悬停：既然整局都被 cancelAll 拆了，
         这个链条本来就该停在这里，由新一局重新开始。 */
      const timer = setInterval(() => {
        const now = performance.now();
        const dt = now - last;         // 这一段的真实时长
        last = now;                    // 无论是否暂停都要推进基准，
                                       //   否则恢复后会把"暂停的那段时间"一次性补进 virtual
        if (paused) return;            // 挂起：本片真实时间直接丢弃，等待被冻结
        virtual += dt * CONFIG.timeScale;
        if (virtual >= ms) finish();
      }, TICK);

      const cancel = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        active.delete(handle);
        /* 故意不 resolve —— 见上 */
      };
      handle.cancel = cancel;
      active.add(handle);
    });

    p.cancel = () => handle.cancel && handle.cancel();
    return p;
  }

  /** 全部取消（用于重开一局）。
      同时清掉卡住的闸门 —— 否则上一局停在闸口，重开时它会永远等下去。 */
  function cancelAll() {
    [...active].forEach((h) => h.cancel && h.cancel());
    active.clear();
    if (gate) { gate = null; Bus.emit(Bus.EVT.GATE, { action: "cancelled" }); }
  }

  /** 简易版：不需要倍速响应的场合。同样尊重暂停 —— 挂起时把等待一次次顺延 */
  function plain(ms) {
    const real = Math.max(0, ms / CONFIG.timeScale);
    return new Promise((resolve) => {
      const handle = { cancel: null };
      let tid = null;
      let done = false;
      const arm = () => { tid = setTimeout(tick, real); };
      const tick = () => {
        if (done) return;
        if (paused) { arm(); return; }   // 挂起：重新计时，不落账
        done = true;
        active.delete(handle);
        resolve();
      };
      /* 取消时只拆定时器、不 resolve —— 理由同 Timers.delay。
         以前这里会 resolve()，等于"取消后还照常放行"。 */
      handle.cancel = () => {
        if (done) return;
        done = true;
        clearTimeout(tid);
        active.delete(handle);
      };
      active.add(handle);
      arm();
    });
  }

  function setPaused(v) {
    paused = !!v;
    /* 恢复时把所有在途 handle 的基准时间重设，避免 dt 突变 */
    const now = performance.now();
    active.forEach((h) => { if (h.rebase) h.rebase(now); });
  }
  const isPaused = () => paused;

  /* ------------------------------------------------------------
   * 「分关闸门」—— 每完成一站就停在这里，等玩家点「进入下一关」。
   *
   * 为什么不把 await 塞进剧情里、而是做成闸门？
   *   · 剧情代码一行不用改结构，只在站点之间 await
   *   · 闸门本身就是个 Promise，天然融入 async/await
   *   · 和暂停可以共存：暂停冻结时间；闸门是自己不走。
   *     恢复暂停不会误放闸门，开闸也不会误解暂停。
   * ---------------------------------------------------------- */
  let gate = null;         // { resolve, id } —— 有值表示正卡在闸口

  /** 在站点之间等待玩家放行。stepMode 关闭时立即通过（不阻塞）。 */
  function waitGate(id, label) {
    if (!stepMode) return Promise.resolve();
    return new Promise((resolve) => {
      gate = { resolve, id, label };
      Bus.emit(Bus.EVT.GATE, { id, label, action: "waiting" });
    });
  }

  /** 放行（点「进入下一关」时调用）。没有卡住就什么都不做。 */
  function openGate() {
    if (!gate) return false;
    const g = gate;
    gate = null;
    Bus.emit(Bus.EVT.GATE, { id: g.id, label: g.label, action: "open" });
    g.resolve();
    return true;
  }

  const isGated = () => !!gate;
  const gateAt = () => (gate ? gate.id : null);

  /* 分关模式开关 */
  let stepMode = false;
  const setStepMode = (v) => { stepMode = !!v; };
  const isStepMode = () => stepMode;

  /* _active 暴露给 progressDelay 用（同样支持 cancelAll / 重设基准） */
  return {
    delay, plain, cancelAll, setPaused, isPaused,
    waitGate, openGate, isGated, gateAt, setStepMode, isStepMode,
    _active: active
  };
})();

/* 供其它模块读取"是否挂起"（进度条 / 结算计时都要知道） */
function isPaused() { return Timers.isPaused(); }

/* ------------------------------------------------------------
 * 三、工具函数
 * ---------------------------------------------------------- */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 向玩家"求助"：问背包里有没有指定道具、玩家愿不愿意用掉它。
 *
 * 逻辑层只管发问，不知道背包长什么样；显示层只管答，不知道剧情跑到哪。
 * 返回 true 表示玩家真的用了（道具已被扣掉），false 表示没有/拒绝。
 */
function askAid(channel, prompt) {
  const res = Bus.request(channel, prompt);
  return res === true;
}

/** 会随机失败的异步任务：成功 resolve，失败 reject
    （内部走 Timers.delay，因此同样支持倍速与暂停） */
function riskyDelay(ms, failRate, okValue, errValue) {
  return Timers.delay(ms).then(() => {
    if (Math.random() < failRate) throw errValue;
    return okValue;
  });
}

/** 把一次等待拆成若干进度步，供动画层画进度条。
    用累加式计时而非 setInterval —— 这样"暂停"时进度条会一起冻住，
    而不是继续偷偷往前走（玩家会发现进度条和剧情对不上）。 */
function progressDelay(totalMs, steps) {
  return new Promise((resolve) => {
    const TICK = 40;
    let virtual = 0;
    let last = performance.now();
    let emitted = 0;
    let done = false;

    const handle = { cancel: null, rebase: (now) => { last = now; } };

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      Timers._active.delete(handle);
      Bus.emit(Bus.EVT.PROGRESS, { value: 1 });
      resolve();
    };

    /* cancel 与 finish 分开：取消不 resolve（见 Timers.delay 里的说明）。
       同时补一个收尾广播，免得进度条停在半路下不来。 */
    const cancel = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      Timers._active.delete(handle);
      Bus.emit(Bus.EVT.PROGRESS, null);
    };

    const timer = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (Timers.isPaused()) return;          // 挂起：进度条同步冻住
      virtual += dt * CONFIG.timeScale;
      const want = Math.min(steps, Math.floor(virtual / totalMs * steps));
      while (emitted < want) {
        emitted++;
        Bus.emit(Bus.EVT.PROGRESS, { value: Math.min(1, emitted / steps) });
      }
      if (virtual >= totalMs) finish();
    }, TICK);

    handle.cancel = cancel;
    Timers._active.add(handle);
  });
}

/** 广播日志的语法糖 */
const log = (text, kind = "info") => Bus.emit(Bus.EVT.LOG, { text, kind });

/* ------------------------------------------------------------
 * 四、宝藏地图 API —— 11 个异步任务
 * ---------------------------------------------------------- */
class TreasureMap {

  /* 情节 1：古老图书馆，找到初始线索 */
  static async getInitialClue() {
    log("正在古老的图书馆里翻找（await getInitialClue）...", "run");
    await Timers.delay(1000);
    return {
      key: "clue", icon: "🧭", node: "clue",
      text: "在古老的图书馆里找到了第一个线索...",
      detail: "一本发霉的航海日志从架子上滑落，扉页写着：「月圆之夜，星图所指」。",
      gold: 20
    };
  }

  /* 情节 2：破译古老文字
     每个失败分支都直接抛错，绝不"既失败又成功"。 */
  static decodeAncientScript(clue) {
    /* 一律走 Timers.delay 而不是裸 setTimeout，
       这样暂停、倍速、重开一局的清理才对这一步有效。 */
    return Timers.delay(1500).then(() => {
      if (!clue) {
        throw new Error("没有线索可以解码！");
      }
      if (Math.random() < CONFIG.diff.decodeFailRate) {
        throw new Error("古老文字被海水泡烂了，完全看不清...");
      }
      return {
        key: "script", icon: "📜", node: "script",
        text: "解码成功！宝藏在一座古老的神庙中...",
        detail: "羊皮卷上浮现出坐标：东经 87.6°，北纬 29.3° —— 那是喜马拉雅的某处。"
      };
    });
  }

  /* 情节 2.5：解码失败的降级方案 —— 花金币向老学者换线索
     独立的背包格（scholar），让"你走了另一条路"在界面上看得见 */
  static askOldScholar(coins) {
    return Timers.delay(1200).then(() => {
      if (coins < 20) {
        throw new Error("老学者摇了摇头：金币不够，我帮不了你。");
      }
      return {
        key: "scholar", icon: "🧙", node: "script",
        text: "你付给老学者 20 金币，他口述了另一种解读方式！",
        detail: "「星图要倒过来看，孩子。」—— 老学者",
        cost: 20
      };
    });
  }

  /* 情节 3：寻找机关钥匙 */
  static findTempleKey(script) {
    return Timers.delay(1300).then(() => {
      if (!script) {
        throw new Error("没有解码结果，无法定位神庙机关！");
      }
      if (Math.random() < CONFIG.diff.keyFailRate) {
        throw new Error("废墟里全是碎石，钥匙被埋得太深了...");
      }
      return {
        key: "key", icon: "🗝️", node: "key",
        text: "拨开碎石，你摸到一把刻着星纹的铜钥匙！",
        detail: "钥匙很冷，握在手里却隐隐发烫 —— 它在指引方向。"
      };
    });
  }

  /* 备用钥匙（key 的降级分支，独立格子，视觉上体现"退而求其次"） */
  static backupKey() {
    return Timers.delay(600).then(() => ({
      key: "backupKey", icon: "🔑", node: "key",
      text: "你从祭坛暗格里取出一把备用钥匙。",
      detail: "备用钥匙也能用，只是光泽暗一些 —— 它没见过月光。"
    }));
  }

  /* 情节 4：登观星台，解读星象图（必经剧情，带进度条） */
  static async readStarChart(key) {
    log("正在登塔，解读星象图（await readStarChart）...", "run");
    await progressDelay(1800, 6);
    Bus.emit(Bus.EVT.PROGRESS, null);
    return {
      key: "map", icon: "🗺️", node: "map",
      text: "星象图与铜钥匙的纹路完全吻合，地宫入口显现了！",
      detail: "北斗第七星指向祭坛第三块石板 —— 那就是入口。"
    };
  }

  /* 情节 5：闯神庙
     遇到守卫不算失败，而是一个正常分支，交给战斗流程处理。 */
  static searchTemple(location) {
    /* 同样走 Timers.delay，保证可暂停、可倍速、可被重开时清掉。 */
    return Timers.delay(2000).then(() => {
      if (Math.random() < CONFIG.diff.guardFightRate) {
        return {
          key: null, icon: "🗿", guard: true,
          text: "糟糕！遇到了神庙守卫！",
          detail: "石像的眼睛亮了 —— 它握着重锤挡在宝箱前。看样子只能打一架了。"
        };
      }
      return {
        key: "chest", icon: "🎁", node: "chest", guard: false,
        text: "找到了一个神秘的箱子...",
        detail: "宝箱上缠着三道封印，铜钥匙插进锁孔的瞬间，封印一道一道碎了。"
      };
    });
  }

  /* 情节 5.5：回合制战斗（用 async 循环实现，逐回合 await）
     胜负判定：只有"把守卫打到 0"才算赢（guardHp <= 0）。
       早期版本用 heroHp>0 判赢，会出现"6 回合没打死守卫、但人还站着就算赢"
       的矛盾 —— 约 8.7% 的战斗里守卫还活着，剧情却说"守卫被击败"。
     平衡：守卫耐久随难度递增，回合上限固定 6。
       三档胜率实测约为 100% / 91% / 59% —— 让"打不过"在普通与地狱难度下
       成为真实可能，也让"宝箱补血"这个道具用法有了存在意义。
     返回：{ win, heroHp, guardHp, rounds } */
  static async fightGuard(hero) {
    let heroHp = hero ? hero.hp : 100;
    let rounds = 0;
    const MAX_ROUNDS = 6;
    const GUARD_HP = { easy: 84, normal: 100, hard: 112 };
    let guardHp = GUARD_HP[State.difficulty] || 100;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (heroHp <= 0) break;
      rounds = round;
      log(`第 ${round} 回合 —— 你挥剑迎上石像守卫！`, "run");
      Bus.emit(Bus.EVT.SFX, { name: "hit" });

      await Timers.delay(420);

      const dmg = randInt(12, 26);
      guardHp -= dmg;
      if (guardHp <= 0) {
        log(`你击中守卫的星辰核心，造成 ${dmg} 点伤害 —— 石像轰然碎裂！`, "ok");
        Bus.emit(Bus.EVT.SFX, { name: "win" });
        await Timers.delay(600);
        return { win: true, heroHp, guardHp: 0, rounds };
      }

      await Timers.delay(360);
      const back = randInt(6, 16);
      heroHp -= back;
      log(`守卫重锤反击，你受到 ${back} 点伤害（剩余体力 ${Math.max(0, heroHp)}）。`, "warn");
      Bus.emit(Bus.EVT.SFX, { name: "hurt" });

      /* 危急时刻：血线告急时，问玩家要不要用掉宝箱里的补给续命。
         这是"道具真正有用"的落点之一 —— 用了就能扛过接下来那几回合。 */
      if (heroHp > 0 && heroHp <= 30) {
        if (askAid("aid:chest", { reason: "体力告急", hp: heroHp })) {
          const heal = 45;
          heroHp += heal;
          log(`你撬开随身宝箱，取出干粮与药膏 —— 体力回复 ${heal} 点（当前 ${heroHp}）。`, "ok");
          Bus.emit(Bus.EVT.SFX, { name: "item" });
          Bus.emit(Bus.EVT.HUD, { gold: State.gold, stamina: State.stamina });
        }
      }
    }

    /* 走到这里 = 没打死守卫（或自己倒了）—— 都不算胜利 */
    return { win: false, heroHp: Math.max(0, heroHp), guardHp: Math.max(0, guardHp), rounds };
  }

  /* 情节 6：宝物选择 —— 三选一宝箱（替代原来"死胡同陷阱"的无厘头设定）
     修复剧情漏洞：原来 testTrial 抽到尖刺陷阱扣钱后，紧接着
       crossTrapCorridor 还可能再踩一次陷阱，同一场景连踩两次很违和。
       现在合并成一个"三选一"事件：选对得宝石、选错触发陷阱，
       陷阱的后续（复活）就在这里一并处理完。

     参数语义：trapRate = 踩陷阱的概率（与 DIFFICULTY 里的字段同名同义），
       内部换算成"选对的概率 = 1 - trapRate"。不传则用当前难度配置。 */
  static chooseChest(trapRate) {
    /* 同上：裸 setTimeout 会让暂停/倍速/取消三件事同时失效。 */
    return Timers.delay(1200).then(() => {
      const tr = trapRate == null ? CONFIG.diff.trapRate : trapRate;
      const ok = Math.random() >= tr;      // 没踩中陷阱 = 选对
      if (ok) {
        return {
          key: "gem", icon: "💎", node: "gem", luck: true,
          bonus: randInt(40, 90),
          text: "三个宝箱，你凭直觉打开了最左边那个 —— 里面躺着发光的守护宝石！",
          detail: "石壁上刻着：「勇气不问对错，只问是否敢选。」"
        };
      }
      return {
        key: "gem", icon: "💎", node: "gem", luck: false, trap: true,
        penalty: 15,
        text: "你选中的箱子里没有宝石，反而弹出了尖刺陷阱！",
        detail: "万幸，背包里的古老文字替你挡了一下 —— 但金币掉了 15 枚。"
      };
    });
  }

  /* 情节 6.5：陷阱脱困（只有踩了陷阱才会调用，逻辑上不再重复） */
  static escapeTrap(coins) {
    return Timers.delay(1000).then(() => {
      if (coins >= CONFIG.diff.reviveCost) {
        return {
          key: null, icon: "🕯️",
          text: `你用 ${CONFIG.diff.reviveCost} 枚金币向地宫守灵人换来一根火把，脱困了！`,
          detail: "守灵人低声说：「每个寻宝人都要付出点代价。」",
          cost: CONFIG.diff.reviveCost
        };
      }
      throw new Error(`金币不足 ${CONFIG.diff.reviveCost} 枚，守灵人拒绝帮忙。`);
    });
  }

  /* 情节 7：开启宝箱 —— 三个结局分支
     普通 / 稀有 / 传说，配合图鉴收集 */
  static openTreasureBox() {
    return Timers.delay(1000).then(() => {
      const r = Math.random();
      let tier, icon, text, detail, gold;
      if (r < 0.22) {
        tier = "legendary"; icon = "👑";
        text = "恭喜！你找到了传说中的宝藏 —— 星辰王冠！";
        detail = "宝箱底还有一行小字：「寻宝的意义，在于你走完了这段路。」";
        gold = randInt(300, 500);
      } else if (r < 0.68) {
        tier = "rare"; icon = "🏆";
        text = "恭喜！你找到了传说中的宝藏！";
        detail = "金币、宝石和一张新的地图 —— 上面标着下一个待解之谜。";
        gold = randInt(120, 260);
      } else {
        tier = "common"; icon = "🥈";
        text = "你打开了宝箱 —— 里面是一小袋金币和一枚旧徽章。";
        detail = "徽章背面刻着：「并非每次冒险都有奇迹，但每次都算数。」";
        gold = randInt(60, 140);
      }
      return { key: "crown", icon, tier, gold, text, detail, node: "crown",
               legendary: tier === "legendary" };
    });
  }
}

/* ------------------------------------------------------------
 * 五、成就系统（纯逻辑，解锁时广播事件，由页面层弹提示）
 * ---------------------------------------------------------- */
const Achievements = (() => {
  const LIST = [
    { id: "first",    icon: "🎒", name: "初出茅庐",   desc: "完成第一次寻宝" },
    { id: "noTrap",   icon: "🛡️", name: "身法轻盈",   desc: "一次都没踩中陷阱" },
    { id: "noFight",  icon: "🕊️", name: "不战而胜",   desc: "全程没遇到神庙守卫" },
    { id: "rich",     icon: "💰", name: "腰缠万贯",   desc: "单局金币达到 500" },
    { id: "legendary",icon: "👑", name: "传说亲历者", desc: "开出传说级宝藏" },
    { id: "triple",   icon: "🌟", name: "三连传说",   desc: "累计开出 3 次传说宝藏" },
    { id: "scholar",  icon: "🧙", name: "不耻下问",   desc: "走过老学者降级路线" },
    { id: "backup",   icon: "🔑", name: "有备无患",   desc: "使用过备用钥匙" },
    { id: "speedrun", icon: "⚡", name: "分秒必争",   desc: "40 秒内完成寻宝" },
    { id: "hell",     icon: "💀", name: "地狱归来",   desc: "在地狱难度下成功寻宝" }
  ];

  const unlocked = new Set();
  /* 本局新解锁的成就，与累计清单 unlocked 分开：
     unlocked 用于成就列表打勾，sessionNew 只用于结算弹窗。 */
  let sessionNew = [];

  function unlock(id) {
    if (unlocked.has(id)) return false;
    const a = LIST.find((x) => x.id === id);
    if (!a) return false;
    unlocked.add(id);
    sessionNew.push(id);
    Bus.emit(Bus.EVT.ACHIEVE, a);
    log(`🏅 解锁成就「${a.name}」—— ${a.desc}`, "warn");
    return true;
  }

  /** 每局开始时清空"本局新增"清单（累计清单保留） */
  function beginRun() { sessionNew = []; }

  /** 从已保存的记录里恢复累计清单。
      页面层读出 localStorage 后调用一次 —— 否则刷新页面后，
      记录里明明有成就，面板却显示 0/10 全是锁，两边自相矛盾。
      注意只填 unlocked，不填 sessionNew（恢复的不是"本局新增"）。 */
  function hydrate(ids) {
    if (!Array.isArray(ids)) return;
    ids.forEach((id) => { if (LIST.some((x) => x.id === id)) unlocked.add(id); });
  }

  /** 清空累计清单（点「清空记录」时调用）。
      持久层和内存层要一起清，只清一半会和面板对不上。 */
  function clearAll() {
    unlocked.clear();
    sessionNew = [];
  }

  return {
    LIST, unlock, unlocked,
    has: (id) => unlocked.has(id),
    count: () => unlocked.size,
    beginRun, hydrate, clearAll,
    newThisRun: () => [...sessionNew]
  };
})();

/* ------------------------------------------------------------
 * 六、剧情主线的两种写法（事件驱动，不含任何 DOM 操作）
 * ---------------------------------------------------------- */

/* ============================================================
 * 6.1 async / await 版本
 *     核心思想：await 让你"像写同步代码一样"写异步流程，
 *     每一步的返回值直接拿到手，不再层层 then 嵌套。
 * ============================================================ */
async function findTreasure() {
  const st = State;
  const diff = CONFIG.diff;

  Achievements.beginRun();     // 清空"本局新解锁"，避免跨局残留
  log(`══════ 使用 async / await 开始寻宝（${diff.icon} ${diff.name}）══════`, "title");
  Bus.emit(Bus.EVT.PHASE, { name: "寻宝中" });

  /* ---------- 第 1 步：初始线索 ---------- */
  Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "clue" });
  const clue = await TreasureMap.getInitialClue();
  gather(clue);
  st.gold += clue.gold || 0;
  log(`await 得到线索：${clue.text}（金币 +${clue.gold}）`, "ok");
  Bus.emit(Bus.EVT.SFX, { name: "coin" });

  /* 分关推进：第 1 关做完，停在这里等玩家点「进入下一关」 */
  await Timers.waitGate("clue", "古老图书馆 · 找到初始线索");

  /* ---------- 第 2 步：解码古老文字（失败则降级） ---------- */
  Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "script" });
  let script;
  try {
    script = await TreasureMap.decodeAncientScript(clue);
    log(`await 解码成功：${script.text}`, "ok");
  } catch (err) {
    /* 降级策略：catch 块里继续 await，寻宝不会因为一次失败就中断 */
    log(`await 解码失败：${err.message}`, "err");
    log("降级策略：await askOldScholar() 向老学者求助...", "warn");
    try {
      script = await TreasureMap.askOldScholar(st.gold);
      st.gold -= script.cost || 0;
      st.flags.usedScholar = true;
      Achievements.unlock("scholar");
      Bus.emit(Bus.EVT.SFX, { name: "coin" });
    } catch (scholarErr) {
      /* 连降级也失败（金币不足）—— 明确收尾，不让异常裸奔 */
      log(scholarErr.message, "err");
      throw new Error(`解码失败，且无法向老学者求助：${scholarErr.message}`);
    }
  }
  gather(script);
  Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
  Bus.emit(Bus.EVT.NARRATE, { text: script.text, detail: script.detail });

  /* 第 2 关结束 */
  await Timers.waitGate("script", "解读古老文字");

  /* ---------- 第 3 步：寻找机关钥匙（重试循环 —— 真异步重试） ---------- */
  Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "key" });
  let key = null;
  for (let attempt = 1; attempt <= 3 && !key; attempt++) {
    try {
      log(`第 ${attempt} 次尝试寻找神庙机关钥匙（await findTempleKey）...`, "run");
      key = await TreasureMap.findTempleKey(script);
    } catch (err) {
      log(`第 ${attempt} 次失败：${err.message}`, "warn");
      if (attempt < 3) await Timers.delay(500);
    }
  }
  if (!key) {
    log("3 次都没找到铜钥匙，降级：await backupKey() 取备用钥匙。", "warn");
    st.flags.usedBackupKey = true;
    Achievements.unlock("backup");
    key = await TreasureMap.backupKey();
  }
  gather(key);
  Bus.emit(Bus.EVT.NARRATE, { text: key.text, detail: key.detail });

  /* 第 3 关结束 */
  await Timers.waitGate("key", "神庙废墟 · 寻找机关钥匙");

  /* ---------- 第 4 步：登观星台，解读星象图 ---------- */
  Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "map" });
  const starMap = await TreasureMap.readStarChart(key);
  gather(starMap);
  log(`await 星象图解读完成：${starMap.text}`, "ok");
  Bus.emit(Bus.EVT.NARRATE, { text: starMap.text, detail: starMap.detail });

  /* 第 4 关结束 */
  await Timers.waitGate("map", "观星台 · 解读星象图");

  /* ---------- 第 5 步：闯神庙 ---------- */
  Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "chest" });
  Bus.emit(Bus.EVT.SHAKE, { power: 9 });
  log("正在潜入神庙（await searchTemple）...", "run");
  let found = await TreasureMap.searchTemple(starMap.text);

  /* 5.1 遇守卫 → await 一整场战斗 */
  if (found.guard) {
    st.flags.fought = true;
    log(found.text, "err");
    Bus.emit(Bus.EVT.NARRATE, { text: found.text, detail: found.detail });
    Bus.emit(Bus.EVT.GUARD_ON);
    Bus.emit(Bus.EVT.SFX, { name: "roar" });

    const battle = await TreasureMap.fightGuard(st.hero);
    st.hero.hp = battle.heroHp;
    Bus.emit(Bus.EVT.GUARD_OFF);

    if (!battle.win) {
      /* 战斗失败 —— 失败原因可能是自己倒了，也可能是回合耗尽没打死守卫 */
      const reason = battle.heroHp <= 0
        ? "体力耗尽，你被石像守卫推了出来……"
        : `缠斗 ${battle.rounds} 回合仍没能击碎石像守卫（它还剩 ${battle.guardHp} 点耐久），你只好先退了出来……`;
      log(reason, "err");
      throw new Error(reason);
    }
    found = {
      key: "chest", icon: "🎁", node: "chest",
      text: `守卫被击败（${battle.rounds} 回合）！石像背后露出了神秘的箱子...`,
      detail: "原来守卫只是在守护，而不是阻止 —— 它认出了你手里的钥匙。"
    };
  }
  gather(found);
  Bus.emit(Bus.EVT.NARRATE, { text: found.text, detail: found.detail });

  /* ---------- 第 6 步：三选一宝箱 → 宝石 或 陷阱 ---------- */
  Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "gem" });
  log("宝箱前出现三个一模一样的箱子，全凭直觉（await chooseChest）...", "run");

  /* 星象图的用法：出手前先"对照星图"勘察，可以直接排除掉带陷阱的箱子。
     这是道具真正影响剧情的落点 —— 用了星图，就是稳拿宝石。 */
  let trapRate = CONFIG.diff.trapRate;
  if (askAid("aid:map", { reason: "对照星图勘察宝箱", trapRate })) {
    trapRate = 0;
    log("你把星象图摊在石台上对照 —— 右侧那只箱子的位置和图上「凶位」完全重合，避开它！", "ok");
    Bus.emit(Bus.EVT.SFX, { name: "item" });
  }

  /* 陷阱概率统一读 DIFFICULTY.trapRate，不再在这里硬编码，
     保证「难度按钮上写的陷阱率」和「实际发生的陷阱率」一致 */
  const gem = await TreasureMap.chooseChest(trapRate);
  gather(gem);

  if (gem.luck) {
    st.gold += gem.bonus;
    log(`${gem.text} 金币 +${gem.bonus}`, "ok");
    Bus.emit(Bus.EVT.SFX, { name: "coin" });
  } else {
    st.gold = Math.max(0, st.gold - gem.penalty);
    st.flags.trapped = true;
    log(`${gem.text} 金币 -${gem.penalty}`, "err");
    Bus.emit(Bus.EVT.SFX, { name: "trap" });
    Bus.emit(Bus.EVT.SHAKE, { power: 14 });

    /* 陷阱的后续就地处理完，避免"同一场景连踩两次陷阱"的剧情漏洞 */
    st.stamina -= 1;
    Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });

    /* 体力归零 = 真的走不动了 —— 让 HUD 上的"体力"成为有效数值，
       而不是只减不判的空数据 */
    if (st.stamina <= 0) {
      throw new Error("连番受挫，你的体力已经耗尽，只能放弃这次寻宝……");
    }

    try {
      const rescue = await TreasureMap.escapeTrap(st.gold);
      st.gold -= rescue.cost;
      Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
      log(rescue.text, "ok");
      Bus.emit(Bus.EVT.NARRATE, { text: rescue.text, detail: rescue.detail });
    } catch (e) {
      /* 脱困失败（金币不够）—— 先给玩家一次"用宝石抵账"的机会，
         宝石是前面从宝箱里拿到的，这里正好派上用场。 */
      log(e.message, "err");
      if (askAid("aid:gem", { reason: "金币不足，无法脱困", cost: CONFIG.diff.reviveCost, gold: st.gold })) {
        st.gold += 25;                       // 宝石变卖
        st.stamina += 1;                     // 恢复一点体力
        log("你取出守护宝石向守灵人抵账 —— 金币 +25，体力 +1。", "ok");
        Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
        const rescue2 = await TreasureMap.escapeTrap(st.gold);
        st.gold -= rescue2.cost;
        Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
        log(rescue2.text, "ok");
        Bus.emit(Bus.EVT.NARRATE, { text: rescue2.text, detail: rescue2.detail });
      } else {
        /* 连宝石都没有/不想用 —— 这才真的走投无路 */
        throw new Error(`掉进陷阱后无法脱身：${e.message}`);
      }
    }
  }
  Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
  Bus.emit(Bus.EVT.NARRATE, { text: gem.text, detail: gem.detail });

  /* 第 6 关结束 */
  await Timers.waitGate("gem", "神庙地宫 · 三选一宝箱");

  /* ---------- 第 7 步：开启宝箱，走向结局 ---------- */
  Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "crown" });
  log("封印全部解开，正在开启宝箱（await openTreasureBox）...", "run");
  const treasure = await TreasureMap.openTreasureBox();
  gather(treasure);
  st.gold += treasure.gold;
  st.legendaryCount += treasure.tier === "legendary" ? 1 : 0;
  st.tier = treasure.tier;

  log(treasure.text, "ok");
  log(`本次收获金币 ${treasure.gold} 枚（${tierName(treasure.tier)}）。`, "ok");
  Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
  Bus.emit(Bus.EVT.SFX, { name: "win" });
  Bus.emit(Bus.EVT.TREASURE_WIN, treasure);

  /* ---------- 收尾：结算 & 成就 ---------- */
  finalize(st, treasure);

  return { ok: true, treasure, clue, script, key, gem, gold: st.gold };
}

/* ============================================================
 * 6.2 Promise 链式版本 —— 与 async 版剧情完全一致
 *     两种写法可以在页面上切换，用来对比可读性
 * ============================================================ */
function findTreasureWithPromises() {
  const st = State;
  const diff = CONFIG.diff;

  Achievements.beginRun();     // 清空"本局新解锁"，避免跨局残留
  log(`══════ 使用 Promise 链式开始寻宝（${diff.icon} ${diff.name}）══════`, "title");
  Bus.emit(Bus.EVT.PHASE, { name: "寻宝中" });

  let clue, script, key, gem, starMapText;

  return TreasureMap.getInitialClue()
    .then((c) => {
      clue = c;
      Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "clue" });
      gather(c);
      st.gold += c.gold || 0;
      log(`then 得到线索：${c.text}（金币 +${c.gold}）`, "ok");
      Bus.emit(Bus.EVT.SFX, { name: "coin" });
      /* 分关推进：用 then 接住闸门，链式写法一样干净 */
      return Timers.waitGate("clue", "古老图书馆 · 找到初始线索");
    })
    .then(() => {
      Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "script" });
      return TreasureMap.decodeAncientScript(clue);
    })
    .catch((err) => {
      /* then 链里做降级：返回一个新 Promise 接上链条 */
      log(`解码失败：${err.message}，降级向老学者求助...`, "warn");
      return TreasureMap.askOldScholar(st.gold).then((s) => {
        st.gold -= s.cost || 0;
        st.flags.usedScholar = true;
        Achievements.unlock("scholar");
        return s;
      });
    })
    .then((s) => {
      script = s;
      gather(s);
      Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
      Bus.emit(Bus.EVT.NARRATE, { text: s.text, detail: s.detail });
      /* 第 2 关结束 */
      return Timers.waitGate("script", "解读古老文字");
    })
    .then(() => {
      Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "key" });
      /* 重试在链式写法里稍绕，这里用一个带重试的辅助函数 */
      return retry(() => TreasureMap.findTempleKey(script), 3, (n, e) => {
        log(`第 ${n} 次失败：${e.message}`, "warn");
      }).catch(() => {
        log("3 次都没找到铜钥匙，降级取备用钥匙。", "warn");
        st.flags.usedBackupKey = true;
        Achievements.unlock("backup");
        return TreasureMap.backupKey();
      });
    })
    .then((k) => {
      key = k;
      gather(k);
      Bus.emit(Bus.EVT.NARRATE, { text: k.text, detail: k.detail });
      /* 第 3 关结束 */
      return Timers.waitGate("key", "神庙废墟 · 寻找机关钥匙");
    })
    .then(() => {
      Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "map" });
      return TreasureMap.readStarChart(key);
    })
    .then((m) => {
      gather(m);
      starMapText = m.text;
      log(`星象图解读完成：${m.text}`, "ok");
      Bus.emit(Bus.EVT.NARRATE, { text: m.text, detail: m.detail });
      /* 第 4 关结束 */
      return Timers.waitGate("map", "观星台 · 解读星象图");
    })
    .then(() => {
      Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "chest" });
      Bus.emit(Bus.EVT.SHAKE, { power: 9 });
      return TreasureMap.searchTemple(starMapText);
    })
    .then((found) => {
      if (!found.guard) return found;
      st.flags.fought = true;
      log(found.text, "err");
      Bus.emit(Bus.EVT.GUARD_ON);
      Bus.emit(Bus.EVT.SFX, { name: "roar" });
      return TreasureMap.fightGuard(st.hero).then((b) => {
        st.hero.hp = b.heroHp;
        Bus.emit(Bus.EVT.GUARD_OFF);
        /* 与 async 版保持一致：必须真把守卫打倒才算赢 */
        if (!b.win) {
          const reason = b.heroHp <= 0
            ? "体力耗尽，你被石像守卫推了出来……"
            : `缠斗 ${b.rounds} 回合仍没能击碎石像守卫（它还剩 ${b.guardHp} 点耐久），你只好先退了出来……`;
          log(reason, "err");
          throw new Error(reason);
        }
        return {
          key: "chest", icon: "🎁", node: "chest",
          text: `守卫被击败（${b.rounds} 回合）！石像背后露出了神秘的箱子...`,
          detail: "原来守卫只是在守护，而不是阻止。"
        };
      });
    })
    .then((found) => {
      gather(found);
      Bus.emit(Bus.EVT.NARRATE, { text: found.text, detail: found.detail });
      Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "gem" });
      /* 与 async 版保持一致：开箱前先问玩家要不要用星象图勘察。
         以前这里直接 chooseChest(CONFIG.diff.trapRate)，漏掉了这条求助 ——
         结果星象图在 Promise 模式下完全没用武之地，白拿。 */
      let trapRate = CONFIG.diff.trapRate;
      if (askAid("aid:map", { reason: "对照星图勘察宝箱", trapRate })) {
        trapRate = 0;
        log("你把星象图摊在石台上对照 —— 右侧那只箱子的位置和图上「凶位」完全重合，避开它！", "ok");
        Bus.emit(Bus.EVT.SFX, { name: "item" });
      }
      return TreasureMap.chooseChest(trapRate);
    })
    .then((g) => {
      gem = g;
      gather(g);
      if (g.luck) {
        st.gold += g.bonus;
        log(`${g.text} 金币 +${g.bonus}`, "ok");
      } else {
        st.gold = Math.max(0, st.gold - g.penalty);
        st.flags.trapped = true;
        st.stamina -= 1;
        log(`${g.text} 金币 -${g.penalty}`, "err");
        Bus.emit(Bus.EVT.SHAKE, { power: 14 });
      }
      Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
      Bus.emit(Bus.EVT.NARRATE, { text: g.text, detail: g.detail });
      /* 只有踩了陷阱才走脱困流程 */
      if (!g.trap) return null;
      /* 与 async 版一致：体力归零即失败 */
      if (st.stamina <= 0) {
        throw new Error("连番受挫，你的体力已经耗尽，只能放弃这次寻宝……");
      }
      return TreasureMap.escapeTrap(st.gold)
        .then((r) => {
          st.gold -= r.cost;
          Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
          log(r.text, "ok");
          Bus.emit(Bus.EVT.NARRATE, { text: r.text, detail: r.detail });
        })
        .catch((e) => {
          /* 与 async 版保持一致：金币不够时，先给一次"用宝石抵账"的机会。
             以前这里直接抛错结束，Promise 模式下宝石同样形同虚设。 */
          log(e.message, "err");
          if (askAid("aid:gem", {
            reason: "金币不足，无法脱困",
            cost: CONFIG.diff.reviveCost, gold: st.gold
          })) {
            st.gold += 25;                       // 宝石变卖
            st.stamina += 1;                     // 恢复一点体力
            log("你取出守护宝石向守灵人抵账 —— 金币 +25，体力 +1。", "ok");
            Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
            return TreasureMap.escapeTrap(st.gold).then((r2) => {
              st.gold -= r2.cost;
              Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
              log(r2.text, "ok");
              Bus.emit(Bus.EVT.NARRATE, { text: r2.text, detail: r2.detail });
            });
          }
          /* 连宝石都没有/没用 —— 这才真的走投无路 */
          throw new Error(`掉进陷阱后无法脱身：${e.message}`);
        });
    })
    .then(() => {
      /* 第 6 关结束 */
      return Timers.waitGate("gem", "神庙地宫 · 三选一宝箱");
    })
    .then(() => {
      Bus.emit(Bus.EVT.NARRATE_BEAT, { id: "crown" });
      return TreasureMap.openTreasureBox();
    })
    .then((treasure) => {
      gather(treasure);
      st.gold += treasure.gold;
      st.legendaryCount += treasure.tier === "legendary" ? 1 : 0;
      st.tier = treasure.tier;
      log(treasure.text, "ok");
      log(`本次收获金币 ${treasure.gold} 枚（${tierName(treasure.tier)}）。`, "ok");
      Bus.emit(Bus.EVT.HUD, { gold: st.gold, stamina: st.stamina });
      Bus.emit(Bus.EVT.SFX, { name: "win" });
      Bus.emit(Bus.EVT.TREASURE_WIN, treasure);
      finalize(st, treasure);
      return { ok: true, treasure, clue, script, key, gem, gold: st.gold };
    })
    .catch((err) => {
      log(`任务失败：${err.message || err}`, "err");
      Bus.emit(Bus.EVT.RESULT, {
        ok: false, title: "寻宝失败", icon: "💀",
        desc: `寻宝途中失败了：${err.message || err}`
      });
      return { ok: false, error: err };
    });
}

/* ------------------------------------------------------------
 * 七、辅助函数
 * ---------------------------------------------------------- */

/** 收集道具 → 广播事件（页面层负责点亮背包） */
function gather(item) {
  if (!item || !item.key) return;
  State.items[item.key] = item;
  Bus.emit(Bus.EVT.ITEM_FOUND, item);
}

/** 带重试的 Promise 包装（链式写法里替代 for + try/catch）
    重试间隔走 Timers.delay，所以同样受倍速 / 暂停控制 */
function retry(fn, times, onFail) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const attempt = () => {
      n++;
      fn().then(resolve).catch((err) => {
        if (onFail) onFail(n, err);
        if (n >= times) reject(err);
        else Timers.delay(400).then(attempt);
      });
    };
    attempt();
  });
}

/** 结局等级中文名 */
function tierName(tier) {
  return { legendary: "传说级", rare: "稀有级", common: "普通级" }[tier] || "未知";
}

/** 一轮结束后的成就判定 + 结算广播 */
function finalize(st, treasure) {
  /* 用时必须扣掉暂停时长 —— 否则"暂停去泡杯茶"会凭空拉长成绩，
        连 40 秒速通成就都会被暂停拖没。 */
  const used = (Date.now() - st.startTime - (st.pausedMs || 0)) / 1000;

  /* --- 成就判定 --- */
  Achievements.unlock("first");
  if (!st.flags.trapped)  Achievements.unlock("noTrap");
  if (!st.flags.fought)   Achievements.unlock("noFight");
  if (st.gold >= 500)     Achievements.unlock("rich");
  if (treasure.tier === "legendary") Achievements.unlock("legendary");
  /* 「三连传说」是"累计"成就，必须读持久化的累计值。
     以前读的是 st.legendaryCount —— 那个字段只活在内存里，
     刷新页面就归零，于是累计了 5 次的玩家刷新后还得从 0 数起；
     而真正持久的 Store.legendary 却只拿去渲染记录面板，两边各算各的。
     现在统一：逻辑层通过 Bus.request 向页面层查这个持久值。 */
  const totalLegendary = Bus.request("stat:legendary", null);
  const legendaryTotal = typeof totalLegendary === "number"
    ? Math.max(totalLegendary, st.legendaryCount)
    : st.legendaryCount;
  if (legendaryTotal >= 3) Achievements.unlock("triple");
  if (used <= 40)         Achievements.unlock("speedrun");
  if (st.difficulty === "hard") Achievements.unlock("hell");

  /* --- 历史最佳记录（由页面层写 localStorage） --- */
  Bus.emit(Bus.EVT.RESULT, {
    ok: true,
    title: treasure.tier === "legendary" ? "传说级寻宝成功！"
         : treasure.tier === "rare" ? "稀有级寻宝成功！" : "寻宝完成！",
    icon: treasure.icon,
    tier: treasure.tier,
    tierName: tierName(treasure.tier),
    treasure,
    gold: st.gold,
    used,
    mode: st.mode,
    difficulty: st.difficulty,
    items: Object.keys(st.items).length,
    /* 只报"本局新解锁"，而不是整个 session 的累计清单 */
    achievements: Achievements.newThisRun(),
    desc: treasure.text + (treasure.detail ? "<br>" + treasure.detail : "")
  });
}
