/**
 * 动画帧表 —— 上游 base.png 里每个动画占哪几列。
 *
 * 只收这局游戏要用的 5 个。列号与帧数都是从上游代码读出来的实测值，
 * 不是按"两个动画之间的间隙"推的：idle 占 2-6 共 5 列，但循环长度是 4，第 6 列是余量。
 * 全量 121 个动画（跳跃/变形/施法…）等真需要时再加，加的时候只要动这一张表。
 */

export type AnimName = 'stand' | 'idle' | 'run' | 'hurt' | 'die';

export interface AnimSpec {
  /** 素材里的动画名，也是 pack.json 里 parts.head/face 的索引键 */
  key: string;
  /** 起始列 */
  col: number;
  /** 循环帧数 */
  frames: number;
  /** 每秒切几帧；上游预览是 110ms/帧 ≈ 9fps */
  fps: number;
}

export const KNOWN_ANIMS: Record<AnimName, AnimSpec> = {
  stand: { key: 'base_stand', col: 0, frames: 1, fps: 1 },
  idle: { key: 'base_idle', col: 2, frames: 4, fps: 9 },
  run: { key: 'base_run', col: 7, frames: 4, fps: 12 },
  hurt: { key: 'base_hurt', col: 12, frames: 4, fps: 12 },
  die: { key: 'base_die', col: 17, frames: 4, fps: 8 },
};

export const ANIM_NAMES = Object.keys(KNOWN_ANIMS) as AnimName[];

/** 该动画在给定时间点的帧号；frames=1 时恒为 0。 */
export function frameAt(name: AnimName, time: number, loop = true): number {
  const spec = KNOWN_ANIMS[name];
  if (spec.frames <= 1) return 0;
  const raw = Math.floor(time * spec.fps);
  if (!loop && raw >= spec.frames) return spec.frames - 1;
  return raw % spec.frames;
}
