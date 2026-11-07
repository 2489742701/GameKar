/**
 * 卡面布局锁（2026-11-07 用户）：
 *  1. "卡面上的加单位或减单位要放在卡面的下方，而不是侧面"；
 *  2. "卡片需要自适应：横屏时默认是宽卡片，竖屏时默认是高卡片"；
 *  3. "其他部分也需要自适应"。
 *
 * 这些是 CSS 规则，测不了运行时 DOM（没有 jsdom），所以直接锁样式表文本。
 * 锁的是**结构性事实**（定位方式、朝向分支、高度关系），不是某个像素值 ——
 * 以后调 118→124px 不会误报，但把需求行改回 `position:absolute; top:25px`
 * （就是上一版那个"贴在名字右侧"的写法）会立刻红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(join(ROOT, 'src', 'styles', 'arena.css'), 'utf8');

/** 取一条规则的花括号内容（这些块里没有嵌套规则，简单配对就够）。 */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`样式表里找不到 ${selector}`);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

/** 取一个 @media 块的全部内容（括号配对，媒体查询里嵌了规则）。 */
function media(query: string): string {
  const head = `@media ${query} {`;
  const start = css.indexOf(head);
  if (start < 0) throw new Error(`样式表里找不到 ${head}`);
  let depth = 0;
  for (let i = start + head.length - 1; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`${head} 括号不配对`);
}

const heightOf = (block: string): number => {
  const m = /\.ahud__card\s*\{[^}]*min-height:\s*(\d+)px/.exec(block);
  return m ? Number(m[1]) : -1;
};

describe('增减行在卡面下方', () => {
  const need = rule('.ahud__card__need');

  it('走正常流 + margin-top:auto 顶到卡底，不是绝对定位贴右侧', () => {
    expect(need).toContain('position: static');
    expect(need).toContain('margin-top: auto');
    expect(need).toContain('align-items: center');
    expect(need).toContain('border-top');
    expect(need).not.toContain('position: absolute');
    expect(need).not.toContain('align-items: flex-end');
  });

  it('两行仍是上下排（增在上、减在下由 supplyRowsHtml 保证）', () => {
    const rows = rule('.ahud__card__need__row');
    expect(rows).toContain('inline-flex');
    // 增删行本身的判据另有 supplyRows 单测，这里只锁容器不把它们改成横向
    expect(need).toContain('flex-direction: column');
  });
});

describe('横屏宽卡 / 竖屏高卡', () => {
  const base = heightOf(rule('.ahud__card'));
  const portrait = heightOf(media('(orientation: portrait)'));
  const shortLandscape = heightOf(media('(orientation: landscape) and (max-height: 520px)'));

  it('按朝向切，不是按宽度切（转屏不该只改宽度）', () => {
    expect(css).toContain('@media (orientation: portrait) {');
    expect(css).toContain('@media (orientation: landscape) {');
    expect(css).toContain('@media (orientation: landscape) and (max-height: 520px) {');
  });

  it('竖屏卡明显更高、横屏默认矮、矮横屏再压一档', () => {
    expect(base).toBeGreaterThan(0);
    expect(portrait).toBeGreaterThan(base);
    expect(shortLandscape).toBeLessThan(base);
  });

  it('竖屏同时放大图标与名字（不是只把盒子拉高留一片空白）', () => {
    const p = media('(orientation: portrait)');
    expect(p).toContain('.ahud__card__art');
    expect(p).toContain('.ahud__card__name');
    expect(p).toContain('.ahud__card__need');
  });

  /**
   * 2026-11-07 晚：设置面板从"压在手牌上方、靠 bottom 抬"改成**居中弹层**，
   * 所以它不再属于"跟着底栈抬"的那一族（toast 仍然要抬）。
   * 这条锁顺便钉住"不许再用 bottom 给它定位" —— 那是把它挤成一条缝的元凶
   * （top+bottom 同时生效时高度被夹死，手机上只剩标题那一行）。
   */
  it('底栈变高时 toast 跟着抬；设置面板是居中弹层，不再按 bottom 定位', () => {
    const p = media('(orientation: portrait)');
    expect(p).toContain('.ahud__toast');
    expect(p).toContain('.ahud__end__title');
    const short = media('(orientation: landscape) and (max-height: 520px)');
    expect(short).toContain('.ahud__toast');
    expect(short).toContain('.ahud__end');
    expect(short).toContain('.ahud__top');
    const panel = css.slice(css.indexOf('.ahud__settings {'), css.indexOf('.ahud__settings__tabs'));
    expect(panel).toContain('transform: translate(-50%, -50%)');
    expect(panel).not.toMatch(/^\s*bottom:/m);
    // 反证：媒体查询里也不许再给它补 bottom
    expect(css).not.toMatch(/\.ahud__settings \{\s*bottom:/);
  });
});
