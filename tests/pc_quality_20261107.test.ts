/**
 * PC 画质档 / 调试读数的锁（2026-11-07 深夜）。
 *
 * 用户："PC 版现在有点卡卡的，不知道是不是渲染层出了问题；在 PC 版上给我出个
 * debug 模式，复制快一点。"
 *
 * 量出来的事实：1280×760 空场 60fps / 127 drawCalls；压力场（20 楼 + 60 兵）
 * 56–60fps / **771 drawCalls**，PC 静态版与 dev 版读数一致 ⇒ 不是打包模式的问题。
 * 但老 `pickQuality` 有个结构性隐患：**所有 ≥0.6MP 的桌面窗口都开 DPR 2**
 * （手机反而降档），而它算出来的 2048 阴影贴图从来没接进 LightingRig。
 *
 * 这些锁盯住的就是"别把这个假配置改回来"，以及"PC 上确实能一按就复制"。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QUALITY_KEY, loadQuality, pickQuality } from '@engine/render/Renderer';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const renderer = readFileSync(join(ROOT, 'src/engine/render/Renderer.ts'), 'utf8');
const panel = readFileSync(join(ROOT, 'src/arena/DebugPanel.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('PC 画质档', () => {
  it('三档的旋钮是 DPR 与阴影，不是那个没人读的 shadowMapSize', () => {
    const px = 1920 * 1080;
    expect(pickQuality(px, 2, 'high')).toMatchObject({ maxPixelRatio: 2, shadows: true });
    expect(pickQuality(px, 2, 'balanced')).toMatchObject({ maxPixelRatio: 1.5, shadows: true });
    expect(pickQuality(px, 2, 'low')).toMatchObject({ maxPixelRatio: 1, shadows: false });
    // 三档都别再编 2048 出来（LightingRig 固定 1024，写了也没人用）
    expect(pickQuality(px, 2, 'high').shadowMapSize).toBe(1024);
  });

  it('小屏即使选 high 也不给 2×（手机物理分辨率不会白翻四倍）', () => {
    const phone = 390 * 844;
    expect(pickQuality(phone, 3, 'high').maxPixelRatio).toBe(1.5);
  });

  it('默认档是 balanced，存档 key 固定', () => {
    expect(loadQuality()).toBe('balanced');
    expect(QUALITY_KEY).toBe('gamekar.quality.v1');
    expect(renderer).toContain('export function saveQuality(');
  });
});

describe('PC 调试面板', () => {
  it('有实时性能读数 + 三档画质按钮', () => {
    expect(panel).toContain('this.perfText.textContent');
    expect(panel).toContain('drawCalls');
    expect(panel).toContain("['high', '高'], ['balanced', '均衡'], ['low', '省电']");
    expect(panel).toContain('this.app.setQualityPreset(key)');
  });

  /**
   * 反证（2026-11-07 深夜实测）：上一版是 `await clipboard.writeText()` 失败后
   * 才 `execCommand('copy')` —— **await 之后用户手势已失效**，后者必然 false，
   * 文本被塞进折叠区里的账本，用户看到"点了完全没反应"。
   *
   * 现在必须：同步 execCommand 优先、按钮有反馈、导出框可见、还能下载 txt。
   */
  it('复制：同步路径优先 + 可见反馈 + 下载兜底', () => {
    expect(panel).toContain('private syncCopy(');
    expect(panel).toContain("document.execCommand('copy')");
    expect(panel).toContain('private copySlots(): void'); // 不是 async，别再 await 后兜底
    expect(panel).not.toContain('await this.writeClipboard(');
    expect(panel).toContain("make('textarea', 'dbg__export')");
    expect(panel).toContain('this.flash(');
    expect(panel).toContain('下载 .txt');
    expect(panel).toContain("a.download = 'gamekar-camera-shots.txt'");
    // 导出框必须挂在面板可见区，不能塞进 <details> 折叠里
    const append = panel.slice(panel.indexOf('this.el.append('), panel.indexOf('this.el.hidden = true'));
    expect(append.indexOf('this.exportBox')).toBeLessThan(append.indexOf('foldBox'));
  });

  it('PC 版有一键 build + 起服务的脚本（不能双击 file://）', () => {
    expect(pkg.scripts['pc']).toContain('npm run build');
    expect(pkg.scripts['pc']).toContain('tools/pc_serve.mjs');
    expect(pkg.scripts['pc:serve']).toContain('tools/pc_serve.mjs');
  });
});
