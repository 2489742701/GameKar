/**
 * 视角导演 —— 几个固定机位 + 自动移动。
 *
 * 用户要"多个视角，而且视角能自动移动"。做成两件事：
 * 1. 三个机位（全景 / 两侧对峙 / 跟随战场），点按钮或按 V 换；
 * 2. **自动模式**：每 9 秒换一个机位、镜头缓慢漂到战场焦点（兵的质心）；
 *    玩家一动手（拖/缩放/转）就退出自动，停手 6 秒后自己回来。
 *
 * 所有位移都走相机自己的阻尼（`centerOnWorld` 不带 instant），所以不会硬跳。
 */

import type { CameraRig } from '@engine/render/CameraRig';

export interface ViewPreset {
  name: string;
  /** 相对"整幅场地入画"的缩放倍率 */
  zoomFactor: number;
  yaw: number;
  pitch: number;
  /** 镜头跟不跟战场焦点 */
  follow: boolean;
}

export const VIEW_PRESETS: ViewPreset[] = [
  { name: '全景', zoomFactor: 1, yaw: 0, pitch: 52, follow: false },
  { name: '两侧对峙', zoomFactor: 0.86, yaw: 22, pitch: 46, follow: false },
  { name: '跟随战场', zoomFactor: 0.62, yaw: 0, pitch: 58, follow: true },
];

/** 自动模式多久换一次机位、玩家停手多久回来。 */
const SWITCH_SECONDS = 9;
const RESUME_SECONDS = 6;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 把角度差折到 [-180, 180]，避免镜头绕远路 */
const shortAngle = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

export class ArenaDirector {
  /**
   * 拖动方向是否反向。默认 **false = 正向**（用户 2026-10-27：他习惯正向，
   * 反向等以后在设置里给个开关）。拨这个开关就能整体翻过来。
   */
  invertOrbit = false;
  index = 0;
  auto = true;
  /** 玩家自己拖过镜头：锁在手动，直到他按"视角"按钮（不再 6 秒后偷偷抢回去） */
  locked = false;
  /** 玩家动过之后的静默计时 */
  private idle = RESUME_SECONDS;
  private switchIn = SWITCH_SECONDS;

  get current(): ViewPreset {
    return VIEW_PRESETS[this.index]!;
  }

  /** 手动换下一个机位（这会立刻退出自动，停手后再回来）。 */
  next(): ViewPreset {
    this.index = (this.index + 1) % VIEW_PRESETS.length;
    this.locked = false;
    this.auto = true;
    this.idle = RESUME_SECONDS;
    this.switchIn = SWITCH_SECONDS;
    return this.current;
  }

  /** 玩家碰了相机。 */
  userTouched(): void {
    this.auto = false;
    this.locked = true;
    this.idle = 0;
  }

  /**
   * 每帧一次。`fitZoom` 是"整幅场地入画"的那个缩放值（随视口现算），
   * `focus` 是战场质心（没有兵就是 null）。
   */
  update(dt: number, rig: CameraRig, fitZoom: number, center: { x: number; z: number }, focus: { x: number; z: number } | null): void {
    // 玩家锁住手动时**一帧都不碰相机**：不然他刚拖好画面，镜头又自己飘回去
    if (this.locked) return;
    if (!this.auto) {
      this.idle += dt;
      if (this.idle >= RESUME_SECONDS) {
        this.auto = true;
        this.switchIn = SWITCH_SECONDS;
      }
      return;
    }

    this.switchIn -= dt;
    if (this.switchIn <= 0) {
      this.index = (this.index + 1) % VIEW_PRESETS.length;
      this.switchIn = SWITCH_SECONDS;
    }

    const view = this.current;
    // 缩放：指数趋近，太快会晕
    const targetZoom = fitZoom * view.zoomFactor;
    rig.zoom = lerp(rig.zoom, targetZoom, 1 - Math.exp(-dt * 1.6));
    // 朝向：只补一小步角度
    rig.rotateBy(shortAngle(view.yaw - rig.yaw) * Math.min(1, dt * 1.8));
    rig.setPitch(lerp(rig.pitch, view.pitch, Math.min(1, dt * 1.2)));
    // 中心：跟焦点或回场地中心（centerOnWorld 自带阻尼）
    const target = view.follow && focus ? focus : center;
    rig.centerOnWorld(target.x, target.z);
  }

  /** 给 HUD 的一行状态。 */
  get status(): string {
    return this.auto ? `自动 · ${this.current.name}` : this.current.name;
  }
}
