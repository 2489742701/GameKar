/**
 * 我方托管的锁。
 *
 * **2026-11-07 傍晚改了口径**（用户："托管就是点一下就托管，不要等 5 秒，
 * 必须玩家自己手动点才会托管"）。原来的"闲置 5 秒自动接管 + 一动就交还"整套删掉，
 * 状态机现在只有一个入口：`toggleManual()`。
 *
 * 这一份锁的重点不是"自动档还能不能用"（它已经不存在了），而是：
 *  ① 手动档点了就是常驻，再点一次才关；
 *  ② 有人把自动档偷偷加回来 —— 这条会红。
 */
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { AutoPilot } from '@arena/autoPilot';

function rig(opts: { pve2?: boolean } = {}) {
  const world = new ArenaWorld(opts.pve2 ? { seed: 7, mode: 'pve', players: 2 } : { seed: 7 });
  const changes: boolean[] = [];
  const pilot = new AutoPilot(world, (s) => changes.push(s.active));
  const blueAuto = () => world.playersOf('blue').map((p) => p.auto);
  return { world, pilot, changes, blueAuto };
}

describe('托管：只能手动点开', () => {
  it('默认不托管（不会有"闲着闲着就替你打"这回事）', () => {
    const { pilot, blueAuto } = rig();
    expect(pilot.state.active).toBe(false);
    expect(pilot.state.manual).toBe(false);
    expect(blueAuto().every((v) => !v)).toBe(true);
  });

  it('点一下 = 常驻代打，再点一下才关；状态变化只通知一次', () => {
    const { pilot, blueAuto, changes } = rig();
    expect(pilot.toggleManual()).toBe(true);
    expect(pilot.state.active).toBe(true);
    expect(blueAuto().every(Boolean)).toBe(true);
    // 反复切状态：同值不重复通知
    pilot.toggleManual();
    pilot.toggleManual();
    expect(changes).toEqual([true, false, true]);
    expect(pilot.toggleManual()).toBe(false);
    expect(blueAuto().every((v) => !v)).toBe(true);
  });

  /**
   * 反证旧口径：状态里**不许**再出现"自动/闲置"字段。
   * 有人把 5 秒自动档加回来时，这条会先炸 —— 比等玩家发现"我还没动它就替我出牌"便宜。
   */
  it('状态只有 active / manual 两个字段（自动档不许偷偷回来）', () => {
    const { pilot } = rig();
    expect(Object.keys(pilot.state).sort()).toEqual(['active', 'manual']);
  });

  it('forceManual 给 ?auto=1 测试通道用：开局即托管', () => {
    const { pilot, blueAuto } = rig();
    pilot.forceManual(true);
    expect(blueAuto().every(Boolean)).toBe(true);
    expect(pilot.state.active).toBe(true);
    pilot.forceManual(false);
    expect(blueAuto().every((v) => !v)).toBe(true);
  });

  it('PVE 双人：两个玩家槽一起托管（不是只驱动 0 号）', () => {
    const { world, pilot, blueAuto } = rig({ pve2: true });
    expect(world.seatCount).toBe(2);
    pilot.toggleManual();
    expect(blueAuto()).toEqual([true, true]);
    pilot.toggleManual();
    expect(blueAuto()).toEqual([false, false]);
  });

  it('红方恒为 AI：托管开关只动 blue，不会把敌方关掉', () => {
    const { world, pilot } = rig();
    pilot.toggleManual();
    pilot.toggleManual();
    expect(world.playersOf('red').every((p) => p.auto)).toBe(true);
  });
});
