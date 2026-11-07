/**
 * 我方托管（AutoPilot）。
 *
 * 2026-11-07 上午的口径是"点按钮手动托管 + 闲置 5 秒自动接管"；
 * **傍晚用户改了口径**："托管就是点一下就托管，不要等 5 秒，必须玩家自己手动点才会托管。"
 *
 * 所以现在只有一条路：**手动**。`active === manual`，没有计时、没有"碰一下就交还"。
 * 理由也顺：自动接管会在玩家思考时突然替他出牌，比"忘了点托管"更烦；
 * 而想挂机的人本来就该自己按一下。
 *
 * `active` 变化时同步 `world.setAuto('blue', ...)`，一次设齐该阵营所有玩家槽
 * （PVE 双人时两人一起托管，不会只驱动 0 号）。
 */
import type { ArenaWorld } from './ArenaWorld';

export interface AutoPilotState {
  /** 此刻是否正在托管 */
  active: boolean;
  /** 手动点开的（唯一入口） */
  manual: boolean;
}

export class AutoPilot {
  private active = false;
  private manualFlag = false;

  constructor(
    private readonly world: ArenaWorld,
    private readonly onChange?: (state: AutoPilotState) => void,
  ) {}

  get state(): AutoPilotState {
    return { active: this.active, manual: this.manualFlag };
  }

  /** 工具行「托管」按钮：开 / 关。唯一入口。 */
  toggleManual(): boolean {
    this.manualFlag = !this.manualFlag;
    this.sync();
    return this.manualFlag;
  }

  /** 强制设手动托管（给 `?auto=1` 自动化测试通道用）。 */
  forceManual(on: boolean): void {
    this.manualFlag = on;
    this.sync();
  }

  private sync(): void {
    const want = this.manualFlag;
    if (want === this.active) return;
    this.active = want;
    // red 侧恒为 true（world.setAuto 自己保证），这里只动 blue 的玩家槽
    this.world.setAuto('blue', want);
    this.onChange?.(this.state);
  }
}
