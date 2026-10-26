/**
 * 建筑模型的"体型"锁 —— 这份模型的唯一验收标准是**看得见的东西**：
 * 件数、占地、高度、旗子落点，以及预览器自己出图是否稳定。
 *
 * 为什么不在测试里直接量几何：量法会和预览器各写一份，两边错法不同就互相掩盖。
 * 这里直接跑预览器、读它印出来的实测尺寸 —— 预览器画错，这些数也会跟着错，
 * 所以它同时是"预览器自证"和"模型尺寸锁"。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARENA_FLAGS, ARENA_MODELS } from '../src/arena/models';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'tools', 'preview_models.mjs');
const OUT = mkdtempSync(join(tmpdir(), 'gamekar-models-'));

interface Measured {
  name: string;
  /** 不动的件（台基、屋顶、骨架） */
  statics: number;
  /** 可脱落的外墙面片 */
  shell: number;
  width: number;
  depth: number;
  height: number;
}

/** 跑一次预览器，读出逐件尺寸。 */
function render(tag: string, pitch: number): { bytes: Buffer; rows: Measured[] } {
  const out = join(OUT, `${tag}.png`);
  const stdout = execFileSync(process.execPath, [SCRIPT, out, String(pitch)], { cwd: ROOT, encoding: 'utf8' });
  const rows = stdout
    .split('\n')
    .map((line) => /^(\w+): (\d+) \+ (\d+) 件 · ([\d.]+)×([\d.]+) 格 · 高 ([\d.]+) 格$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      name: m[1]!,
      statics: Number(m[2]),
      shell: Number(m[3]),
      width: Number(m[4]),
      depth: Number(m[5]),
      height: Number(m[6]),
    }));
  return { bytes: readFileSync(out), rows };
}

const base = render('base', 50);

describe('建筑模型体型', () => {
  it('五栋楼各有实测尺寸，且都在 3×3 占地附近', () => {
    expect(base.rows.map((r) => r.name).sort()).toEqual(Object.keys(ARENA_MODELS).sort());
    for (const r of base.rows) {
      // 宽/深不超过 4.8 格：上一版核心的屋顶量出来 8 格，比占地宽一倍 —— 就是那次的教训
      expect(r.width, `${r.name} 宽`).toBeLessThanOrEqual(4.8);
      expect(r.depth, `${r.name} 深`).toBeLessThanOrEqual(4.8);
      expect(r.width, `${r.name} 宽`).toBeGreaterThanOrEqual(2.0);
      expect(r.height, `${r.name} 高`).toBeLessThanOrEqual(7.2);
      expect(r.height, `${r.name} 高`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('骨架件数不多，外墙切成够多的面片（掉起来才像"一块块"）', () => {
    for (const r of base.rows) {
      // 不动的件（含内部骨架）不超过 22：再多就是又堆碎了
      expect(r.statics, `${r.name} 固定件`).toBeLessThanOrEqual(22);
      expect(r.statics, `${r.name} 固定件`).toBeGreaterThanOrEqual(8);
      // 面片至少 10 块：12 块的炮塔每档崩 2 块也够看出洞
      expect(r.shell, `${r.name} 面片`).toBeGreaterThanOrEqual(10);
      expect(r.shell, `${r.name} 面片`).toBeLessThanOrEqual(60);
    }
  });

  it('每栋都有一面旗，且杆顶高过楼身下半截（不是插在地上的小旗）', () => {
    const byName = new Map(base.rows.map((r) => [r.name, r]));
    for (const [name, spot] of Object.entries(ARENA_FLAGS)) {
      const h = byName.get(name)!.height;
      expect(spot.base, `${name} 杆底`).toBeGreaterThanOrEqual(0);
      expect(spot.pole, `${name} 杆高`).toBeGreaterThanOrEqual(0.6);
      const top = spot.base + spot.pole;
      expect(top, `${name} 旗顶`).toBeGreaterThanOrEqual(h * 0.7);
      expect(top, `${name} 旗顶`).toBeLessThanOrEqual(h + 2);
    }
  });
});

describe('预览器自证', () => {
  it('同一份模型两次出图字节完全相同（没有取巧的随机数）', () => {
    const again = render('again', 50);
    expect(again.bytes.equals(base.bytes)).toBe(true);
  });

  it('换俯角图会变（机位真的生效了，不是画了张固定的图）', () => {
    const tilted = render('tilted', 62);
    expect(tilted.bytes.equals(base.bytes)).toBe(false);
  });
});
