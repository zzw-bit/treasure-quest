/* ============================================================
 * audio.js —— 音效层（Web Audio API 实时合成，不依赖任何音频文件）
 *
 * 用合成而不是 mp3：零外部资源、不会因为文件缺失而 404，
 * 频率与时长还能随机微调，重复播放不呆板。
 *
 * 浏览器的自动播放策略要求 AudioContext 必须由用户手势创建，
 * 所以这里在首次点击/按键时才初始化（unlock）。
 * ============================================================ */

const Sfx = (() => {
  let ctx = null;
  let master = null;
  let enabled = true;

  /** 懒初始化：必须由用户手势触发 */
  function unlock() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { enabled = false; return null; }
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.28;          // 总音量，别吵到人
      master.connect(ctx.destination);
    } catch (e) {
      enabled = false;
    }
    return ctx;
  }

  /** 单个音符：类型、频率、时长、音量、可选滑音终点 */
  function tone({ freq = 440, dur = 0.12, type = "sine", vol = 0.5, slideTo = null, delay = 0 }) {
    if (!enabled || !unlock()) return;
    const t0 = ctx.currentTime + delay;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);

    // 短促的 ADSR 包络，避免"咔哒"爆音
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 噪声：用于打击/爆炸/陷阱 */
  function noise({ dur = 0.18, vol = 0.4, filterFreq = 1200, delay = 0 }) {
    if (!enabled || !unlock()) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      // 随时间衰减的白噪声
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = filterFreq;

    const gain = ctx.createGain();
    gain.gain.value = vol;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(t0);
  }

  /* ---- 具体音效配方 ---- */
  const RECIPES = {
    /* 金币：两声清脆高音 */
    coin() {
      tone({ freq: 988, dur: 0.09, type: "triangle", vol: 0.45 });
      tone({ freq: 1319, dur: 0.16, type: "triangle", vol: 0.4, delay: 0.07 });
    },
    /* 拿到道具：上行三音 */
    item() {
      [523, 659, 784].forEach((f, i) =>
        tone({ freq: f, dur: 0.14, type: "sine", vol: 0.4, delay: i * 0.07 }));
    },
    /* 打击：低沉方波 + 噪声 */
    hit() {
      tone({ freq: 160, dur: 0.1, type: "square", vol: 0.35, slideTo: 70 });
      noise({ dur: 0.1, vol: 0.3, filterFreq: 2200 });
    },
    /* 受伤：下行滑音 */
    hurt() {
      tone({ freq: 320, dur: 0.22, type: "sawtooth", vol: 0.32, slideTo: 110 });
    },
    /* 守卫低吼：低频长音 */
    roar() {
      tone({ freq: 90, dur: 0.6, type: "sawtooth", vol: 0.4, slideTo: 55 });
      noise({ dur: 0.5, vol: 0.25, filterFreq: 500 });
    },
    /* 陷阱：刺耳下行 + 噪声 */
    trap() {
      tone({ freq: 700, dur: 0.35, type: "square", vol: 0.3, slideTo: 120 });
      noise({ dur: 0.3, vol: 0.35, filterFreq: 900 });
    },
    /* 胜利：四音上行大调琶音 */
    win() {
      [523, 659, 784, 1047].forEach((f, i) =>
        tone({ freq: f, dur: 0.28, type: "triangle", vol: 0.42, delay: i * 0.11 }));
    },
    /* 传说宝藏：更华丽，加一个高音泛音 */
    legendary() {
      [523, 659, 784, 1047, 1319].forEach((f, i) =>
        tone({ freq: f, dur: 0.34, type: "triangle", vol: 0.42, delay: i * 0.1 }));
      tone({ freq: 2093, dur: 0.5, type: "sine", vol: 0.2, delay: 0.55 });
    },
    /* 成就解锁：两音问好 */
    achieve() {
      tone({ freq: 880, dur: 0.12, type: "sine", vol: 0.4 });
      tone({ freq: 1175, dur: 0.3, type: "sine", vol: 0.4, delay: 0.1 });
    },
    /* 成败：失败下行 */
    fail() {
      [392, 330, 262].forEach((f, i) =>
        tone({ freq: f, dur: 0.3, type: "sine", vol: 0.38, delay: i * 0.14 }));
    },
    /* 点击 UI */
    click() {
      tone({ freq: 660, dur: 0.05, type: "square", vol: 0.18 });
    }
  };

  /** 播放指定音效 */
  function play(name) {
    if (!enabled) return;
    const recipe = RECIPES[name];
    if (recipe) { try { recipe(); } catch (e) { /* 静默失败，音效不该影响游戏 */ } }
  }

  function setEnabled(v) { enabled = !!v; }
  function isEnabled() { return enabled; }
  function isReady() { return !!ctx; }

  return { unlock, play, setEnabled, isEnabled, isReady };
})();

window.Sfx = Sfx;
