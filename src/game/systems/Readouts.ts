/**
 * 建筑读数 —— 把世界账本与战斗内核里的数，折成"屏幕上要画什么"的一份结构。
 *
 * 为什么要单独一层：血条、读条、气泡、底部信息卡四处都要说同一栋楼的同一件事。
 * 各算各的必然出现"气泡说 3/4，头顶条画 5 格"这种自相矛盾（`ui/facts.ts` 顶上就写着这条规矩）。
 *
 * 这里只做**纯读**：不改世界、不碰 DOM，所以在 node 里能一次断完。
 */

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
  return {
    left: st.magazine,
    size: spec.magazine,
    reloading: st.reloading,
    level: st.level,
    maxLevel,
    line: `Lv${st.level} · ${line}`,
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

