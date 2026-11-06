/**
 * 对战模式的配色与模型对应表 —— 只放"看起来像什么"，不放数值（数值在 config.ts）。
 *
 * 2026-11-06 起蓝/红不再写死：**阵营色来自玩家的旗帜花色**（banner.ts）。
 * `setSideBanners()` 在开局时注入一次，之后所有 sideColor() / sideBanner() 的读数
 * 都跟着花色走 —— 房顶、水晶、旗布、血条、兵营旗、小人 suit 全是同一条链，
 * 所以"地上的人和头顶的水晶"天然不打架（这是老规矩，见下面旧注释）。
 */

import type { Side } from './config';
import { DEFAULT_BLUE, DEFAULT_RED, hexToInt, type Banner } from './banner';

export const SIDE_COLOR = {
  blue: 0x3f7fe0,
  red: 0xd9453c,
} as const;

/** 当前生效的花色（默认 = 旧的蓝/红，行为和以前一模一样）。 */
const active: Record<Side, Banner> = {
  blue: DEFAULT_BLUE,
  red: DEFAULT_RED,
};

/** 开局注入一次（main.ts 读 localStorage + 敌方模式后调它）。 */
export function setSideBanners(banners: Record<Side, Banner>): void {
  active.blue = banners.blue;
  active.red = banners.red;
}

/** 这一方的花色（旗布图案、小人镶边都从这拿）。 */
export const sideBanner = (side: Side): Banner => active[side];

/** 阵营主色（= 花色主色）。旧的写死值只在没注入时兜底。 */
export const sideColor = (side: Side): number => hexToInt(active[side].primary);

/** 卡面底色：建筑偏木、军队偏阵营色。 */
export const cardAccent = (kind: 'building' | 'squad'): number => (kind === 'building' ? 0xd9b25c : 0x8f6de0);
