/**
 * 音效 —— **全部现场合成，一个音频文件都不加载**。
 *
 * 为什么不用采样：
 * 1. 这是像素小人 + 低多边形的战场，合成音的音色反而更贴；
 * 2. 零素材 = 零版权风险（上架素材要过审）、零加载等待、包体不涨；
 * 3. 每条音效都能带**随机 pitch/时长**，几十次开火不会听出"同一段录音循环"。
 *
 * 代价是"木材堆放""人声冲锋"这类靠采样才像的声音做不像 —— 所以换了个做法：
 * 用**多声错落的短敲击**去表达"一堆木头放下去了"，而不是试图模仿一根木头的录音。
 *
 * 触发点全在 `ArenaApp` 里（它知道世界发生了什么），这里只管发声。
 */

export type SfxName =
  | 'place' // 打出一张牌
  | 'build' // 建筑完工（木材堆放）
  | 'arrow' // 弓/弩开火
  | 'cannon' // 炮塔/火炮开火
  | 'melee' // 近战命中
  | 'impact' // 远程命中
  | 'kill' // 单位阵亡
  | 'collapse' // 建筑被拆
  | 'win'
  | 'lose';
// coin（金币到账）2026-11-06 撤：用户嫌吵（"把它关掉吧"）——
// 2 秒一格 + 磨坊产金，声音比动作密得多。想加回来从 git 历史找 case 'coin'。

/** 同名音效的最小间隔（秒）：几十个兵同一帧命中时，叠起来就是噪音 */
const MIN_GAP = 0.045;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** 白噪声缓冲：所有"沙沙/砰"的底子都从它切一段出来 */
  private noise: AudioBuffer | null = null;
  private readonly lastAt = new Map<SfxName, number>();
  private enabled = true;

  constructor() {
    try {
      this.enabled = localStorage.getItem('gamekar.sfx') !== 'off';
    } catch {
      // 隐私模式下 localStorage 会抛，默认开着就好
    }
  }

  get on(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem('gamekar.sfx', on ? 'on' : 'off');
    } catch {
      // 存不上就算了，这次会话有效
    }
    if (this.master && this.ctx) {
      // 不是 0：直接 0 会让之后的音效全哑（gain 回到 1 时还得手动恢复）
      this.master.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * 解锁音频。**必须由用户手势触发**（浏览器的自动播放策略），
   * 唯一的天然时机就是开始菜单上那个"开始对战"。
   */
  unlock(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  play(name: SfxName, opts: { pitch?: number } = {}): void {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const prev = this.lastAt.get(name) ?? -1;
    if (now - prev < MIN_GAP) return;
    this.lastAt.set(name, now);

    const pitch = opts.pitch ?? 1;
    // 每条音效整体再抖 ±4%：连发时不会听成机器
    const detune = pitch * (0.96 + Math.random() * 0.08);
    this.voice(name, now + 0.001, detune);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.noise = null;
  }

  // ------------------------------------------------------------ 内部

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = typeof window !== 'undefined' ? window.AudioContext : undefined;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.enabled ? 0.62 : 0;
    /**
     * 压缩器不是"音质装饰"，是必需品：一场混战里近战命中 + 命中 + 阵亡可能同一帧响七八下，
     * 不压会直接削波（爆音）。阈值 -12dB、8:1，听起来只是"变紧"，不会明显变闷。
     */
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 6;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    master.connect(comp).connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    this.noise = this.makeNoise(ctx);
    return ctx;
  }

  /** 1 秒白噪声，循环取用。 */
  private makeNoise(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 1);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 一个有音高、带包络的声音（敲击、炮响的"芯"）。 */
  private tone(
    at: number,
    o: { f0: number; f1?: number; dur: number; gain: number; type?: OscillatorType; attack?: number },
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f0, at);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), at + o.dur);
    const a = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(o.gain, at + a);
    g.gain.exponentialRampToValueAtTime(0.0001, at + o.dur);
    osc.connect(g).connect(this.master!);
    osc.start(at);
    osc.stop(at + o.dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  }

  /** 一段噪声（沙沙、碎屑、风声），可由带通扫频塑形。 */
  private burst(
    at: number,
    o: { dur: number; gain: number; f0: number; f1?: number; q?: number; type?: BiquadFilterType; attack?: number },
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type ?? 'bandpass';
    filter.frequency.setValueAtTime(o.f0, at);
    if (o.f1 !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(40, o.f1), at + o.dur);
    filter.Q.value = o.q ?? 0.9;
    const g = ctx.createGain();
    const a = o.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(o.gain, at + a);
    g.gain.exponentialRampToValueAtTime(0.0001, at + o.dur);
    src.connect(filter).connect(g).connect(this.master!);
    src.start(at);
    src.stop(at + o.dur + 0.02);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      g.disconnect();
    };
  }

  /** 各音效的配方。`d` 是音高系数（1 = 原调）。 */
  private voice(name: SfxName, t: number, d: number): void {
    switch (name) {
      /** 出牌：木牌拍在桌上的一声脆响 */
      case 'place': {
        this.tone(t, { f0: 520 * d, f1: 330 * d, dur: 0.075, gain: 0.16, type: 'triangle' });
        this.burst(t, { dur: 0.045, gain: 0.12, f0: 1800, f1: 700, q: 1.2 });
        break;
      }

      /**
       * 建筑完工 = **木材堆放**（用户点名的声音）。
       *
       * 做法不是"模仿一根木头落地"，而是**五六声错落的短敲**：
       * 先几声轻的（板子/椽子），最后一声沉的（主梁压下来）。
       * 错落感靠 30–65ms 的随机间隔，整齐排列会听成"打字机"。
       */
      case 'build': {
        const hits = 5 + Math.floor(Math.random() * 3);
        let at = t;
        for (let i = 0; i < hits; i++) {
          const f = (165 + Math.random() * 150) * d;
          this.tone(at, { f0: f, f1: f * 0.72, dur: 0.085 + Math.random() * 0.04, gain: 0.15, type: 'triangle' });
          this.burst(at, { dur: 0.04, gain: 0.07, f0: 1100 + Math.random() * 700, f1: 480, q: 1.4 });
          at += 0.032 + Math.random() * 0.033;
        }
        this.tone(at + 0.01, { f0: 92 * d, f1: 58 * d, dur: 0.24, gain: 0.2, type: 'sine' });
        break;
      }

      /** 弓弦：一记短促的"嗖"，高频扫到低频 */
      case 'arrow': {
        this.burst(t, { dur: 0.11, gain: 0.14, f0: 2600 * d, f1: 700, q: 1.6 });
        this.tone(t, { f0: 420 * d, f1: 180 * d, dur: 0.06, gain: 0.07, type: 'triangle' });
        break;
      }

      /** 炮：低频"咚"打底 + 一层闷噪，尾巴比箭长一倍 */
      case 'cannon': {
        this.tone(t, { f0: 105 * d, f1: 38 * d, dur: 0.3, gain: 0.3, type: 'sine' });
        this.burst(t, { dur: 0.2, gain: 0.22, f0: 900, f1: 220, q: 0.6, type: 'lowpass' });
        this.burst(t, { dur: 0.05, gain: 0.12, f0: 3200, f1: 1400, q: 1.1 });
        break;
      }

      /**
       * 近战命中：金属"锵" + 一记钝击。
       * 高频那层会被随机音高拉到 2.1–2.6kHz，砍起来是"叮叮当当"而不是同一声。
       */
      case 'melee': {
        this.burst(t, { dur: 0.055, gain: 0.2, f0: 520 * d, f1: 900, q: 0.8 });
        this.tone(t, { f0: 2100 * d + Math.random() * 500, f1: 1500 * d, dur: 0.055, gain: 0.1, type: 'triangle' });
        break;
      }

      /** 远程命中：比近战闷、比炮轻 */
      case 'impact': {
        this.burst(t, { dur: 0.09, gain: 0.12, f0: 1400, f1: 400, q: 0.7 });
        this.tone(t, { f0: 220 * d, f1: 90 * d, dur: 0.1, gain: 0.09, type: 'sine' });
        break;
      }

      /** 阵亡：一记下坠的闷响 */
      case 'kill': {
        this.tone(t, { f0: 180 * d, f1: 62 * d, dur: 0.18, gain: 0.15, type: 'sine' });
        this.burst(t, { dur: 0.1, gain: 0.08, f0: 700, f1: 200, q: 0.7, type: 'lowpass' });
        break;
      }

      /** 建筑倒塌：长噪声 + 低频轰鸣 + 一串碎石（这是全场最重的一声） */
      case 'collapse': {
        this.tone(t, { f0: 70 * d, f1: 34 * d, dur: 0.75, gain: 0.28, type: 'sine' });
        this.burst(t, { dur: 0.7, gain: 0.2, f0: 1600, f1: 160, q: 0.5, type: 'lowpass' });
        for (let i = 0; i < 5; i++) {
          const at = t + 0.06 + Math.random() * 0.5;
          this.burst(at, { dur: 0.05, gain: 0.09, f0: 900 + Math.random() * 900, f1: 300, q: 1.5 });
        }
        break;
      }

      case 'win': {
        const notes = [523, 659, 784, 1046];
        notes.forEach((f, i) =>
          this.tone(t + i * 0.11, { f0: f, dur: 0.28, gain: 0.16, type: 'triangle' }),
        );
        break;
      }

      case 'lose': {
        const notes = [440, 392, 330, 262];
        notes.forEach((f, i) =>
          this.tone(t + i * 0.13, { f0: f, dur: 0.34, gain: 0.15, type: 'triangle' }),
        );
        break;
      }
    }
  }
}
