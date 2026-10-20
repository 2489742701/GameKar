/**
 * 小人系统的锁。
 *
 * 两个特别之处：
 *  1. 直接读仓库里那份**真素材**（pack.json + PNG 的 IHDR 头），
 *     所以"搬资产少一个文件 / 换错包"会当场红，而不是等画面上出现半张脸；
 *  2. 关键断言都配了反例（故意喂错数据），打不红的锁我就不钉。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pos } from '@engine/math/Grid';
import { Random, hashString } from '@engine/math/Random';
import { VEIN_WORK } from '@game/config';
import { buildingDef } from '@game/data/buildings';
import { KNOWN_ANIMS } from '@game/dudes/anims';
import { atlasLayout, frameRect } from '@game/dudes/atlas';
import { frameOf } from '@game/dudes/DudeView';
import { tripSeconds } from '@game/dudes/Miners';
import { SUBSTITUTIONS, hexToRgb, parsePack, type ColorSet, type DudePack, type PaletteRole, type Rgb } from '@game/dudes/pack';
import { compileRules, recolorRgba } from '@game/dudes/recolor';
import { colorSetOf, randomStyle } from '@game/dudes/style';
import { GameWorld } from '@game/world/GameWorld';
import { TileMap } from '@game/world/TileMap';

const asset = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../public/assets/dudes/${name}`, import.meta.url)));

/** PNG 宽高就写在前 24 字节的 IHDR 里，不用解码库。 */
const pngSize = (buf: Buffer): { width: number; height: number } => ({
  width: buf.readUInt32BE(16),
  height: buf.readUInt32BE(20),
});

const GRID = {
  base: pngSize(asset('base.png')),
  heads: pngSize(asset('heads.png')),
  faces: pngSize(asset('faces.png')),
};

const rawPack = () => JSON.parse(asset('pack.json').toString('utf8')) as Record<string, unknown>;
const PACK: DudePack = parsePack(rawPack(), GRID);
const ROLES: PaletteRole[] = ['eyes', 'body', 'item', 'suit', 'more'];

/** 五个部位各给一个一眼能认出来的颜色，好判断"谁换成了谁"。 */
const FIXTURE_COLORS: Record<PaletteRole, string> = {
  eyes: '#ffffff',
  body: '#c08040',
  item: '#20bf20',
  suit: '#3040ff',
  more: '#ff8000',
};

const fixture = (): ColorSet => ({
  outline: [16, 16, 16],
  palette: Object.fromEntries(ROLES.map((r) => [r, hexToRgb(FIXTURE_COLORS[r])])) as Record<PaletteRole, Rgb>,
});

const px = (c: Rgb, a = 255): number[] => [c[0], c[1], c[2], a];
const at = (data: Uint8ClampedArray, i: number): number[] => [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!];

describe('素材包完整性（资产搬运锁）', () => {
  it('三张表按 16x24 整除：头 333 件、脸 103 件、体型 1 行、帧 703 列', () => {
    expect(PACK.w).toBe(16);
    expect(PACK.h).toBe(24);
    expect(PACK.maxima).toEqual({ base: 0, head: 332, face: 102 });
    expect(PACK.frameCols).toBe(703);
  });

  it('五组调色板各 39 色；魔术色 10 条；阴影系数都是 0.5', () => {
    for (const role of ROLES) {
      expect(PACK.palettes[role]).toHaveLength(39);
      expect(PACK.shadow[role]).toBe(0.5);
    }
    expect(Object.keys(PACK.from)).toHaveLength(10);
    expect(PACK.from.eyes).toEqual([255, 0, 0]);
    expect(PACK.from.item).toEqual([255, 0, 255]);
  });

  it('头/脸浮动表在包里：base_run 的头部位移实测 [-1,-2,0,1]', () => {
    expect(PACK.anims).toHaveLength(121);
    expect(PACK.anims).toContain('base_run');
    expect([0, 1, 2, 3].map((f) => PACK.offsetY('head', 'base_run', f))).toEqual([-1, -2, 0, 1]);
    // 越界帧号回 0：宁可不动，也不要画到表外面
    expect(PACK.offsetY('head', 'base_run', 99)).toBe(0);
  });

  it('反例：w=17 除不尽、或表变小到装不下动画，parsePack 当场拒收', () => {
    // 11248 不能被 17 整除
    expect(() => parsePack({ ...rawPack(), w: 17 }, GRID)).toThrow(/整格切开/);
    // 128 能被 16 整除 → 只有 8 列，而 run 要用到第 11 列，必须被拦下
    expect(() => parsePack(rawPack(), { ...GRID, base: { width: 128, height: 24 } })).toThrow(/动画 base_run/);
    // w=0 是坏数据
    expect(() => parsePack({ ...rawPack(), w: 0 }, GRID)).toThrow();
  });
});

describe('换色内核', () => {
  const rules = compileRules(PACK);

  it('六种魔术色各归各位，描边走 outline 而不是调色板', () => {
    const data = new Uint8ClampedArray([
      ...px(PACK.from.outline),
      ...px(PACK.from.eyes),
      ...px(PACK.from.skin),
      ...px(PACK.from.suit),
      ...px(PACK.from.item),
      ...px(PACK.from.more),
    ]);
    expect(recolorRgba(data, rules, fixture())).toBe(6);

    expect(at(data, 0)).toEqual([16, 16, 16]); // outline → colors.outline
    expect(at(data, 1)).toEqual([255, 255, 255]); // eyes
    expect(at(data, 2)).toEqual([192, 128, 64]); // skin → body 调色板
    expect(at(data, 3)).toEqual([48, 64, 255]); // suit
    expect(at(data, 4)).toEqual([32, 191, 32]); // item
    expect(at(data, 5)).toEqual([255, 128, 0]); // more
  });

  it('阴影变体按 0.5 暗化并截断（不是四舍五入）', () => {
    // item #20bf20 = (32,191,32) → 半亮 (16, 95.5→截断 95, 16)；四舍五入会得到 96
    const data = new Uint8ClampedArray([...px(PACK.from.item2), ...px(PACK.from.skin2)]);
    recolorRgba(data, rules, fixture());
    expect(at(data, 0)).toEqual([16, 95, 16]);
    expect(at(data, 1)).toEqual([96, 64, 32]);
  });

  it('眼睛红不被物品品红吞掉：规则顺序 + ±1 容差一起生效', () => {
    const data = new Uint8ClampedArray([...px(PACK.from.eyes), ...px(PACK.from.item)]);
    recolorRgba(data, rules, fixture());
    expect(at(data, 0)).toEqual([255, 255, 255]);
    expect(at(data, 1)).toEqual([32, 191, 32]);
  });

  it('匹配是按通道比的：差 1 命中、差 60 不命中（±1 容差真的在起作用）', () => {
    const rules2 = [
      { source: PACK.from.eyes, palette: 'eyes' as PaletteRole, factor: 1 },
      { source: PACK.from.item, palette: 'item' as PaletteRole, factor: 1 },
    ];
    // item 的蓝通道与 eyes 差 255：不能被第一条截走
    const far = new Uint8ClampedArray(px(PACK.from.item));
    recolorRgba(far, rules2, fixture());
    expect(at(far, 0)).toEqual([32, 191, 32]);

    // 与 eyes 只差 1 的近似色：必须命中第一条
    const near = new Uint8ClampedArray([255, 1, 0, 255]);
    recolorRgba(near, rules2, fixture());
    expect(at(near, 0)).toEqual([255, 255, 255]);
  });

  it('透明像素不动，认不出的颜色原样保留', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 0, 7, 8, 9, 255]);
    expect(recolorRgba(data, rules, fixture())).toBe(0);
    expect(Array.from(data.slice(0, 4))).toEqual([255, 0, 0, 0]);
    expect(Array.from(data.slice(4, 8))).toEqual([7, 8, 9, 255]);
  });

  it('替换表的顺序与条数就是语义本身，少一条或换序都会改变结果', () => {
    expect(SUBSTITUTIONS.map((r) => r.source)).toEqual([
      'outline', 'eyes', 'skin', 'skin2', 'more', 'more2', 'item', 'item2', 'suit', 'suit2',
    ]);
  });
});

describe('风格由种子决定', () => {
  const styleAt = (n: number) => randomStyle(new Random(hashString(`s:${n}`)), PACK);

  it('同 seed 逐字段相同，不同 seed 不会撞同一张脸', () => {
    expect(styleAt(1)).toEqual(styleAt(1));
    const a = styleAt(1);
    const b = styleAt(2);
    expect(a.head === b.head && a.face === b.face && a.hex.suit === b.hex.suit).toBe(false);
  });

  it('400 次取样都在表内（越界就是画到表外面）', () => {
    for (let i = 0; i < 400; i++) {
      const s = randomStyle(new Random(i), PACK);
      expect(s.head).toBeGreaterThanOrEqual(0);
      expect(s.head).toBeLessThanOrEqual(PACK.maxima.head);
      expect(s.face).toBeLessThanOrEqual(PACK.maxima.face);
      expect(s.base).toBeLessThanOrEqual(PACK.maxima.base);
      for (const role of ROLES) expect(hexToRgb(s.hex[role]).length).toBe(3);
    }
  });

  it('bias 越界时夹回可用范围，不抛异常', () => {
    const s = randomStyle(new Random(9), PACK, { head: [1000, 2000], face: [10, 12] });
    expect(s.head).toBe(0);
    expect(s.face).toBeGreaterThanOrEqual(10);
    expect(s.face).toBeLessThanOrEqual(12);
  });

  it('colorSetOf 产出五个部位 + 描边，键名跟 pack.json 一致', () => {
    const set = colorSetOf(styleAt(7));
    expect(Object.keys(set.palette).sort()).toEqual(['body', 'eyes', 'item', 'more', 'suit']);
    expect(set.outline.length).toBe(3);
  });
});

describe('帧表与图集布局', () => {
  it('5 个动画的列号与帧数等于实测：0/1、2/4、7/4、12/4、17/4', () => {
    expect(Object.values(KNOWN_ANIMS).map((a) => `${a.col}/${a.frames}`)).toEqual([
      '0/1', '2/4', '7/4', '12/4', '17/4',
    ]);
  });

  it('17 帧横排 = 272×24；最后一帧不越图集', () => {
    const layout = atlasLayout(PACK);
    // stand1 + idle4 + run4 + hurt4 + die4 = 17
    expect(layout.frameCount).toBe(1 + 4 + 4 + 4 + 4);
    expect(layout.width).toBe(17 * PACK.w);
    expect(layout.height).toBe(24);
    for (const anim of Object.keys(layout.byAnim) as (keyof typeof layout.byAnim)[]) {
      const last = layout.byAnim[anim].frames - 1;
      const rect = frameRect(layout, PACK, anim, last);
      expect(rect.x + rect.w).toBeLessThanOrEqual(layout.width);
    }
  });

  it('die 播到最后一帧停住；stand 恒 0；run 按 fps 循环', () => {
    expect(frameOf('die', 0.001, false)).toBe(0);
    expect(frameOf('die', 99, false)).toBe(KNOWN_ANIMS.die.frames - 1);
    expect(frameOf('stand', 99)).toBe(0);
    // run 是 12fps：0 / 0.05 / 0.1 / 0.2 秒 → 帧号 0,0,1,2
    expect([0, 0.05, 0.1, 0.2].map((t) => frameOf('run', t))).toEqual([0, 0, 1, 2]);
  });
});

describe('运输小人的脚程 == 账上的脚程', () => {
  /** 平地 + 一条矿，把楼摆在离矿 d 格处。 */
  function rig(d: number, id: 'mine' | 'refinery') {
    const map = new TileMap({ cols: 30, rows: 30 });
    const world = new GameWorld(map);
    world.grant('gold', 9999);
    world.addPopulationCap(50);
    const vein = pos(10, 10);
    map.setTerrain(vein, 'vein');
    world.addPermits(id, 1);
    const b = world.build(id, pos(vein.col + d, vein.row))!;
    b.built = true;
    return { world, b };
  }

  it.each([1, 3, 6])('矿井 %i 格外：每趟载重 ÷ 来回秒数 == 经济算出的产出', (d) => {
    const { world, b } = rig(d, 'mine');
    const spec = buildingDef('mine').veinWork!;
    const claim = world.claimsOf(b)[0]!;

    expect(claim.tiles).toBe(d);
    expect(tripSeconds(d, spec.speed)).toBeCloseTo(
      Math.max(VEIN_WORK.overheadTiles, 2 * d) / spec.speed,
      8,
    );
    expect(spec.perTrip / tripSeconds(claim.tiles, spec.speed)).toBeCloseTo(world.yieldOf(b).crystal!, 8);
  });

  it('同一栋楼：小人来回一趟的秒数就是产量倒数（画与账同源）', () => {
    const { world, b } = rig(3, 'refinery');
    const spec = buildingDef('refinery').veinWork!;
    const perSecond = world.yieldOf(b).crystal!;
    expect(perSecond).toBeGreaterThan(0);
    expect(tripSeconds(3, spec.speed)).toBeCloseTo(spec.perTrip / perSecond, 6);
  });

  it('反例：把 2×格数当成 1×格数，等值锁立刻红', () => {
    const { world, b } = rig(3, 'mine');
    const spec = buildingDef('mine').veinWork!;
    const halfTrip = spec.perTrip / (tripSeconds(3, spec.speed) / 2);
    expect(halfTrip).not.toBeCloseTo(world.yieldOf(b).crystal!, 5);
  });
});
