/**
 * 操作方向偏好的锁（2026-11-07 用户："双指上下滑动能不能反转一下？我个人的偏好是
 * 反转过来的……在设置里面可以把操作反转之类的都设置好，可以常态化保存"）。
 *
 * 三条要分别量，别混成一句"做了"：
 *  ① 默认方向真的换成了用户要的那一侧；
 *  ② 四个反转开关真的会改符号（不是"装上了"的假开关）；
 *  ③ 存档能读回来、坏了能回落，而且**手势回调确实读了这份偏好**（装配锁，
 *     防止以后有人把手势改回写死的符号，设置面板变成摆设）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_KEY,
  DEFAULT_CONTROLS,
  loadControls,
  panDelta,
  pitchDelta,
  rotateDelta,
  saveControls,
  TILT_DEG_PER_PX,
  zoomDelta,
  type ControlPrefs,
} from '@arena/controls';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  } as Storage;
}

const prefs = (over: Partial<ControlPrefs> = {}): ControlPrefs => ({ ...DEFAULT_CONTROLS, ...over });

describe('默认方向与反转开关', () => {
  it('默认四个方向都不反转（托管已改成纯手动，不再有闲置档）', () => {
    // 只剩四个方向开关：`idleAuto`（闲置自动托管）2026-11-07 傍晚按用户口径删掉了
    expect(DEFAULT_CONTROLS).toEqual({
      tiltInvert: false,
      panInvert: false,
      rotateInvert: false,
      zoomInvert: false,
    });
  });

  it('双指往下滑 = 更俯视（pitch 增），往上滑 = 更平；这是这次改过来的方向', () => {
    expect(pitchDelta(100, prefs())).toBeCloseTo(100 * TILT_DEG_PER_PX);
    expect(pitchDelta(-100, prefs())).toBeCloseTo(-100 * TILT_DEG_PER_PX);
  });

  it('反证：勾上「反转」后符号必须翻过来（回到上一版那个方向）', () => {
    const normal = pitchDelta(100, prefs());
    const inverted = pitchDelta(100, prefs({ tiltInvert: true }));
    expect(normal).toBeGreaterThan(0);
    expect(inverted).toBeCloseTo(-normal);
  });

  it('平移 / 转视角 / 缩放三个开关也各自真的改符号', () => {
    expect(panDelta(8, -5, prefs())).toEqual([8, -5]);
    expect(panDelta(8, -5, prefs({ panInvert: true }))).toEqual([-8, 5]);
    expect(rotateDelta(12, prefs())).toBe(12);
    expect(rotateDelta(12, prefs({ rotateInvert: true }))).toBe(-12);
    expect(zoomDelta(2, prefs())).toBe(2);
    // 缩放反转取倒数，不是取负 —— 倍率取负会把相机翻过来
    expect(zoomDelta(2, prefs({ zoomInvert: true }))).toBe(0.5);
  });

  it('四个开关互不串味：只反转俯仰时，另外三个仍是默认方向', () => {
    const p = prefs({ tiltInvert: true });
    expect(panDelta(3, 4, p)).toEqual([3, 4]);
    expect(rotateDelta(9, p)).toBe(9);
    expect(zoomDelta(1.5, p)).toBe(1.5);
  });
});

describe('常态化保存（localStorage）', () => {
  it('save → load 闭环：四个开关都读得回来', () => {
    const s = fakeStorage();
    const wanted = prefs({ tiltInvert: true, rotateInvert: true });
    saveControls(wanted, s);
    expect(s.getItem(CONTROL_KEY)).toBeTruthy();
    expect(loadControls(s)).toEqual(wanted);
  });

  it('没存过档 / 存储不可用 ⇒ 回落默认，不抛错', () => {
    expect(loadControls(fakeStorage())).toEqual(DEFAULT_CONTROLS);
    expect(loadControls(null)).toEqual(DEFAULT_CONTROLS);
    expect(() => saveControls(prefs(), null)).not.toThrow();
  });

  it('存档坏了（非法 JSON、数组、字段类型不对）都不拖垮启动', () => {
    const s = fakeStorage();
    s.setItem(CONTROL_KEY, '{oops');
    expect(loadControls(s)).toEqual(DEFAULT_CONTROLS);
    s.setItem(CONTROL_KEY, '["tiltInvert"]');
    expect(loadControls(s)).toEqual(DEFAULT_CONTROLS);
    s.setItem(CONTROL_KEY, JSON.stringify({ tiltInvert: true, panInvert: 'yes', nope: 1 }));
    const got = loadControls(s);
    expect(got.tiltInvert).toBe(true);
    expect(got.panInvert).toBe(false); // 非布尔值不认，其余三项保住
    expect(got.zoomInvert).toBe(false);
  });

  it('改一次存一次，旧值被覆盖而不是累加', () => {
    const s = fakeStorage();
    saveControls(prefs({ tiltInvert: true }), s);
    saveControls(prefs({ zoomInvert: true }), s);
    expect(loadControls(s)).toEqual(prefs({ zoomInvert: true }));
  });
});

/**
 * 装配锁：这个项目吃过「统计层装配完整、运行时零调用」的亏，
 * 所以"设置面板能存"和"手势回调真的读了它"必须分开验。
 */
describe('装配：四个手势回调都读同一份偏好', () => {
  const app = read('src/arena/ArenaApp.ts');
  const hud = read('src/arena/ArenaHud.ts');

  it('ArenaApp 的四个手势都走 controls.ts 的判据，没有写死的符号', () => {
    expect(app).toContain('panDelta(dx, dy, this.controls)');
    expect(app).toContain('zoomDelta(factor, this.controls)');
    expect(app).toContain('rotateDelta(deg, this.controls)');
    expect(app).toContain('pitchDelta(dy, this.controls)');
    expect(app).toContain('readonly controls = loadControls()');
    // 上一版那个写死的方向不该回来
    expect(app).not.toContain('this.rig.pitch - dy * 0.22');
  });

  it('设置面板改的是同一个对象并立刻存档（不用重载 / 事件总线）', () => {
    expect(hud).toContain('saveControls(this.app.controls)');
    expect(hud).toContain('this.app.controls[row.key] = !this.app.controls[row.key]');
    for (const key of ['tiltInvert', 'panInvert', 'rotateInvert', 'zoomInvert']) {
      expect(hud).toContain(`key: '${key}'`);
    }
  });

  it('旧的假开关 invertOrbit 已经拆掉，不留两套反转', () => {
    expect(read('src/arena/Camera.ts')).not.toContain('invertOrbit =');
  });
});
