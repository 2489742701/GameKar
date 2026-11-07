/**
 * HUD 顶栏结构的锁（2026-11-07 晚）。
 *
 * 用户当天两次改口，最后定的是：
 * "设置不应该是在顶栏那边，关和视角、退出也应在顶栏上面显示，时间放在中间。"
 * 所以这三条必须钉住 —— 它们是**布局约定**，没有逻辑断言能覆盖，
 * 只能扫源码（和 `settings_tabs` 那一族同一个路数）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hud = readFileSync(join(ROOT, 'src/arena/ArenaHud.ts'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/arena.css'), 'utf8');

describe('顶栏：读数 / 时间 / 视角·设置·退出', () => {
  it('三件套装在顶栏那一排，不是底部工具行', () => {
    expect(hud).toContain("const topTools = make('div', 'ahud__tools ahud__tools--top')");
    expect(hud).toContain('topTools.append(view, settings, quit)');
    expect(hud).toContain('top.append(supply, this.clock, topTools)');
    // 底部那一排只剩托管（+ 调试按钮）
    expect(hud).toContain('tools.append(auto)');
  });

  it('时间真正居中：顶栏是 1fr auto 1fr 的 grid，不是 flex space-between', () => {
    const block = css.slice(css.indexOf('.ahud__top {'), css.indexOf('.ahud__hp {'));
    expect(block).toContain('grid-template-columns: 1fr auto 1fr');
    expect(block).not.toContain('justify-content: space-between');
    expect(css).toContain('.ahud__top > .ahud__clock');
    expect(css).toContain('justify-self: center');
  });

  /**
   * 反证当天那次改口：右键 / 长按空地都**不许**再叫设置面板。
   * 判据是"这条隐藏路径的接线已经拆干净"—— 只留顶栏按钮这一个入口。
   */
  it('右键不再开设置（入口只在顶栏那颗按钮）', () => {
    expect(hud).not.toContain("addEventListener('contextmenu'");
    // 面板仍然能从按钮打开
    expect(hud).toContain("settings.addEventListener('click', () => this.openSettings())");
  });

  it('手机上也有相机调试入口（F2 之外的那条）', () => {
    expect(hud).toContain("'ahud__view ahud__debugbtn'");
    expect(hud).toContain('this.opts.onToggleDebug?.()');
  });
});
