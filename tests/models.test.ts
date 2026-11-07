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
import { ARENA_FLAGS, ARENA_MODELS, ARENA_PAL, roofOf, ridgeOf } from '../src/arena/models';
import { SIDE_COLOR } from '../src/arena/theme';

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
      // 例外：齿轮工厂是 4×3 占地（用户 2026-11-07），允许宽到 5.6
      const wide = r.name === 'gearFactory' ? 5.6 : 4.8;
      expect(r.width, `${r.name} 宽`).toBeLessThanOrEqual(wide);
      expect(r.depth, `${r.name} 深`).toBeLessThanOrEqual(4.8);
      expect(r.width, `${r.name} 宽`).toBeGreaterThanOrEqual(2.0);
      expect(r.height, `${r.name} 高`).toBeLessThanOrEqual(7.2);
      expect(r.height, `${r.name} 高`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('骨架件数不多，外墙切成够多的面片（掉起来才像"一块块"）', () => {
    for (const r of base.rows) {
      // 不动的件（含内部骨架）不超过 22：再多就是又堆碎了
      // 例外：齿轮工厂的大/小齿轮由 12+8 齿 + 辐条组成，放宽到 48
      expect(r.statics, `${r.name} 固定件`).toBeLessThanOrEqual(r.name === 'gearFactory' ? 48 : 22);
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

/**
 * 敌我辨识的锁（用户 2026-10-27：「我方和敌方房顶的颜色以及一些小特征是不一样的」）。
 *
 * 上一版只有核心水晶、炮塔四角、磨坊顶盖三处吃阵营色，其余三栋（兵营/箭塔/民居）
 * 蓝红两版**颜色完全相同** —— 隔着一个战场只能靠旗子和血条分敌我。
 * 这两条锁保证以后谁把阵营色撤掉、或者把 `roofOf` 改成一个常量，都会立刻红。
 */
describe('每栋楼都要能一眼分出敌我', () => {
  const NAMES = Object.keys(ARENA_MODELS) as (keyof typeof ARENA_MODELS)[];

  it('每一栋蓝红两版的配色集合都真的不一样', () => {
    for (const name of NAMES) {
      const colors = (side: 'blue' | 'red') =>
        new Set(ARENA_MODELS[name](SIDE_COLOR[side]).static.map((n) => n.color));
      const blue = colors('blue');
      const red = colors('red');
      const onlyBlue = [...blue].filter((c) => !red.has(c));
      const onlyRed = [...red].filter((c) => !blue.has(c));
      expect(onlyBlue.length, `${name}：蓝方没有自己独有的颜色`).toBeGreaterThan(0);
      expect(onlyRed.length, `${name}：红方没有自己独有的颜色`).toBeGreaterThan(0);
    }
  });

  it('屋顶瓦与屋脊本身就是按阵营算出来的（不是写死的一个色）', () => {
    expect(roofOf(SIDE_COLOR.blue)).not.toBe(roofOf(SIDE_COLOR.red));
    expect(ridgeOf(SIDE_COLOR.blue)).not.toBe(ridgeOf(SIDE_COLOR.red));
    // 压暗之后仍然是"瓦"的明度，不能亮到像塑料
    for (const side of ['blue', 'red'] as const) {
      const lum = (c: number) => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
      expect(lum(roofOf(SIDE_COLOR[side]))).toBeLessThan(lum(SIDE_COLOR[side]));
    }
  });
});

/**
 * 磨坊帆的"贴合"锁（用户 2026-10-28：「帆错位了，应该紧紧贴着那个木棍，就在木棍后面」）。
 *
 * 上一版的布是手算的散点：位置相对轴心的方向是 63°，而梁长轴是 45° ⇒ 布和梁不同向，
 * 看上去就是帆飘在棍子旁边。这条锁把两件事钉死：
 * ① **布的中心必须落在梁的方向线上**（方向角 == 90° + rotZ，模 180 —— 臂有内外两端）；
 * ② **布必须贴在梁的背面**（z 比梁小，但差得不多：贴着，不是穿过去也不是悬空）。
 * 变异检查：把布的位置改回手算的 [0.2, 2.02]，① 立刻红。
 */
describe('磨坊的帆贴着木梁', () => {
  const mill = ARENA_MODELS.mill(SIDE_COLOR.blue);
  const sails = mill.static.filter((n) => n.spin !== undefined && n.pivot);
  const beams = sails.filter((n) => n.color === ARENA_PAL.wood);
  const cloths = sails.filter((n) => n.color !== ARENA_PAL.wood);
  const pivot = sails[0]!.pivot!;

  it('两根木梁 + 四片帆布，都挂在同一个轴心上', () => {
    expect(beams.length).toBe(2);
    expect(cloths.length).toBe(4);
    for (const n of sails) expect(n.pivot).toEqual(pivot);
  });

  it('每一片布都沿着自己那根梁的方向铺（方向角对齐，不是飘在旁边）', () => {
    for (const c of cloths) {
      const dx = c.at![0]! - pivot[0];
      const dy = c.at![1]! - pivot[1];
      const dirDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      // 竖直长条绕 z 转 rotZ ⇒ 长轴方向 = 90° + rotZ（度）
      const beamDeg = 90 + (c.rot![2]! * 180) / Math.PI;
      const off = Math.abs((((dirDeg - beamDeg) % 180) + 180) % 180);
      const aligned = Math.min(off, 180 - off);
      const where = 'at ' + c.at![0]!.toFixed(2) + ',' + c.at![1]!.toFixed(2);
      expect(aligned, '布 ' + where + ' 没有沿着梁的方向').toBeLessThan(1);
    }
  });

  it('布绷在梁的前面：z 比梁大一点（贴着），不是穿过去也不是悬空', () => {
    // 2026-10-28：先做的"贴在木棍后面"，用户看过之后改成**前面** —— 布在外、木梁当骨架。
    // 这条锁跟着翻面：只守住"贴着"这个几何关系，不锁死当初那一版的前后选择。
    const beamZ = beams[0]!.at![2]!;
    for (const c of cloths) {
      const gap = c.at![2]! - beamZ;
      expect(gap, '布跑到梁后面去了（它应该绷在木棍前面）').toBeGreaterThan(0);
      expect(gap, '布离梁太远，看着是悬空的').toBeLessThanOrEqual(0.07);
    }
  });
});
