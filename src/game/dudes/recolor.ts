/**
 * 换色内核 —— 把素材里的"魔术色"整像素替换成调色板颜色。
 *
 * 上游的做法：素材用固定颜色标记语义（绿=皮肤、蓝=衣服、品红=手持物、青=头发、红=眼睛、黄=描边），
 * 渲染时逐像素匹配后改写；带 2 的是同一色的阴影变体，按 shadowMod 暗化。
 * 这里按同一套语义重写（不搬上游代码），键名跟随 pack.json，
 * 不跟随上游那两个反着命名的 UI 变量（palBody 其实指向眼睛调色板）。
 */

import { SUBSTITUTIONS, type ColorSet, type DudePack, type PaletteRole, type Rgb, type SourceRole } from './pack';

/** 一条替换规则：命中这个源色 → 换成那个调色板的色，乘上系数。palette 为 null 表示描边。 */
export interface Rule {
  source: Rgb;
  palette: PaletteRole | null;
  factor: number;
}

/**
 * 容差 ±1，和上游 `isSame` 一致。这个数字不能放宽：
 * eyes 是纯红 (255,0,0)、item 是品红 (255,0,255)，只差一个通道；
 * skin (0,255,0) 与 skin2 (0,136,0) 又只差一个通道 —— 放宽就会互相吞色。
 */
const TOLERANCE = 1;

const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

/** 顺序即语义：SUBSTITUTIONS 的先后决定谁先命中，别重排。 */
export function compileRules(pack: Pick<DudePack, 'from' | 'shadow'>): Rule[] {
  return SUBSTITUTIONS.map(({ source, palette, shadowed }) => ({
    source: pack.from[source as SourceRole],
    palette,
    factor: palette && shadowed ? pack.shadow[palette] : 1,
  }));
}

/** 暗化用截断而不是四舍五入，和上游 parseInt 的行为对齐（差 1 个色阶，但两边要一致）。 */
const shade = (value: number, factor: number): number => (factor >= 1 ? value : Math.trunc(value * factor));

/**
 * 就地替换 RGBA 缓冲。alpha 一律不动，所以透明区域照旧透明；
 * 没命中任何魔术色的像素**原样保留**（素材里的抗锯齿细节色就是这类）。
 * 返回被改写的像素数，给测试和读数用。
 */
export function recolorRgba(data: Uint8ClampedArray, rules: readonly Rule[], colors: ColorSet): number {
  let touched = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;

    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;

    for (const rule of rules) {
      const s = rule.source;
      if (!near(s[0], r) || !near(s[1], g) || !near(s[2], b)) continue;

      const rgb: Rgb = rule.palette ? colors.palette[rule.palette] : colors.outline;
      data[i] = shade(rgb[0], rule.factor);
      data[i + 1] = shade(rgb[1], rule.factor);
      data[i + 2] = shade(rgb[2], rule.factor);
      touched++;
      break;
    }
  }
  return touched;
}
