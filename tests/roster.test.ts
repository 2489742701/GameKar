/**
 * 兵种外观（roster）的锁。
 *
 * 这一族的坑是"看着绿，其实什么也没测"，所以每条都配了能让它红的夹具：
 * 空列、非蓝的 suit、换取样顺序 —— 三个方向各打一次。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Random } from '@engine/math/Random';
import { UNITS, unitList, type UnitDef } from '@game/data/units';
import { blueFilter, faceCandidates, headCandidates, isBlue, Roster, styleForUnit } from '@game/dudes/roster';
import { parsePack, type DudePack } from '@game/dudes/pack';
import { decodePng, scanColumns } from './support/pngColumns';

const asset = (name: string): string =>
  fileURLToPath(new URL(`../public/assets/dudes/${name}`, import.meta.url));
const rawPack = (): Record<string, unknown> =>
  JSON.parse(readFileSync(asset('pack.json'), 'utf8') as string) as Record<string, unknown>;

const baseImg = decodePng(asset('base.png'));
const headsImg = decodePng(asset('heads.png'));
const facesImg = decodePng(asset('faces.png'));
const headScan = scanColumns(headsImg, 16);
const faceScan = scanColumns(facesImg, 16);

const GRID = {
  base: { width: baseImg.width, height: baseImg.height },
  heads: { width: headsImg.width, height: headsImg.height },
  faces: { width: facesImg.width, height: facesImg.height },
};

const PACK: DudePack = parsePack(rawPack(), GRID);
/** 把 node 扫出来的"非空列"喂进去，形状和浏览器里 loadPack() 做的完全一致 */
PACK.filled = { heads: headScan.filled, faces: faceScan.filled };

describe('素材空列（node 尺子与浏览器现量对表）', () => {
  it('头表的空格子列号 = 今天在浏览器里逐列数出来的那 14 列，一个不多一个不少', () => {
    expect(headScan.cols).toBe(333);
    expect(headScan.blanks).toEqual([0, 34, 51, 63, 102, 127, 150, 164, 200, 210, 240, 274, 306, 318]);
  });

  it('脸表只有第 0 列是空的 —— 所以"头 + 脸"能叠着画', () => {
    expect(faceScan.cols).toBe(103);
    expect(faceScan.blanks).toEqual([0]);
  });
});

describe('蓝带', () => {
  it('现包 39 色里恰好 5 条蓝，就是量到的那几个十六进制', () => {
    expect(PACK.palettes.suit).toHaveLength(39);
    expect([...blueFilter(PACK.palettes.suit)]).toEqual(['#668da9', '#acc1e4', '#5c699f', '#5a5888', '#7c6da2']);
  });

  it('判据有牙：红的一眼被否，边界差 1 就翻脸', () => {
    expect(isBlue('#5a5888')).toBe(true);
    expect(isBlue('#ca5954')).toBe(false);
    // B 比 R 高正好 25 不算蓝，高 26 才算
    expect(isBlue('#000019')).toBe(false);
    expect(isBlue('#00001a')).toBe(true);
  });

  it('库里一条蓝都没有时退化成全表，而不是抛异常造不出人', () => {
    const noBlue = ['#ff0000', '#00ff00'];
    expect([...blueFilter(noBlue)]).toEqual(noBlue);
  });
});

describe('头型候选：分区 ∩ 非空列', () => {
  it('每个兵种都取得到候选，且全落在自己分区内、且不是空列', () => {
    for (const unit of unitList()) {
      const got = headCandidates(unit, PACK);
      expect(got.length).toBeGreaterThan(0);
      for (const c of got) {
        expect(headScan.filled.has(c)).toBe(true);
        expect(unit.headBands.some(([lo, hi]) => c >= lo && c <= hi)).toBe(true);
      }
    }
  });

  it('分区起点那几空列（51/63/127/164/306）被剔掉', () => {
    expect(headCandidates(UNITS.archer!, PACK)).toEqual(Array.from({ length: 11 }, (_, i) => 52 + i));
    const orc = headCandidates(UNITS.orc!, PACK);
    expect(orc[0]).toBe(64);
    expect(orc).not.toContain(63);
    expect(orc).not.toContain(127);
    expect(headCandidates(UNITS.shade!, PACK)).not.toContain(306);
    expect(headCandidates(UNITS.golem!, PACK)).not.toContain(164);
  });

  it('分区整个落空时退化成"库里任意有画的头"，绝不返回空列', () => {
    const orphan: UnitDef = { ...UNITS.archer!, headBands: [[63, 63], [0, 0]] };
    const got = headCandidates(orphan, PACK);
    expect(got.length).toBe(headScan.filled.size);
    expect(got).not.toContain(63);
    expect(got).not.toContain(0);
  });

  it('还没扫过像素（走 parsePack 那条路）时给第 0 格，不抛', () => {
    const unscanned = parsePack(rawPack(), GRID);
    expect(headCandidates(UNITS.knight!, unscanned)).toEqual([0]);
    expect(() => styleForUnit(UNITS.knight!, new Random('s'), unscanned)).not.toThrow();
  });

  it('脸没给区间就是"这层不画"（第 0 格实测空白）', () => {
    const noFace: UnitDef = { ...UNITS.knight!, faceBand: undefined };
    expect(faceCandidates(noFace, PACK)).toEqual([0]);
    expect(faceCandidates(UNITS.knight!, PACK).every((c) => faceScan.filled.has(c))).toBe(true);
  });
});

describe('阵营色与可复现', () => {
  it('自己人 30 个种子全在蓝带内', () => {
    const blues = new Set<string>(blueFilter(PACK.palettes.suit));
    for (let seed = 0; seed < 30; seed++) {
      for (const unit of unitList().filter((u) => u.faction === 'own')) {
        expect(blues.has(styleForUnit(unit, new Random(`own${seed}`), PACK).hex.suit)).toBe(true);
      }
    }
  });

  it('敌人确实随机：60 个种子出来不止一种衣服色', () => {
    const enemy = unitList().find((u) => u.faction === 'enemy')!;
    const suits = new Set<string>();
    for (let seed = 0; seed < 60; seed++) suits.add(styleForUnit(enemy, new Random(`e${seed}`), PACK).hex.suit);
    expect(suits.size).toBeGreaterThan(1);
  });

  it('同 seed 复现，而且与取样顺序无关（fork 不推进父流）', () => {
    const order = unitList();
    const a = new Roster(PACK, new Random('wave-seed'));
    const b = new Roster(PACK, new Random('wave-seed'));
    const forward = order.map((u) => a.styleFor(u, 2));
    const backward = [...order].reverse().map((u) => b.styleFor(u, 2)).reverse();
    expect(forward).toEqual(backward);
  });

  it('自己人一个兵种一张脸；敌人四张轮换，第 5 个转回第 1 个', () => {
    const roster = new Roster(PACK, new Random('cache'));
    const archer = UNITS.archer!;
    for (const variant of [1, 2, 3, 9]) {
      expect(roster.styleFor(archer, variant)).toEqual(roster.styleFor(archer, 0));
    }
    const raider = UNITS.raider!;
    const enemyHeads = new Set([0, 1, 2, 3].map((v) => roster.styleFor(raider, v).head));
    expect(enemyHeads.size).toBeGreaterThan(1);
    expect(roster.styleFor(raider, 4)).toEqual(roster.styleFor(raider, 0));

    // 纹理张数就是这里的 styleCount：自己人不随队伍规模涨，敌人封顶 4 张
    const own = new Roster(PACK, new Random('own-cache'));
    for (const v of [0, 1, 2, 3, 9]) own.styleFor(archer, v);
    expect(own.styleCount).toBe(1);
    const foe = new Roster(PACK, new Random('foe-cache'));
    for (const v of [0, 1, 2, 3, 4, 5, 6]) foe.styleFor(raider, v);
    expect(foe.styleCount).toBe(4);
  });

  it('每个兵种要烘的动作集合无重复，且含它的攻击与待命动作', () => {
    for (const unit of unitList()) {
      expect(new Set(unit.anims).size).toBe(unit.anims.length);
      expect(unit.anims).toContain(unit.attackAnim);
      expect(unit.anims).toContain(unit.idleAnim);
    }
  });
});
