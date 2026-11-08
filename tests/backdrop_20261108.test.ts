/**
 * P-082：收掉 P-077 遗留的「直出 → 后期」+10.47% 一次性亮度跳变。
 *
 * 根因（CDP 逐像素量出来的，见 `tools/brightness_probe.mjs`）：
 *   `gl.clearColor` 写的背景**不经过材质着色器**，直出时绕过了 ACES；
 *   composer 里 `RenderPass` 用上一帧残留的 sRGB 数值清线性 RT，`OutputPass`
 *   又对整幅做一次 ACES + sRGB，于是只有背景被抬亮：
 *     角落 (11,18,32) → (45,66,97)，画面中心几何 (199,171,99) 两边一模一样。
 *   把 clearColor 设成纯黑后跳变只剩 +0.03%（黑是色调映射的不动点）—— 反证成立。
 *
 * 修法：**背景改成被渲染出来的几何**（1×1 `NoColorSpace` DataTexture 当
 * `scene.background`），three 的全屏背景平面带 `tonemapping_fragment` +
 * `colorspace_fragment`，直出与 composer 于是对背景/几何走同一套数学。
 *
 * 这一族锁的是：修法不被退回成清屏色、颜色空间不被改成 sRGB、
 * 安装时机在 composer 之前、老模式的清屏色不被牵连。
 * 亮度数值本身由 `PROBE_STRICT=1 node tools/brightness_probe.mjs` 真机闸门验。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { BACKDROP_RGB, installArenaBackdrop } from '@arena/visuals/backdrop';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const app = readFileSync(join(ROOT, 'src/arena/ArenaApp.ts'), 'utf8');
const backdrop = readFileSync(join(ROOT, 'src/arena/visuals/backdrop.ts'), 'utf8');
const renderer = readFileSync(join(ROOT, 'src/engine/render/Renderer.ts'), 'utf8');
const probe = readFileSync(join(ROOT, 'tools/brightness_probe.mjs'), 'utf8');

describe('背景必须是渲染出来的几何，不是 gl.clearColor', () => {
  it('ArenaApp 在 composer 之前安装背景（顺序反了 RenderPass 就看不到背景平面）', () => {
    const install = app.indexOf('installArenaBackdrop(this.scene, this.renderer.instance)');
    const composer = app.indexOf('new EffectComposer');
    expect(install).toBeGreaterThan(0);
    expect(composer).toBeGreaterThan(0);
    expect(install).toBeLessThan(composer);
  });

  it('运行时真的把 1×1 纹理挂到 scene.background，并把 clearColor 设黑', () => {
    const scene = new THREE.Scene();
    const setClearColor = vi.fn();
    installArenaBackdrop(scene, { setClearColor } as unknown as THREE.WebGLRenderer);

    expect(setClearColor).toHaveBeenCalledWith(0x000000, 1);
    const bg = scene.background as THREE.DataTexture;
    expect(bg).toBeInstanceOf(THREE.DataTexture);
    expect(bg.isTexture).toBe(true);
    expect(bg.image.width).toBe(1);
    expect(bg.image.height).toBe(1);
    expect([...bg.image.data]).toEqual([...BACKDROP_RGB, 0xff]);
    // needsUpdate 只有 setter，赋值一次 version 就 +1（初始 0）
    expect(bg.version).toBeGreaterThan(0);
  });

  it('反证：纹理必须是 NoColorSpace；用 sRGB 会让背景平面 toneMapped=false，跳变立刻回来', () => {
    const bg = new THREE.DataTexture(new Uint8Array([...BACKDROP_RGB, 0xff]), 1, 1);
    bg.colorSpace = THREE.NoColorSpace;
    // three 的 WebGLBackground 就是按这一句决定 toneMapped 的
    expect(THREE.ColorManagement.getTransfer(bg.colorSpace)).not.toBe(THREE.SRGBTransfer);
    expect(THREE.ColorManagement.getTransfer(THREE.SRGBColorSpace)).toBe(THREE.SRGBTransfer);

    expect(backdrop).toContain('tex.colorSpace = THREE.NoColorSpace');
    expect(backdrop).not.toContain('tex.colorSpace = THREE.SRGBColorSpace');
    expect(backdrop).toContain('scene.background = tex');
    expect(backdrop).toContain('new THREE.DataTexture');
  });

  it('反证：对战模式不许再用非黑清屏色当背景；黑是唯一对色调映射不变的兜底', () => {
    expect(backdrop).toContain('renderer.setClearColor(0x000000, 1)');
    // ArenaApp 里不许再冒出带 0x0b1220 的 setClearColor
    expect(app).not.toMatch(/setClearColor\(\s*0x0b1220/);
    // 老模式 /index.html 仍用 Renderer 构造里的清屏色，不被这次改动牵连
    expect(renderer).toContain('this.instance.setClearColor(0x0b1220, 1)');
  });

  it('OutputPass 仍在，且顺序不变（P-077 的主修不能被 P-082 顺手删掉）', () => {
    expect(app).toContain('this.composer.addPass(new OutputPass());');
    const chain = app.slice(app.indexOf('new EffectComposer'), app.indexOf('// 场地底盘'));
    expect(chain.indexOf('addPass(new RenderPass')).toBeLessThan(chain.indexOf('addPass(new OutputPass())'));
    expect(chain.indexOf('addPass(new OutputPass())')).toBeLessThan(chain.indexOf('addPass(this.tiltPass)'));
  });
});

describe('亮度探针是常备回归闸门', () => {
  it('固定像素采样 + 严格模式，别退回只看平均亮度（平均看不出是背景还是整幅曝光）', () => {
    expect(probe).toContain("PROBE_STRICT");
    expect(probe).toContain('GATE 直出/后期亮度连续');
    expect(probe).toContain("samples[name] = [cur[i], cur[i + 1], cur[i + 2]]");
    expect(probe).toContain('Math.abs(jump) > 1.5');
  });
});
