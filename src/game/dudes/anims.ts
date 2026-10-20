/**
 * 动画帧表 —— 上游 base.png 里每个动画占哪几列、循环几帧。
 *
 * 下面每一条的 (列号, 帧数) 都是在跑起来的原版里逐条量出来的，不是从代码里推的：
 * 列号来自 getAnimX0，帧数来自 modF 的循环周期。最大用到 691 列 ≤ 本包 703 列。
 * 只收这局游戏要用的动作；加新动作时只要往这张表里添一行。
 */

export type AnimName =
  | 'stand'
  | 'idle'
  | 'run'
  | 'hurt'
  | 'die'
  | 'sword'
  | 'shield'
  | 'staff'
  | 'wand'
  | 'bowTall'
  | 'bowShort'
  | 'idleSword'
  | 'idleShield'
  | 'idleStaff'
  | 'idleWand'
  | 'idleBow'
  | 'cast'
  | 'heal'
  | 'dash'
  | 'knocked'
  | 'respawn';

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
  // 基础位移与生死
  stand: { key: 'base_stand', col: 0, frames: 1, fps: 1 },
  idle: { key: 'base_idle', col: 2, frames: 4, fps: 9 },
  run: { key: 'base_run', col: 7, frames: 4, fps: 12 },
  hurt: { key: 'base_hurt', col: 12, frames: 4, fps: 12 },
  die: { key: 'base_die', col: 17, frames: 4, fps: 8 },
  // 近战攻击
  sword: { key: 'weapon_sword_atk_melee', col: 662, frames: 6, fps: 14 },
  staff: { key: 'weapon_staff_atk_melee', col: 669, frames: 6, fps: 14 },
  wand: { key: 'weapon_wand_atk_melee', col: 676, frames: 6, fps: 14 },
  shield: { key: 'weapon_shield_atk_melee', col: 683, frames: 8, fps: 14 },
  // 远程攻击
  bowTall: { key: 'weapon_bow_tall_fire_fast', col: 590, frames: 5, fps: 14 },
  bowShort: { key: 'weapon_bow_short_fire_fast', col: 616, frames: 5, fps: 14 },
  // 待命时手里那件家伙的姿态（和上面不是同一批列）
  idleSword: { key: 'weapon_sword_idle', col: 530, frames: 4, fps: 9 },
  idleShield: { key: 'weapon_shield_idle', col: 535, frames: 4, fps: 9 },
  idleStaff: { key: 'weapon_staff_idle', col: 540, frames: 4, fps: 9 },
  idleWand: { key: 'weapon_wand_idle', col: 545, frames: 4, fps: 9 },
  idleBow: { key: 'weapon_bow_tall_idle', col: 550, frames: 4, fps: 9 },
  // 法术与治疗
  cast: { key: 'spell_casting', col: 291, frames: 8, fps: 12 },
  heal: { key: 'life_heal', col: 193, frames: 6, fps: 11 },
  // 被冲撞/击飞与补员出场
  dash: { key: 'dash_one', col: 239, frames: 4, fps: 16 },
  knocked: { key: 'knock_back_one', col: 164, frames: 4, fps: 12 },
  respawn: { key: 're_spawn', col: 91, frames: 6, fps: 12 },
};

/** 矿工与建筑旁跑动的只要这几条；默认集保持和 P-001 一致（1+4+4+4+4 = 17 帧）。 */
export const BASE_ANIMS: AnimName[] = ['stand', 'idle', 'run', 'hurt', 'die'];

export const ANIM_NAMES = BASE_ANIMS;

export const animSpec = (name: AnimName): AnimSpec => KNOWN_ANIMS[name];

/** 一组动画需要的总帧数，用来先算图集宽度再决定烘不烘。 */
export function framesOfSet(anims: readonly AnimName[]): number {
  return anims.reduce((sum, a) => sum + KNOWN_ANIMS[a].frames, 0);
}

/** 该动画在给定时间点的帧号；frames=1 时恒为 0。 */
export function frameAt(name: AnimName, time: number, loop = true): number {
  const spec = KNOWN_ANIMS[name];
  if (spec.frames <= 1) return 0;
  const raw = Math.floor(time * spec.fps);
  return loop ? raw % spec.frames : Math.min(raw, spec.frames - 1);
}
