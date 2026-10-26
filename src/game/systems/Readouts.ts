/**
 * 建筑读数 —— 把世界账本与战斗内核里的数，折成"屏幕上要画什么"的一份结构。
 *
 * 为什么要单独一层：血条、读条、气泡、底部信息卡四处都要说同一栋楼的同一件事。
 * 各算各的必然出现"气泡说 3/4，头顶条画 5 格"这种自相矛盾（`ui/facts.ts` 顶上就写着这条规矩）。
 *
 * 这里只做**纯读**：不改世界、不碰 DOM，所以在 node 里能一次断完。
 */

import { RESOURCE_META } from '@game/config';
import { unitDef } from '@game/data/units';
import type { Combat } from '@game/systems/Combat';
import type { Building, GameWorld } from '@game/world/GameWorld';

/** 血条量化成几档：与界面材质的"色阶档数"无关，这是玩法读数的硬边。 */
export const HP_STEPS = 6;

export interface HpReadout {
  hp: number;
  max: number;
  /** 0..1 */
  frac: number;
  /** 1..HP_STEPS，给像素血条用的格数 */
  steps: number;
  /** 满血不挂条：一屏幕绿条等于没有信息 */
  visible: boolean;
}

export interface SquadReadout {
  alive: number;
  total: number;
  stock: number;
  /** 生产读条 0..1；null = 这一格不该出现读条 */
  training: number | null;
  /** 给文字用的一句：'补 2/3' / '生产中 40%' / '满编' */
  line: string;
}

export interface AmmoReadout {
  left: number;
  size: number;
  /** 空仓装填还剩几秒；0 = 没在装 */
  reloading: number;
  /** 这次装填一共几秒（画方块用） */
  reloadTotal: number;
  /** 已经装好几发（0..size）：装填中按进度算，不然就是弹夹余量 */
  filled: number;
  level: number;
  maxLevel: number;
  line: string;
}

export interface BuildingReadout {
  id: number;
  name: string;
  hp: HpReadout;
  squad: SquadReadout | null;
  ammo: AmmoReadout | null;
  understaffed: boolean;
}

export function hpOf(b: Building): HpReadout {
  const max = Math.max(1, b.def.hp);
  const frac = Math.min(1, Math.max(0, b.hp / max));
  // 量化往上取整：掉一丝血也至少亮一格，不然"挨了一下"看不出来
  const steps = Math.max(frac > 0 ? 1 : 0, Math.ceil(frac * HP_STEPS));
  return { hp: Math.round(b.hp), max: b.def.hp, frac, steps, visible: frac < 1 };
}

export function squadOf(combat: Combat, b: Building): SquadReadout | null {
  const squad = b.def.squad;
  if (!squad || !b.built) return null;
  const st = combat.barracksState(b);
  const total = combat.squadSize(b);
  // 当场数一遍在场的人：barracksState().alive 是上次 update 时算的，
  // 刚死一个还没刷新的话，屏幕上会出现"死了人还显示满编"
  let alive = 0;
  for (const u of combat.liveUnits()) if (!u.dead && u.home === b.id) alive++;
  const training = alive < total && st.stock === 0 ? st.progress : null;
  const line =
    alive >= total
      ? `满编 ${alive}/${total}`
      : training !== null
        ? `生产中 ${Math.round(training * 100)}%`
        : `补 ${alive}/${total} · 储备 ${st.stock}`;
  return { alive, total, stock: st.stock, training, line };
}

export function ammoOf(combat: Combat, b: Building): AmmoReadout | null {
  const spec = b.def.tower;
  if (!spec || !b.built) return null;
  const st = combat.towerState(b);
  const maxLevel = spec.upgrades.length + 1;
  const line =
    st.reloading > 0
      ? `装填 ${st.reloading.toFixed(1)}s`
      : `弹夹 ${st.magazine}/${spec.magazine}`;
  const reloadTotal = combat.reloadSeconds(b);
  // 装填时按时间进度逐格点亮；平时就是弹夹余量
  // 装填中：从"已有几发"往上填到满（空闲补弹是从 5/6 补到 6/6，不是从 0 开始重画）
  const filled =
    st.reloading > 0 && reloadTotal > 0
      ? Math.min(
          spec.magazine,
          st.magazine + Math.floor((1 - st.reloading / reloadTotal) * (spec.magazine - st.magazine)),
        )
      : st.magazine;
  return {
    left: st.magazine,
    size: spec.magazine,
    reloading: st.reloading,
    reloadTotal,
    filled: Math.max(0, filled),
    level: b.level,
    maxLevel,
    line: `Lv${b.level} · ${line}`,
  };
}

export function readoutOf(world: GameWorld, combat: Combat, b: Building): BuildingReadout {
  return {
    id: b.id,
    name: b.def.name,
    hp: hpOf(b),
    squad: squadOf(combat, b),
    ammo: ammoOf(combat, b),
    understaffed: world.isUnderstaffed(b),
  };
}

/** 屏幕上需要挂条的那些楼（掉过血 / 兵营没满编 / 塔在装填）。 */
export function barWorthies(world: GameWorld, combat: Combat): BuildingReadout[] {
  const out: BuildingReadout[] = [];
  for (const b of world.buildings.values()) {
    const r = readoutOf(world, combat, b);
    const squadBusy = r.squad !== null && r.squad.alive < r.squad.total;
    const ammoBusy = r.ammo !== null && (r.ammo.reloading > 0 || r.ammo.left < r.ammo.size);
    if (r.hp.visible || squadBusy || ammoBusy) out.push(r);
  }
  return out;
}

/** 升级按钮要的那句话（价格与是否满级），放在这里免得 UI 自己算等级。 */
export function upgradeLine(b: Building, level: number): string {
  const spec = b.def.tower;
  if (!spec) return '';
  const price = spec.upgrades[level - 1];
  if (!price) return '已满级';
  const parts = [`金${price.gold}`];
  if (price.crystal) parts.push(`水${price.crystal}`);
  return `升级 Lv${level + 1} · ${parts.join(' ')}`;
}

/** 兵种名（信息卡读小队编制时用）。 */
export function squadNames(b: Building): string {
  const squad = b.def.squad;
  if (!squad) return '';
  return squad.map((m) => `${unitDef(m.unitId).name}×${m.size}`).join('、');
}

/** 一格图标 + 一个数：屏幕上那种"像游戏"的战力条。 */
export interface PowerBit {
  icon: 'sword' | 'shield' | 'heart' | 'pop' | 'bread' | 'gold' | 'crystal';
  value: string;
  /** 人话说明（也当 title 提示用），免得只有图形没处问 */
  title: string;
}

/**
 * 一栋楼的战力读数。数字一律从**开火与伤害的那一处**拿：
 * 塔伤走 `combat.towerDamage()`（含等级缩放），兵走单位表本体。
 * `combat` 缺席时（早期夹具、素材没加载）塔伤退回表上的基线值，不显示放大后的数。
 *
 * 楼自己的血量不在这行里 —— 它已经有头顶那条血格了，再画一颗心只会让人猜"这两颗心哪个算哪个"。
 */
export function powerOf(b: Building, combat?: Combat): PowerBit[] {
  const out: PowerBit[] = [];
  const spec = b.def.tower;
  if (spec) {
    const level = b.level;
    const dmg = combat ? combat.towerDamage(b) : spec.damage;
    out.push({ icon: 'sword', value: String(dmg), title: `Lv${level} 单发伤害` });
  }
  for (const m of b.def.squad ?? []) {
    const u = unitDef(m.unitId);
    out.push({ icon: 'sword', value: String(u.attack), title: `${u.name} 的攻击（队里 ${m.size} 个）` });
    out.push({ icon: 'shield', value: String(u.defense), title: `${u.name} 的防御` });
    out.push({ icon: 'heart', value: String(u.hp), title: `${u.name} 的血量` });
  }
  /**
   * 下面这几条统一写成**带符号的收支**："人口 +4 / 面包 −1 / 金币 −45"。
   *
   * 原来写成"住 4 人，吃 1 面包"这种人话，两个问题：① 得靠读句子才知道是收入还是支出；
   * ② 句子是手写的，改了表它不会跟着变（民居的 +3/+4 就是这么漂过一回）。
   * 现在一律从 `def` 现算，符号就是方向。
   */
  if (b.def.population > 0) {
    out.push({ icon: 'pop', value: `−${b.def.population}`, title: `占 ${b.def.population} 个人手（从人口里扣）` });
  }
  if (b.def.populationCap) {
    out.push({ icon: 'pop', value: `+${b.def.populationCap}`, title: `人口上限 +${b.def.populationCap}` });
  }
  if (b.def.breadPerRound) {
    out.push({ icon: 'bread', value: `+${b.def.breadPerRound.base}`, title: '每回合面包底产（贴田另加）' });
  }
  // 造价：一次性支出。放在最后，跟上面的产出/占用分开读
  const cost = b.def.cost ?? {};
  for (const res of ['gold', 'crystal', 'bread'] as const) {
    const amount = cost[res];
    if (!amount) continue;
    out.push({ icon: res, value: `−${amount}`, title: `${RESOURCE_META[res].label} 造价 ${amount}` });
  }
  return out;
}

