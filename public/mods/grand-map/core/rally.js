/**
 * 点击地面集结军队 + 行军（2026-11-09，P-087 续；2026-11-15 接原版战斗口径）。
 *
 * 老模式 `/index.html` 里这条链路是：`GameWorld.setRally(id, cell)` → 旗子钉在集合点
 * → 产兵建筑出的兵往旗子走；交互是「旗架拿旗 → 点地面落旗」。
 * 大地图是**热插拔模组**，不许 import 主程序，所以在模组内复刻同一条状态机，
 * 只是把三步简化成用户要的「点一下地面就集结」。
 *
 * ## 战斗数值一律从原版 `unitDef()` 读（2026-11-15）
 *
 * 用户：「单位战斗原版中就有了」。所以这里**不写死攻防血**，每个兵都带
 * `hp / maxHp / attack / defense / range / cooldown`，全部来自 `host.engine.unitDef(id)`。
 * 伤害走同一套 `damageOf(攻, 防) = max(1, 攻 − 防)`——和 /arena.html 一字不差。
 *
 * 这样做的意义：以后调平衡改的是 `src/game/data/units.ts` 一处，
 * 老模式、对战模式、大地图三条线**同时**跟着变，不会再出现"模组里那套数是上一版的"。
 *
 * 纯规则层：零 three / 零 DOM，位置一律用**格坐标浮点**（视图层自己 cellToWorld），
 * 可 `node --test` 直接验。`unitDef` 由调用方注入（node 里给个桩也能测）。
 */
import * as M from './map.js';

/** 行进速度（格/秒）。地图半径 38 格，从主城走到中心约 5 秒，看得清但不用干等。 */
export const MARCH_SPEED = 6.5;
/** 到位后围绕旗子散开，别叠成一坨 */
const RING = 12;
/** 视野：看见这个范围内最近的敌人就贴上去打（和原版 `UNIT.sight` 同量级） */
export const SIGHT = 4.2;
/** 一次 tick 最多推进多少秒，防卡帧跳跃 */
const MAX_DT = 0.1;

/**
 * 用原版兵种表给一个兵算出初始战斗状态。
 *
 * `def` 至少要有 hp / attack / defense / range / cooldown；
 * 缺字段时退到保守默认值（不抛），因为模组的兵卡 id 可能比原版表晚一步。
 */
function combatStateOf(def) {
  const hp = Number(def?.hp) || 30;
  return {
    maxHp: hp,
    hp,
    attack: Number(def?.attack) || 5,
    defense: Number(def?.defense) || 0,
    range: Number(def?.range) || 1,
    cooldown: Number(def?.cooldown) || 1,
    /** 距离下次能出手还剩几秒 */
    ready: 0,
    role: def?.role ?? 'melee',
  };
}

export function createRally(deps = {}) {
  /**
   * 原版兵种查询。**必须由 host 注入**（`host.engine.unitDef`），
   * 模组不许 import 主程序。测试里可以传桩函数。
   */
  const unitDef = typeof deps.unitDef === 'function' ? deps.unitDef : null;
  /**
   * 原版伤害公式。没注入时退回同一条式子（`max(1, 攻 − 防)`），
   * 保证 node 自测在没有 hosting 的情况下仍能验战斗。
   */
  const damageOf = typeof deps.damageOf === 'function'
    ? deps.damageOf
    : (atk, dfn) => Math.max(1, atk - dfn);

  let enabled = true;
  let flag = null;                 // { col, row } | null
  let nextId = 1;
  const units = [];                // 见 spawn() 里的形状
  let seed = 20261109;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  function targetFor(id) {
    const i = (id - 1) % RING;
    const ring = Math.floor((id - 1) / RING);
    const a = (Math.PI * 2 * i) / RING;
    const r = 0.7 + ring * 0.5;
    return { col: flag.col + Math.cos(a) * r, row: flag.row + Math.sin(a) * r };
  }

  function retarget() {
    if (!flag) return;
    for (const u of units) {
      const t = targetFor(u.id);
      u.targetCol = t.col;
      u.targetRow = t.row;
      u.arrived = false;
    }
  }

  /** 点地面插旗。军队可以站道路上（「道路不能建造，但军队可以拦」），所以道路不拦。 */
  function dropFlag(col, row) {
    if (!enabled) return { ok: false, reason: '集结功能没启用：先点顶栏「集结」' };
    if (!M.inHex(col, row)) return { ok: false, reason: '旗子得插在地图里' };
    flag = { col, row };
    retarget();
    return { ok: true, flag: { ...flag } };
  }

  /**
   * 打出军队卡 ⇒ 从落牌点拉出一队兵；没插旗就原地待命。
   *
   * `unitId` 是要按原版表算战斗数值的兵种 id（比如 `archer` / `knight`）。
   * 给不出就用卡 id 兜底，再失败就走默认值 —— 不能让一张卡因为查不到兵种就出不来。
   */
  function spawn(col, row, count, card = 'militia', unitId = null) {
    const made = [];
    // 一个卡 id → 一个兵种 id 的推测：原版卡与兵种大多同名或同族
    const lookupId = unitId ?? card;
    let def = null;
    if (unitDef) {
      try { def = unitDef(lookupId); } catch { def = null; }
    }
    for (let i = 0; i < count; i++) {
      const u = {
        id: nextId++,
        col: col + (rnd() - 0.5) * 0.6,
        row: row + (rnd() - 0.5) * 0.6,
        targetCol: col,
        targetRow: row,
        moving: false,
        arrived: !flag,
        card,
        unitId: lookupId,
        ...combatStateOf(def),
      };
      if (flag) {
        const t = targetFor(u.id);
        u.targetCol = t.col;
        u.targetRow = t.row;
      }
      units.push(u);
      made.push(u);
    }
    return made;
  }

  /**
   * 一个兵打一下：伤害走**原版同一条公式**，返回实际掉血。
   * 单独抽出来是为了让视图层能播特效、也让测试能直断数字。
   */
  function strike(attacker, target) {
    const dmg = damageOf(attacker.attack, target.defense);
    target.hp = Math.max(0, target.hp - dmg);
    return dmg;
  }

  /** 逐帧向集结点行进 + 冷却推进。到位后停住，视图层据此切 run / idle。 */
  function tick(dt) {
    const d = Math.min(dt, MAX_DT);
    const step = MARCH_SPEED * d;
    for (const u of units) {
      // 冷却一律推进，哪怕站着不动（驻军也得回气）
      u.ready = Math.max(0, u.ready - d);
      if (!flag || u.arrived) { u.moving = false; continue; }
      const dc = u.targetCol - u.col;
      const dr = u.targetRow - u.row;
      const dist = Math.hypot(dc, dr);
      if (dist <= 0.06) { u.arrived = true; u.moving = false; continue; }
      const k = Math.min(1, step / dist);
      u.col += dc * k;
      u.row += dr * k;
      u.moving = true;
    }
    // 尸体不进下一帧：血归零的当场清掉（视图层靠 alive 集合自己收模型）
    for (let i = units.length - 1; i >= 0; i--) {
      if (units[i].hp <= 0) units.splice(i, 1);
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) for (const u of units) u.moving = false;
    return enabled;
  }

  function reset() {
    flag = null;
    units.length = 0;
    nextId = 1;
    seed = 20261109;
  }

  return {
    get enabled() { return enabled; },
    get flag() { return flag ? { ...flag } : null; },
    get units() { return units; },
    dropFlag,
    spawn,
    strike,
    tick,
    setEnabled,
    reset,
  };
}
