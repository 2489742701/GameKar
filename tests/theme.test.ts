/**
 * 界面材质的锁。
 *
 * 全部打在纯函数上（`woodPixels` / `giltPixels`），所以 node 里就能跑完，不开浏览器。
 * 最要紧的一条是**平铺无缝**：噪声只要不是周期的，接缝那一列就会跳变，
 * 而这件事在画面上只是"面板上有条暗竖线"，很容易被当成美术效果看过去 —— 所以在这里钉死。
 */

import { describe, expect, it } from 'vitest';
import { Random } from '@engine/math/Random';
import { Prefs } from '@game/prefs';
import {
  DEFAULT_GILT,
  DEFAULT_WOOD,
  GILT_RAMP,
  WOOD_RAMP,
  giltPixels,
  parseHex,
  rampIndex,
  tileNoise,
  woodPixels,
} from '@ui/theme';
import {
  DEFAULT_TUNING,
  decodeTuning,
  encodeTuning,
  loadTuning,
  saveTuning,
  snapTuning,
  woodOf,
  type Tuning,
} from '@ui/themePrefs';

/** 亮度用 Rec.709 的权重折成一个数，够比较深浅了 */
const luma = (hex: string): number => {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const lumaAt = (pixels: Uint8ClampedArray, size: number, x: number, y: number): number => {
  const i = (y * size + x) * 4;
  return 0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!;
};

describe('色板', () => {
  it('木色板与金色板都严格从暗到亮（用户要的"深黑→深褐→深黄"是有序的一族）', () => {
    const wood = WOOD_RAMP.map(luma);
    const gilt = GILT_RAMP.map(luma);
    for (let i = 1; i < wood.length; i++) expect(wood[i]!).toBeGreaterThan(wood[i - 1]!);
    for (let i = 1; i < gilt.length; i++) expect(gilt[i]!).toBeGreaterThan(gilt[i - 1]!);
  });

  it('木色板最亮一档仍是"深黄"，不掉到发白（发白就成塑料了）', () => {
    expect(luma(WOOD_RAMP[WOOD_RAMP.length - 1]!)).toBeLessThan(180);
  });

  it('rampIndex 只在色板里挑档，不越界也不插值', () => {
    expect(rampIndex(0, 6, 8)).toBe(0);
    expect(rampIndex(5, 6, 8)).toBe(7);
    expect(rampIndex(-3, 6, 8)).toBe(0);
    expect(rampIndex(99, 6, 8)).toBe(7);
    // 档数少于色板长度时是等距取档：三档取第二档落在色板中间偏上
    expect(rampIndex(1, 3, 8)).toBe(4);
  });
});

describe('木纹像素', () => {
  it('长度、alpha 都按规格来', () => {
    const spec = { ...DEFAULT_WOOD, size: 32 };
    const px = woodPixels(spec);
    expect(px.length).toBe(32 * 32 * 4);
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(spec.alpha);
  });

  it('量化确实生效：出现过的颜色不超过 steps 种，也不止 1 种', () => {
    const px = woodPixels(DEFAULT_WOOD);
    const seen = new Set<string>();
    for (let i = 0; i < px.length; i += 4) seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
    expect(seen.size).toBeGreaterThan(1);
    expect(seen.size).toBeLessThanOrEqual(DEFAULT_WOOD.steps);
  });

  it('噪声按周期折回：f(u+1,v) 与 f(u,v+1) 差到一个像素都看不出来（1e-6）', () => {
    // 不拿 === 当尺子：u+1 再乘 period 会差一个浮点 ulp，正好落在格点上时 floor 会翻一位。
    // 判据要的是"看不出来"，所以是容差；去掉 wrap 的话差的是 0.1 量级，照样红。
    let bad = 0;
    for (let i = 0; i < 97; i++) {
      const t = i / 97;
      if (Math.abs(tileNoise(t, 0.31, 3, 13, 20261020) - tileNoise(t + 1, 0.31, 3, 13, 20261020)) > 1e-6) bad++;
      if (Math.abs(tileNoise(0.53, t, 3, 13, 20261020) - tileNoise(0.53, t + 1, 3, 13, 20261020)) > 1e-6) bad++;
      if (Math.abs(tileNoise(t, 0.31, 3, 13, 20261020) - tileNoise(t - 1, 0.31, 3, 13, 20261020)) > 1e-6) bad++;
    }
    expect(bad).toBe(0);
  });

  // 上一版这里我用的是"列均值的接缝 vs 内部中位数"，那条锁红过两次而纹理其实没坏：
  // 量化成 6 档之后，列均值里一格跳档就是 ±20 亮度，接缝统计被它 dominating。
  // 真正的判据是下面这条 —— 逐像素比"接缝那一列"和"内部任一列"，量纲一致。
  it('拼起来看不见缝：接缝列的逐像素平均跳变不大于内部列的平均跳变', () => {
    const size = DEFAULT_WOOD.size;
    const px = woodPixels(DEFAULT_WOOD);
    const meanDelta = (from: number, to: number) => {
      let s = 0;
      for (let y = 0; y < size; y++) s += Math.abs(lumaAt(px, size, from, y) - lumaAt(px, size, to, y));
      return s / size;
    };
    // 内部逐列取平均：列号按行错开，免得只量到同一列的巧合
    let inner = 0;
    for (let y = 0; y < size; y++) {
      const x = y % (size - 1);
      inner += Math.abs(lumaAt(px, size, x, y) - lumaAt(px, size, x + 1, y));
    }
    inner /= size;
    const seam = meanDelta(0, size - 1);
    expect(seam).toBeLessThanOrEqual(inner * 1.25);
  });

  it('板缝只压暗板头顶那一行：同一份噪声，关掉板缝之后那些行必须更亮、其余行一模一样', () => {
    const size = DEFAULT_WOOD.size;
    const plankRows = 8;
    const withSeam = woodPixels({ ...DEFAULT_WOOD, plankRows, seam: 0.2 });
    const noSeam = woodPixels({ ...DEFAULT_WOOD, plankRows, seam: 0 });
    const rowMean = (px: Uint8ClampedArray, y: number) => {
      let s = 0;
      for (let x = 0; x < size; x++) s += lumaAt(px, size, x, y);
      return s / size;
    };

    // 缝行确实被压暗（缝效应只在亮度上，量化后可能个别行撞进同一档，所以断"多数缝行"）
    const seams = [0, 8, 16, 24, 32, 40];
    const darker = seams.filter((y) => rowMean(withSeam, y) < rowMean(noSeam, y));
    expect(darker.length).toBeGreaterThanOrEqual(4);

    // 板中间的行不该被顺手改动：这是"只改一处"的定位锁
    for (const y of [3, 5, 11, 19, 27, 37]) {
      expect(rowMean(withSeam, y)).toBe(rowMean(noSeam, y));
    }
  });

  it('同 seed 一模一样，换 seed 必须不一样（可复现，但不是一张图用到底）', () => {
    const a = woodPixels(DEFAULT_WOOD);
    const b = woodPixels(DEFAULT_WOOD);
    const c = woodPixels({ ...DEFAULT_WOOD, seed: DEFAULT_WOOD.seed + 1 });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(c)).not.toEqual(Array.from(a));
  });

  it('压亮度会让整张图变暗 —— 强度这一维是真能调的', () => {
    const mean = (px: Uint8ClampedArray, size: number) => {
      let s = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) s += lumaAt(px, size, x, y);
      return s / (size * size);
    };
    const dark = mean(woodPixels({ ...DEFAULT_WOOD, brightness: 0.2 }), DEFAULT_WOOD.size);
    const light = mean(woodPixels({ ...DEFAULT_WOOD, brightness: 0.7 }), DEFAULT_WOOD.size);
    expect(dark).toBeLessThan(light);
  });
});

describe('镀金像素', () => {
  it('顶边两行是镜面高光：平均亮度明显高于中间行', () => {
    const size = DEFAULT_GILT.size;
    const px = giltPixels(DEFAULT_GILT);
    const rowMean = (y: number) => {
      let s = 0;
      for (let x = 0; x < size; x++) s += lumaAt(px, size, x, y);
      return s / size;
    };
    expect(rowMean(0)).toBeGreaterThan(rowMean(Math.floor(size / 2)));
  });

  it('颜色只从金色板里出，一档不多', () => {
    const px = giltPixels(DEFAULT_GILT);
    const allowed = new Set(GILT_RAMP.map((hex) => {
      const { r, g, b } = parseHex(hex);
      return `${r},${g},${b}`;
    }));
    for (let i = 0; i < px.length; i += 4) {
      expect(allowed.has(`${px[i]},${px[i + 1]},${px[i + 2]}`)).toBe(true);
    }
  });
});

describe('材质 ID（可分享的调参码）', () => {
  /** 自己写一份打包器当尺子：位序与位宽照抄注释里那张表，故意不从被测件派生。 */
  const WIDTHS = [5, 3, 4, 4, 3, 3, 3, 3];
  const pack = (indices: number[]) => {
    let bits = 0;
    for (let i = 0; i < WIDTHS.length; i++) bits = bits * 2 ** WIDTHS[i]! + indices[i]!;
    let out = '';
    let n = bits;
    for (let i = 0; i < 6; i++) {
      out = '0123456789abcdefghijklmnopqrstuvwxyz'[n % 36] + out;
      n = Math.floor(n / 36);
    }
    return `mk-1${out}`;
  };

  const rng = new Random('tuning-fuzz');
  const randTuning = (): Tuning => ({
    brightness: Math.round((0.2 + 0.02 * rng.int(0, 26)) * 100) / 100,
    steps: 3 + rng.int(0, 6),
    grainY: 6 + rng.int(0, 15),
    plankRows: 4 + 2 * rng.int(0, 11),
    seam: Math.round(0.05 * rng.int(0, 7) * 100) / 100,
    scale: 1 + rng.int(0, 5),
    seedVariant: rng.int(0, 8),
    gilt: 40 * rng.int(0, 6),
  });

  it('往返不变：500 组随机参数，编码再解码一个数都不差', () => {
    for (let i = 0; i < 500; i++) {
      const t = randTuning();
      expect(decodeTuning(encodeTuning(t))).toEqual(t);
    }
  });

  it('同一套参数永远同一个码（这是分享码的地基）', () => {
    const t = randTuning();
    expect(encodeTuning(t)).toBe(encodeTuning(t));
    expect(encodeTuning(t)).toMatch(/^mk-1[0-9a-z]{6}$/);
  });

  it('2000 组随机参数不撞号', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) ids.add(encodeTuning(randTuning()));
    expect(ids.size).toBe(2000);
  });

  it('默认参数的码钉死在这里：偷偷改默认值会红，这是故意的', () => {
    expect(encodeTuning(DEFAULT_TUNING)).toBe('mk-11q37sz');
  });

  it('非法码一律拒绝：前缀、长度、版本、表外字符、越界档位', () => {
    const good = encodeTuning(DEFAULT_TUNING);
    expect(decodeTuning('')).toBeNull();
    expect(decodeTuning('xx-1abcdefg')).toBeNull();
    expect(decodeTuning(good.slice(0, -1))).toBeNull();
    expect(decodeTuning(good.replace('mk-1', 'mk-2'))).toBeNull();
    expect(decodeTuning('mk-1!!!!!!')).toBeNull();
    // 第 2 个字段（色阶档数）只有 6 档合法，指到第 7 档的码必须被拒
    expect(decodeTuning(pack([0, 7, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(decodeTuning(pack([0, 5, 0, 0, 0, 0, 0, 0]))).not.toBeNull();
  });

  it('snap 幂等：贴回档位之后再贴不会漂', () => {
    const t = { ...DEFAULT_TUNING, brightness: 0.351, seam: 0.12, steps: 6.4 };
    const once = snapTuning(t);
    expect(snapTuning(once)).toEqual(once);
    expect(encodeTuning(once)).toBe(encodeTuning(t));
  });

  it('参数换成规格：档数/密度/板宽/板缝都真的落到纹理上', () => {
    const t = { ...DEFAULT_TUNING, steps: 3, grainY: 6, plankRows: 4, seam: 0.3 };
    const spec = woodOf(t);
    expect(spec.steps).toBe(3);
    expect(spec.grainY).toBe(6);
    expect(spec.plankRows).toBe(4);
    expect(spec.seam).toBe(0.3);
    // 种子变体 0 必须还是默认那颗种子，否则老码解出来的长相会变
    expect(woodOf(DEFAULT_TUNING).seed).toBe(DEFAULT_WOOD.seed);
    expect(woodOf({ ...DEFAULT_TUNING, seedVariant: 3 }).seed).not.toBe(DEFAULT_WOOD.seed);
  });

  it('存盘读回：写进去的是码，新实例读回来还是同一套参数', () => {
    const store = new Map<string, string>();
    const fake = {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
    };
    const prefs = new Prefs(fake);
    const t = { ...DEFAULT_TUNING, steps: 7, scale: 4 };
    const id = saveTuning(prefs, t);
    expect(prefs.themeId).toBe(id);
    expect(loadTuning(new Prefs(fake))).toEqual(snapTuning(t));

    // 存了个坏码：读回默认，而不是崩、也不是把坏值原样吐出去
    prefs.setThemeId('mk-9zzzzzz');
    expect(loadTuning(new Prefs(fake))).toEqual(DEFAULT_TUNING);
  });
});
