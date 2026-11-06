/**
 * 固定步长主循环 —— 逻辑按 20Hz 推进，画面按刷新率渲染。
 * RTS 的确定性依赖这一点：同一 seed + 同一步数必须得到同一个战局。
 */

export interface FrameInfo {
  /** 真实经过的秒数（渲染帧间隔，已限幅） */
  delta: number;
  /** 自启动累计秒数 */
  time: number;
  /** 最近一段的平滑帧率 */
  fps: number;
}

export interface GameLoopOptions {
  /** 逻辑步频，默认 20Hz */
  hz?: number;
  /** 单帧最多补算几步，防止后台回来后雪崩，默认 5 */
  maxSubSteps?: number;
  onSimStep?(dt: number): void;
  onFrame?(info: FrameInfo): void;
}

const MAX_DELTA = 0.25;

export class GameLoop {
  private readonly fixedDt: number;
  private readonly maxSubSteps: number;
  private readonly opts: GameLoopOptions;

  private handle: number | null = null;
  private lastMs = 0;
  private accumulator = 0;
  private time = 0;
  private fps = 60;
  /** 暂停时逻辑不推进，但 `onFrame` 照常 —— 菜单背后的场景还要渲染 */
  private paused = false;

  constructor(options: GameLoopOptions) {
    this.opts = options;
    this.fixedDt = 1 / (options.hz ?? 20);
    this.maxSubSteps = options.maxSubSteps ?? 5;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  /** 现在是不是暂停中（开始菜单打开时是 true）。 */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * 暂停逻辑（开始菜单用）。
   *
   * 暂停的是 `onSimStep`，**不是渲染**：菜单背后那幅战场要一直在（浮尘会飘、相机手动手感还在），
   * 只是"时间不走"—— 否则玩家在读说明的 30 秒里，对面 AI 已经推平了他的大本营。
   */
  pause(): void {
    this.paused = true;
    this.accumulator = 0;
  }

  /** 恢复：丢掉暂停期间的积压，别一开打就补算几十步。 */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.accumulator = 0;
    this.lastMs = performance.now();
  }

  start(): void {
    if (this.running) return;
    this.lastMs = performance.now();
    this.accumulator = 0;
    this.handle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.handle !== null) {
      cancelAnimationFrame(this.handle);
      this.handle = null;
    }
  }

  /** 供单测驱动：手动推进一帧。 */
  advance(ms: number): void {
    this.consume(ms / 1000);
  }

  private readonly tick = (nowMs: number): void => {
    this.handle = requestAnimationFrame(this.tick);
    this.consume((nowMs - this.lastMs) / 1000, nowMs);
  };

  private consume(delta: number, nowMs = performance.now()): void {
    this.lastMs = nowMs;
    const clamped = Math.min(delta, MAX_DELTA);
    if (delta > 0) this.fps += (1 / delta - this.fps) * 0.08;

    this.accumulator += clamped;
    let steps = 0;
    // 暂停时只渲染不推进：`time` 也不涨，回放/确定性才不会被"读说明的 30 秒"污染
    if (!this.paused) {
      while (this.accumulator >= this.fixedDt && steps < this.maxSubSteps) {
        this.accumulator -= this.fixedDt;
        this.time += this.fixedDt;
        steps++;
        this.opts.onSimStep?.(this.fixedDt);
      }
    } else {
      this.accumulator = 0;
    }
    // 补算到顶说明机器跟不上，丢弃积压而不是越积越多
    if (steps === this.maxSubSteps) this.accumulator = 0;

    this.opts.onFrame?.({ delta: clamped, time: this.time, fps: this.fps });
  }
}
