/**
 * 受伤碎裂的锁：档位、面片脱落、以及"掉下来的就是原来那块板"。
 * 墙面网格用 three 的几何体（node 里不需要 WebGL，构造 Mesh/BufferGeometry 是纯 CPU）。
 */

import { describe, expect, it } from 'vitest';
import { HIT_THRESHOLDS, hitsFor } from '../src/arena/damage';
import { ARENA_MODELS } from '../src/arena/models';
import { WallShell } from '../src/arena/shell';
import { Random } from '../src/engine/math/Random';

const KINDS = Object.keys(ARENA_MODELS) as (keyof typeof ARENA_MODELS)[];

describe('碎裂档位', () => {
  it('血量越低崩得越多，阈值处严格进位', () => {
    expect(hitsFor(1)).toBe(0);
    expect(hitsFor(0.81)).toBe(0);
    expect(hitsFor(0.8)).toBe(1);
    expect(hitsFor(0.5)).toBe(2);
    expect(hitsFor(0.45)).toBe(3);
    expect(hitsFor(0.15)).toBe(5);
    expect(hitsFor(0)).toBe(HIT_THRESHOLDS.length);
  });

  it('血量一路往下，崩裂次数只增不减', () => {
    let last = 0;
    for (let f = 1; f >= 0; f -= 0.01) {
      const n = hitsFor(f);
      expect(n, `frac=${f.toFixed(2)}`).toBeGreaterThanOrEqual(last);
      last = n;
    }
    expect(last).toBe(5);
  });
});

describe('外墙面片', () => {
  it('五栋楼都有可脱落的面片，且每块都有实际尺寸', () => {
    for (const kind of KINDS) {
      const model = ARENA_MODELS[kind](0);
      expect(model.shell.length, `${kind} 面片数`).toBeGreaterThanOrEqual(10);
      for (const p of model.shell) {
        expect(p.w, `${kind} 板宽`).toBeGreaterThan(0.12);
        expect(p.h, `${kind} 板高`).toBeGreaterThan(0.12);
        expect(p.t, `${kind} 板厚`).toBeGreaterThan(0.02);
        // 面板在楼身范围内（局部坐标，不含台基外沿）
        expect(Math.hypot(p.x, p.z), `${kind} 板到楼心`).toBeLessThan(1.4);
        expect(p.y, `${kind} 板高`).toBeGreaterThan(0);
      }
    }
  });

  it('崩掉 n 块：网格里就少 n 块，顶点数跟着变', () => {
    for (const kind of KINDS) {
      const model = ARENA_MODELS[kind](0);
      const shell = new WallShell(model.shell);
      const before = shell.count;
      const vertsBefore = shell.mesh.geometry.getAttribute('position').count;
      const removed = shell.breach(5, new Random(7));
      expect(removed, `${kind} 摘掉块数`).toHaveLength(Math.min(5, before));
      expect(shell.count).toBe(before - removed.length);
      expect(shell.mesh.geometry.getAttribute('position').count).toBe(shell.count * 36);
      expect(vertsBefore).toBe(before * 36);
      // 没有 NaN（合错矩阵时最常见的崩法）；非索引 box = 36 个顶点
      const pos = shell.mesh.geometry.getAttribute('position').array as Float32Array;
      expect([...pos].every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it('洞口是连成一片的，不是一墙均匀的洞', () => {
    for (const kind of KINDS) {
      const shell = new WallShell(ARENA_MODELS[kind](0).shell);
      const removed = shell.breach(6, new Random(99));
      let max = 0;
      for (const a of removed) {
        for (const b of removed) {
          max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
        }
      }
      expect(max, `${kind} 洞口直径`).toBeLessThan(1.3);
    }
  });

  it('同一栋楼、同一个种子崩在同样的位置（可复现）', () => {
    for (const kind of KINDS) {
      const model = ARENA_MODELS[kind](0);
      const a = new WallShell(model.shell).breach(5, new Random(1234));
      const b = new WallShell(model.shell).breach(5, new Random(1234));
      expect(a.map((p) => [p.x, p.y, p.z])).toEqual(b.map((p) => [p.x, p.y, p.z]));
    }
  });

  it('面片掉光也不会崩（最后一次只摘剩下的）', () => {
    const shell = new WallShell(ARENA_MODELS.core(0).shell);
    let guard = 0;
    while (shell.count > 0 && guard++ < 20) shell.breach(6, new Random(guard));
    expect(shell.count).toBe(0);
    expect(shell.breach(6, new Random(1))).toHaveLength(0);
  });
});
