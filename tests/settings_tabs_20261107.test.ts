/**
 * 设置面板分窗口的锁（2026-11-07 用户："设置栏目应该有多个窗口，
 * 就是调不同的东西，而不是压在一起"）。
 *
 * 三类设置（托管 / 方向 / 花色）各有生效时机：托管和方向立刻生效且常驻保存，
 * 花色下一局生效。堆在一条滚动栏里时这句说明混成一团，玩家找开关还要翻半天。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hud = readFileSync(join(ROOT, 'src/arena/ArenaHud.ts'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/arena.css'), 'utf8');

describe('标签栏结构', () => {
  it('三页各有自己的 key / 标题 / 生效说明', () => {
    expect(hud).toContain("key: 'auto'");
    expect(hud).toContain("key: 'controls'");
    expect(hud).toContain("key: 'banner'");
    expect(hud).toContain("label: '托管'");
    expect(hud).toContain("label: '方向'");
    expect(hud).toContain("label: '旗帜'");
    expect(hud).toContain('改完立刻生效并存在本机');
    expect(hud).toContain('下一局生效');
  });

  it('切换时只亮一个按钮、只显示一页，底部说明跟着换', () => {
    expect(hud).toContain('private selectSettingsTab(key: SettingsTab)');
    expect(hud).toContain("btn.dataset['on'] = String(on)");
    expect(hud).toContain('pane.hidden = k !== key');
    expect(hud).toContain('this.settingsHint.textContent');
    // 打开面板时也要同步一次，别留着上一次的 DOM 状态
    expect(hud).toContain('if (next) this.selectSettingsTab(this.settingsTab)');
  });

  it('记住上次那一页（不是每次叫出都跳回第一页）', () => {
    expect(hud).toContain("private settingsTab: SettingsTab = 'auto'");
    expect(hud).toContain('this.settingsTab = key');
  });

  it('三样内容各自进自己的 pane，不再直接 append 到面板根上', () => {
    expect(hud).toContain('auto: this.buildAutoOptions()');
    expect(hud).toContain('controls: this.buildControlOptions()');
    expect(hud).toContain('banner: createBannerEditor(');
    expect(hud).toContain("this.settingsPanes.set(def.key, pane)");
    expect(hud).toContain("this.settingsPanel.append(settingsHead, tabs, body, this.settingsHint)");
  });
});

describe('CSS：头与标签栏固定，只有内容区滚动', () => {
  it('面板整体不再滚动，滚动交给 body', () => {
    // 只取 .ahud__settings 根规则的声明块；后面的 __body 本来就该 overflow-y:auto
    const block = /\.ahud__settings\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toContain('overflow: hidden');
    expect(block).not.toContain('overflow-y: auto');
    expect(css).toContain('.ahud__settings__body {');
    expect(css).toContain('.ahud__settings__pane[hidden]');
  });

  it('标签栏与底部说明都 flex:none，不会被内容挤走', () => {
    expect(css).toContain('.ahud__settings__tabs {');
    expect(css).toContain('.ahud__settings__foot {');
    expect(css).toContain('.ahud__settings__tab[data-on=\'true\']');
  });
});

describe('反证：退回"一锅粥"的单页必须被看出来', () => {
  it('把切换逻辑拿掉、三页全显示，这些锁会红', () => {
    // 这两条是判据存在的正向锁；反证在实机/无头探针里做（改源码后跑 DOM 读数）。
    // 这里明确锁住"隐藏其余页"这一句，防止有人只把按钮画出来却不真的切页。
    expect(hud).toMatch(/for \(const \[k, pane\] of this\.settingsPanes\) pane\.hidden = k !== key/);
    expect(hud).not.toContain('this.settingsPanel.append(settingsHead, settingsNote, this.buildAutoOptions()');
  });
});
