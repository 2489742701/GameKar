/**
 * 建筑朝向（2026-11-07 设计文档 B 节）。
 *
 * 用户："占地都是 3×3，朝向可以随机一点，这样更有意思"。
 * 四个正方向（90° 一档）+ ±0.04 rad 小抖动；用 `落点+建筑类型` 做 key，
 * 保证：① 同 seed 同摆法朝向稳定；② 拖拽影子和落成模型的朝向一致。
 *
 * 不引入随机数状态机（逻辑层全走 seeded rng 的规矩），纯哈希即可复现。
 */
import { hashString } from '@engine/math/Random';

const QUARTER = Math.PI / 2;

/** 按 key 给一个稳定的朝向（弧度，绕 Y）。 */
export function spinOf(key: string): number {
  const h = Math.abs(hashString(key));
  const quarter = h % 4;
  const jitter = ((h >>> 5) % 9 - 4) * 0.01; // -0.04..0.04 rad
  return quarter * QUARTER + jitter;
}

/** 楼体落成时用的 key：位置 + 类型。 */
export const buildingSpinKey = (col: number, row: number, kind: string): string =>
  `${col},${row},${kind}`;
