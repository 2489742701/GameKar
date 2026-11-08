/**
 * P-079 后期设置页 + 景深跟随镜头（2026-11-08）。
 *
 * 用户一口气四件事："顶栏始终要居中、手机版只留简要 SVG、后期也加一个设置栏、
 * 景深可以高一点或低一点让用户自己调，偏向高一点；拉近景深高、拉远景深低。"
 * 顶栏部分锁在 `hud_topbar_20261107.test.ts`，这一份管后面两件。
 *
 * 核心红线：**基准（用户拖的）和生效值（含镜头联动）必须是两个量**。
 * 混成一个的话，自动联动会把滑杆自己拽回去，玩家以为没调动。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TILT_AUTO_KEY,
  TILT_DEFAULT,
  TILT_ZOOM_SLOPE,
  loadTilt,
  loadTiltAuto,
  saveTilt,
  saveTiltAuto,
} from '@arena/visuals/tiltShift';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const app = readFileSync(join(ROOT, 'src/arena/ArenaApp.ts'), 'utf8');
const hud = readFileSync(join(ROOT, 'src/arena/ArenaHud.ts'), 'utf8');
const panel = readFileSync(join(ROOT, 'src/arena/DebugPanel.ts'), 'utf8');
const shader = readFileSync(join(ROOT, 'src/arena/visuals/tiltShift.ts'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/arena.css'), 'utf8');

afterEach(() => vi.unstubAllGlobals());

describe('设置面板第四页「后期」', () => {
  it('四页各就各位，后期页有自己 key / 标题 / 生效说明', () => {
    expect(hud).toContain("type SettingsTab = 'auto' | 'controls' | 'banner' | 'post'");
    expect(hud).toContain("key: 'post'");
    expect(hud).toContain("label: '后期'");
    expect(hud).toContain('post: this.buildPostOptions()');
    expect(hud).toContain('改完立刻生效、存在本机');
  });

  it('两根滑杆 + 一个跟随开关，全都直连 App，不在 HUD 里另存数值', () => {
    expect(hud).toContain('this.app.setTilt(v)');
    expect(hud).toContain('this.app.setDim(v)');
    expect(hud).toContain('this.app.setTiltAuto(!this.app.tiltFollowsCamera)');
    expect(hud).toContain("input.type = 'range'");
    expect(hud).toContain('this.postControls = {');
    // 反证：HUD 里不许出现第二份默认值
    expect(hud).not.toContain('0.55');
  });

  it('F2 面板和设置页读同一份状态，10Hz 同步，不会各报一个数', () => {
    expect(hud).toContain('this.paintPostOptions()');
    expect(hud).toMatch(/refresh\(\): void \{\s*this\.paintAuto\(\);\s*this\.paintPostOptions\(\);/);
    expect(panel).toContain('this.app.tiltKnob');
    expect(panel).toContain('this.app.setTiltAuto(!this.app.tiltFollowsCamera)');
  });

  it('滑杆行在窄面板里是两行 grid，不挤成一团', () => {
    expect(css).toContain(".ahud__opt--range {");
    expect(css).toContain("grid-template-areas: 'txt num' 'range range'");
  });

  /**
   * 反证：844×390 横屏第一次实测「跟随镜头」那行被切掉一半、说明文字挤在底下。
   * 少了这几条压缩规则，设置页又只能靠滚动才够得着最后一行。
   */
  it('短横屏专门压紧设置面板，后期页三行一屏全露', () => {
    const short = css.slice(css.indexOf('@media (orientation: landscape) and (max-height: 520px)'));
    expect(short).toContain('max-height: 92vh');
    expect(short).toContain('.ahud__settings__body { max-height: 62vh; }');
    expect(short).toContain(".ahud__opt__desc { font-size: 9px; line-height: 1.2; }");
  });
});

describe('景深跟随镜头：拉近更强、拉远更弱', () => {
  it('数值只有一处：默认基准 0.55（偏高）、斜率 0.55、开关独立存档', () => {
    expect(TILT_DEFAULT).toBe(0.55);
    expect(TILT_ZOOM_SLOPE).toBe(0.55);
    expect(TILT_AUTO_KEY).toBe('gamekar.tiltAuto.v1');
    expect(loadTiltAuto(), '首次运行默认开').toBe(true);
    expect(loadTilt(), '无 localStorage 时走偏高默认').toBe(TILT_DEFAULT);
  });

  it('反证：公式按 zoomRatio 反向走，且夹在 0~1', () => {
    const effective = (base: number, ratio: number, auto: boolean): number => {
      const raw = auto ? base + (1 - ratio) * TILT_ZOOM_SLOPE : base;
      return Math.min(1, Math.max(0, raw));
    };
    expect(effective(0.55, 1, true), '默认机位 = 基准').toBeCloseTo(0.55, 6);
    expect(effective(0.55, 0.6, true), '拉近 ⇒ 更强').toBeCloseTo(0.77, 6);
    expect(effective(0.55, 1.4, true), '拉远 ⇒ 更弱').toBeCloseTo(0.33, 6);
    expect(effective(0.55, 0.6, false), '关跟随 ⇒ 恒等于基准').toBe(0.55);
    expect(effective(0.55, -5, true), '极端拉近也不许超过 1').toBe(1);
  });

  it('源码：联动每帧算、排在导演之后，渲染判据读生效值', () => {
    expect(app).toContain('(1 - this.zoomRatio) * TILT_ZOOM_SLOPE');
    expect(app).toContain('private syncTiltToCamera(): void');
    expect(app).toContain('this.tiltPass.uniforms[\'amount\']!.value = this.tiltEffective');
    const draw = app.slice(app.indexOf('this.director.update(info.delta'), app.indexOf('if (postFx'));
    expect(draw.indexOf('this.syncTiltToCamera()')).toBeGreaterThan(
      draw.indexOf('this.director.update(info.delta'),
    );
    expect(app).toContain('const postFx = this.tiltEffective > 0.001 || this.dimAmount > 0.001;');
  });

  it('反证：基准与生效值分开暴露，滑杆读 tiltKnob、遥测读 tilt', () => {
    expect(app).toContain('private tiltBase = loadTilt()');
    expect(app).toContain('private tiltEffective = 0');
    expect(app).toContain('get tilt(): number {');
    expect(app).toContain('get tiltKnob(): number {');
    expect(app).toContain('get tiltFollowsCamera(): boolean');
    expect(app).toContain('zoomRatio: this.zoomRatio');
    expect(app).toContain('tiltBase: this.tiltBase');
    expect(panel).toContain('this.app.tiltKnob');
    expect(panel).not.toContain("String(this.app.tilt)");
  });

  it('存档：景深基准与跟随开关各存各的，拖到 0 要尊重用户', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    expect(loadTilt(), '没存档 ⇒ 偏高默认').toBe(0.55);
    saveTilt(0);
    expect(loadTilt(), '用户拖到 0 ⇒ 真的关掉').toBe(0);
    saveTilt(1.7);
    expect(loadTilt()).toBe(1);
    saveTiltAuto(false);
    expect(loadTiltAuto()).toBe(false);
    expect(store.get(TILT_AUTO_KEY)).toBe('0');
    saveTiltAuto(true);
    expect(loadTiltAuto()).toBe(true);
  });

  it('旧写法反证：不许再用 Number(localStorage.getItem(...)) 把 null 读成 0', () => {
    expect(shader).toContain('if (raw === null) return fallback;');
    expect(shader).toContain('readStored(TILT_KEY, TILT_DEFAULT)');
    expect(shader).not.toContain('Number(localStorage.getItem(key))');
  });
});
