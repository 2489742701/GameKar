/**
 * 微缩景深（tilt-shift）的锁。
 *
 * 用户："建筑小小小小的，能不能搞个景深、模糊背景，比较卡哇伊的感觉"。
 * 做的是移轴微缩（中间清晰 / 上下虚 + 提饱和），不是 BokehPass：
 * 这里是正交相机，深度纹理那套既贵又不兼容。
 *
 * 三条红线：
 *  ① 默认关，且关的时候**完全不跑后期**（不能给不开的人加开销）；
 *  ② 强度可现场调；③ 调试面板里有滑杆，别做成"装上了但没入口"。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTilt, TILT_DEFAULT, TILT_KEY, TILT_SHIFT_SHADER } from '@arena/visuals/tiltShift';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const app = readFileSync(join(ROOT, 'src/arena/ArenaApp.ts'), 'utf8');
const panel = readFileSync(join(ROOT, 'src/arena/DebugPanel.ts'), 'utf8');

describe('微缩景深', () => {
  it('默认基准偏高（用户"偏向高一点好看"），存档 key 固定；shader 初值仍是 0', () => {
    // node 里没有 localStorage ⇒ loadTilt() 走 fallback，正好量"首次运行"的默认值
    expect(TILT_DEFAULT).toBe(0.55);
    expect(loadTilt()).toBe(TILT_DEFAULT);
    expect(TILT_KEY).toBe('gamekar.tilt.v1');
    expect(TILT_SHIFT_SHADER.uniforms.amount.value).toBe(0);
  });

  it('shader 是移轴：有清晰带、模糊半径、提饱和，且不吃深度纹理', () => {
    const frag = TILT_SHIFT_SHADER.fragmentShader;
    expect(frag).toContain('smoothstep(focusWidth');
    expect(frag).toContain('texture2D(tDiffuse');
    expect(frag).toContain('vec3(0.299, 0.587, 0.114)'); // 提饱和
    expect(frag).not.toContain('depthTexture');
    expect(TILT_SHIFT_SHADER.uniforms.resolution.value.x).toBe(1);
  });

  it('两个旋钮实际生效值都为 0 时直接 renderer.render，一帧后期都不跑', () => {
    expect(app).toContain('const postFx = this.tiltEffective > 0.001 || this.dimAmount > 0.001;');
    expect(app).toContain('if (postFx && this.composer) this.composer.render(info.delta);');
    expect(app).toContain('else this.renderer.render(this.scene, this.rig.camera);');
    expect(app).toContain('private syncPostFx(');
  });

  it('强度可现场调（设置页 / F2 同一条路径）', () => {
    expect(app).toContain('setTilt(amount: number): void');
    expect(app).toContain('saveTilt(this.tiltBase)');
    expect(panel).toContain("this.slider('微缩景深'");
    expect(panel).toContain('(v) => this.app.setTilt(v)');
  });

  it('后期接管时不报假的 drawCalls 读数', () => {
    expect(panel).toContain('后期接管');
  });
});
