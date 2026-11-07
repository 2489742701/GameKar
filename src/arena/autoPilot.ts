/**
 * 我方托管（AutoPilot）—— 2026-11-07 用户："给自己装个托管模式……玩家 5 秒钟
 * 未操作时就会自动托管，或者我们直接点一下就可以托管；在设置里面可以打开托管。"
 *
 * 三条规矩，各自有理由：
 *  1. **手动**（点「托管」按钮）是常驻的，直到再点一次才关。玩家中途碰屏幕
 *     不该把它悄悄解除，否则手动开关就没有意义了；
 *  2. **闲置自动**（默认开，5 秒）只在玩家真的没动静时接管，
 *     而且**任何指针/键盘操作都立刻把控制权交还** —— 这是"挂机保护"不是"抢操作"；
 *  3. 两者叠加：`active = manual || (idleAuto && idle >= 5)`。
 *     `active` 变化时同步 `world.setAuto('blue', ...)`，一次设齐该阵营所有玩家槽
 *     （PVE 双人时两人一起托管，不会只驱动 0 号）。
 *
 * 计时走 `GameLoop.onSimStep`（20Hz 逻辑步），所以开始菜单 `app.pause()` 期间
 * 既不计时也不托管 —— 玩家读规则读 30 秒，AI 不会替他打完半局。
 *
 * 这里**不监听 DOM**：玩家操作由 ArenaApp 在 window 捕获阶段统一喂 `activity()`，
 * 状态机本身是纯的，给一个 dt 就能单测。
 */
import type { ArenaWorld } from './ArenaWorld';
import type { ControlPrefs } from './controls';

/** 闲置多久自动托管（秒）。 */
export const IDLE_AUTO_SECONDS = 5;

export interface AutoPilotState {
  /** 此刻是否正在托管 */
  active: boolean;
  /** 手动点开的（不受 activity 影响） */
  manual: boolean;
  /** 设置里的总开关 */
  idleAuto: boolean;
  /** 距自动托管还剩几秒；手动托管 / 关掉总开关时为 0 */
  idleLeft: number;
}

export class AutoPilot {
  private idle = 0;
  private active = false;
  private manualFlag = false;

  constructor(
    private readonly world: ArenaWorld,
    private readonly prefs: ControlPrefs,
    private readonly onChange?: (state: AutoPilotState) => void,
  ) {}

  get state(): AutoPilotState {
    return {
      active: this.active,
      manual: this.manualFlag,
      idleAuto: this.prefs.idleAuto,
      idleLeft:
        this.manualFlag || !this.prefs.idleAuto
          ? 0
          : Math.max(0, IDLE_AUTO_SECONDS - this.idle),
    };
  }

  /**
   * 玩家动了（pointerdown / keydown）。只重置闲置计时；
   * 自动托管会在下一帧自动解除，手动托管保持不动。
   */
  activity(): void {
    this.idle = 0;
    this.sync();
  }

  /** 20Hz 逻辑步；菜单暂停时不会走到这里。 */
  step(dt: number): void {
    this.idle = Math.min(IDLE_AUTO_SECONDS + 1, this.idle + Math.max(0, dt));
    this.sync();
  }

  /** 工具行「托管」按钮：手动托管开 / 关。 */
  toggleManual(): boolean {
    this.manualFlag = !this.manualFlag;
    this.idle = 0;
    this.sync();
    return this.manualFlag;
  }

  /**
   * 强制设手动托管（给 `?auto=1` 自动化测试通道用）。
   * 那条通道要求开局就托管，且不能被"5 秒没操作"的逻辑在下一帧关掉。
   */
  forceManual(on: boolean): void {
    this.manualFlag = on;
    this.idle = 0;
    this.sync();
  }

  /** 设置面板的「闲置自动托管」开关。改的是同一份偏好对象，由 HUD 负责存档。 */
  setIdleAuto(on: boolean): void {
    this.prefs.idleAuto = on;
    this.idle = 0;
    this.sync();
  }

  private sync(): void {
    const want = this.manualFlag || (this.prefs.idleAuto && this.idle >= IDLE_AUTO_SECONDS);
    if (want === this.active) return;
    this.active = want;
    // red 侧恒为 true（world.setAuto 自己保证），这里只动 blue 的玩家槽
    this.world.setAuto('blue', want);
    this.onChange?.(this.state);
  }
}
