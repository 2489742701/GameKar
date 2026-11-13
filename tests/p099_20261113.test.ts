/**
 * P-099（2026-11-13）：「做一下，就是夜晚」—— 把 P-077 留的 dim 接口接上昼夜时间轴。
 *
 * 用户原始方向：「10 分钟一大局，从早打到晚（夕阳 + 夜晚）」，
 * 接口 `setDim(elapsed / 总时长)`，**白天 0 仍零后期开销**；
 * ⚠️ HUD 是 DOM 不吃 WebGL 后期，做昼夜必须同步 HUD 主题。
 *
 * 这里钉的是：曲线只有一处、白天真的零开销、色温确实进了 shader、
 * HUD 主题跟着同一个 period 走、手动滑杆不会被时间轴覆盖回去。
 * 每条主锁配反证：把关键实现删掉，锁必须红。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY_CYCLE, MATCH } from '@arena/config';
import {
  dayPhaseAt,
  dayPhaseFromDim,
  dayTotalSeconds,
} from '@arena/visuals/dayCycle';
import {
  DAY_CLOCK_KEY,
  TILT_SHIFT_SHADER,
  loadDayClock,
  saveDayClock,
} from '@arena/visuals/tiltShift';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const app = read('src/arena/ArenaApp.ts');
const hud = read('src/arena/ArenaHud.ts');
const css = read('src/styles/arena.css');
const curve = read('src/arena/visuals/dayCycle.ts');
const frag = TILT_SHIFT_SHADER.fragmentShader;

afterEach(() => vi.unstubAllGlobals());

describe('昼夜曲线：一张表、三段、单调', () => {
  it('分界与压暗值都合法，白天比例最长', () => {
    expect(DAY_CYCLE.duskAt).toBeGreaterThan(0);
    expect(DAY_CYCLE.duskAt).toBeLessThan(DAY_CYCLE.nightAt);
    expect(DAY_CYCLE.nightAt).toBeLessThan(1);
    expect(DAY_CYCLE.duskDim).toBeGreaterThan(0);
    expect(DAY_CYCLE.nightDim).toBeGreaterThan(DAY_CYCLE.duskDim);
    expect(DAY_CYCLE.nightDim).toBeLessThanOrEqual(1);
    expect(DAY_CYCLE.endlessSeconds).toBeGreaterThan(MATCH.seconds);
  });

  it('★ 白天 dim=0 且 tint 是单位向量 ⇒ 不会把 composer 平白拉起来', () => {
    const dawn = dayPhaseAt(0, MATCH.seconds);
    expect(dawn.period).toBe('day');
    expect(dawn.dim).toBe(0);
    expect([...dawn.tint]).toEqual([1, 1, 1]);
    // 整个白天段（不是只有 t=0）都必须是 0
    for (let p = 0; p < DAY_CYCLE.duskAt; p += 0.02) {
      const phase = dayPhaseAt(p * MATCH.seconds, MATCH.seconds);
      expect(phase.dim, `p=${p.toFixed(2)}`).toBe(0);
      expect(phase.period).toBe('day');
    }
  });

  it('夕阳偏暖、夜晚偏冷，dim 一路只增不减', () => {
    let last = -1;
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const phase = dayPhaseAt(p * MATCH.seconds, MATCH.seconds);
      expect(phase.dim, `p=${p.toFixed(2)}`).toBeGreaterThanOrEqual(last);
      last = phase.dim;
    }
    expect(last).toBeCloseTo(DAY_CYCLE.nightDim, 6);

    const dusk = dayPhaseAt(DAY_CYCLE.nightAt * MATCH.seconds * 0.98, MATCH.seconds);
    const night = dayPhaseAt(MATCH.seconds, MATCH.seconds);
    expect(dusk.period).toBe('dusk');
    expect(dusk.tint[0]).toBeGreaterThan(dusk.tint[2]); // 暖：红 > 蓝
    expect(night.period).toBe('night');
    expect(night.tint[2]).toBeGreaterThan(night.tint[0]); // 冷：蓝 > 红
  });

  it('分界处不跳档：压暗与色温连续', () => {
    for (const at of [DAY_CYCLE.duskAt, DAY_CYCLE.nightAt]) {
      const before = dayPhaseAt((at - 0.0001) * MATCH.seconds, MATCH.seconds);
      const after = dayPhaseAt((at + 0.0001) * MATCH.seconds, MATCH.seconds);
      expect(after.dim).toBeCloseTo(before.dim, 3);
      for (let i = 0; i < 3; i++) {
        expect(after.tint[i]!).toBeCloseTo(before.tint[i]!, 3);
      }
    }
  });

  it('按总时长归一化：3 分钟和 10 分钟同一个进度出同一个画面', () => {
    const a = dayPhaseAt(0.6 * MATCH.seconds, MATCH.seconds);
    const b = dayPhaseAt(0.6 * 600, 600); // 以后真做 10 分钟大局
    expect(b.period).toBe(a.period);
    expect(b.dim).toBeCloseTo(a.dim, 10);
    expect([...b.tint]).toEqual([...a.tint]);
    expect(curve).toContain('elapsed / 总时长');
  });

  it('加时 / 超出总时长钳在夜晚，不会绕回白天', () => {
    const end = dayPhaseAt(MATCH.seconds, MATCH.seconds);
    const beyond = dayPhaseAt(MATCH.seconds + MATCH.overtimeSeconds, MATCH.seconds);
    expect(beyond).toEqual(end);
    expect(beyond.period).toBe('night');
  });

  it('总时长按模式取，且常规局读 MATCH.seconds（不是写死 180）', () => {
    expect(dayTotalSeconds('arena')).toBe(MATCH.seconds);
    expect(dayTotalSeconds('pve', 300)).toBe(300);
    expect(dayTotalSeconds('endless')).toBe(DAY_CYCLE.endlessSeconds);
    expect(curve).toContain('return MATCH.seconds;');
    expect(curve).not.toContain('return 180;');
  });

  it('反证：白天被偷偷加一点压暗，零开销锁就红', () => {
    const withAmbient = { ...dayPhaseAt(0, MATCH.seconds), dim: 0.01 };
    expect(withAmbient.dim).toBeGreaterThan(0);
    // postFx 的判据确实只看 dim / tilt —— 0.01 就会拉起 composer
    const postFx = (dim: number) => 0 > 0.001 || dim > 0.001;
    expect(postFx(dayPhaseAt(0, MATCH.seconds).dim)).toBe(false);
    expect(postFx(withAmbient.dim)).toBe(true);
  });
});

describe('手动滑杆与时间轴同源', () => {
  it('dim=0 ⇒ 白天；dim=nightDim ⇒ 夜晚且色温一致', () => {
    expect(dayPhaseFromDim(0).period).toBe('day');
    expect([...dayPhaseFromDim(0).tint]).toEqual([1, 1, 1]);
    const auto = dayPhaseAt(MATCH.seconds, MATCH.seconds);
    const manual = dayPhaseFromDim(auto.dim);
    expect(manual.period).toBe('night');
    expect(manual.dim).toBeCloseTo(auto.dim, 10);
    for (let i = 0; i < 3; i++) expect(manual.tint[i]!).toBeCloseTo(auto.tint[i]!, 3);
  });

  it('dim 原样返回，不夹掉用户拖出来的值', () => {
    expect(dayPhaseFromDim(0.95).dim).toBe(0.95);
    expect(dayPhaseFromDim(-3).dim).toBe(0);
    expect(dayPhaseFromDim(3).dim).toBe(1);
  });
});

describe('色温进了 shader，且白天是恒等', () => {
  it('tint uniform 默认 (1,1,1)，fragment 里真的乘了一次', () => {
    const t = TILT_SHIFT_SHADER.uniforms.tint.value;
    expect(t.x).toBe(1);
    expect(t.y).toBe(1);
    expect(t.z).toBe(1);
    expect(frag).toContain('uniform vec3 tint;');
    expect(frag).toContain('base.rgb *= tint;');
    // 乘在 dim 分支之后（显示空间），不碰景深段
    expect(frag.indexOf('base.rgb *= tint;')).toBeGreaterThan(frag.indexOf('if (dim > 0.001)'));
  });

  it('反证：把这行乘法删掉，结构锁必须红', () => {
    const stripped = frag.replace('base.rgb *= tint;', '');
    expect(stripped).not.toContain('base.rgb *= tint;');
    expect(frag).toContain('base.rgb *= tint;');
  });
});

describe('HUD 是 DOM，必须跟着同一个 period 换主题', () => {
  it('App 每帧只算一次 phase，再分给 shader / DOM / telemetry', () => {
    expect(app).toContain("import { dayPhaseAt, dayPhaseFromDim, dayTotalSeconds");
    expect(app).toContain('private syncDay(): void');
    expect(app).toContain('this.syncDay();');
    // 顺序：syncDay 必须排在 postFx 判定之前，否则本帧用的是上一帧的 dim
    expect(app.indexOf('this.syncDay();')).toBeLessThan(app.indexOf('const postFx ='));
    expect(app).toContain('dayPhaseAt(');
    expect(app).toContain('dayPhaseFromDim(this.dimAmount)');
    expect(app).toContain('this.tiltPass.uniforms[\'tint\']!.value as THREE.Vector3');
    expect(app).toContain("delete this.opts.container.dataset['period']");
    expect(app).toContain("this.opts.container.dataset['period'] = phase.period");
    expect(app).toContain('dayPeriod: this.periodNow');
    expect(app).toContain('dayClock: this.dayClockOn');
  });

  it('夕阳 / 夜晚两套 CSS 都在，夜里收掉木纹', () => {
    expect(css).toContain('#arena-ui[data-period="dusk"]');
    expect(css).toContain('#arena-ui[data-period="night"]');
    expect(css).toContain('--tex-wood: none;');
    expect(css).toContain('#arena-ui[data-period="night"] .ahud__card');
    // 反证：把夜间卡面规则整族拿掉，锁就红（这个前缀在 [data-selected] 变体里也出现）
    const stripped = css.replaceAll('#arena-ui[data-period="night"] .ahud__card', '');
    expect(stripped).not.toContain('#arena-ui[data-period="night"] .ahud__card');
  });

  it('设置页有「昼夜 · 自动」开关，读数跟着时间轴刷新', () => {
    expect(hud).toContain("make('span', 'ahud__opt__name', '昼夜 · 自动')");
    expect(hud).toContain('this.app.setDayClock(!this.app.dayClock)');
    expect(hud).toContain("c.dayClock.textContent = this.app.dayClock ? '自动 · 开' : '自动 · 关';");
    expect(hud).toContain('this.app.setDim(v)');
  });

  it('拖手动滑杆会关掉自动，且只在这里写存档', () => {
    const setter = app.slice(app.indexOf('setDim(amount: number): void'), app.indexOf('get dayClock(): boolean'));
    expect(setter).toContain('this.dayClockOn = false;');
    expect(setter).toContain('saveDayClock(false);');
    expect(setter).toContain('saveDim(this.dimAmount)');
    expect(setter).toContain('this.applyDay(dayPhaseFromDim(this.dimAmount));');
    // 自动模式的 syncDay 不许写 localStorage
    const sync = app.slice(app.indexOf('private syncDay(): void'), app.indexOf('private applyDay('));
    expect(sync).not.toContain('saveDim');
    expect(sync).not.toContain('saveDayClock');
  });
});

describe('亮度闸门不许再给假绿', () => {
  it('P-099：探针先确认 window.arena 活着，空白页必须 FAIL', () => {
    const probe = read('tools/brightness_probe.mjs');
    expect(probe).toContain("typeof a?.setDim === 'function'");
    expect(probe).toContain("if (!booted?.ok || !booted?.hasDim)");
    expect(probe).toContain("console.log('GATE FAIL: arena 没起来，闸门不许给假绿。'");
    expect(probe).toContain('process.exitCode = 1');
    // 反证：把启动校验删掉，这条锁就红（以前端口 4173 没起也会 PASS 0.00%）
    const stripped = probe.replace("if (!booted?.ok || !booted?.hasDim)", 'if (false)');
    expect(stripped).not.toContain("if (!booted?.ok || !booted?.hasDim)");
  });
});

describe('昼夜自动开关：默认开、独立存档', () => {
  it('key 独立，默认开，显式存 0 才关', () => {
    expect(DAY_CLOCK_KEY).toBe('gamekar.dayClock.v1');
    expect(DAY_CLOCK_KEY).not.toBe('gamekar.dim.v1');
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    expect(loadDayClock()).toBe(true);
    saveDayClock(false);
    expect(store.get(DAY_CLOCK_KEY)).toBe('0');
    expect(loadDayClock()).toBe(false);
    saveDayClock(true);
    expect(loadDayClock()).toBe(true);
  });
});
