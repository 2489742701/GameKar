/**
 * **昼夜曲线：唯一判据**（P-099，2026-11-13）。
 *
 * 纯函数、不 import three / DOM，所以 node 里能直接锁。三个消费方读同一份结果：
 * ① `ArenaApp` 灌进 shader 的 `dim` / `tint`；② `#arena-ui` 的 `data-period`
 * （HUD 是 DOM，不吃 WebGL 后期）；③ 设置页 / telemetry 的读数。
 *
 * 设计要点：
 * - **分母是"这一局的总时长"**，曲线全用比例 ⇒ 3 分钟常规局、5 分钟 PVE、
 *   以后的 10 分钟档只换分母，不用改这里；加时超出 1 就钳在夜晚。
 * - **白天 dim 恒为 0、tint 恒为 (1,1,1)**：`postFx` 的开关只看
 *   `tiltEffective || dimAmount`，白天不会因为昼夜功能多跑一帧 composer（P-082 红线）。
 * - 色温是**显示空间**的一次乘法（在 OutputPass 之后），不碰 3D 光照，
 *   所以老模式 `/index.html` 和模组注入的同一套 shader 都不会被牵连。
 * - 单调：压暗只增不减，夕阳 / 夜晚用 smoothstep 过渡，不会在分界处跳一下。
 */

import { DAY_CYCLE, MATCH } from '../config';

export type DayPeriod = 'day' | 'dusk' | 'night';

export type RgbTint = readonly [number, number, number];

export interface DayPhase {
  period: DayPeriod;
  /** 0..1 压暗，灌给 shader 的 `dim` */
  dim: number;
  /** 全屏色温乘子，灌给 shader 的 `tint`；(1,1,1) = 不改色 */
  tint: RgbTint;
  /** 归一化进度 0..1（已钳在 1） */
  progress: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smooth = (t: number): number => {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const mixTint = (a: RgbTint, b: RgbTint, t: number): RgbTint => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

const NEUTRAL: RgbTint = [1, 1, 1];

/** 由归一化进度算一帧的昼夜状态（两个模式共用这一条曲线）。 */
function phaseAtProgress(progress: number): DayPhase {
  const p = clamp01(progress);
  const { duskAt, nightAt, duskDim, nightDim, warmTint, coolTint } = DAY_CYCLE;

  if (p < duskAt) {
    // 白天：dim=0 / tint=单位 ⇒ 零后期开销，别在这里 hand 任何"氛围"
    return { period: 'day', dim: 0, tint: NEUTRAL, progress: p };
  }
  if (p < nightAt) {
    const t = smooth((p - duskAt) / (nightAt - duskAt));
    return {
      period: 'dusk',
      dim: lerp(0, duskDim, t),
      tint: mixTint(NEUTRAL, warmTint, t),
      progress: p,
    };
  }
  const t = smooth((p - nightAt) / (1 - nightAt));
  return {
    period: 'night',
    dim: lerp(duskDim, nightDim, t),
    tint: mixTint(warmTint, coolTint, t),
    progress: p,
  };
}

/**
 * 自动模式：`elapsed / 总时长`。总时长由调用方给（常规 `MATCH.seconds`、
 * PVE 关卡 `level.seconds`、无尽 `DAY_CYCLE.endlessSeconds`），这里不认识模式。
 */
export function dayPhaseAt(elapsed: number, totalSeconds: number): DayPhase {
  const total = totalSeconds > 0 ? totalSeconds : 1;
  return phaseAtProgress(Math.max(0, elapsed) / total);
}

/**
 * 手动模式：滑杆给的是 `dim`，反推同一条曲线上的时段与色温。
 * 这样"拖滑杆"和"时间轴自动走"看到的是同一套画面，不会出现两种夜晚。
 */
export function dayPhaseFromDim(dim: number): DayPhase {
  const { duskAt, nightAt, duskDim, nightDim } = DAY_CYCLE;
  const d = clamp01(dim);
  if (d <= 0.001) return { period: 'day', dim: 0, tint: NEUTRAL, progress: 0 };
  if (d < duskDim) {
    const t = d / duskDim;
    return {
      period: 'dusk',
      dim: d,
      tint: mixTint(NEUTRAL, DAY_CYCLE.warmTint, t),
      progress: lerp(duskAt, nightAt, t),
    };
  }
  const t = clamp01((d - duskDim) / Math.max(1e-6, nightDim - duskDim));
  return {
    period: 'night',
    dim: d,
    tint: mixTint(DAY_CYCLE.warmTint, DAY_CYCLE.coolTint, t),
    progress: lerp(nightAt, 1, t),
  };
}

/**
 * 这一局总时长：按模式选分母，纯函数方便锁。
 * 常规读 `MATCH.seconds`（不写死 180，以后改总时长曲线自动跟着走）；
 * PVE 读关卡自己的秒数；无尽没有倒计时，用 `DAY_CYCLE.endlessSeconds` 走完一昼夜后停夜。
 */
export function dayTotalSeconds(mode: 'arena' | 'pve' | 'endless', levelSeconds?: number): number {
  if (mode === 'endless') return DAY_CYCLE.endlessSeconds;
  if (mode === 'pve') return levelSeconds ?? MATCH.seconds + MATCH.overtimeSeconds;
  return MATCH.seconds;
}
