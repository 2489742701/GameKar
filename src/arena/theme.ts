/**
 * 对战模式的配色与模型对应表 —— 只放"看起来像什么"，不放数值（数值在 config.ts）。
 *
 * 蓝/红不是随手挑的色：它与像素小人衣服的色带**同源**（蓝方取蓝带、红方取红带），
 * 所以地上的人和头顶的水晶不会打架。
 */

import type { Side } from './config';

export const SIDE_COLOR = {
  blue: 0x3f7fe0,
  red: 0xd9453c,
} as const;

export const sideColor = (side: Side): number => SIDE_COLOR[side];

/** 核心头顶那颗水晶：更亮一点，远远就能认出这是要守的东西。 */
export const CORE_COLOR = {
  blue: 0x7cc4ff,
  red: 0xff8f7a,
} as const;

/** 建筑种类 → 模型库里的名字（全部复用老模式已经建好的模型）。 */
export const CARD_MODEL = {
  barracks: 'barracks',
  arrowTower: 'arrowTower',
  cannonTower: 'cannonTower',
  mill: 'mill',
} as const;

/** 卡面底色：建筑偏木、军队偏阵营色。 */
export const cardAccent = (kind: 'building' | 'squad'): number => (kind === 'building' ? 0xd9b25c : 0x8f6de0);
