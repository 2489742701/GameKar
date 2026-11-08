/**
 * HUD 顶栏结构的锁（2026-11-07 晚定稿，2026-11-08 P-079 返工）。
 *
 * 用户的口径一路演进，最后定的是：
 * "设置/视角/退出在顶栏，时间放在中间" → "顶栏始终要居中，但手机版会卡在一起，
 *  只显示简要的 SVG，退出、设置都画一下"。
 *
 * 返工原因：`1fr auto 1fr` 看着对称，右列三颗**文字**按钮的 min-content 会把
 * `1fr` 撑开，时钟被挤到屏幕 36% 处（真机量过）。改成时钟绝对居中 +
 * 三颗按钮 SVG 图标化，三种视口实测 offsetPx 全为 0。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hud = readFileSync(join(ROOT, 'src/arena/ArenaHud.ts'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/arena.css'), 'utf8');
const icons = readFileSync(join(ROOT, 'src/arena/topbarIcons.ts'), 'utf8');

describe('顶栏：读数 / 时间 / 视角·设置·退出', () => {
  it('三件套装在顶栏那一排，不是底部工具行', () => {
    expect(hud).toContain("const topTools = make('div', 'ahud__tools ahud__tools--top')");
    expect(hud).toContain('topTools.append(view.btn, settings.btn, quit.btn)');
    expect(hud).toContain('top.append(supply, this.clock, topTools)');
    // 底部那一排只剩托管（+ 调试按钮）
    expect(hud).toContain('tools.append(auto)');
  });

  /** 反证：把 grid 三列放回来，右列 min-content 又会挤歪时钟。 */
  it('时间严格居中：绝对定位 50% + translateX(-50%)，不再靠等宽列', () => {
    const block = css.slice(css.indexOf('.ahud__top {'), css.indexOf('.ahud__hp {'));
    expect(block).toContain('position: relative');
    expect(block).toContain('display: flex');
    expect(block).toContain('left: 50%');
    expect(block).toContain('transform: translateX(-50%)');
    expect(block).not.toContain('grid-template-columns');
    expect(block).not.toContain('justify-self: center');
  });

  it('三颗按钮各有一枚简要 SVG，手机上文字收掉只留图标', () => {
    expect(icons).toContain('VIEW_ICON');
    expect(icons).toContain('SETTINGS_ICON');
    expect(icons).toContain('QUIT_ICON');
    // 设置那枚是真齿轮（evenodd 挖孔），不是"中心圆 + 八根辐条"的太阳
    expect(icons).toContain('fill-rule="evenodd"');
    expect(hud).toContain('iconButton(VIEW_ICON');
    expect(hud).toContain('iconButton(SETTINGS_ICON');
    expect(hud).toContain('iconButton(QUIT_ICON');
    expect(hud).toContain("btn.setAttribute('aria-label', label)");
    expect(css).toContain('.ahud__iconbtn__txt { display: none; }');
  });

  /** 反证：以前 `setViewStatus` / 两段式退出直接改 button.textContent，会把 SVG 一起冲掉。 */
  it('改文字只动 span，不许覆盖按钮的 textContent', () => {
    expect(hud).toContain('this.viewBtnText.textContent !== status');
    expect(hud).toContain('this.quitBtnText.textContent =');
    expect(hud).not.toContain('this.quitBtn.textContent =');
    expect(hud).not.toContain('this.viewBtn.textContent =');
  });

  it('右键不再开设置（入口只在顶栏那颗按钮）', () => {
    expect(hud).not.toContain("addEventListener('contextmenu'");
    expect(hud).toContain("settings.btn.addEventListener('click', () => this.openSettings())");
  });

  it('手机上也有相机调试入口（F2 之外的那条）', () => {
    expect(hud).toContain("'ahud__view ahud__debugbtn'");
    expect(hud).toContain('this.opts.onToggleDebug?.()');
  });
});
