/**
 * 小人长相 —— 一条可序列化、可由 seed 复现的"风格"。
 *
 * 上游是 Math.random 不可复现，而且头/脸范围写死在代码里（那个 163 就不是本包的 332）。
 * 这里改成：范围一律来自 pack.maxima，随机一律走项目里已有的种子 Random
 * —— 同一局游戏里，同一栋楼的小人长相永远相同，不需要存盘。
 */

import type { Random } from '@engine/math/Random';
import { hexToRgb, type ColorSet, type DudePack, type PaletteRole } from './pack';

export interface DudeStyle {
  /** base 表里的体型行；本包只有 0 */
  base: number;
  head: number;
  face: number;
  /** 五组调色板各选一色 + 描边色，存十六进制串便于序列化 */
  hex: Record<PaletteRole, string> & { outline: string };
}

const ROLES: PaletteRole[] = ['eyes', 'body', 'item', 'suit', 'more'];

/**
 * 从种子随机出一张脸。
 * `bias` 用来限定头/脸区间（比如只想要有帽子的），不传就是全库。
 */
export function randomStyle(
  rng: Random,
  pack: DudePack,
  bias: { head?: readonly [number, number]; face?: readonly [number, number] } = {},
): DudeStyle {
  const within = (range: readonly [number, number] | undefined, max: number): [number, number] => {
    const lo = Math.max(0, Math.floor(range?.[0] ?? 0));
    const hi = Math.min(max, Math.ceil(range?.[1] ?? max));
    return hi <= lo ? [0, 0] : [lo, hi];
  };

  const [headLo, headHi] = within(bias.head, pack.maxima.head);
  const [faceLo, faceHi] = within(bias.face, pack.maxima.face);

  const hex = {} as Record<PaletteRole, string> & { outline: string };
  for (const role of ROLES) {
    const list = pack.palettes[role];
    hex[role] = list[rng.int(0, list.length)]!;
  }
  // 描边不随机：素材本来就用近黑，换成亮色会让小人在地图上散成一圈噪点
  hex.outline = `#${pack.outline.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

  return {
    base: pack.maxima.base > 0 ? rng.int(0, pack.maxima.base + 1) : 0,
    head: rng.int(headLo, headHi + 1),
    face: rng.int(faceLo, faceHi + 1),
    hex,
  };
}

/** 风格 → 渲染要用的颜色组。 */
export function colorSetOf(style: DudeStyle): ColorSet {
  const palette = {} as Record<PaletteRole, ReturnType<typeof hexToRgb>>;
  for (const role of ROLES) palette[role] = hexToRgb(style.hex[role]);
  return { outline: hexToRgb(style.hex.outline), palette };
}

/** 给读数/调试用的一行短描述。 */
export function styleLabel(style: DudeStyle): string {
  return `体型${style.base} 头${style.head} 脸${style.face} 衣${style.hex.suit} 持${style.hex.item}`;
}
