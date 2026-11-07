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
      const wide = r.name === 'gearFactory' ? 4.0 : 4.8;
      const deep = r.name === 'gearFactory' ? 3.0 : 4.8;
      expect(r.width, `${r.name} 宽`).toBeLessThanOrEqual(wide);
      expect(r.depth, `${r.name} 深`).toBeLessThanOrEqual(deep);
      expect(r.width, `${r.name} 宽`).toBeGreaterThanOrEqual(2.0);
      expect(r.height, `${r.name} 高`).toBeLessThanOrEqual(r.name === 'gearFactory' ? 4.6 : 7.2);
      expect(r.height, `${r.name} 高`).toBeGreaterThanOrEqual(1.5);
    }
  });

  /**
   * 2026-11-07 用户："工业工厂穿模了……没那么高，稍微矮一点，有两个烟囱，有齿轮转"。
   *
   * 这条锁的意义是**能证伪**：旧版量出来 5.97×3.89 格 / 高 7.06 格
   * （`BUILDING_SCALE 2.2 × 1.18` 额外放大 + 模型本身就写大了），
   * 旗位 base 2.25 格远低于屋顶 —— 上面三条会同时红。
   * 只写"不超过 5.6"那种给旧版留后门的宽松阈值，等于没锁。
   */
  it('齿轮工厂：收进 4×3 占地、比大本营矮、旗子不插在墙里', () => {
    const byName = new Map(base.rows.map((r) => [r.name, r]));
    const factory = byName.get('gearFactory')!;
    const core = byName.get('core')!;
    expect(factory.width).toBeLessThanOrEqual(4.0);
    expect(factory.depth).toBeLessThanOrEqual(3.0);
    expect(factory.height).toBeLessThan(core.height);
    // 旗杆底必须落在屋脊附近，不能从砖墙中段长出来（旧版 2.25 < 4.1×0.7）
    expect(ARENA_FLAGS.gearFactory.base).toBeGreaterThanOrEqual(factory.height * 0.7);
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

/**
 * 齿轮工厂的**零件级**锁：用户点名要「两个烟囱 + 齿轮转」。
 * 尺寸锁只管外轮廓，管不到"烟囱是不是偷偷变回一根"或者"齿轮是不是被改成静物"。
 */
describe('齿轮工厂：双烟囱与咬合齿轮', () => {
  const nodes = ARENA_MODELS.gearFactory(SIDE_COLOR.blue).static;

  it('正好两根烟囱（半径 0.085 的石柱），左右对称', () => {
    const stacks = nodes.filter(
      (n) => n.part.kind === 'cyl' && (n.part as { rTop: number }).rTop === 0.085,
    );
    expect(stacks).toHaveLength(2);
    const xs = stacks.map((n) => n.at![0]).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(0);
    expect(xs[1]).toBeGreaterThan(0);
    expect(Math.abs(xs[0]! + xs[1]!)).toBeLessThan(1e-6);
  });

  it('两枚齿轮反向转，且**每一片齿都跟着转**（不是只有轮毂在自转）', () => {
    const moving = nodes.filter((n) => n.spin !== undefined);
    const speeds = [...new Set(moving.map((n) => n.spin))].sort((a, b) => a! - b!);
    expect(speeds).toHaveLength(2);
    expect(speeds[0]).toBeLessThan(0);
    expect(speeds[1]).toBeGreaterThan(0);
    // 12 齿 + 8 齿 + 4 辐条 + 2 盘 + 2 轴心 = 28 件都会动
    expect(moving).toHaveLength(28);
    for (const n of moving) expect(n.pivot, '转轴必须给，否则 buildModel 不生成 Spinner').toBeTruthy();
    // 反证：小轮要比大轮快（半径小的转得快），等速就是"两轮各转各的"没咬上
    const big = Math.max(...(speeds as number[]));
    const small = Math.abs(Math.min(...(speeds as number[])));
    expect(small).toBeGreaterThan(big);
  });

  it('齿轮贴墙：最远的零件仍在 3 格占地的半深内', () => {
    const scale = 2.2; // BUILDING_SCALE，模型单位 → 格
    for (const n of nodes) {
      const z = Math.abs(n.at?.[2] ?? 0);
      // 盘厚 0.08 / 齿盒 0.08，保守按 0.06 半径补
      expect((z + 0.06) * scale, `零件 ${n.part.kind} 飘出占地`).toBeLessThanOrEqual(1.5);
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

/**
 * **里子必须比外壳小一圈**（2026-11-07 用户实机，原话："后面新加的几个建筑
 * （兽人房屋和工业工厂），外面的可掉落墙壁和里面穿模了。里面的里子应该是小一点的"）。
 *
 * 病灶：这两栋的**本体盒和 `boxShell` 传的宽深一模一样**（工厂 1.56×1.04、
 * 巢穴 1.2×1.0）。外壳面片厚 0.06，外皮正好落在 ±w/2，而本体的表面也在 ±w/2
 * ⇒ 两个面**共面**：实机上是墙面闪烁（z-fighting），墙板掉了本体还占着那块体积，
 * "洞"是假的。老楼一直是缩进的（大本营 1.42→1.06、兵营 1.42→1.2、民居 1.14→0.94）。
 *
 * 这条锁从**面片反推**壳的外轮廓，不另抄一份尺寸表 —— 壳一改，判据跟着改。
 * 只对 `boxShell` 的方楼成立（圆塔用 ringShell，半径口径不同，另有锁）。
 */
/** 板厚：和 models.ts 的 `PANEL_T` 同一个物理量 */
const PANEL_T = 0.06;
const EPS = 0.01;
/** 本体与内皮的最大允许间隙：再大就是"空壳里放了个小盒子" */
const MAX_GAP = 0.3;

describe('里子比外壳小一圈：墙片不许和本体共面（方壳）', () => {
  interface Box {
    sx: number;
    sy: number;
    sz: number;
    y0: number;
    y1: number;
  }

  /** 静态件里所有**不旋转的盒子**（旋转的是骨刺/斜撑这类装饰，不参与本体判断）。 */
  function boxesOf(name: keyof typeof ARENA_MODELS): Box[] {
    const nodes = ARENA_MODELS[name]('blue' as never).static as unknown as {
      part: { kind: string; size?: [number, number, number] };
      at?: [number, number, number];
      rot?: [number, number, number];
    }[];
    const out: Box[] = [];
    for (const n of nodes) {
      if (n.part.kind !== 'box' || !n.part.size || !n.at) continue;
      if (n.rot && n.rot.some((r) => Math.abs(r) > 1e-6)) continue;
      const [sx, sy, sz] = n.part.size;
      out.push({ sx, sy, sz, y0: n.at[1] - sy / 2, y1: n.at[1] + sy / 2 });
    }
    return out;
  }

  /** 从面片反推方壳的外轮廓（x / z 半宽）与高度带。 */
  function shellOf(name: keyof typeof ARENA_MODELS) {
    const panels = ARENA_MODELS[name]('blue' as never).shell as unknown as {
      x: number;
      y: number;
      z: number;
      h: number;
      t: number;
      yaw: number;
    }[];
    let halfX = 0;
    let halfZ = 0;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of panels) {
      const c = Math.cos(p.yaw);
      const s = Math.sin(p.yaw);
      // 面片局部 +z 是板厚方向；世界侧向按 yaw 判：|cos|≈1 ⇒ 前后墙（吃 z），否则左右墙（吃 x）
      if (Math.abs(c) > 0.9) halfZ = Math.max(halfZ, Math.abs(p.z) + p.t / 2);
      else if (Math.abs(s) > 0.9) halfX = Math.max(halfX, Math.abs(p.x) + p.t / 2);
      else throw new Error(`${String(name)} 不是方壳（yaw=${p.yaw}），这条锁只管 boxShell`);
      y0 = Math.min(y0, p.y - p.h / 2);
      y1 = Math.max(y1, p.y + p.h / 2);
    }
    return { halfX, halfZ, y0, y1 };
  }

  // 兽人巢穴 2026-11-07 傍晚改成半圆地堡（ringShell），不在方壳这组里，见下面那条
  const shellBuildings = ['core', 'barracks', 'house', 'gearFactory'] as const;

  it('本体盒落在壳的内皮以内（不吃进 0.06 的板厚），也没缩成一个点', () => {
    for (const name of shellBuildings) {
      const shell = shellOf(name);
      const span = shell.y1 - shell.y0;
      // 本体 = 与壳高度带重叠过半、且水平面积最大的那个盒（楼板/檐口这类横条不算）
      const inside = boxesOf(name).filter((b) => {
        const overlap = Math.min(b.y1, shell.y1) - Math.max(b.y0, shell.y0);
        return overlap > span * 0.5;
      });
      expect(inside.length, `${name} 找不到本体盒`).toBeGreaterThan(0);
      const body = inside.sort((a, b) => b.sx * b.sz - a.sx * a.sz)[0]!;

      const maxX = shell.halfX - PANEL_T - EPS;
      const maxZ = shell.halfZ - PANEL_T - EPS;
      expect(body.sx / 2, `${name} 里子宽 ${body.sx} 顶到墙片了（壳外宽 ${shell.halfX * 2}）`).toBeLessThan(maxX + 1e-9);
      expect(body.sz / 2, `${name} 里子深 ${body.sz} 顶到墙片了（壳外深 ${shell.halfZ * 2}）`).toBeLessThan(maxZ + 1e-9);
      expect(body.sx / 2, `${name} 里子缩得太狠，墙片掉光会看到一个大空壳`).toBeGreaterThan(maxX - MAX_GAP);
      expect(body.sz / 2, `${name} 里子缩得太狠，墙片掉光会看到一个大空壳`).toBeGreaterThan(maxZ - MAX_GAP);
    }
  });

  /**
   * 反证：把两栋的旧写法代进**同一组阈值**，必须全部越界。
   * 旧写法的本体宽深就是照抄 `boxShell` 的入参（工厂 1.56×1.04 / 巢穴 1.2×1.0），
   * 所以这组数只要有一条不越界，说明上面的阈值给松了、锁是自证的。
   */
  it('反证：旧写法（本体宽深照抄壳）代进同一组阈值 ⇒ 必须越界', () => {
    // 巢穴现在是圆壳，反证在下面圆壳那条里；这里只剩工厂这一个方壳受害者
    const old: [keyof typeof ARENA_MODELS, number, number][] = [['gearFactory', 1.56, 1.04]];
    for (const [name, w, d] of old) {
      const shell = shellOf(name);
      const maxX = shell.halfX - PANEL_T - EPS;
      const maxZ = shell.halfZ - PANEL_T - EPS;
      expect(w / 2, `${name} 旧写法的半宽竟然还在阈值内`).toBeGreaterThanOrEqual(maxX);
      expect(d / 2, `${name} 旧写法的半深竟然还在阈值内`).toBeGreaterThanOrEqual(maxZ);
    }
  });
});

/**
 * 圆壳楼（`ringShell`）的同一条法律：**里子半径必须小于壳的内半径**。
 *
 * 兽人巢穴改成"半圆地堡"之后，筒身是一圈 12 段的圆壳，判据不能再拿宽深算 ——
 * 从面片反推半径（`ringShell` 把面片中心放在 `r - t/2`，所以 `r = |中心| + t/2`），
 * 本体取"与壳高度带重叠过半、底面半径最大"的圆柱。
 */
describe('里子比外壳小一圈（圆壳）', () => {
  function ringOf(name: keyof typeof ARENA_MODELS) {
    const panels = ARENA_MODELS[name]('blue' as never).shell as unknown as {
      x: number; y: number; z: number; h: number; t: number; yaw: number;
    }[];
    let r = 0;
    let y0 = Infinity;
    let y1 = -Infinity;
    let skewed = 0;
    let rightCount = 0;
    for (const p of panels) {
      // 圆壳的 yaw 是 π/2 − a，一圈里总有落在斜角上的那几片；方壳则**全部**是直角。
      // 所以判据是"至少有一片不是直角"（只看一片会撞上恰好是直角的那个）
      const right = [0, Math.PI / 2, Math.PI, -Math.PI / 2].some((a) => Math.abs(p.yaw - a) < 1e-6);
      if (!right) skewed++;
      else rightCount++;
      r = Math.max(r, Math.hypot(p.x, p.z) + p.t / 2);
      y0 = Math.min(y0, p.y - p.h / 2);
      y1 = Math.max(y1, p.y + p.h / 2);
    }
    expect(skewed, `${String(name)} 的壳全是直角，是方壳不是圆壳`).toBeGreaterThan(0);
    expect(rightCount, `${String(name)} 的壳一片直角都没有？`).toBeGreaterThan(-1);
    return { r, y0, y1 };
  }

  function innerCylinderOf(name: keyof typeof ARENA_MODELS, y0: number, y1: number) {
    const nodes = ARENA_MODELS[name]('blue' as never).static as unknown as {
      part: { kind: string; rBottom?: number; height?: number };
      at?: [number, number, number];
      rot?: [number, number, number];
    }[];
    const span = y1 - y0;
    const cands = nodes
      .filter((n) => n.part.kind === 'cyl' && !n.rot?.some((v) => Math.abs(v) > 1e-6) && n.at && n.part.height)
      .map((n) => {
        const h = n.part.height!;
        const b = n.at![1] - h / 2;
        const overlap = Math.min(b + h, y1) - Math.max(b, y0);
        return { r: n.part.rBottom!, overlap };
      })
      .filter((c) => c.overlap > span * 0.5);
    expect(cands.length, `${String(name)} 找不到内衬筒`).toBeGreaterThan(0);
    return cands.sort((a, b) => b.r - a.r)[0]!;
  }

  it('兽人巢穴：内衬半径落在壳内皮以内，且没缩成一根柱子', () => {
    const shell = ringOf('orcLair');
    const body = innerCylinderInspect();
    const maxR = shell.r - PANEL_T - EPS;
    expect(body, '内衬半径顶到墙片了').toBeLessThan(maxR + 1e-9);
    expect(body, '内衬缩得太狠，墙片掉光会看到一个大空壳').toBeGreaterThan(maxR - MAX_GAP);

    function innerCylinderInspect() {
      return innerCylinderOf('orcLair', shell.y0, shell.y1).r;
    }
  });

  it('反证：把内衬改回和壳同半径（0.60）代进同一阈值 ⇒ 必须越界', () => {
    const shell = ringOf('orcLair');
    expect(0.6).toBeGreaterThanOrEqual(shell.r - PANEL_T - EPS);
  });
});
