/**
 * 相机调试面板的锁（2026-11-07 傍晚）。
 *
 * 用户要的是一个"能自己调机位、把 ID 发回来"的入口，所以这里锁三件事：
 *  ① 面板里那 5 个参数都得真接上相机（朝向 / 俯角 / 缩放 / 中心 col / row）；
 *  ② 槽位 + 「复制全部机位」还在（他一次要发好几档）；
 *  ③ **构造里不许 `apply()`** —— 上一版无条件套 DEFAULT_SHOT，
 *     一进游戏就把相机从 ARENA_CAMERA 拽走并 `locked`，导演再也接管不了。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHOT, encodeCamera, decodeCamera } from '@arena/cameraId';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(join(ROOT, 'src/arena/DebugPanel.ts'), 'utf8');
const app = readFileSync(join(ROOT, 'src/arena/ArenaApp.ts'), 'utf8');

describe('相机调试面板', () => {
  it('五个参数都接了相机：朝向 / 俯角 / 缩放 / 中心 col / 中心 row', () => {
    expect(src).toContain("this.slider('朝向 yaw'");
    expect(src).toContain("this.slider('俯角 pitch'");
    expect(src).toContain("this.slider('缩放 zoom'");
    expect(src).toContain("this.slider('中心 col'");
    expect(src).toContain("this.slider('中心 row'");
    expect(src).toContain('this.app.setCameraShot(shot)');
    expect(src).toContain('this.app.setCameraCenter(');
    // 相机侧真有这两个接口，不是面板自说自话
    expect(app).toContain('setCameraCenter(col: number, row: number): void');
    expect(app).toContain('get cameraCenterCell()');
  });

  it('能存多档机位，并一键复制整份（用户一次要发好几档）', () => {
    expect(src).toContain('private recordSlot()');
    expect(src).toContain('private slotLine(s: ShotSlot, i: number)');
    expect(src).toContain('复制全部机位');
    // 行格式固定：slotN + 机位 ID + 三项参数 + 中心
    expect(src).toContain('slot${i + 1} ${encodeCamera(s.shot)}');
  });

  /**
   * 反证历史坑：构造末尾那一版 `this.apply()` 会把相机拽到滑杆默认值。
   * 判据是"构造函数体里不出现 apply()"—— 只检查到 `private slider(` 之前那一段。
   */
  it('构造里不许 apply()（面板不许偷偷改玩家的镜头）', () => {
    const ctorStart = src.indexOf('constructor(private readonly app: ArenaApp) {');
    const ctorEnd = src.indexOf('private slider(');
    expect(ctorStart).toBeGreaterThan(0);
    expect(ctorEnd).toBeGreaterThan(ctorStart);
    const ctor = src.slice(ctorStart, ctorEnd);
    expect(ctor).not.toContain('this.apply()');
    expect(ctor).not.toContain('this.app.setCameraShot(');
  });

  it('机位 ID 可逆：同一组参数同一个码，解出来还是它', () => {
    const shot = { yaw: 238, pitch: 32, zoom: 0.8 };
    const code = encodeCamera(shot);
    expect(decodeCamera(code)).toEqual(shot);
    expect(encodeCamera(DEFAULT_SHOT)).toBe(encodeCamera({ ...DEFAULT_SHOT }));
  });
});
