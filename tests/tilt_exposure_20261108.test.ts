/**
 * P-077 曝光锁（2026-11-08）："微缩景深开到底画面会变暗，理论上不该变暗；
 * 变暗可以保存，后续要加夕阳和夜晚（10 分钟一大局，从早上打到晚上）"。
 *
 * 实测基线（CDP 无头 Edge 截屏逐像素统计，1000×600）：
 *   旧版 tilt 0 → 平均亮度 0.27536；tilt 1 → 0.13756（**掉了 50%**）。
 * 两个独立病根：
 *   ① composer 最后缺 `OutputPass`：直出走 ACESFilmic + sRGB 编码，
 *      后期链路把线性值直接写屏 —— 这才是暗一半的主因；
 *   ② shader 把「提亮 + 暗角」挂在 `amount` 上，景深一开就改曝光。
 *
 * 这一族锁的是：**景深不改曝光**（含数学反证）、**压暗独立成 dim 通道**、
 * **OutputPass 不许删**。色温/时间轴等第二个昼夜用例出现再加，这一版不实现。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIM_KEY,
  DIM_SHADE,
  TILT_KEY,
  TILT_SHIFT_SHADER,
  loadDim,
  saveDim,
} from '@arena/visuals/tiltShift';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const app = readFileSync(join(ROOT, 'src/arena/ArenaApp.ts'), 'utf8');
const panel = readFileSync(join(ROOT, 'src/arena/DebugPanel.ts'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/arena.css'), 'utf8');
const frag = TILT_SHIFT_SHADER.fragmentShader;

/** 景深段 = dim 分支之前的所有代码；这里不许出现任何改曝光的东西。 */
const tiltOnly = frag.slice(0, frag.indexOf('if (dim > 0.001)'));

afterEach(() => vi.unstubAllGlobals());

describe('景深不改曝光', () => {
  it('反证：景深段没有任何乘性压暗 / 暗角 / 提亮（把旧的 amount 曝光放回来这条就红）', () => {
    expect(tiltOnly).not.toContain('base.rgb *=');
    expect(tiltOnly).not.toContain('vignette');
    expect(tiltOnly).not.toMatch(/base\.rgb\s*\*\s*\(/);
    expect(tiltOnly).not.toContain('0.045 * amount'); // 旧的提亮
    expect(tiltOnly).not.toContain('0.14 * amount');  // 旧的暗角
    expect(tiltOnly).toContain('mix(vec3(lum), base.rgb, 1.0 + 0.22 * amount)');
  });

  it('数学反证：提饱和以 lum 为中心线性外插，任意 amount 下加权亮度守恒', () => {
    const w = [0.299, 0.587, 0.114];
    const rgb = [0.2, 0.5, 0.8];
    const lum = rgb.reduce((s, c, i) => s + c * w[i]!, 0);
    for (const amount of [0, 0.25, 0.5, 0.75, 1]) {
      const out = rgb.map((c) => lum + (1 + 0.22 * amount) * (c - lum));
      const lumOut = out.reduce((s, c, i) => s + c * w[i]!, 0);
      expect(lumOut, `amount=${amount} 不该改亮度`).toBeCloseTo(lum, 10);
    }
  });

  it('模糊是邻域加权平均，本身也不改亮度（10 次采样除以 10）', () => {
    expect(tiltOnly).toContain('base = mix(base, sum / 10.0, blur);');
    expect(tiltOnly).toContain('vec4 sum = base * 2.0;');
  });
});

describe('色彩空间：composer 必须补 OutputPass', () => {
  it('反证：删掉 OutputPass，后期输出就退回没编码的线性值（暗一半）', () => {
    expect(app).toContain("import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'");
    expect(app).toContain('this.composer.addPass(new OutputPass());');
    // 顺序：RenderPass → OutputPass → ShaderPass（风格化必须是最后一个，在显示空间工作）
    const composer = app.slice(app.indexOf('new EffectComposer'), app.indexOf('// 场地底盘'));
    expect(composer.indexOf('addPass(new RenderPass')).toBeLessThan(composer.indexOf('addPass(new OutputPass())'));
    expect(composer.indexOf('addPass(new OutputPass())')).toBeLessThan(composer.indexOf('addPass(this.tiltPass)'));
    expect(composer.trimEnd().endsWith('this.composer.addPass(this.tiltPass);')).toBe(true);
  });

  it('渲染器确实是 ACESFilmic + sRGB（这条决定了 OutputPass 不能省）', () => {
    const renderer = readFileSync(join(ROOT, 'src/engine/render/Renderer.ts'), 'utf8');
    expect(renderer).toContain('outputColorSpace = THREE.SRGBColorSpace');
    expect(renderer).toContain('toneMapping = THREE.ACESFilmicToneMapping');
  });
});

describe('变暗独立保存：dim 通道（给后续夕阳 / 夜晚留的接口）', () => {
  it('独立 uniform + 独立存档 key，默认都是 0', () => {
    expect(TILT_SHIFT_SHADER.uniforms.dim.value).toBe(0);
    expect(TILT_SHIFT_SHADER.uniforms.amount.value).toBe(0);
    expect(DIM_KEY).toBe('gamekar.dim.v1');
    expect(DIM_KEY).not.toBe(TILT_KEY);
    expect(loadDim()).toBe(0);
  });

  it('压暗系数只有一处，shader 从常量插值（不许多写一份 0.55 / 0.14）', () => {
    expect(DIM_SHADE.exposure).toBeGreaterThan(0);
    expect(DIM_SHADE.vignette).toBeGreaterThan(0);
    expect(frag).toContain('uniform float dim');
    expect(frag).toContain('if (dim > 0.001)');
    expect(frag).toContain(`1.0 - dim * ${DIM_SHADE.exposure.toFixed(2)}`);
    expect(frag).toContain(`1.0 - dim * ${DIM_SHADE.vignette.toFixed(2)}`);
    // dim=1 时确实变暗（保留下来的能力，不是被删掉了）
    const factorAtNight = (1 - DIM_SHADE.exposure) * (1 - DIM_SHADE.vignette * 0.5 * 3);
    expect(factorAtNight).toBeLessThan(1);
    expect(1 - 0 * DIM_SHADE.exposure).toBe(1); // dim=0 恒等
  });

  it('存档读写 0~1 夹取，且不会串到景深档上', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    saveDim(0.7);
    expect(store.get(DIM_KEY)).toBe('0.7');
    expect(store.has(TILT_KEY)).toBe(false);
    expect(loadDim()).toBe(0.7);
    saveDim(3);
    expect(loadDim()).toBe(1);
    saveDim(-1);
    expect(loadDim()).toBe(0);
  });

  it('现场可调：setDim / get dim / 独立滑杆 / telemetry / 两个旋钮任一开都走后期', () => {
    expect(app).toContain('setDim(amount: number): void');
    expect(app).toContain('saveDim(this.dimAmount)');
    expect(app).toContain("this.tiltPass.uniforms['dim']!.value = this.dimAmount");
    expect(app).toContain('get dim(): number');
    expect(app).toContain('dim: this.dimAmount');
    expect(panel).toContain("this.slider('氛围压暗·昼夜'");
    expect(panel).toContain('(v) => this.app.setDim(v)');
    expect(panel).toContain('this.dimInput.parentElement!');
    expect(panel).toContain('const postFx = t.tilt > 0 || t.dim > 0');
    expect(app).toContain('const postFx = this.tiltEffective > 0.001 || this.dimAmount > 0.001;');
  });

  it('反证：dim 初始化时也必须灌进 shader（只存 localStorage 不上屏就等于没接）', () => {
    expect(app).toContain('private dimAmount = loadDim();');
    expect(app).toContain("this.tiltPass.uniforms['dim']!.value = this.dimAmount;");
  });
});

describe('多出来的第七根滑杆不能把面板挤爆', () => {
  it('面板本体始终可滚动（内容再多也不会有点不到的控件）', () => {
    const dbg = css.slice(css.indexOf('.dbg {'), css.indexOf('.dbg[hidden]'));
    expect(dbg).toContain('bottom: calc(var(--safe-bottom) + 8px)');
    expect(dbg).toContain('overflow-y: auto');
  });

  /**
   * 反证：P-077 加了「氛围压暗·昼夜」之后，844×390 手机横屏实测
   * 「复制全部机位 / 下载 .txt」被切掉一半、性能读数看不见。
   * 短屏 media 里这几条压缩规则少一条，那张图就会回到被裁的状态。
   */
  it('短横屏专门收紧：收说明、压行距、压矮导出框与性能读数', () => {
    const short = css.slice(css.indexOf('@media (orientation: landscape) and (max-height: 520px)'));
    expect(short).toContain('.dbg__hint {');
    expect(short).toContain('.dbg__row {');
    expect(short).toContain('min-height: 18px');
    expect(short).toContain('.dbg__export {');
    expect(short).toContain('min-height: 30px');
    expect(short).toContain('.dbg__perf {');
  });
});
