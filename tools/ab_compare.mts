/**
 * **整局 A/B 对比器**（2026-11-16，P-109）。
 *
 * 用户：「你正常尝试，应该按照一整局来对比」。
 *
 * 这个工具跑**同一组 seed 序列**下的多个方案，把整局指标并排对比 ——
 * 不是单点数值对照，是"这一局打成什么样"的对照。
 *
 * 用法：
 *   npx tsx tools/ab_compare.mts            # 默认 48 局 × 全部方案
 *   npx tsx tools/ab_compare.mts 96         # 指定局数
 *
 * 方案在下面 `PLANS` 里改：每个方案是一组**数值覆盖**（跑完自动还原）。
 *
 * ⚠️ 为什么要"同一组 seed"：不同 seed 之间的方差极大（单局时长 111~300 秒），
 * 换一批 seed 出来的差异会盖住真实效果。同 seed 序列才可比。
 */
import { ArenaWorld } from '../src/arena/ArenaWorld.ts';
import { TOWER } from '../src/arena/config.ts';
import { UNITS } from '../src/game/data/units.ts';

const args = process.argv.slice(2);
const GAMES = Number(args.find((a) => /^\d+$/.test(a)) ?? 48);

/**
 * 给若干兵种临时乘一个血量倍数，返回还原函数。
 *
 * `UNITS` 里的定义是**只读对象**（`U()` 冻结过），所以这里用 `as` 强转写回，
 * 跑完立刻还原 —— 只在这个进程里生效，不落地、不影响别的测试。
 */
function scaleHp(byId: Record<string, number>): () => void {
  const saved: [string, number][] = [];
  for (const [id, mult] of Object.entries(byId)) {
    const def = (UNITS as Record<string, { hp: number }>)[id];
    if (!def) continue;
    saved.push([id, def.hp]);
    def.hp = Math.round(def.hp * mult);
  }
  return () => {
    for (const [id, hp] of saved) (UNITS as Record<string, { hp: number }>)[id]!.hp = hp;
  };
}

interface Metric {
  blueWin: number;
  redWin: number;
  draw: number;
  avgSeconds: number;
  fast: number;
  slow: number;
  destroyed: number;
  deployed: number;
  survived: number;
  casts: number;
  maxTanks: number;
}

/** 一个方案：名字 + 对世界的数值覆盖（跑完还原）。 */
interface Plan {
  name: string;
  /** 应用覆盖，返回还原函数 */
  apply: () => () => void;
}

const PATCHERS: Plan[] = [
  {
    name: '基线（当前）',
    apply: () => () => {},
  },
  {
    name: 'A: 塔对兵伤害 ×0.7',
    apply: () => {
      const a = TOWER.arrow.damage;
      const c = TOWER.cannon.damage;
      (TOWER.arrow as { damage: number }).damage = Math.round(a * 0.7);
      (TOWER.cannon as { damage: number }).damage = Math.round(c * 0.7);
      return () => {
        (TOWER.arrow as { damage: number }).damage = a;
        (TOWER.cannon as { damage: number }).damage = c;
      };
    },
  },
  {
    name: 'B: 塔×0.7 + 肉盾血×1.25',
    apply: () => {
      const a = TOWER.arrow.damage;
      const c = TOWER.cannon.damage;
      (TOWER.arrow as { damage: number }).damage = Math.round(a * 0.7);
      (TOWER.cannon as { damage: number }).damage = Math.round(c * 0.7);
      const restoreHp = scaleHp({ orcTank: 1.25, orcGiant: 1.25 });
      return () => {
        (TOWER.arrow as { damage: number }).damage = a;
        (TOWER.cannon as { damage: number }).damage = c;
        restoreHp();
      };
    },
  },
  {
    name: 'C: 只加肉盾血 ×1.4（不动塔）',
    apply: () => scaleHp({ orcTank: 1.4, orcGiant: 1.4 }),
  },
];

/** 跑一组 seed，返回汇总指标。 */
function runPlan(): Metric {
  const m: Metric = {
    blueWin: 0, redWin: 0, draw: 0, avgSeconds: 0, fast: 0, slow: 0,
    destroyed: 0, deployed: 0, survived: 0, casts: 0, maxTanks: 0,
  };
  let totalSeconds = 0;

  for (let seed = 1; seed <= GAMES; seed++) {
    const w = new ArenaWorld({ seed, auto: { blue: true, red: true } });
    let t = 0;
    const seen = new Set<number>();
    const tankIds = new Set<number>();

    while (w.outcome === 'playing' && t < 400) {
      w.update(0.05);
      t += 0.05;
      for (const u of w.units) {
        if (u.side !== 'blue') continue;
        seen.add(u.id);
        if (u.defId === 'orcTank' || u.defId === 'orcGiant') tankIds.add(u.id);
      }
    }

    totalSeconds += t;
    if (t < 120) m.fast++;
    if (t >= 240) m.slow++;
    m.destroyed += w.destroyed.red + w.destroyed.blue;
    m.deployed += seen.size;
    m.survived += w.units.filter((u) => u.side === 'blue').length;
    m.casts += w.spellNotes.length;
    m.maxTanks += tankIds.size;

    if (w.outcome === 'draw') m.draw++;
    else if (w.outcome === 'win') m.blueWin++;
    else m.redWin++;
  }

  m.avgSeconds = totalSeconds / GAMES;
  return m;
}

// ---------------- 跑所有方案 ----------------
const results: { name: string; m: Metric }[] = [];
for (const plan of PATCHERS) {
  const restore = plan.apply();
  const m = runPlan();
  restore();
  results.push({ name: plan.name, m });
  console.log(`[完成] ${plan.name}`);
}

// ---------------- 并排输出 ----------------
const pad = (s: string | number, w: number): string => String(s).padStart(w);
console.log('');
console.log(`════════ 整局 A/B 对比（${GAMES} 局 / 方案，同 seed 序列）════════`);
console.log('');
const head = ['指标', ...results.map((r) => r.name)];
const rows: [string, (m: Metric) => string | number][] = [
  ['蓝方胜', (m) => `${m.blueWin} (${((m.blueWin / GAMES) * 100).toFixed(0)}%)`],
  ['红方胜', (m) => `${m.redWin} (${((m.redWin / GAMES) * 100).toFixed(0)}%)`],
  ['平局', (m) => m.draw],
  ['平均时长', (m) => `${m.avgSeconds.toFixed(0)}s`],
  ['短局<2min', (m) => `${m.fast} (${((m.fast / GAMES) * 100).toFixed(0)}%)`],
  ['长局>4min', (m) => `${m.slow} (${((m.slow / GAMES) * 100).toFixed(0)}%)`],
  ['总拆楼', (m) => (m.destroyed / GAMES).toFixed(2)],
  ['出兵/局', (m) => (m.deployed / GAMES).toFixed(1)],
  ['存活率', (m) => `${((m.survived / m.deployed) * 100).toFixed(0)}%`],
  ['施法/局', (m) => (m.casts / GAMES).toFixed(1)],
  ['肉盾/局', (m) => (m.maxTanks / GAMES).toFixed(2)],
];
const width = 22;
console.log(pad(head[0]!, 12) + head.slice(1).map((h) => pad(h, width)).join(''));
console.log('─'.repeat(12 + width * results.length));
for (const [label, fn] of rows) {
  console.log(pad(label, 12) + results.map((r) => pad(fn(r.m), width)).join(''));
}
console.log('');
console.log('解读：');
console.log('  存活率 ↑ = 兵能站住（肉盾/削塔有效）；长局占比 ↓ = 节奏变快');
console.log('  蓝红胜率接近 50% = 对称；一边 >60% 就该查平衡');
