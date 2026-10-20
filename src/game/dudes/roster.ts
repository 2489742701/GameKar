/**
 * 兵种外观 —— 把单位表的头型区间 + 阵营色，翻成一张可复现的 DudeStyle。
 *
 * 两条硬规矩（都是实测逼出来的，见计划板 P-002 §8）：
 * 1. **头/脸一律"分区 ∩ 非空列"**，不写死列号。头表第 0 列与 14 个分区的起始列都是空格子，
 *    写死列号将来换个数据包就会画出一个透明人。
 * 2. **自己人强制蓝衣带，敌人随机**。蓝带也是现量的：suit 调色板 39 色里满足
 *    `B > R+25 且 B > G+15` 的有 5 条（#668da9 #acc1e4 #5c699f #5a5888 #7c6da2），
 *    索引 21–25。这里按同一个判据现场扫，不写死这 5 个值。
 *
 * 随机一律走 fork(label)：fork 不推进父流状态，所以取样的先后顺序不影响结果 ——
 * 同一局里 (阵营:兵种:变体) 这个键永远同一张脸。
 */

import type { Random } from '@engine/math/Random';
import type { UnitDef } from '@game/data/units';
import { hexToRgb, type DudePack } from './pack';
import { randomStyle, type DudeStyle } from './style';

/** 蓝判据：蓝通道至少比红高 25、比绿高 15（现量把 39 色分成 5 蓝 / 34 非蓝） */
export const isBlue = (hex: string): boolean => {
  const [r, g, b] = hexToRgb(hex);
  return b > r + 25 && b > g + 15;
};

/** 一组可用色里挑出蓝带；没有蓝就原样返回（换个数据包不至于造不出人）。 */
export const blueFilter = (list: readonly string[]): readonly string[] => {
  const blue = list.filter(isBlue);
  return blue.length > 0 ? blue : list;
};

/** 头型候选：单位给的若干区间，逐个和"非空列"求交。 */
export function headCandidates(unit: UnitDef, pack: DudePack): number[] {
  const out: number[] = [];
  for (const [lo, hi] of unit.headBands) {
    for (let c = Math.max(0, lo); c <= Math.min(pack.maxima.head, hi); c++) {
      if (pack.filled.heads.has(c)) out.push(c);
    }
  }
  if (out.length > 0) return out;
  // 分区在这个包里全空（换了个不相容的数据包）：退化成"库里任意有画的头"，
  // 而不是画一个透明人 —— 宁可长得不像本兵种，也别在地图上消失。
  const any = [...pack.filled.heads].sort((a, b) => a - b);
  // 扫描结果本身为空（走 parsePack 那条路拿不到像素）时给空格子，别让 pick() 抛异常
  return any.length > 0 ? any : [0];
}

/** 脸型候选；不给区间或求交为空就返回 [0] —— 第 0 列实测是空格子，等于"这层不画"。 */
export function faceCandidates(unit: UnitDef, pack: DudePack): number[] {
  if (!unit.faceBand) return [0];
  const out: number[] = [];
  const [lo, hi] = unit.faceBand;
  for (let c = Math.max(0, lo); c <= Math.min(pack.maxima.face, hi); c++) {
    if (pack.filled.faces.has(c)) out.push(c);
  }
  return out.length > 0 ? out : [0];
}

export function styleForUnit(unit: UnitDef, rng: Random, pack: DudePack): DudeStyle {
  const style = randomStyle(rng, pack);
  const suits = unit.faction === 'own' ? blueFilter(pack.palettes.suit) : pack.palettes.suit;
  return {
    ...style,
    head: rng.pick(headCandidates(unit, pack)),
    face: rng.pick(faceCandidates(unit, pack)),
    hex: { ...style.hex, suit: rng.pick(suits) },
  };
}

/** 自己人一个兵种一张脸（队伍看着齐），敌人每兵种 4 张轮换（要的就是杂乱感）。 */
const VARIANTS: Record<UnitDef['faction'], number> = { own: 1, enemy: 4 };

/**
 * 外观缓存。兵营/波次每次要长相都来这里取，同 (兵种,变体) 复用同一张脸，
 * 因此烘出的纹理图集张数有上限 —— 这个数直接进 HUD 的 dudeStyles 读数。
 */
export class Roster {
  private readonly cache = new Map<string, DudeStyle>();

  constructor(
    private readonly pack: DudePack,
    private readonly rng: Random,
  ) {}

  styleFor(unit: UnitDef, variant = 0): DudeStyle {
    const count = VARIANTS[unit.faction];
    const key = `${unit.faction}:${unit.id}:${Math.abs(variant) % count}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const made = styleForUnit(unit, this.rng.fork(key), this.pack);
    this.cache.set(key, made);
    return made;
  }

  get styleCount(): number {
    return this.cache.size;
  }
}
