/**
 * 2026-11-07 设计文档 A–E 节的锁：发牌裁量 / 三架独立飞行器 / 飞行越障 /
 * 扑翼轰炸机的「直冲 → 投弹 → 出界消失 / 被击毁」四条路径。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld, type ArenaUnit } from '@arena/ArenaWorld';
import { CARDS, FIELD, TECH, cardById } from '@arena/config';
import { FLYER_STYLE, flyerYaw } from '@arena/visuals/flyers';
import { unitDef } from '@game/data/units';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readSrc = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function run(w: ArenaWorld, seconds: number, each?: () => void): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    w.update(0.05);
    each?.();
  }
}

/** 直接摆一栋完工楼（视图逻辑不参与测试）。 */
function place(w: ArenaWorld, side: 'blue' | 'red', col: number, row: number) {
  const b = w['place'](side, 'house', col, row, 220);
  b.build = 1;
  return b;
}

/** 把蓝方半场所有 3×3 可能左上角都堵死（3 格步长铺满，错位空位也必然重叠）。 */
function fillBlueHalf(w: ArenaWorld): void {
  for (let col = 0; col <= 15; col += 3) {
    for (let row = 0; row <= 15; row += 3) place(w, 'blue', col, row);
  }
}

function putCard(w: ArenaWorld, id: string): void {
  w.hands.blue[0] = cardById(id);
  w.handCooldowns.blue[0] = 0;
  w.gold.blue = 20;
}

describe('发牌裁量：没空位只发军队（P-056 A 节）', () => {
  it('空场有位置；铺满后没有；拆一栋又有了', () => {
    const w = new ArenaWorld({ seed: 201 });
    expect(w.buildingRoom('blue')).toBe(true);
    fillBlueHalf(w);
    expect(w.buildingRoom('blue')).toBe(false);
    const first = [...w.buildings.values()].find((b) => b.side === 'blue' && b.kind === 'house')!;
    w.buildings.delete(first.id);
    expect(w.buildingRoom('blue')).toBe(true);
  });

  it('没空位时刷新：4 张全不是建筑卡（后勤/建筑保底都跳过）', () => {
    const w = new ArenaWorld({ seed: 202 });
    fillBlueHalf(w);
    expect(w.reroll('blue').ok).toBe(true);
    expect(w.hands.blue.filter((c) => c?.kind === 'building')).toHaveLength(0);
    expect(w.hands.blue.every((c) => c !== null)).toBe(true);
  });

  it('有空位时恢复：刷新仍保房屋（用户"刷新默认给一张房屋"）', () => {
    const w = new ArenaWorld({ seed: 203 });
    expect(w.reroll('blue').ok).toBe(true);
    expect(w.hands.blue.some((c) => c?.id === 'house')).toBe(true);
  });

  it('反证：判据与落牌共用——没空位时建筑卡落牌必被拒', () => {
    const w = new ArenaWorld({ seed: 204 });
    fillBlueHalf(w);
    putCard(w, 'house');
    expect(w.buildingRoom('blue')).toBe(false);
    const res = w.playCard('blue', 0, 3, 3);
    expect(res.ok).toBe(false);
  });
});

describe('三架独立飞行器与四张新军队（P-056 B 节）', () => {
  it('卡池 23 张；热气球 / 空气螺旋机 / 扑翼轰炸机是三个不同单位', () => {
    expect(CARDS).toHaveLength(25);
    const ids = ['balloon', 'airscrew', 'bomber'];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(cardById(id)).toBeTruthy();
      expect(unitDef(id).flying).toBe(true);
    }
    expect(unitDef('balloon').name).toBe('热气球');
    expect(unitDef('airscrew').name).toBe('空气螺旋机');
    expect(unitDef('bomber').name).toBe('扑翼轰炸机');
    expect(unitDef('bomber').bomber).toBe(true);
    expect(unitDef('balloon').bomber).toBeUndefined();
  });

  it('新卡平衡：地面三张的人数/价格、飞行三架价格与功能定位', () => {
    const men = (id: string) => (cardById(id).squad ?? []).reduce((n, g) => n + g.count, 0);
    expect(cardById('spearmen').cost).toBe(6); expect(men('spearmen')).toBe(3);
    expect(cardById('crossbowmen').cost).toBe(8); expect(men('crossbowmen')).toBe(3);
    expect(cardById('shields').cost).toBe(10); expect(men('shields')).toBe(2);
    expect(cardById('balloon').cost).toBe(12);
    expect(cardById('airscrew').cost).toBe(9);
    expect(cardById('bomber').cost).toBe(14);
    expect(unitDef('crossbowman').range).toBeGreaterThan(unitDef('archer').range);
    expect(unitDef('shieldbearer').hp).toBeGreaterThan(unitDef('knight').hp);
  });
});

describe('飞行越障与扑翼轰炸机（P-056 C/E 节）', () => {
  it('热气球直穿建筑不绕行（地面兵会绕）', () => {
    const w = new ArenaWorld({ seed: 205 });
    w.auto.red = false;
    w.auto.blue = false;
    place(w, 'blue', 12, 9); // 己方楼：挡路但不是敌对目标，气球不会停下打它
    putCard(w, 'balloon');
    expect(w.playCard('blue', 0, 10, 9).ok).toBe(true);
    const b = w.units.find((u) => u.defId === 'balloon')!;
    const z0 = b.z;
    run(w, 4);
    expect(b.x, '越过 12–14 那栋楼的中心 13.5，说明没被挡').toBeGreaterThan(13.5);
    expect(Math.abs(b.z - z0), '不做绕障').toBeLessThan(0.3);
  });

  it('轰炸机：直冲敌方、下方有敌军就投弹（溅射掉血）', () => {
    const w = new ArenaWorld({ seed: 206 });
    w.auto.red = false;
    w.auto.blue = false;
    putCard(w, 'bomber');
    expect(w.playCard('blue', 0, 6, 9).ok).toBe(true);
    const b = w.units.find((u) => u.defId === 'bomber')!;
    const x0 = b.x;
    w.units.push({ id: 9901, side: 'red', defId: 'knight', x: 11, z: 9.5, hp: 200, maxHp: 200, cooldown: 0, stun: 999, order: null, detour: 1, aim: Math.PI });
    let bombSeen = false;
    run(w, 4, () => { if (w.shots.some((s) => s.ammo === 'cannon' && s.source === 'unit')) bombSeen = true; });
    expect(b.x).toBeGreaterThan(x0 + 3);
    expect(bombSeen).toBe(true);
    const foe = w.units.find((u) => u.id === 9901);
    expect(foe ? foe.hp : 0, '炸弹溅射要掉血').toBeLessThan(200);
  });

  it('轰炸机飞出地图 → 直接消失且记进 leftField（视图不播解体）', () => {
    const w = new ArenaWorld({ seed: 207 });
    w.auto.red = false;
    w.auto.blue = false;
    putCard(w, 'bomber');
    expect(w.playCard('blue', 0, 6, 9).ok).toBe(true);
    const b = w.units.find((u) => u.defId === 'bomber')!;
    b.x = FIELD.cols - 0.5;
    run(w, 1.5);
    expect(w.units.some((u) => u.id === b.id)).toBe(false);
    expect(w.leftField.has(b.id)).toBe(true);
  });

  it('反证：地图内被击毁不算离场（leftField 不含它 ⇒ 视图播解体）', () => {
    const w = new ArenaWorld({ seed: 208 });
    w.auto.red = false;
    w.auto.blue = false;
    putCard(w, 'bomber');
    expect(w.playCard('blue', 0, 6, 9).ok).toBe(true);
    const b: ArenaUnit = w.units.find((u) => u.defId === 'bomber')!;
    b.hp = 0;
    run(w, 0.1);
    expect(w.units.some((u) => u.id === b.id)).toBe(false);
    expect(w.leftField.has(b.id)).toBe(false);
  });
});

/**
 * 2026-11-07 中午追加（用户："滑翔机甚至头没有对前，是歪过来滑的；
 * 所有飞行单位飞行高度太小、大小也太小，尤其热气球可以更大一点；
 * 移动火炮和移动弓弩也需要建造工厂才能使用"）。
 */
describe('机头朝向（局部 +Z → 逻辑 aim）', () => {
  /** 局部 +Z (0,0,1) 绕 Y 转 yaw 后在 XZ 平面上的方向。 */
  const forward = (yaw: number): [number, number] => [Math.sin(yaw), Math.cos(yaw)];

  it('四个方向都对得上：+X / -X / +Z / -Z 与任意角', () => {
    for (const aim of [0, Math.PI, Math.PI / 2, -Math.PI / 2, 0.7]) {
      const [fx, fz] = forward(flyerYaw(aim));
      expect(fx, `aim=${aim} 的 x`).toBeCloseTo(Math.cos(aim), 6);
      expect(fz, `aim=${aim} 的 z`).toBeCloseTo(Math.sin(aim), 6);
    }
  });

  it('反证：抄攻城车那套 -aim 会整体歪 90°（就是原来那个 bug）', () => {
    const [sx, sz] = forward(-0); // 攻城车公式在 aim=0 时的朝向
    expect(sx).toBeCloseTo(0, 6);
    expect(sz).toBeCloseTo(1, 6); // 机身朝 +Z，兵却往 +X 走
    const [fx, fz] = forward(flyerYaw(0));
    expect(fx).toBeCloseTo(1, 6);
    expect(fz).toBeCloseTo(0, 6);
  });

  it('装配锁：flying 分支真的设了 rotation.y，开局那一下也给对', () => {
    const app = readSrc('src/arena/ArenaApp.ts');
    expect(app).toContain('entry.obj.rotation.y = flyerYaw(aim)');
    expect(app).toContain('g.rotation.y = flyerYaw(');
    expect(app).not.toContain('FLY_HEIGHT'); // 写死的旧高度不该回来
  });
});

describe('飞行高度与体型', () => {
  it('高度明显高于原来的 1.25 格，又没高到脱离战场', () => {
    expect(FLYER_STYLE.height).toBeGreaterThan(2);
    expect(FLYER_STYLE.height).toBeLessThan(4);
  });

  it('三架都变大，热气球最大（用户点名）', () => {
    const s = FLYER_STYLE.scale;
    expect(s.airscrew).toBeGreaterThan(0.8);
    expect(s.bomber).toBeGreaterThan(0.34);
    expect(s.balloon).toBeGreaterThan(1.2);
    expect(s.balloon).toBeGreaterThan(s.airscrew);
    expect(s.balloon).toBeGreaterThan(s.bomber);
  });

  it('影子跟着体型走，热气球最大', () => {
    expect(FLYER_STYLE.shadow.balloon).toBeGreaterThan(1.2);
    expect(FLYER_STYLE.shadow.balloon).toBeGreaterThanOrEqual(FLYER_STYLE.shadow.airscrew);
  });
});

describe('工厂前置：攻城车也要齿轮工厂', () => {
  it('factoryCards 收齐三架飞行器 + 两台攻城车', () => {
    expect(TECH.factoryCards).toEqual([
      'balloon', 'airscrew', 'bomber', 'mobileCannon', 'ballista',
    ]);
    for (const id of TECH.factoryCards) expect(cardById(id), `${id} 得在卡池里`).toBeTruthy();
  });

  it('没工厂：两张攻城车都被拦；建好工厂才放行', () => {
    const w = new ArenaWorld({ seed: 209 });
    for (const id of ['mobileCannon', 'ballista']) {
      expect(w.techAllows('blue', cardById(id)), `${id} 不该无前置可用`).toBe(false);
    }
    const b = w['place']('blue', 'gearFactory', 10, 6, 700);
    b.build = 1;
    for (const id of ['mobileCannon', 'ballista']) {
      expect(w.techAllows('blue', cardById(id)), `${id} 建厂后该解锁`).toBe(true);
    }
  });
});
