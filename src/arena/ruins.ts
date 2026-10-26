/**
 * 随机碎裂 —— 把一栋楼的占地切成一堆大小不一的碎块（废墟、掉渣都用它）。
 *
 * 算法是"递归二分"（BSP）：从占地矩形开始，每次随机挑一条轴、随机比例切一刀，
 * 递归到块数够了为止。切出来的块**互相不重叠、拼起来正好覆盖原地**，
 * 所以看起来像"这栋楼碎成了这些块"，而不是随手撒了几块石头。
 *
 * 关键：**结果是确定的** —— 只由 (seed + 楼号) 决定。同一堆废墟刷新前后长得一样，
 * 但不同楼、不同位置一定不一样。
 */

export interface RuinPiece {
  /** 相对占地中心的偏移（格） */
  x: number;
  z: number;
  /** 块的长宽（格） */
  w: number;
  d: number;
  /** 块高（格） */
  h: number;
  /** 绕 y 的旋转（弧度） */
  spin: number;
  /** 0..1：0 = 最暗的焦土，1 = 最亮的碎石 */
  tone: number;
  /** 这块是从哪来的：屋瓦 / 墙体 / 木头 —— 决定颜色族 */
  part: 'roof' | 'wall' | 'wood';
}

/** 32 位散列，跟项目里那套同形状（不用 Math.random，否则刷新就变）。 */
function hash(a: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

class FragRng {
  private state: number;
  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * Math.max(1, hi - lo));
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(0, list.length)]!;
  }
}

interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/**
 * 把占地切成 pieces 块。`seed` 建议传"楼号 + 一次拆解"的组合，保证可复现。
 * 返回的块是**占地局部坐标**（原点在中心），调用方自己加世界坐标。
 */
export function fracture(cols: number, rows: number, seed: number, pieces = 9): RuinPiece[] {
  const rng = new FragRng(hash(seed));
  let rects: Rect[] = [{ x: -cols / 2, z: -rows / 2, w: cols, d: rows }];

  while (rects.length < pieces) {
    // 挑一块最大的来切：切完形状更不均匀，像碎的不是像切豆腐
    let target = 0;
    for (let i = 1; i < rects.length; i++) {
      if (rects[i]!.w * rects[i]!.d > rects[target]!.w * rects[target]!.d) target = i;
    }
    const r = rects[target]!;
    const alongX = r.w > r.d ? rng.next() < 0.72 : rng.next() < 0.28;
    const t = 0.32 + rng.next() * 0.36; // 切在 32%–68% 之间，避免薄片
    if (alongX) {
      const left = r.w * t;
      rects.splice(target, 1, { ...r, w: left }, { ...r, x: r.x + left, w: r.w - left });
    } else {
      const front = r.d * t;
      rects.splice(target, 1, { ...r, d: front }, { ...r, z: r.z + front, d: r.d - front });
    }
  }

  return rects.map((r) => {
    const size = Math.min(r.w, r.d);
    return {
      // 碎块不会正好铺满：缩一点、偏一点，缝里露出地皮才像塌的
      x: r.x + r.w / 2 + (rng.next() - 0.5) * 0.1,
      z: r.z + r.d / 2 + (rng.next() - 0.5) * 0.1,
      w: Math.max(0.16, r.w * (0.72 + rng.next() * 0.22)),
      d: Math.max(0.16, r.d * (0.72 + rng.next() * 0.22)),
      // 小块可以高一点（梁/柱），大块低（地面碎层）
      h: Math.max(0.08, Math.min(0.42, 0.34 - size * 0.08 + rng.next() * 0.12)),
      spin: (rng.next() - 0.5) * 0.9,
      tone: 0.25 + rng.next() * 0.7,
      part: rng.pick(['roof', 'wall', 'wood'] as const),
    };
  });
}

/** 掉渣用：从同一套碎裂里挑几块，摆到占地**外围**（像是从墙上崩下来的）。 */
export function spall(cols: number, rows: number, seed: number, count: number): RuinPiece[] {
  const base = fracture(cols, rows, seed, Math.max(2, count));
  return base.slice(0, count).map((p) => {
    const ang = Math.atan2(p.z, p.x) || 0;
    const push = 0.55 + Math.abs(p.x) * 0.1;
    return {
      ...p,
      x: p.x + Math.cos(ang) * push,
      z: p.z + Math.sin(ang) * push,
      w: Math.min(p.w, 0.34),
      d: Math.min(p.d, 0.34),
      h: Math.min(p.h, 0.2),
    };
  });
}
