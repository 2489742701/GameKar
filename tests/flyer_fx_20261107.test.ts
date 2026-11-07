/**
 * 深夜这五条视觉修复的锁（2026-11-07）：
 *  ① 空军飞得更高；② 拖尾跟着弹道；③ 空军坠地才解体；
 *  ④ 热气球变大 + 有吊篮；⑤ 只有挨打那一栋泛白。
 *
 * 都是渲染层事实，跑不了无 WebGL 的 DOM，所以锁源码里的结构 + 纯常量。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLYER_STYLE } from '@arena/visuals/flyers';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const app = readFileSync(join(ROOT, 'src/arena/ArenaApp.ts'), 'utf8');
const flyers = readFileSync(join(ROOT, 'src/arena/visuals/flyers.ts'), 'utf8');

describe('空军：高度与热气球', () => {
  it('飞行高度 3.8 格（2.6 那版还是贴着屋顶）', () => {
    expect(FLYER_STYLE.height).toBeGreaterThanOrEqual(3.5);
    expect(flyers).toContain('height: 3.8');
  });

  it('热气球球囊放大、吊篮是个"小斗子"（有立柱与上下沿）', () => {
    expect(flyers).toContain('new THREE.SphereGeometry(1.0, 16, 12)');
    expect(flyers).toContain('new THREE.BoxGeometry(0.66, 0.42, 0.66)');
    expect(flyers).toContain('斗子的四角立柱');
    expect(FLYER_STYLE.scale.balloon).toBeGreaterThanOrEqual(1.5);
  });
});

describe('拖尾与弹道', () => {
  it('弹丸朝向对齐瞬时速度（含抛物线仰角），不是只绕 Y', () => {
    expect(app).toContain('mesh.quaternion.setFromUnitVectors(');
    expect(app).toContain('arcAmp * Math.PI * Math.cos(k * Math.PI)');
    // 反证：旧的"只按水平方向绕 Y"写法不许回来
    expect(app).not.toContain("mesh.rotation.y = -Math.atan2(s.toZ - s.fromZ");
  });
});

describe('击落：先坠地，再解体', () => {
  it('死亡分支把飞行器交给 fallingFlyers，触地才 scatterPieces', () => {
    expect(app).toContain('private stepFalling(dt: number): void');
    expect(app).toContain('this.fallingFlyers.push(');
    expect(app).toContain('const pieces = this.scatterPieces(f.obj)');
    expect(app).toContain('this.stepFalling(info.delta)');
    // 反证：不许再"空中直接 scatter 当前飞行高度的 obj"
    expect(app).not.toContain('if (entry.siege || entry.flying)');
  });
});

describe('受击泛白：只白挨打那一栋', () => {
  it('建楼时克隆材质（kit.ts 的 materialCache 是全场共享的）', () => {
    expect(app).toContain('mesh.material = m.clone()');
    expect(app).toContain('全场共用一份');
  });
});
