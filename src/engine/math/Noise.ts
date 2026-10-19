/**
 * 值噪声 / 分形噪声 —— 没有贴图资产时，地形起伏与聚落分布全靠它。
 * 纯函数 + 整数散列，因此同坐标永远同结果。
 */

function hash2i(x: number, y: number, seed: number): number {
  let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 单倍频值噪声，返回 [0,1)。 */
export function valueNoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = fade(x - xi);
  const ty = fade(y - yi);

  const v00 = hash2i(xi, yi, seed);
  const v10 = hash2i(xi + 1, yi, seed);
  const v01 = hash2i(xi, yi + 1, seed);
  const v11 = hash2i(xi + 1, yi + 1, seed);

  return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty);
}

export interface FbmOptions {
  octaves?: number;
  frequency?: number;
  lacunarity?: number;
  gain?: number;
  seed?: number;
}

/** 多倍频叠加，归一化到 [0,1)。用于大陆感与矿脉散布。 */
export function fbm(x: number, y: number, options: FbmOptions = {}): number {
  const { octaves = 4, frequency = 1 / 24, lacunarity = 2, gain = 0.5, seed = 0 } = options;

  let amp = 1;
  let sum = 0;
  let norm = 0;
  let fx = x * frequency;
  let fy = y * frequency;

  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(fx, fy, seed + i * 7919) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** 把 [0,1) 线性重映射并夹紧。 */
export function remap(value: number, inMin: number, inMax: number, outMin = 0, outMax = 1): number {
  if (inMax === inMin) return outMin;
  const t = (value - inMin) / (inMax - inMin);
  return outMin + (outMax - outMin) * Math.min(1, Math.max(0, t));
}
