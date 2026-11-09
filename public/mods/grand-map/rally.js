/**
 * 点击地面集结军队（2026-11-09，P-087 续）。
 *
 * 老模式 `/index.html` 里这条链路是：`GameWorld.setRally(id, cell)` → 旗子钉在集合点
 * → 产兵建筑出的兵往旗子走；交互是「旗架拿旗 → 点地面落旗」。
 * 大地图是**热插拔模组**，不许 import 主程序，所以在模组内复刻同一条状态机，
 * 只是把三步简化成用户要的「点一下地面就集结」。
 *
 * 纯规则层：零 three / 零 DOM，位置一律用**格坐标浮点**（视图层自己 cellToWorld），
 * 可 `node --test` 直接验。
 */
import * as M from './map.js';

/** 行进速度（格/秒）。地图半径 38 格，从主城走到中心约 5 秒，看得清但不用干等。 */
export const MARCH_SPEED = 6.5;
/** 到位后围绕旗子散开，别叠成一坨 */
const RING = 12;

export function createRally() {
  let enabled = true;
  let flag = null;                 // { col, row } | null
  let nextId = 1;
  const units = [];                // { id, col, row, targetCol, targetRow, moving, arrived, card }
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

  /** 打出军队卡 ⇒ 从落牌点拉出一队兵；没插旗就原地待命。 */
  function spawn(col, row, count, card = 'militia') {
    const made = [];
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

  /** 逐帧向集结点行进。到位后停住，视图层据此切 run / idle。 */
  function tick(dt) {
    const step = MARCH_SPEED * Math.min(dt, 0.1);
    for (const u of units) {
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
    tick,
    setEnabled,
    reset,
  };
}
