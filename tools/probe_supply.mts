/**
 * 一次性探针：人口 / 面包上线之后，双方是不是被这两条**卡死**了。
 * 跑法：npx vite-node tools/probe_supply.mts
 */
import { ArenaWorld } from '../src/arena/ArenaWorld';

const N = 12;
let popSum = 0;
let breadSum = 0;
let popCap = 0;
let breadCap = 0;
let samples = 0;
let stuckPop = 0;
let stuckBread = 0;
const perMatch: string[] = [];

for (let seed = 1; seed <= N; seed++) {
  const w = new ArenaWorld({ seed, auto: { blue: true } });
  let t = 0;
  let lastLog = 0;
  let peakPop = 0;
  while (t < 180 && w.outcome === 'playing') {
    w.update(0.1);
    t += 0.1;
    if (t - lastLog >= 10) {
      lastLog = t;
      const s = w.supplyOf('blue');
      popSum += s.pop;
      popCap += s.popMax;
      breadSum += s.bread;
      breadCap += s.breadMax;
      samples++;
      if (s.pop >= s.popMax) stuckPop++;
      if (s.bread >= s.breadMax) stuckBread++;
      peakPop = Math.max(peakPop, s.popMax);
    }
  }
  const s = w.supplyOf('blue');
  perMatch.push(
    `seed ${String(seed).padStart(2)}：结束 ${w.outcome.padEnd(6)} 人口 ${s.pop}/${s.popMax} 面包 ${s.bread}/${s.breadMax} 峰值人口上限 ${peakPop}`,
  );
}

console.log(perMatch.join('\n'));
console.log(
  `\n采样 ${samples} 次 ｜ 人口平均 ${(popSum / samples).toFixed(1)}/${(popCap / samples).toFixed(1)}（${((popSum / popCap) * 100).toFixed(0)}%）` +
    ` ｜ 面包平均 ${(breadSum / samples).toFixed(1)}/${(breadCap / samples).toFixed(1)}（${((breadSum / breadCap) * 100).toFixed(0)}%）`,
);
console.log(
  `满员占比：人口 ${((stuckPop / samples) * 100).toFixed(0)}% ｜ 面包 ${((stuckBread / samples) * 100).toFixed(0)}%`,
);
