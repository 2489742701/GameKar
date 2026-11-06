/**
 * 一次性探针：把对战模式的兵种数值排成一张表（体型高度来自实机测量，见注释）。
 * 跑法：npx vite-node tools/unit_table.mts
 */
import { CARDS } from '../src/arena/config';
import { unitDef } from '../src/game/data/units';
import { statsOf } from '../src/arena/ArenaWorld';

/** 实机量出来的身高（格，脚到顶），来自 tools/unit_lineup.js 在真页面里的包围盒测量 */
const HEIGHT: Record<string, number> = {
  knight: 1.45,
  archer: 1.45,
  mage: 1.45,
  orc: 1.45,
  priest: 1.45,
  golem: 1.9,
  mech: 2.4,
  mobileCannon: 1.6,
  ballista: 1.5,
};

/** 车/炮本体（不含推车人）的顶高，世界坐标减地面 0.5 */
const BODY_TOP: Record<string, number> = { mobileCannon: 1.13, ballista: 0.91 };

const rows = [];
for (const card of CARDS) {
  if (!card.squad) continue;
  for (const part of card.squad) {
    const id = part.unitId;
    const st = statsOf(id);
    let name = id;
    try {
      name = unitDef(id).name;
    } catch {
      name = id === 'mobileCannon' ? '移动火炮' : id;
    }
    const dps = st.damage / st.cooldown;
    const count = part.count;
    const totalHp = st.hp * count;
    const totalDps = dps * count;
    // 对攻 12 的常见敌人：每次挨打掉 max(1, 12 - 防)
    const ehp = st.hp * (12 / Math.max(1, 12 - st.defense)) * count;
    rows.push({
      card: card.name,
      unit: name,
      cost: card.cost,
      count,
      hp: st.hp,
      atk: st.damage,
      def: st.defense,
      range: st.range,
      speed: st.speed,
      cd: st.cooldown,
      dps: +dps.toFixed(1),
      totalDps: +totalDps.toFixed(1),
      ehp: Math.round(ehp),
      height: HEIGHT[id] ?? null,
      bodyTop: BODY_TOP[id] ?? null,
      dpsPerGold: +(totalDps / card.cost).toFixed(2),
      ehpPerGold: +(ehp / card.cost).toFixed(1),
    });
  }
}

console.log('| 卡 | 兵 | 价 | 数量 | 血/只 | 攻 | 防 | 射程 | 速度 | 间隔 | DPS/只 | 总DPS | EHP | 体高 | 每金DPS | 每金EHP |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(
    `| ${r.card} | ${r.unit} | ${r.cost} | ${r.count} | ${r.hp} | ${r.atk} | ${r.def} | ${r.range} | ${r.speed} | ${r.cd} | ${r.dps} | ${r.totalDps} | ${r.ehp} | ${r.height ?? '-'} | ${r.dpsPerGold} | ${r.ehpPerGold} |`,
  );
}

// 体型 vs 战力：高度和"每金 DPS"分别排个名，看差得多不多
const withH = rows.filter((r) => r.height !== null);
const byH = [...withH].sort((a, b) => b.height! - a.height!).map((r) => `${r.unit}${r.height}`);
const byD = [...rows].sort((a, b) => b.dpsPerGold - a.dpsPerGold).map((r) => `${r.unit}${r.dpsPerGold}`);
console.log('\n体型从大到小：' + byH.join(' > '));
console.log('每金 DPS 从高到低：' + byD.join(' > '));
