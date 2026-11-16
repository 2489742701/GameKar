/**
 * **AI 互打 · 平衡评估器**（2026-11-16，P-107）。
 *
 * 用户：「你先让 AI 互相对战玩一下看看，然后中间比如说让 log 输出倾向就是谁更容易赢，
 *   然后这个 debug 评估一下游戏平衡性」。
 *
 * 用法：
 *   npx tsx tools/ai_balance.mts                # 默认 64 局
 *   npx tsx tools/ai_balance.mts 200            # 指定局数
 *   npx tsx tools/ai_balance.mts 200 --verbose  # 每局一行
 *
 * 输出三块：
 *   ① 胜负倾向（谁更容易赢、平局率、平均时长）
 *   ② 节奏分布（短局 / 中局 / 长局各占多少）—— 对应"节奏快能快、慢能慢"
 *   ③ 科技与法术使用情况（AI 到底走了哪条线）
 *
 * ⚠️ 这是**诊断工具**，不是回归锁。回归锁在 `tests/balance_20261107.test.ts`
 * （它只钉"拆楼 1.8~4.5 栋/局"这类硬判据，避免把工具的输出写死成测试）。
 */
import { ArenaWorld } from '../src/arena/ArenaWorld.ts';
import { CARD_WEIGHT, SPELL } from '../src/arena/config.ts';

const args = process.argv.slice(2);
const GAMES = Number(args.find((a) => /^\d+$/.test(a)) ?? 64);
const VERBOSE = args.includes('--verbose');

interface Row {
  seed: number;
  outcome: string;
  reason: string | null;
  seconds: number;
  blueDestroyed: number;
  redDestroyed: number;
  blueBuildings: number;
  redBuildings: number;
  blueUnits: number;
  redUnits: number;
  casts: number;
  techs: string[];
}

const rows: Row[] = [];

for (let seed = 1; seed <= GAMES; seed++) {
  // 双方都托管 ⇒ 纯 AI 对 AI
  const w = new ArenaWorld({ seed, auto: { blue: true, red: true } });
  let t = 0;
  while (w.outcome === 'playing' && t < 400) {
    w.update(0.05);
    t += 0.05;
  }

  const side = (s: 'blue' | 'red') => {
    const bs = [...w.buildings.values()].filter((b) => b.side === s);
    const techs: string[] = [];
    if (bs.some((b) => b.kind === 'barracks')) techs.push('兵营');
    if (bs.some((b) => b.kind === 'gearFactory')) techs.push('工厂');
    if (bs.some((b) => b.kind === 'orcLair')) techs.push('兽穴');
    if (bs.some((b) => b.kind === 'spellForge')) techs.push('法工');
    return {
      buildings: bs.filter((b) => b.kind !== 'core').length,
      units: w.units.filter((u) => u.side === s && u.hp > 0).length,
      techs,
    };
  };

  const b = side('blue');
  const r = side('red');
  rows.push({
    seed,
    outcome: w.outcome,
    reason: w.outcomeReason,
    seconds: t,
    blueDestroyed: w.destroyed.red,   // 蓝方拆掉了红方多少
    redDestroyed: w.destroyed.blue,
    blueBuildings: b.buildings,
    redBuildings: r.buildings,
    blueUnits: b.units,
    redUnits: r.units,
    casts: w.spellNotes.length,
    techs: b.techs,
  });

  if (VERBOSE) {
    const tag = w.outcome === 'win'
      ? (w.destroyed.red >= w.destroyed.blue ? '蓝胜' : '红胜')
      : w.outcome;
    console.log(
      `seed ${String(seed).padStart(3)} ${tag.padEnd(5)} ${t.toFixed(0).padStart(3)}s ` +
      `拆楼 蓝${w.destroyed.red}/红${w.destroyed.blue} ` +
      `楼 蓝${b.buildings}/红${r.buildings} 兵 蓝${b.units}/红${r.units} ` +
      `科技[${b.techs.join(',')}]`,
    );
  }
}

// ---------------- 汇总 ----------------
const n = rows.length;
const pct = (v: number): string => `${((v / n) * 100).toFixed(0)}%`;
const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/**
 * 胜负口径：`outcome` 只有 win/lose/draw，而 **win 是"蓝方视角"**。
 * 所以"谁更容易赢"要自己拆：蓝拆得多 = 蓝赢。
 */
let blue = 0;
let red = 0;
let draw = 0;
for (const r of rows) {
  if (r.outcome === 'draw') { draw++; continue; }
  if (r.outcome === 'win') blue++; else red++;
}

const reasons: Record<string, number> = {};
for (const r of rows) reasons[r.reason ?? 'none'] = (reasons[r.reason ?? 'none'] ?? 0) + 1;

const secs = rows.map((r) => r.seconds);
const fast = rows.filter((r) => r.seconds < 120).length;
const mid = rows.filter((r) => r.seconds >= 120 && r.seconds < 240).length;
const slow = rows.filter((r) => r.seconds >= 240).length;

console.log('');
console.log('══════════ AI 互打平衡评估 ══════════');
console.log(`样本        ${n} 局（同 seed 序列，双方全托管）`);
console.log('');
console.log('① 胜负倾向');
console.log(`   蓝方胜    ${blue} 局 (${pct(blue)})`);
console.log(`   红方胜    ${red} 局 (${pct(red)})`);
console.log(`   平局      ${draw} 局 (${pct(draw)})`);
console.log(`   → 倾向：${Math.abs(blue - red) / n < 0.12 ? '基本对称 ✅' : blue > red ? '蓝方明显更强 ⚠️' : '红方明显更强 ⚠️'}`);
console.log('');
console.log('② 胜负方式');
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  const label = k === 'core' ? '拆掉大本营' : k === 'time' ? '时间到比积分' : k === 'waves' ? 'PVE 波次' : k;
  console.log(`   ${label.padEnd(12)} ${v} 局 (${pct(v)})`);
}
console.log('');
console.log('③ 节奏分布（用户要的"快能快、慢能慢"）');
console.log(`   短局 <2min   ${fast} 局 (${pct(fast)})`);
console.log(`   中局 2-4min  ${mid} 局 (${pct(mid)})`);
console.log(`   长局 >4min   ${slow} 局 (${pct(slow)})`);
console.log(`   平均时长     ${avg(secs).toFixed(0)} 秒   最短 ${Math.min(...secs).toFixed(0)}s  最长 ${Math.max(...secs).toFixed(0)}s`);
console.log(`   → 多样性：${slow / n > 0.15 && fast / n > 0.15 ? '快慢都有 ✅' : '节奏偏单一 ⚠️'}`);
console.log('');
console.log('④ 拆楼与兵力');
console.log(`   平均拆楼    蓝 ${avg(rows.map((r) => r.blueDestroyed)).toFixed(2)} / 红 ${avg(rows.map((r) => r.redDestroyed)).toFixed(2)} 栋`);
console.log(`   终局楼数    蓝 ${avg(rows.map((r) => r.blueBuildings)).toFixed(1)} / 红 ${avg(rows.map((r) => r.redBuildings)).toFixed(1)} 栋`);
console.log(`   终局兵力    蓝 ${avg(rows.map((r) => r.blueUnits)).toFixed(1)} / 红 ${avg(rows.map((r) => r.redUnits)).toFixed(1)} 个`);
console.log('');
console.log('⑤ 科技与法术（AI 实际走了哪条线）');
const techCount: Record<string, number> = {};
for (const r of rows) for (const t of r.techs) techCount[t] = (techCount[t] ?? 0) + 1;
for (const [k, v] of Object.entries(techCount).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(6)} ${v} 局 (${pct(v)})`);
}
console.log(`   平均施法  ${avg(rows.map((r) => r.casts)).toFixed(2)} 次/局（每局播报上限 8 条）`);
console.log('');
console.log('⑥ 当前关键旋钮');
console.log(`   建筑卡权重  ${CARD_WEIGHT.building}`);
console.log(`   导弹伤害    ${SPELL.missile!.damage}（对楼实际 ${SPELL.missile!.damage * 2.2}）`);
