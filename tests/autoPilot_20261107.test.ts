/**
 * 我方托管的锁（2026-11-07 用户："给自己装个托管模式……玩家 5 秒钟未操作时
 * 就会自动托管，或者我们直接点一下就可以托管；在设置里面可以打开托管"）。
 *
 * 状态机是纯的（喂 dt / activity 就够），所以这些是**行为锁**不是 DOM 锁：
 * 自动托管会触发、会交还、手动托管不被误解除、设置开关真的能关掉它。
 */
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { AutoPilot, IDLE_AUTO_SECONDS } from '@arena/autoPilot';
import { DEFAULT_CONTROLS, type ControlPrefs } from '@arena/controls';

function rig(over: Partial<ControlPrefs> = {}, opts: { pve2?: boolean } = {}) {
  const world = new ArenaWorld(opts.pve2 ? { seed: 7, mode: 'pve', players: 2 } : { seed: 7 });
  const prefs: ControlPrefs = { ...DEFAULT_CONTROLS, ...over };
  const changes: boolean[] = [];
  const pilot = new AutoPilot(world, prefs, (s) => changes.push(s.active));
  const blueAuto = () => world.playersOf('blue').map((p) => p.auto);
  return { world, prefs, pilot, changes, blueAuto };
}

describe('闲置 5 秒自动托管', () => {
  it('未到 5 秒不接管，到了立刻接管，且状态变化只通知一次', () => {
    const { pilot, blueAuto, changes } = rig();
    expect(pilot.state.active).toBe(false);
    pilot.step(IDLE_AUTO_SECONDS - 0.2);
    expect(pilot.state.active).toBe(false);
    expect(pilot.state.idleLeft).toBeGreaterThan(0);
    pilot.step(0.3);
    expect(pilot.state.active).toBe(true);
    expect(blueAuto().every(Boolean)).toBe(true);
    pilot.step(10);
    expect(changes).toEqual([true]);
  });

  it('玩家一动手就把控制权交还（自动托管不是抢操作）', () => {
    const { pilot, blueAuto, changes } = rig();
    pilot.step(IDLE_AUTO_SECONDS + 0.1);
    expect(pilot.state.active).toBe(true);
    pilot.activity();
    pilot.step(0.05);
    expect(pilot.state.active).toBe(false);
    expect(blueAuto().every((v) => !v)).toBe(true);
    expect(changes).toEqual([true, false]);
    // 交还之后重新计时，不会立刻又抢回去
    pilot.step(1);
    expect(pilot.state.active).toBe(false);
  });

  it('设置里关掉「闲置自动托管」⇒ 挂多久都不会接管', () => {
    const { pilot, prefs, blueAuto } = rig({ idleAuto: false });
    pilot.step(60);
    expect(pilot.state.active).toBe(false);
    expect(prefs.idleAuto).toBe(false);
    expect(blueAuto().every((v) => !v)).toBe(true);
    pilot.setIdleAuto(true);
    pilot.step(IDLE_AUTO_SECONDS + 0.1);
    expect(pilot.state.active).toBe(true);
  });
});

describe('手动托管与测试通道', () => {
  it('点一下常驻，玩家操作不解除，再点一下才关', () => {
    const { pilot, blueAuto } = rig();
    expect(pilot.toggleManual()).toBe(true);
    expect(pilot.state.active).toBe(true);
    expect(pilot.state.manual).toBe(true);
    expect(blueAuto().every(Boolean)).toBe(true);
    pilot.activity();
    pilot.step(10);
    expect(pilot.state.active).toBe(true); // 手动档不怕 activity
    expect(pilot.toggleManual()).toBe(false);
    pilot.step(0.05);
    expect(pilot.state.active).toBe(false);
  });

  it('forceManual 给 ?auto=1 测试通道用：开局即托管，不被闲置逻辑翻掉', () => {
    const { pilot, blueAuto } = rig({ idleAuto: false });
    pilot.forceManual(true);
    expect(blueAuto().every(Boolean)).toBe(true);
    pilot.step(30);
    expect(pilot.state.active).toBe(true);
  });

  it('PVE 双人：两个玩家槽一起托管（不是只驱动 0 号）', () => {
    const { world, pilot, blueAuto } = rig({}, { pve2: true });
    expect(world.seatCount).toBe(2);
    pilot.step(IDLE_AUTO_SECONDS + 0.1);
    expect(blueAuto()).toEqual([true, true]);
    pilot.activity();
    pilot.step(0.05);
    expect(blueAuto()).toEqual([false, false]);
  });

  it('红方恒为 AI：托管开关只动 blue，不会把敌方关掉', () => {
    const { world, pilot } = rig();
    pilot.step(IDLE_AUTO_SECONDS + 0.1);
    expect(world.playersOf('red').every((p) => p.auto)).toBe(true);
    pilot.setIdleAuto(false);
    pilot.activity();
    pilot.step(0.05);
    expect(world.playersOf('red').every((p) => p.auto)).toBe(true);
  });
});
