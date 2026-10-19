/**
 * 地表装饰物 —— 树、岩、晶簇。
 * 它们不参与玩法，但地图一旦没有它们就会像棋盘而不是像世界。
 */

import { PAL, box, cone, crystal, cyl, plinth, sphere, type ModelSpec } from './kit';

export const broadleaf: ModelSpec = [
  cyl([0.055, 0.08, 0.4], PAL.woodDark, [0, 0.2, 0], 5),
  sphere(0.3, PAL.grassTuft, [0, 0.62, 0], 1),
  sphere(0.19, 0x86b45c, [0.16, 0.5, 0.1], 1),
];

export const pine: ModelSpec = [
  cyl([0.05, 0.07, 0.3], PAL.woodDark, [0, 0.15, 0], 5),
  cone([0.32, 0.5], 0x3f6b43, [0, 0.42, 0], 6),
  cone([0.24, 0.42], 0x4a7a4e, [0, 0.74, 0], 6),
  cone([0.15, 0.3], 0x558a58, [0, 1.02, 0], 6),
];

export const bush: ModelSpec = [
  sphere(0.2, 0x5d8a4a, [0, 0.14, 0], 0),
  sphere(0.13, 0x6f9a52, [0.16, 0.1, 0.08], 0),
];

export const rockCluster: ModelSpec = [
  sphere(0.32, PAL.stone, [0, 0.16, 0], 0),
  sphere(0.18, PAL.stoneDark, [0.3, 0.09, 0.14], 0),
  box([0.24, 0.12, 0.2], PAL.stoneDark, [-0.28, 0.06, -0.1]),
];

/** 晶脉上的发光簇：告诉玩家"这块地值得占"。 */
export const crystalCluster: ModelSpec = [
  plinth([0.7, 0.1, 0.7], PAL.stoneDark, [0, 0, 0]),
  crystal([0.14, 0.66], PAL.crystal, [0, 0.34, 0], {
    emissive: PAL.crystal,
    emissiveIntensity: 0.85,
    rough: 0.2,
  }),
  crystal([0.09, 0.4], PAL.glow, [0.24, 0.22, 0.14], {
    emissive: PAL.glow,
    emissiveIntensity: 0.8,
    rough: 0.2,
  }),
  crystal([0.07, 0.3], PAL.crystal, [-0.22, 0.17, -0.16], {
    emissive: PAL.crystal,
    emissiveIntensity: 0.7,
  }),
];

/** 残骸：将来建筑被拆/被毁时的占位视觉。 */
export const rubble: ModelSpec = [
  box([0.5, 0.14, 0.4], PAL.stoneDark, [-0.2, 0.07, 0.1]),
  box([0.34, 0.1, 0.3], PAL.wallDark, [0.24, 0.05, -0.2]),
  sphere(0.16, PAL.stone, [0.05, 0.1, 0.24], 0),
];

export const propModels: Record<string, ModelSpec> = {
  broadleaf,
  pine,
  bush,
  rockCluster,
  crystalCluster,
  rubble,
};
