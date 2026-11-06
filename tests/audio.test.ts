/**
 * 音效引擎的"降级"锁。
 *
 * 这套东西在浏览器里靠 Web Audio 发声，但**没有音频设备时必须安静地什么都不做**：
 * node 里跑单测、用户把浏览器音频禁掉、iOS 静音键 —— 都不该让游戏崩。
 */

import { describe, expect, it } from 'vitest';
import { Sfx } from '../src/audio/sfx';

describe('音效引擎：没有 AudioContext 也不崩', () => {
  it('node 环境（无 window）里 play / unlock / setEnabled 都不抛', () => {
    const sfx = new Sfx();
    expect(() => sfx.unlock()).not.toThrow();
    expect(() => sfx.play('cannon')).not.toThrow();
    expect(() => sfx.play('build', { pitch: 1.2 })).not.toThrow();
    expect(() => sfx.setEnabled(false)).not.toThrow();
    expect(sfx.on).toBe(false);
    expect(() => sfx.setEnabled(true)).not.toThrow();
    expect(sfx.on).toBe(true);
    expect(() => sfx.dispose()).not.toThrow();
  });
});
