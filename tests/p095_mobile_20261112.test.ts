/**
 * P-095 追加锁（2026-11-12）：用户「不是，你可以用浏览器处理呀，安卓版顺带做」。
 *
 * 这轮不做纯逻辑改动，改的是**用浏览器量出来的窄屏排版**：
 *  - 390×844 实测：`.ahud__supply` 右边界 189px、绝对居中时钟左边界 167px
 *    ⇒ 人口三分（P-094 加的「闲/占/共」标签）把左列撑宽后**重叠 22px**，
 *    截图里就是「🏠2:56」连成一坨。320px 宽更惨，重叠 40px。
 *  - 修完实测：390 间隙 +45px、320 间隙 +10px，时钟中心仍严格 = 视口/2。
 *  - 安卓包 `dist-android/` 用同一个浏览器以 390×844 打开，
 *    三分读数 / 4 张卡图标 / 新 CSS 全部在位；大地图模组窄屏 37/37。
 *
 * 这里锁的是**规则**（CSS / 探针参数），实机读数由 CDP 探针与流水账记录，
 * 不在 vitest 里启一个浏览器拖慢 65 文件套件。
 * 复跑命令写在文件末尾的注释里，后来人照着敲即可。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 统一 CRLF → LF：Windows 工作区里 `.css` 是 CRLF，跨行 toContain 会被 \r 坑。 */
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const css = read('src/styles/arena.css');
const hud = read('src/arena/ArenaHud.ts');

describe('手机窄屏顶栏：三分读数不许再撞上绝对居中的时钟', () => {
  it('时钟红线仍在：绝对定位 50% + translateX(-50%)，不靠等宽列', () => {
    const block = css.slice(css.indexOf('.ahud__top {'), css.indexOf('.ahud__hp {'));
    expect(block).toContain('left: 50%');
    expect(block).toContain('transform: translateX(-50%)');
    expect(block).not.toContain('grid-template-columns');
    expect(hud).toContain('sup.idle');
    expect(hud).toContain('sup.used');
    expect(hud).toContain('sup.total');
  });

  it('≤560px 收起「闲/占/共」标签，改成斜杠分隔的三个数', () => {
    expect(css).toContain('.ahud__supply__pop3__tag { display: none; }');
    expect(css).toContain("content: '/'");
    expect(css).toContain('.ahud__supply__pop3 .ahud__supply__num { font-size: 10px; }');
    // 三项的颜色区分还在，不能因为收了标签就变成三个同色数字
    expect(css).toContain(".ahud__supply__pop3__part[data-part='idle'] .ahud__supply__num");
    expect(css).toContain(".ahud__supply__pop3__part[data-part='used'] .ahud__supply__num");
  });

  it('≤560px 收起民居胶囊并压紧内边距（320px 宽也留得下）', () => {
    expect(css).toContain('.ahud__supply__item:last-child {\n    display: none;');
    expect(css).toContain('padding: 1px 3px;');
    // 缺配告警没被删：通知栏 + 卡面房屋 SVG 仍在
    expect(hud).toContain('您的商行缺少民居');
    expect(hud).toContain('supplyBlocked');
  });

  it('窄屏结算结论行允许换行，不再贴边挤成一条', () => {
    expect(css).toContain('overflow-wrap: anywhere;');
    expect(css).toContain('.ahud__ledger__head {\n    font-size: 11px;');
  });
});

describe('浏览器探针支持手机视口 / 安卓包同源', () => {
  it('arena_shot 用 SHOT_SIZE=宽,高（逗号！），注释也写对了', () => {
    const shot = read('tools/arena_shot.mjs');
    expect(shot).toContain('SHOT_SIZE=390,844');
    expect(shot).toContain(".split(',').map(Number)");
    expect(shot).not.toContain('SHOT_SIZE=390x844');
  });

  it('grand_map_probe 可用 PROBE_SIZE 切视口，且竖屏设 mobile:true', () => {
    const probe = read('tools/grand_map_probe.mjs');
    expect(probe).toContain("process.env.PROBE_SIZE ?? '1280,760'");
    expect(probe).toContain('`--window-size=${VIEW_W},${VIEW_H}`');
    expect(probe).toContain('mobile: VIEW_H > VIEW_W');
  });

  it('安卓包入口就是 arena.html（一开就是对战模式），资源路径不重写', () => {
    const prep = read('tools/prepare_android_web.mjs');
    expect(prep).toContain("arena.html 换到 index.html");
    expect(prep).toContain('不重写资源路径');
    const sync = read('tools/sync_android_web.mjs');
    expect(sync).toContain('android/app/src/main/assets/public');
  });
});

/**
 * 复跑（先 npm run build，服务起在 4188 指向 dist、4189 指向 dist-android）：
 *   SHOT_SIZE=390,844 node tools/arena_shot.mjs "http://127.0.0.1:4188/arena.html?auto=1" 3 shot.png
 *   SHOT_SIZE=390,844 node tools/arena_shot.mjs "http://127.0.0.1:4189/?auto=1" 3 android.png
 *   PROBE_SIZE=390,844 node tools/grand_map_probe.mjs \
 *     "http://127.0.0.1:4189/arena.html?mod=grand-map" D:/tmp/modprobe
 * 期望：顶栏 supply.right < clock.left、时钟中心 = 视口/2、模组 37/37。
 */
