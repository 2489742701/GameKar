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

  constructor(options: GameLoopOptions) {
    this.opts = options;
    this.fixedDt = 1 / (options.hz ?? 20);
    this.maxSubSteps = options.maxSubSteps ?? 5;
  }

  get running(): boolean {
    return this.handle !== null;
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
    while (this.accumulator >= this.fixedDt && steps < this.maxSubSteps) {
      this.accumulator -= this.fixedDt;
      this.time += this.fixedDt;
      steps++;
      this.opts.onSimStep?.(this.fixedDt);
    }
    // 补算到顶说明机器跟不上，丢弃积压而不是越积越多
    if (steps === this.maxSubSteps) this.accumulator = 0;

    this.opts.onFrame?.({ delta: clamped, time: this.time, fps: this.fps });
  }
}
