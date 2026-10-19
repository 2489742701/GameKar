/**
 * 全局调参处 —— 数值、颜色、手感集中在这里，其余模块只读不猜。
 */

import type { FlatSize } from '@engine/math/Grid';

export const SIM_HZ = 20;

export const WORLD: FlatSize & { seed: number } = {
  cols: 46,
  rows: 46,
  seed: 20261019,
};

export const CAMERA = {
  /** 俯视角：看得见建筑立面，又看得见屋顶与地板 */
  pitchDeg: 50,
  yawDeg: 45,
  /** 竖屏时短边（宽）期望看到的格数 */
  tilesAcross: 11,
  minTilesAcross: 6,
  maxTilesAcross: 30,
};

export type TerrainType = 'grass' | 'sand' | 'rock' | 'water' | 'vein';

export interface TerrainSpec {
  label: string;
  /** 平铺地块的基色 */
  color: number;
  /** 地块厚度，制造 2.5D 的起伏感 */
  thickness: number;
  buildable: boolean;
  /** 行走与视野阻挡 */
  blocksSight: boolean;
}

export const TERRAIN: Record<TerrainType, TerrainSpec> = {
  grass: { label: '草原', color: 0x6f9a52, thickness: 0.5, buildable: true, blocksSight: false },
  sand: { label: '沙地', color: 0xc2ab74, thickness: 0.46, buildable: true, blocksSight: false },
  rock: { label: '岩脊', color: 0x7d8595, thickness: 0.78, buildable: false, blocksSight: true },
  water: { label: '水域', color: 0x2f6f96, thickness: 0.3, buildable: false, blocksSight: false },
  vein: { label: '晶脉', color: 0x6c5aa6, thickness: 0.56, buildable: true, blocksSight: false },
};

export const TERRAIN_ORDER: readonly TerrainType[] = ['grass', 'sand', 'rock', 'water', 'vein'];

export const RESOURCE_META = {
  gold: { label: '金币', color: 0xffd36b },
  crystal: { label: '晶钻', color: 0x7cd8ff },
} as const;

export type ResourceId = keyof typeof RESOURCE_META;

export const ECONOMY = {
  /** 开局底储：够一次十连（540）+ 一座田庄，第一眼就能把主循环跑通 */
  starting: { gold: 320, crystal: 640 } as Record<ResourceId, number>,
  basePopulationCap: 6,
};

export const UI = {
  /** 竖屏底部坞的高度上限，超过它会挤压战场视野 */
  dockMaxHeightPx: 96,
};
