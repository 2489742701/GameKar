/**
 * 固定步长主循环 + 暂停。
 *
 * 暂停是 2026-11-05 加开始菜单时补的：以前一打开页面倒计时就在走，
 * 玩家读说明的 30 秒里对面 AI 已经出完两张牌了。
 * 这里钉住的是"**停逻辑、不停渲染**"——两者混掉的话，菜单背后那幅战场会僵成一张图。
 */

import { describe, expect, it } from 'vitest';
import { GameLoop } from '../src/engine/core/GameLoop';

describe('主循环：暂停', () => {
  it('暂停时 onSimStep 不调，onFrame 照常', () => {
    let steps = 0;
    let frames = 0;
    const loop = new GameLoop({
      hz: 20,
      onSimStep: () => steps++,
      onFrame: () => frames++,
    });

    loop.advance(100); // 0.1 秒 = 2 步
    expect(steps).toBe(2);

    loop.pause();
    const frozen = steps;
    const framesBefore = frames;
    loop.advance(500); // 暂停里推进 0.5 秒
    expect(steps, '暂停期间逻辑不该走').toBe(frozen);
    expect(frames, '画面还得继续渲染').toBeGreaterThan(framesBefore);

    loop.resume();
    loop.advance(100);
    // 恢复后是"重新开始计步"，不是把暂停那 0.5 秒补算成 10 步
    expect(steps).toBe(frozen + 2);
  });

  it('还没 start 也能安全 pause/resume（开始菜单在 boot 之后就调用）', () => {
    const loop = new GameLoop({ hz: 20 });
    expect(loop.isPaused).toBe(false);
    loop.pause();
    expect(loop.isPaused).toBe(true);
    loop.resume();
    expect(loop.isPaused).toBe(false);
  });
});
