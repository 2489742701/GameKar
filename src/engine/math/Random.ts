/**
 * 确定性随机 —— 抽卡、地形、掉落都必须可复现。
 * 同一 seed 构造出的实例，调用序列完全一致。
 */

export interface Weighted<T> {
  item: T;
  /** 相对权重，>=0；内部自动归一化 */
  weight: number;
}

/** 32 位字符串散列，用来把名字变成可派生的子流种子。 */
export function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Random {
  private state: number;

  constructor(seed: number | string = 1) {
    const s = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    // 避免 0 状态导致退化
    this.state = (s === 0 ? 0x9e3779b9 : s) >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) 整数；min===max 时返回 min */
  int(min: number, max: number): number {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.ceil(Math.max(min, max));
    return lo + Math.floor(this.next() * (hi - lo));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(list: readonly T[]): T {
    if (list.length === 0) throw new RangeError('Random.pick: 列表为空');
    return list[this.int(0, list.length)]!;
  }

  /** 权重和为 0 时退化为等概率，避免调用方漏填权重就崩。 */
  weighted<T>({ items }: { items: readonly Weighted<T>[] }): T {
    if (items.length === 0) throw new RangeError('Random.weighted: 候选为空');
    let total = 0;
    for (const { weight } of items) total += Math.max(0, weight);

    if (total <= 0) return this.pick(items).item;

    let roll = this.next() * total;
    for (const { item, weight } of items) {
      roll -= Math.max(0, weight);
      if (roll < 0) return item;
    }
    return items[items.length - 1]!.item;
  }

  /** 就地 Fisher–Yates，返回同一数组便于链式调用。 */
  shuffle<T>(list: T[]): T[] {
    for (let i = list.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    return list;
  }

  /** 从当前流派生独立子流：地形和抽卡互不污染。 */
  fork(label: string): Random {
    return new Random(hashString(`${label}#${this.state >>> 0}`));
  }

  get seedState(): number {
    return this.state;
  }
}
