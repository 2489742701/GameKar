/**
 * 一次性探针：加时赛 + 兵营免人口（2026-11-06 P-039）后的对局读数。
 * 跑法：npx vite-node tools/probe_nobuild.mts
 *
 * 这一轮顺带量「兵最远推进到哪一列」（上一轮遗留问题：拆楼 1.8 < 施工前 2.6，
 * 兵峰值 8.8 说明兵出得来但推不动）：
 * - maxBlueCol：蓝方兵历史最远推进到的列（越大越深入红方）；
 * - minRedCol：红方兵历史最深入蓝方的列（越小越危险）；
 * - 中线 22，禁建带 18~26。
 */
import { ArenaWorld } from '../src/arena/ArenaWorld';
import { FIELD, NO_BUILD } from '../src/arena/config';

console.log(`禁建带：列 ${FIELD.midCol - NO_BUILD.halfWidth} ~ ${FIELD.midCol + NO_BUILD.halfWidth}（${NO_BUILD.halfWidth * 2 + 1} 列）`);

const rows: {
  seed: number; sec: number; outcome: string; reason: string | null;
  bd: number; rd: number; bl: number; rl: number; bad: number;
  maxBlueCol: number; minRedCol: number; unitPeak: number;
}[] = [];

for (let seed = 1; seed <= 24; seed++) {
  const w = new ArenaWorld({ seed, auto: { blue: true } });
  let t = 0;
  let maxBlueCol = 0;
  let minRedCol = FIELD.cols;
  let unitPeak = 0;
  while (t < 500 && w.outcome === 'playing') {
    w.update(0.1);
    t += 0.1;
    for (const u of w.units) {
      if (u.hp <= 0) continue;
      if (u.side === 'blue') maxBlueCol = Math.max(maxBlueCol, u.x);
      else minRedCol = Math.min(minRedCol, u.x);
    }
    unitPeak = Math.max(unitPeak, w.units.filter((u) => u.hp > 0).length);
  }
  let bad = 0;
  for (const b of w.buildings.values()) {
    for (let c = b.col; c < b.col + b.cols; c++) {
      if (c >= FIELD.midCol - NO_BUILD.halfWidth && c <= FIELD.midCol + NO_BUILD.halfWidth) bad++;
    }
  }
  const left = (s: 'blue' | 'red') => [...w.buildings.values()].filter((b) => b.side === s && b.kind !== 'core').length;
  rows.push({
    seed,
    sec: Math.round(t),
    outcome: w.outcome,
    reason: w.outcomeReason,
    bd: w.destroyed.blue,
    rd: w.destroyed.red,
    bl: left('blue'),
    rl: left('red'),
    bad,
    maxBlueCol: Math.round(maxBlueCol),
    minRedCol: Math.round(minRedCol),
    unitPeak,
  });
}

for (const r of rows) {
  console.log(
    `seed ${String(r.seed).padStart(2)} | ${String(r.sec).padStart(3)}s | ${r.outcome.padEnd(4)} ${String(r.reason).padEnd(8)} | 被拆 蓝${r.bd}/红${r.rd} | 剩 蓝${r.bl}/红${r.rl} | 蓝推到${String(r.maxBlueCol).padStart(2)} 红推到${String(r.minRedCol).padStart(2)} | 兵峰${r.unitPeak} | 压黄区 ${r.bad}`,
  );
}

const win = rows.filter((r) => r.outcome === 'win').length;
const lose = rows.filter((r) => r.outcome === 'lose').length;
const draw = rows.filter((r) => r.outcome === 'draw').length;
const done = rows.filter((r) => r.outcome !== 'playing').length;
const destroyed = rows.reduce((n, r) => n + r.bd + r.rd, 0);
const avg = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
console.log(
  `\n结束 ${done}/24 ｜ 蓝 ${win} 胜 / ${lose} 负 / ${draw} 平 ｜ 共拆 ${destroyed} 栋（平均 ${(destroyed / 24).toFixed(1)}）` +
  ` ｜ 蓝推进均值 ${avg(rows.map((r) => r.maxBlueCol))} ｜ 红推进均值 ${avg(rows.map((r) => r.minRedCol))} ｜ 兵峰均值 ${avg(rows.map((r) => r.unitPeak))}`,
);
