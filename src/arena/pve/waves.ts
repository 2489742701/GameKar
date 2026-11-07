/**
 * PVE 的波次数据（2026-11-07）。
 *
 * 口径见 `docs/工作笔记/PVE模式设计_20261107.md` §4/§5：
 * - 一条推进方向（沿 -col 走向玩家的家）、**多个出生行** —— 多路感来自出生点，不做分道地图；
 * - 波次表是纯数据，`levels.ts` 组关卡，`ArenaWorld.tickWaves` 照表生成；
 * - 波次表**不碰金币/后勤**：怪不吃面包、不占人口、不产金。
 */

/**
 * 一波里的一组怪。
 *
 * `row` 不填就在这一波的 `lane` 里按 seed 分散（同一波不会全挤在一行）。
 */
export interface WaveSpawn {
  unitId: string;
  count: number;
  /** 固定出生行（不填 = 在 lane 里散开） */
  row?: number;
  /** 出生时彼此的间距（格），默认 0.55 —— 太挤会被碰撞分离挤成一坨 */
  gap?: number;
}

export interface Wave {
  /** 开打后第几秒来 */
  at: number;
  /** 这一波的出生行范围 [from, to]（不填 = 用关卡的默认 lane） */
  lane?: [number, number];
  /** 这一波的出生列（不填 = 用关卡的 spawnCol） */
  col?: number;
  /** 这一波是谁来（数据驱动，改关卡只改这里） */
  spawns: WaveSpawn[];
  /** 精英波：HUD 标红、来袭提示重一档 */
  elite?: boolean;
}

/** 一波里总共有几个单位（HUD 的"这一波 N 个"读数）。 */
export function waveSize(w: Wave): number {
  return w.spawns.reduce((n, s) => n + s.count, 0);
}

/** 整关有多少个怪（给 HUD 的进度条用；不是判据）。 */
export function levelSize(waves: Wave[]): number {
  return waves.reduce((n, w) => n + waveSize(w), 0);
}
