/**
 * 用户自选机位的锁（2026-11-07 深夜，他从 PC 调试面板复制回来的四行）。
 *
 * 这些是**他调好的数**，不许被"统一格式"改掉。两件事要验：
 *  ① 机位 ID 能解回同一组参数（抄错一位，码就对不上）；
 *  ② VIEW_PRESETS 里那四档的 yaw/pitch/zoom/center 与原文逐项一致，
 *     且绝对中心格走 `center`，不是 `centerBias`。
 */
import { describe, expect, it } from 'vitest';
import { VIEW_PRESETS } from '@arena/Camera';
import { decodeCamera } from '@arena/cameraId';

interface UserShot {
  slot: number;
  id: string;
  yaw: number;
  pitch: number;
  zoom: number;
  col: number;
  row: number;
}

const SHOTS: UserShot[] = [
  { slot: 1, id: 'cam-11hqr6', yaw: 306, pitch: 25, zoom: 1.0, col: 23, row: 5 },
  { slot: 2, id: 'cam-10ae8n', yaw: 59, pitch: 33, zoom: 0.73, col: 6, row: 9 },
  { slot: 3, id: 'cam-109tzg', yaw: 56, pitch: 20, zoom: 0.62, col: 0, row: 0 },
  { slot: 4, id: 'cam-11ct8j', yaw: 278, pitch: 20, zoom: 0.53, col: 44, row: 1 },
];

describe('用户复制回来的四档机位', () => {
  it('机位 ID 解出来和原文逐项一致', () => {
    for (const s of SHOTS) {
      expect(decodeCamera(s.id), `${s.id} 解不开`).toEqual({
        yaw: s.yaw,
        pitch: s.pitch,
        zoom: s.zoom,
      });
    }
  });

  it('四档都进了 1v1 机位表，参数没被改动', () => {
    for (const s of SHOTS) {
      const v = VIEW_PRESETS.find((x) => x.name === `自选 ${s.slot}`)!;
      expect(v, `自选 ${s.slot} 不见了`).toBeDefined();
      expect(v.yaw).toBe(s.yaw);
      expect(v.pitch).toBe(s.pitch);
      expect(v.zoomFactor).toBe(s.zoom);
      expect(v.center).toEqual({ col: s.col, row: s.row });
      // 反证：绝对中心不许再被写成相对偏移
      expect(v.centerBias).toBeUndefined();
    }
  });

  it('默认档仍是第一档（斜视），没被自选档顶掉', () => {
    expect(VIEW_PRESETS[0]!.name).toBe('斜视');
  });
});
