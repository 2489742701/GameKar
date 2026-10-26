/**
 * 机位码的锁 —— 用户会把它抄下来发我，所以"同一个角度永远是同一个码、且能还原"必须钉死。
 */

import { describe, expect, it } from 'vitest';
import { Random } from '@engine/math/Random';
import { DEFAULT_SHOT, decodeCamera, encodeCamera, snapShot, type CameraShot } from '@arena/cameraId';

const rng = new Random('cam-fuzz');
const randShot = (): CameraShot => ({
  yaw: rng.int(0, 360),
  pitch: rng.int(20, 81),
  zoom: Math.round((0.5 + rng.int(0, 71) * 0.01) * 100) / 100,
});

describe('机位码', () => {
  it('往返不变：500 组随机角度，编码再解码一个数都不差', () => {
    for (let i = 0; i < 500; i++) {
      const shot = randShot();
      expect(decodeCamera(encodeCamera(shot))).toEqual(shot);
    }
  });

  it('同一组参数永远同一个码，格式是 cam-1 + 5 位', () => {
    const shot = randShot();
    expect(encodeCamera(shot)).toBe(encodeCamera(shot));
    expect(encodeCamera(shot)).toMatch(/^cam-1[0-9a-z]{5}$/);
  });

  it('默认斜视机位的码钉死：偷偷改默认视角会红', () => {
    expect(encodeCamera(DEFAULT_SHOT)).toBe('cam-104ape');
  });

  it('2000 组随机角度不撞号', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) ids.add(encodeCamera(randShot()));
    expect(ids.size).toBe(2000);
  });

  it('坏码一律拒绝：前缀、长度、版本、表外字符', () => {
    const good = encodeCamera(DEFAULT_SHOT);
    expect(decodeCamera('')).toBeNull();
    expect(decodeCamera('xx-1pz3kc')).toBeNull();
    expect(decodeCamera(good.slice(0, -1))).toBeNull();
    expect(decodeCamera(good.replace('cam-1', 'cam-2'))).toBeNull();
    expect(decodeCamera('cam-1!!!!1')).toBeNull();
  });

  it('贴档幂等：贴回量化档位之后再贴不会漂', () => {
    const shot = { yaw: 24.4, pitch: 49.6, zoom: 0.999 };
    const once = snapShot(shot);
    expect(snapShot(once)).toEqual(once);
    expect(encodeCamera(once)).toBe(encodeCamera(shot));
  });
});
