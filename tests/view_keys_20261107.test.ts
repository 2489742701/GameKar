/**
 * 桌面视角键的锁（2026-11-07 深夜用户纠正："电脑的 W 和 S 是调整视角的上下俯视的"）。
 *
 * 上一版把整组 WASD 当人物移动键：W/S 前后平移、A/D 左右平移、Q/E 转 yaw。
 * 但这里是**调相机**，W/S 应该是俯仰 pitch。这条锁钉住映射，防止哪天又被"统一"
 * 回平移去。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const app = readFileSync(join(ROOT, 'src/arena/ArenaApp.ts'), 'utf8');
const panel = readFileSync(join(ROOT, 'src/arena/DebugPanel.ts'), 'utf8');

/** 只取 stepViewKeys 的函数体，别让别处的 setPitch 混进来。 */
function body(): string {
  const start = app.indexOf('private stepViewKeys(');
  const end = app.indexOf('private', start + 10);
  expect(start).toBeGreaterThan(0);
  return app.slice(start, end);
}

describe('桌面视角键', () => {
  it('W/S 改俯仰（setPitch），不是平移', () => {
    const b = body();
    expect(b).toContain("if (this.keys.has('w')) this.rig.setPitch(this.rig.pitch + tilt)");
    expect(b).toContain("if (this.keys.has('s')) this.rig.setPitch(this.rig.pitch - tilt)");
    expect(b).toContain('const tilt = 60 * sec');
    // 反证：旧写法是 W/S 往 dy 里加像素
    expect(b).not.toContain('dy');
  });

  it('A/D 平移、Q/E 转朝向，仍然保留', () => {
    const b = body();
    expect(b).toContain("if (this.keys.has('a')) dx += px");
    expect(b).toContain("if (this.keys.has('d')) dx -= px");
    expect(b).toContain('this.rig.panByPixels(dx, 0)');
    expect(b).toContain("if (this.keys.has('q')) this.rig.rotateBy(-turn)");
    expect(b).toContain("if (this.keys.has('e')) this.rig.rotateBy(turn)");
  });

  it('调试面板把键位写清楚（免得下次又靠猜）', () => {
    expect(panel).toContain('W/S 调俯仰、A/D 平移、Q/E 转向');
  });
});
