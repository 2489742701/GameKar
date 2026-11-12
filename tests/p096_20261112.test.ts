/**
 * P-096 锁（2026-11-12）：拖牌影子吸附 / 满场不生成 / 建筑碰撞内缩 /
 * 飞行抬高 / 牧师优先治疗+远程低攻 / 确定性刚体掉落 / 维修锤击图标。
 *
 * 用户原话摘在流水账 P-096。这里每条都配一个**能证伪**的点：
 * 把实现退回旧版（或把关键常量改回去）必须红，不是只断言"字符串存在"。
 * 跨行读源码统一 CRLF → LF（Windows 工作区踩过坑）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld, type ArenaUnit } from '@arena/ArenaWorld';
import { FIELD, UNIT, cardById } from '@arena/config';
import { unitDef } from '@game/data/units';
import { FLYER_STYLE } from '@arena/visuals/flyers';
import { RIGID, rigidPoseAt, stepRigid, type RigidState } from '@arena/visuals/rigidFall';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const app = read('src/arena/ArenaApp.ts');
const world = read('src/arena/ArenaWorld.ts');
const css = read('src/styles/arena.css');
const repair = read('src/arena/visuals/repairButtons.ts');
const ruinView = read('src/arena/visuals/ruinView.ts');
const damage = read('src/arena/damage.ts');

function run(w: ArenaWorld, seconds: number): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) w.update(0.05);
}

/** 直接落一栋完工楼，跳过施工。 */
function built(w: ArenaWorld, kind: 'house' | 'mill', col: number, row: number) {
  const b = w['place']('blue', kind, col, row, 220);
  b.build = 1;
  return b;
}

// ---------------------------------------------------------------- ① 影子

describe('① 拖牌影子：出界卡住、拉远才收', () => {
  it('装配锁：lastCell 吸附 + 距离阈值 + 落牌读同一格', () => {
    expect(app).toContain('const DRAG_HIDE_PX = 180;');
    expect(app).toContain('lastCell: GridPos | null;');
    expect(app).toContain('drag.hidden = Math.hypot(clientX - drag.lastClient.x, clientY - drag.lastClient.y) > DRAG_HIDE_PX;');
    expect(app).toContain('drag.ghost.visible = !drag.hidden;');
    expect(app).toContain('const cell = this.dragCell(clientX, clientY, pointerType) ?? (drag.hidden ? null : drag.lastCell);');
    // 旧版一越界就隐藏的写法不许回来
    expect(app).not.toContain('drag.ghost.visible = cell !== null;');
  });

  it('「选卡 + 场地长按出影子」的入口仍在（PointerInput 三件套）', () => {
    expect(app).toContain('onLongPress: (x, y, pointerType) => this.handleLongPress');
    expect(app).toContain('onGrabMove:');
    expect(app).toContain('onGrabEnd:');
  });
});

// ---------------------------------------------------------------- ② 满场

describe('② 场地满：绝不生成建筑', () => {
  /** 用 3×3 民居铺满蓝方半场（housePopCost=0，不触发人口拦截）。 */
  const full = (): ArenaWorld => {
    const w = new ArenaWorld({ seed: 961 });
    w.auto.red = false;
    for (let row = 0; row + 3 <= FIELD.rows; row += 3) {
      for (let col = 0; col + 3 <= FIELD.cols / 2; col += 3) built(w, 'house', col, row);
    }
    w.gold.blue = 30;
    return w;
  };

  it('一个空位都不剩时，建筑卡落牌被拒、不生成楼、不扣钱', () => {
    const w = full();
    expect(w.hasRoomFor('blue', 'mill')).toBe(false);
    const before = w.buildings.size;
    w.hands.blue[0] = cardById('mill');
    w.handCooldowns.blue[0] = 0;
    const res = w.playCard('blue', 0, 6, 12);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('场地已满');
    expect(w.buildings.size).toBe(before);
    expect(w.gold.blue).toBe(30);
  });

  it('判据在 placementProblem 里，和影子 canPlaceAtOf 同源', () => {
    expect(world).toContain("if (!this.hasRoomFor(side, card.building!)) return '场地已满 · 这座楼放不下了';");
  });
});

// ---------------------------------------------------------------- ③ 碰撞

describe('③ 建筑碰撞体内缩：两楼夹缝能过', () => {
  const pair = (): ArenaWorld => {
    const w = new ArenaWorld({ seed: 962 });
    w.auto.red = false;
    built(w, 'mill', 0, 4); // 占 col 0..2
    built(w, 'mill', 3, 4); // 占 col 3..5，紧贴上一栋
    return w;
  };

  it('楼心仍挡，紧贴边界变成可站的缝', () => {
    const w = pair();
    expect(w['blockedBy'](1.5, 5.5), '楼心必须挡').toBe(true);
    expect(w['blockedBy'](3.0, 5.5), '两楼之间的缝').toBe(false);
    expect(UNIT.buildingInset).toBe(0.16);
  });

  it('反证：内缩归零时，原本能过的 2.9 立刻变回墙里', () => {
    const before = UNIT.buildingInset;
    try {
      // 旧判据（整格 Math.floor）对 x=2.9 一定挡：它落在左边那栋的 col 0..2
      expect(pair()['blockedBy'](2.9, 5.5), '内缩 0.16 时这里是缝').toBe(false);
      UNIT.buildingInset = 0;
      expect(pair()['blockedBy'](2.9, 5.5), '退回整格判定就该挡').toBe(true);
    } finally {
      UNIT.buildingInset = before;
    }
  });

  it('落牌占位仍按整格，不读内缩', () => {
    const w = pair();
    expect(w['cellFree'](0, 4, 3, 3)).toBe(false);
    expect(world).toContain('const inset = UNIT.buildingInset;');
  });
});

// ---------------------------------------------------------------- ④⑤ 飞行 / 牧师

describe('④ 飞行单位再抬一档', () => {
  it('4.8 格，明显高于 P-095 的 3.8', () => {
    expect(FLYER_STYLE.height).toBe(4.8);
    expect(FLYER_STYLE.height).toBeGreaterThan(3.8);
  });
});

describe('⑤ 牧师：远程低攻 + 优先追队友回血', () => {
  const priest = (): ArenaUnit => ({
    id: 9700, side: 'blue', defId: 'priest', x: 10, z: 10,
    hp: 30, maxHp: 30, cooldown: 0, stun: 0, order: null, detour: 1 as const,
  });

  it('兵种表：法术弹道、攻击 3、射程比旧的 2.4 远', () => {
    const d = unitDef('priest');
    expect(d.projectile).toBe('magic');
    expect(d.attack).toBe(3);
    expect(d.range).toBeGreaterThan(2.4);
    expect(d.special?.kind).toBe('heal');
  });

  it('有残血队友在追赶半径内 ⇒ 牧师朝队友跑，且这一帧不开火', () => {
    const w = new ArenaWorld({ seed: 963 });
    w.auto.red = false;
    w.units.push(priest());
    w.units.push({
      id: 9701, side: 'blue', defId: 'knight', x: 14, z: 10,
      hp: 20, maxHp: 60, cooldown: 0, stun: 0, order: null, detour: 1 as const,
    });
    const x0 = w.units[0]!.x;
    run(w, 0.5);
    expect(w.units[0]!.x, '应该往队友那边挪').toBeGreaterThan(x0);
    expect(w.shots, '照顾队友时不许开火').toHaveLength(0);
  });

  it('没有需要治疗的队友 ⇒ 自己远程攻击，且走的是弹道不是近战', () => {
    const w = new ArenaWorld({ seed: 964 });
    w.auto.red = false;
    w.units.push(priest());
    w.units.push({
      id: 9702, side: 'red', defId: 'knight', x: 12.5, z: 10,
      hp: 60, maxHp: 60, cooldown: 999, stun: 0, order: null, detour: 1 as const,
    });
    run(w, 0.3);
    const foe = w.units.find((u) => u.id === 9702)!;
    expect(foe.hp).toBeLessThan(60);
    expect(w.shots.some((s) => s.ammo === 'magic')).toBe(true);
    expect(w.heals).toHaveLength(0);
  });

  it('反证：追赶半径归零 ⇒ 牧师回到普通推进（不再以 1.4 倍速扑向队友）', () => {
    const advance = (): number => {
      const w = new ArenaWorld({ seed: 965 });
      w.auto.red = false;
      w.units.push(priest());
      w.units.push({
        id: 9703, side: 'blue', defId: 'knight', x: 14, z: 10,
        hp: 20, maxHp: 60, cooldown: 0, stun: 0, order: null, detour: 1 as const,
      });
      run(w, 0.5);
      return w.units.find((u) => u.id === 9700)!.x - 10;
    };
    const before = UNIT.priestSeek;
    try {
      const withSeek = advance();
      UNIT.priestSeek = 0;
      const withoutSeek = advance();
      expect(withSeek, '有追赶时应该更快').toBeGreaterThan(withoutSeek + 0.1);
      expect(withoutSeek).toBeGreaterThan(0); // 不是站着发呆，是普速推进
    } finally {
      UNIT.priestSeek = before;
    }
  });
});

// ---------------------------------------------------------------- ⑥ 刚体掉落

describe('⑥ 掉落：确定性刚体，不再手造缓动', () => {
  const body = (): RigidState => ({
    x: 0, y: 3, z: 0, vx: 0.6, vy: 1.2, vz: 0,
    rx: 0.2, ry: 0, rz: -0.1, wx: 2.4, wy: 0, wz: -1.8, floor: 0.25,
  });

  it('重力抛物线：0.2 秒的 y 严格等于解析解', () => {
    const b = body();
    const t = 0.2;
    const p = rigidPoseAt(b, t);
    expect(p.y).toBeCloseTo(3 + 1.2 * t - 0.5 * RIGID.g * t * t, 6);
    expect(p.x).toBeCloseTo(0 + 0.6 * t, 6);
  });

  it('★ 旋转与位移同源推进：落地过程中角度真的在变', () => {
    const b = body();
    const p = rigidPoseAt(b, 0.35);
    expect(p.rx, '旧版旋转从头到尾固定，这里必须变').not.toBeCloseTo(b.rx, 3);
    expect(p.rz).not.toBeCloseTo(b.rz, 3);
  });

  it('不依赖帧率：同一 age 两次求值完全一致', () => {
    const b = body();
    expect(rigidPoseAt(b, 0.73)).toEqual(rigidPoseAt(b, 0.73));
  });

  it('落地后不会穿地，速度耗尽时姿态不再被外部摆正', () => {
    const s = body();
    let rest = false;
    for (let i = 0; i < 400; i++) {
      const r = stepRigid(s, 0.02);
      if (r.rest) { rest = true; break; }
    }
    expect(rest).toBe(true);
    expect(s.y).toBe(s.floor);
    expect(s.wx).toBe(0);
    const still = { ...s };
    stepRigid(still, 0.02);
    expect(still.rx).toBe(s.rx); // 静止后角度不许再被改
  });

  it('装配锁：废墟与墙片共用同一套积分，旧手造缓动已删', () => {
    expect(ruinView).toContain('rigidPoseAt(body, age)');
    expect(ruinView).not.toContain('const ease =');
    expect(ruinView).not.toContain("userData['burst']");
    expect(damage).toContain('stepRigid(s, dt)');
    expect(damage).not.toContain('rotation.set(-Math.PI / 2');
    expect(damage).not.toContain('const GRAVITY = 16;');
  });

  it('反证：把角速度置零，旋转就不该再变（证明确实来自积分）', () => {
    const b = body();
    b.wx = 0; b.wy = 0; b.wz = 0;
    expect(rigidPoseAt(b, 0.35).rx).toBeCloseTo(b.rx, 6);
  });
});

// ---------------------------------------------------------------- ⑦ 维修图标

describe('⑦ 维修 SVG：去边框、锤子敲打', () => {
  it('徽章底板与文字都没了，SVG 自身不再描边', () => {
    const rp = css.slice(css.indexOf('.rp {'), css.indexOf('@keyframes rp-pop'));
    expect(rp).not.toContain('border:');
    expect(rp).not.toContain('background:');
    expect(rp).not.toContain('box-shadow:');
    expect(repair).not.toContain('rp__txt');
    expect(repair).not.toContain('stroke="#5c3b1f"');
    expect(repair).not.toContain('stroke="#4a2f18"');
  });

  it('★ 动作是"举起→砸下→微弹→抬回"，不是绕柄尾左右摆', () => {
    expect(css).toContain('transform-origin: 29px 8px;'); // 柄顶，不是柄尾 30px 31px
    const swing = css.slice(css.indexOf('@keyframes rp-swing'), css.indexOf('@keyframes rp-spark'));
    expect(swing).toContain('translateY(-10px)');
    expect(swing).toContain('translateY(0)');
    expect(swing).toContain('ease-in');
    expect(css).not.toContain('transform-origin: 30px 31px;');
  });
});
