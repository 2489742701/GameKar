/**
 * **开发者模式**（2026-11-08 用户："把调试默认设为看不见，
 * 在设置里面，将'开发者模式'开关默认设为关闭"）。
 *
 * 一个开关管三样：F2、工具行「调试」按钮、相机调试面板的可用性。
 * 状态只在入口一处，HUD / DebugPanel 都只是被通知的一方。
 * 2026-11-08 模组化后 `main.ts` 变成薄分流器，原入口**原样**搬到了 `vanilla.ts`
 * —— 判据一个没松，只是改读新位置（见 `tests/mod_isolation_20261108.test.ts`）。
 * 最要紧的反证：把 F2 里那句 `if (devMode)` 删掉，正常玩家又能按出调试面板。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEV_KEY, loadDevMode, saveDevMode } from '@arena/devMode';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const entry = readFileSync(join(ROOT, 'src/arena/vanilla.ts'), 'utf8');
const hud = readFileSync(join(ROOT, 'src/arena/ArenaHud.ts'), 'utf8');
const panel = readFileSync(join(ROOT, 'src/arena/DebugPanel.ts'), 'utf8');
const dev = readFileSync(join(ROOT, 'src/arena/devMode.ts'), 'utf8');

afterEach(() => vi.unstubAllGlobals());

describe('开发者模式：默认关', () => {
  it('存档 key 固定，无 localStorage 时返回 false', () => {
    expect(DEV_KEY).toBe('gamekar.devMode.v1');
    expect(loadDevMode()).toBe(false);
  });

  it('开关读写：只有 "1" 算开，别的值都算关', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    expect(loadDevMode(), '没存档 ⇒ 关').toBe(false);
    saveDevMode(true);
    expect(store.get(DEV_KEY)).toBe('1');
    expect(loadDevMode()).toBe(true);
    saveDevMode(false);
    expect(loadDevMode()).toBe(false);
    store.set(DEV_KEY, 'garbage');
    expect(loadDevMode(), '脏值不许当开').toBe(false);
  });

  it('反证：默认不许写成 true（写死开启会让所有玩家看到调试入口）', () => {
    expect(dev).toContain("localStorage.getItem(DEV_KEY) === '1'");
    expect(dev).not.toMatch(/return true;\s*\}\s*catch/);
  });
});

describe('开发者模式：单一状态源与三处入口', () => {
  it('vanilla.ts（原入口）是唯一持有者：默认关 + ?debug=1 只强制初值、不写存档', () => {
    expect(entry).toContain("const forcedDebug = params.get('debug') === '1'");
    expect(entry).toContain('let devMode = forcedDebug || loadDevMode();');
    expect(entry).toContain('devMode: () => devMode');
    expect(entry).toContain('onDevModeChange: (on) => setDevMode(on)');
    expect(entry).toContain('debug.setEnabled(devMode)');
    expect(entry).toContain('function setDevMode(on: boolean): void');
  });

  it('反证：F2 必须判 devMode，关着时按了什么都不发生', () => {
    const from = entry.indexOf("e.key === 'F2'");
    const block = entry.slice(from, from + 220);
    expect(block).toMatch(/if \(devMode\)\s*debug\?\.toggle\(\)/);
    // 反证：删掉判断后就会变成行首直接 toggle，这条会红
    expect(block).not.toMatch(/^\s*debug\?\.toggle\(\);/m);
  });

  it('HUD：工具行按钮隐藏 + 设置页开关，均由 setDevMode 一处重画', () => {
    expect(hud).toContain('setDevMode(on: boolean): void');
    expect(hud).toContain('this.devBtn.hidden = !on');
    expect(hud).toContain("row('开发者模式'");
    expect(hud).toContain('this.opts.onDevModeChange?.(');
    expect(hud).toContain("this.setDevMode(this.opts.devMode?.() ?? false)");
  });

  it('DebugPanel：关掉之后 toggle / show 都不生效', () => {
    expect(panel).toContain('setEnabled(on: boolean): void');
    expect(panel).toContain('if (!on) this.hide()');
    expect(panel).toContain('if (!this.enabled) return;');
    const toggle = panel.slice(panel.indexOf('toggle(): void'), panel.indexOf('show(): void'));
    expect(toggle).toContain('if (!this.enabled) return;');
  });
});
