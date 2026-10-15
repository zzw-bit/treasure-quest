/* ============================================================
 * bus.js —— 事件总线（逻辑层 ↔ 渲染层 的解耦桥梁）
 *
 * 逻辑层只广播"发生了什么"，不关心谁来处理：
 *
 *     Bus.emit(Bus.EVT.ITEM_FOUND, clue);
 *
 * 页面层（main.js）订阅自己关心的事件，更新 DOM / canvas：
 *
 *     Bus.on(Bus.EVT.ITEM_FOUND, (item) => { ... });
 *
 * 这样剧情代码里不会掺进 DOM 操作，换一套界面也不用改剧情。
 * ============================================================ */

const Bus = (() => {
  /* 事件名集中定义，避免各处拼错字符串 */
  const EVT = {
    LOG:        "log",          // 写一条日志   payload: { text, kind }
    NARRATE:    "narrate",      // 底部解说字幕 payload: { text, detail }
    ITEM_FOUND: "item:found",   // 拿到道具     payload: item 对象
    /* 剧情节点推进（探险家随之走到对应站点）payload: { id }
       —— 早期的 NODE_MOVE 已被它取代，故不再单独定义 */
    NARRATE_BEAT: "beat",
    /* 「分关闸门」—— 每站结束时广播，等玩家点「进入下一关」
       payload: { id, label, action: "waiting" | "open" } */
    GATE:       "gate",
    PROGRESS:   "progress",     // 进度条       payload: { value } | null
    SHAKE:      "shake",        // 震屏         payload: 强度
    GUARD_ON:   "guard:on",     // 守卫出现
    GUARD_OFF:  "guard:off",    // 守卫退场
    HUD:        "hud",          // 刷新顶部数值 payload: { gold, stamina }
    PHASE:      "phase",        // 阶段标题     payload: { name }
    ACHIEVE:    "achieve",      // 解锁成就     payload: { id, name, icon, desc }
    SFX:        "sfx",          // 播放音效     payload: { name }
    TREASURE_WIN: "treasure:win",   // 宝藏到手，触发"起宝"镜头
    RESULT:     "result",       // 整轮结算     payload: { ok, ... }
    /* 需要返回值的场景（逻辑层问显示层"有没有这个道具"）不走事件，
       而是用下面的 Bus.provide / Bus.request 同步通道。 */
  };

  /* 原生 EventTarget 就够用，不必自己手写订阅表 */
  const target = new EventTarget();

  /** 订阅：返回取消订阅的函数，方便清理 */
  function on(type, handler) {
    const wrapped = (e) => handler(e.detail);
    target.addEventListener(type, wrapped);
    return () => target.removeEventListener(type, wrapped);
  }

  /** 只触发一次 */
  function once(type, handler) {
    const off = on(type, (d) => { off(); handler(d); });
    return off;
  }

  /** 广播事件（容错：单个订阅者抛错不影响其他订阅者） */
  function emit(type, detail) {
    try {
      target.dispatchEvent(new CustomEvent(type, { detail }));
    } catch (err) {
      console.error(`[Bus] 事件 "${type}" 的订阅者出错：`, err);
    }
  }

  /**
   * 同步请求-应答：注册一个"供货方"，别人可以问它要东西。
   * 用于「逻辑层想用道具 → 问显示层有没有、要不要用」这种需要返回值的场景。
   * 只有最后一个注册的供货方生效（本项目只有一个背包）。
   */
  const providers = {};
  function provide(channel, fn) { providers[channel] = fn; }
  function request(channel, query) {
    const fn = providers[channel];
    if (!fn) return null;
    try { return fn(query); }
    catch (err) { console.error(`[Bus] 请求 "${channel}" 出错：`, err); return null; }
  }

  return { EVT, on, once, emit, provide, request };
})();

/* 同时挂到全局，方便页面层与其他文件使用 */
window.Bus = Bus;
