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
   * 反证：`navigator.clipboard` 在非安全上下文会抛，PC 上必须还有第二条路。
   * 只写 `writeText` 的版本在 file:// 打开时"复制"按钮直接哑掉。
   */
  it('复制有 file:// 兜底（execCommand / 摊进账本）', () => {
    expect(panel).toContain('private async writeClipboard(');
    expect(panel).toContain('document.execCommand(\'copy\')');
    expect(panel).toContain('复制全部机位');
  });

  it('PC 版有一键 build + 起服务的脚本（不能双击 file://）', () => {
    expect(pkg.scripts['pc']).toContain('npm run build');
    expect(pkg.scripts['pc']).toContain('tools/pc_serve.mjs');
    expect(pkg.scripts['pc:serve']).toContain('tools/pc_serve.mjs');
  });
});
