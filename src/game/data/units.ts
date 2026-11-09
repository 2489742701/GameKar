/**
 * 单位表 —— 兵种的本体数值。兵营只负责"产哪一种、一队几个"，数值都在这里。
 *
 * 攻防血速是我按手感定的（下面每条都写了为什么），跑完会把"第一波能不能守住"
 * 的实测量出来再调，不在这里自说自话。
 * 伤害公式：max(1, 攻 − 防) —— 下限 1 保证"堆防也堆不死人"这件事不会发生。
 */

import type { AnimName } from '@game/dudes/anims';

export type Faction = 'own' | 'enemy';
export type UnitRole = 'ranged' | 'melee' | 'tank' | 'healer';

export interface UnitSpecial {
  /** charge = 冲撞击飞（兽人）；heal = 周期回血（牧师） */
  kind: 'charge' | 'heal';
  /** 每隔几秒触发一次 */
  every: number;
  /** charge：把对方顶开几格 */
  knockTiles?: number;
  /** charge：对方定身几秒 */
  stunSeconds?: number;
  /** charge：冲出去的距离 */
  dashTiles?: number;
  /** heal：一次回几点、半径几格 */
  amount?: number;
  radius?: number;
}

export interface UnitDef {
  id: string;
  name: string;
  blurb: string;
  role: UnitRole;
  faction: Faction;
  hp: number;
  attack: number;
  defense: number;
  /** 攻击距离（格）。近战 1.2 就是"贴上去才打得到" */
  range: number;
  /** 脚程，格/秒。和矿井小人的 speed 同一个单位口径 */
  speed: number;
  /** 攻击间隔（秒） */
  cooldown: number;
  /** 索敌半径（格）：兵营的自动守家范围 */
  sight: number;
  attackAnim: AnimName;
  idleAnim: AnimName;
  /** 这个兵种需要烘哪些动画 */
  anims: AnimName[];
  /** 头型候选区间（含端点）。取的时候会再和"非空列"求交 */
  headBands: readonly (readonly [number, number])[];
  /** 脸型候选区间；不给就是"多半不叠脸" */
  faceBand?: readonly [number, number];
  /** 远程投射物：有值才在对战里画出一条飞行的弹道（弓=箭，法师=法术弹，气球=炸弹） */
  projectile?: 'arrow' | 'magic' | 'cannon';
  /** 飞行单位（2026-11-07）：移动越过建筑/黄区、不与地面兵互挤、视图悬浮 */
  flying?: boolean;
  /** 一次性轰炸机：不索敌、直冲敌方、下方有敌军投弹、飞出界消失、被击毁解体 */
  bomber?: boolean;
  /** 显示身高（格）。不给就是普通兵；机器巨人这种要显大 */
  heightTiles?: number;
  special?: UnitSpecial;
  /**
   * 岗位。`repair` = 议事厅派出来的工匠：谁掉血就去补谁，路上遇敌就抡一锤。
   * 不给就是普通战斗单位。
   */
  duty?: 'repair';
  /** 造一队要几秒、初始储备几个（兵营用） */
  trainSeconds: number;
  stockInitial: number;
}

const U = (def: UnitDef): UnitDef => def;

/** 所有兵种共用的动作集：待命/行进/攻击/挨打/倒下。stand 不烘，站着就是待命第一帧。 */
const COMBAT_ANIMS = (attack: AnimName, idle: AnimName): AnimName[] => [idle, 'run', attack, 'hurt', 'die'];

export const UNITS: Record<string, UnitDef> = {
  /**
   * 工匠 —— 议事厅自己的杂役，不由兵营生产。
   * 数值故意压得很低（攻 3、血 30）：它的本职是补墙，不是当兵用。
   */
  worker: U({
    id: 'worker',
    name: '工匠',
    blurb: '议事厅派出来的杂役：会补墙，也会抡锤。',
    role: 'melee',
    faction: 'own',
    duty: 'repair',
    hp: 30,
    attack: 3,
    defense: 1,
    range: 1.0,
    speed: 1.25,
    cooldown: 1.5,
    sight: 4,
    attackAnim: 'sword',
    idleAnim: 'idle',
    anims: COMBAT_ANIMS('sword', 'idle'),
    headBands: [[0, 63]],
    faceBand: [1, 60],
    trainSeconds: 0,
    stockInitial: 0,
  }),

  archer: U({
    id: 'archer',
    name: '弓箭手',
    blurb: '远程，血薄腿快。',
    role: 'ranged',
    faction: 'own',
    hp: 26,
    attack: 7,
    defense: 2,
    range: 4.2,
    speed: 1.55,
    cooldown: 1.15,
    sight: 4.6,
    attackAnim: 'bowTall',
    idleAnim: 'idleBow',
    anims: COMBAT_ANIMS('bowTall', 'idleBow'),
    projectile: 'arrow',
    // 弓手带：实测 51–62 是作者的 archers 段
    headBands: [[51, 62]],
    faceBand: [1, 40],
    trainSeconds: 11,
    stockInitial: 2,
  }),

  knight: U({
    id: 'knight',
    name: '骑士',
    blurb: '近战主力，防高。',
    role: 'melee',
    faction: 'own',
    hp: 60,
    attack: 12,
    defense: 5,
    range: 1.3,
    speed: 1.35,
    cooldown: 1.35,
    sight: 4.2,
    attackAnim: 'sword',
    idleAnim: 'idleSword',
    anims: COMBAT_ANIMS('sword', 'idleSword'),
    // 骑士带：1–33（第 0 列是空格子，取头时会过滤掉）
    headBands: [[1, 33]],
    faceBand: [1, 40],
    trainSeconds: 14,
    stockInitial: 2,
  }),

  mage: U({
    id: 'mage',
    name: '法师',
    blurb: '远程法术，伤害高、血薄。',
    role: 'ranged',
    faction: 'own',
    hp: 32,
    attack: 13,
    defense: 1,
    range: 3.9,
    speed: 1.2,
    cooldown: 1.8,
    sight: 4.6,
    attackAnim: 'cast',
    idleAnim: 'idleStaff',
    anims: ['idleStaff', 'run', 'cast', 'hurt', 'die'],
    // 法师段：实测 35–50 有画（34 那列是空的）
    headBands: [[35, 50]],
    faceBand: [1, 40],
    projectile: 'magic',
    trainSeconds: 15,
    stockInitial: 1,
  }),

  ballista: U({
    id: 'ballista',
    name: '移动弩箭',
    blurb: '专点步兵：射程长、一发重伤，但拆不了楼。',
    role: 'ranged',
    faction: 'own',
    hp: 70,
    attack: 26,
    defense: 0,
    range: 6,
    speed: 0.55,
    cooldown: 2.2,
    sight: 6.5,
    attackAnim: 'bowTall',
    idleAnim: 'idleBow',
    anims: COMBAT_ANIMS('bowTall', 'idleBow'),
    headBands: [[51, 62]],
    faceBand: [1, 40],
    projectile: 'arrow',
    trainSeconds: 20,
    stockInitial: 1,
  }),

  mech: U({
    id: 'mech',
    name: '机器巨人',
    blurb: '慢、笨重，但一拳能砸穿墙。',
    role: 'tank',
    faction: 'own',
    hp: 300,
    attack: 30,
    defense: 8,
    range: 1.5,
    speed: 0.65,
    cooldown: 2.4,
    sight: 4.8,
    attackAnim: 'staff',
    idleAnim: 'idle',
    anims: ['idle', 'run', 'staff', 'hurt', 'die'],
    // 机甲段：实测 310–332 有画（318 是空格）
    headBands: [[310, 332]],
    faceBand: [1, 40],
    heightTiles: 2.4,
    trainSeconds: 26,
    stockInitial: 1,
  }),

  orc: U({
    id: 'orc',
    name: '兽人',
    blurb: '冲撞击飞，血厚。',
    role: 'tank',
    faction: 'own',
    hp: 80,
    attack: 15,
    defense: 3,
    range: 1.3,
    speed: 1.15,
    cooldown: 1.7,
    sight: 4.4,
    attackAnim: 'shield',
    idleAnim: 'idleShield',
    anims: [...COMBAT_ANIMS('shield', 'idleShield'), 'dash', 'knocked'],
    // 角与兽面：64–71 实测是成对分叉的角，128–149 是怪物段
    headBands: [[64, 71], [128, 149]],
    faceBand: [1, 30],
    special: { kind: 'charge', every: 6, knockTiles: 1.5, stunSeconds: 0.6, dashTiles: 2.2 },
    trainSeconds: 17,
    stockInitial: 2,
  }),

  /**
   * 兽人投矛手（2026-11-09 用户："兽人大军里面为什么没有远程单位啊？
   * 有远程兽人投矛手呀，缺防空"）。
   * 兽人阵营唯一的远程 + 唯一能拦空军的兵，和近战 orc 混编进「兽人 / 兽人大队」。
   * 投矛走 arrow 弹道（飞行弹道同一套），头/脸沿用兽人段，外观仍是兽人。
   */
  orcThrower: U({
    id: 'orcThrower',
    name: '兽人投矛手',
    blurb: '兽人阵营唯一的远程，投矛能拦空军。',
    role: 'ranged',
    faction: 'own',
    hp: 42,
    attack: 11,
    defense: 2,
    range: 4.4,
    speed: 1.15,
    cooldown: 1.45,
    sight: 5,
    attackAnim: 'bowTall',
    idleAnim: 'idleBow',
    anims: COMBAT_ANIMS('bowTall', 'idleBow'),
    projectile: 'arrow',
    headBands: [[64, 71], [128, 149]],
    faceBand: [1, 30],
    trainSeconds: 15,
    stockInitial: 2,
  }),

  priest: U({
    id: 'priest',
    name: '牧师',
    blurb: '奶附近血少的。',
    role: 'healer',
    faction: 'own',
    hp: 30,
    attack: 3,
    defense: 1,
    range: 2.4,
    speed: 1.3,
    cooldown: 2.5,
    sight: 3.6,
    attackAnim: 'heal',
    idleAnim: 'idleStaff',
    anims: [...COMBAT_ANIMS('heal', 'idleStaff'), 'cast'],
    // 尖顶高帽带（35–39 实测是尖顶）+ 头巾段
    headBands: [[35, 39], [241, 248]],
    faceBand: [1, 26],
    special: { kind: 'heal', every: 2.5, amount: 6, radius: 3 },
    trainSeconds: 20,
    stockInitial: 1,
  }),

  // ---------------------------------------------------------------- 敌方

  raider: U({
    id: 'raider',
    name: '劫掠兽人',
    blurb: '第一波，拆楼快。',
    role: 'melee',
    faction: 'enemy',
    hp: 40,
    attack: 4,
    defense: 2,
    range: 1.3,
    speed: 1.05,
    cooldown: 1.6,
    sight: 5,
    attackAnim: 'shield',
    idleAnim: 'idle',
    anims: ['idle', 'run', 'shield', 'hurt', 'die'],
    headBands: [[64, 71], [128, 149]],
    faceBand: [1, 60],
    trainSeconds: 0,
    stockInitial: 0,
  }),

  golem: U({
    id: 'golem',
    name: '石怪',
    blurb: '硬慢坦克。',
    role: 'tank',
    faction: 'enemy',
    hp: 120,
    attack: 8,
    defense: 6,
    range: 1.3,
    speed: 0.85,
    cooldown: 2.1,
    sight: 5,
    attackAnim: 'staff',
    idleAnim: 'idle',
    anims: ['idle', 'run', 'staff', 'hurt', 'die'],
    headBands: [[319, 332], [164, 199]],
    faceBand: [60, 102],
    heightTiles: 1.9,
    trainSeconds: 0,
    stockInitial: 0,
  }),

  shade: U({
    id: 'shade',
    name: '暗影弓手',
    blurb: '敌方远程。',
    role: 'ranged',
    faction: 'enemy',
    hp: 24,
    attack: 5,
    defense: 1,
    range: 4.0,
    speed: 1.4,
    cooldown: 1.25,
    sight: 4.8,
    attackAnim: 'bowShort',
    idleAnim: 'idle',
    anims: ['idle', 'run', 'bowShort', 'hurt', 'die'],
    projectile: 'arrow',
    headBands: [[211, 239], [306, 317]],
    faceBand: [40, 102],
    trainSeconds: 0,
    stockInitial: 0,
  }),

  // ---------------------------------------------------------------- 2026-11-07 四张新军队卡（平衡见设计文档 B 节）
  /** 民兵集结专用：攻防都低、人多炮灰（2026-11-07 设计文档 B 节） */
  militia: U({
    id: 'militia',
    name: '民兵',
    blurb: '临时召集：便宜、脆、靠人数。',
    role: 'melee',
    faction: 'own',
    hp: 22,
    attack: 5,
    defense: 0,
    range: 1.2,
    speed: 1.5,
    cooldown: 1.1,
    sight: 4.2,
    attackAnim: 'sword',
    idleAnim: 'idleSword',
    anims: COMBAT_ANIMS('sword', 'idleSword'),
    headBands: [[1, 33]],
    faceBand: [1, 40],
    trainSeconds: 0,
    stockInitial: 0,
  }),

  spearman: U({
    id: 'spearman',
    name: '长矛兵',
    blurb: '便宜近战，人多血薄。',
    role: 'melee',
    faction: 'own',
    hp: 40,
    attack: 9,
    defense: 3,
    range: 1.6,
    speed: 1.45,
    cooldown: 1.0,
    sight: 4.2,
    attackAnim: 'sword',
    idleAnim: 'idleSword',
    anims: COMBAT_ANIMS('sword', 'idleSword'),
    headBands: [[1, 33]],
    faceBand: [1, 40],
    trainSeconds: 12,
    stockInitial: 2,
  }),

  crossbowman: U({
    id: 'crossbowman',
    name: '弩手',
    blurb: '射程更远，装填更慢。',
    role: 'ranged',
    faction: 'own',
    hp: 30,
    attack: 9,
    defense: 1,
    range: 5.2,
    speed: 1.25,
    cooldown: 1.3,
    sight: 5.2,
    attackAnim: 'bowTall',
    idleAnim: 'idleBow',
    anims: COMBAT_ANIMS('bowTall', 'idleBow'),
    projectile: 'arrow',
    headBands: [[51, 62]],
    faceBand: [1, 40],
    trainSeconds: 13,
    stockInitial: 2,
  }),

  shieldbearer: U({
    id: 'shieldbearer',
    name: '盾卫',
    blurb: '高血肉盾，输出低。',
    role: 'tank',
    faction: 'own',
    hp: 95,
    attack: 7,
    defense: 9,
    range: 1.3,
    speed: 0.95,
    cooldown: 1.3,
    sight: 4.2,
    attackAnim: 'shield',
    idleAnim: 'idle',
    anims: ['idle', 'run', 'shield', 'hurt', 'die'],
    headBands: [[1, 33]],
    faceBand: [1, 40],
    trainSeconds: 18,
    stockInitial: 1,
  }),

  balloon: U({
    id: 'balloon',
    name: '热气球',
    blurb: '悬浮投弹：越过建筑与黄区，从空中丢炸弹。',
    role: 'ranged',
    faction: 'own',
    hp: 90,
    attack: 16,
    defense: 3,
    range: 4.0,
    speed: 0.9,
    cooldown: 1.8,
    sight: 6.0,
    attackAnim: 'cast',
    idleAnim: 'idleStaff',
    anims: COMBAT_ANIMS('cast', 'idleStaff'),
    projectile: 'cannon',
    flying: true,
    heightTiles: 1.6,
    headBands: [[1, 33]],
    faceBand: [1, 40],
    trainSeconds: 0,
    stockInitial: 0,
  }),

  /** 第一份 HTML：达芬奇空气螺旋机（尖锥座舱 + 旋转螺旋帆）——快速掠袭 */
  airscrew: U({
    id: 'airscrew',
    name: '空气螺旋机',
    blurb: '飞行掠袭：螺旋帆推动，贴脸敲人。',
    role: 'melee',
    faction: 'own',
    hp: 70,
    attack: 12,
    defense: 2,
    range: 1.8,
    speed: 1.6,
    cooldown: 1.2,
    sight: 5.0,
    attackAnim: 'sword',
    idleAnim: 'idleSword',
    anims: COMBAT_ANIMS('sword', 'idleSword'),
    flying: true,
    heightTiles: 1.6,
    headBands: [[1, 33]],
    faceBand: [1, 40],
    trainSeconds: 0,
    stockInitial: 0,
  }),

  /** 第二份 HTML：达芬奇机械扑翼机（开放座舱）——一次性轰炸机，逻辑见 E 节 */
  bomber: U({
    id: 'bomber',
    name: '扑翼轰炸机',
    blurb: '一次性冲刺：直扑敌方，下方有敌军就投弹，飞出地图即消失。',
    role: 'ranged',
    faction: 'own',
    hp: 80,
    attack: 0,
    defense: 2,
    range: 0,
    speed: 1.45,
    cooldown: 1.4,
    sight: 0,
    attackAnim: 'cast',
    idleAnim: 'idleStaff',
    anims: COMBAT_ANIMS('cast', 'idleStaff'),
    flying: true,
    bomber: true,
    heightTiles: 1.6,
    headBands: [[1, 33]],
    faceBand: [1, 40],
    trainSeconds: 0,
    stockInitial: 0,
  }),
};

export const unitList = (): UnitDef[] => Object.values(UNITS);

export function unitDef(id: string): UnitDef {
  const u = UNITS[id];
  if (!u) throw new Error(`未知兵种 "${id}"`);
  return u;
}

/** 伤害公式，只此一处：锁在 tests/combat.test.ts 里。 */
export function damageOf(attack: number, defense: number): number {
  return Math.max(1, attack - defense);
}

/** 给 UI 用的一句数值摘要。 */
export function unitStatLine(u: UnitDef): string {
  const parts = [`血${u.hp}`, `攻${u.attack}`, `防${u.defense}`];
  if (u.role === 'ranged') parts.push(`射程${u.range}`);
  if (u.special?.kind === 'charge') parts.push(`冲撞${u.special.every}s`);
  if (u.special?.kind === 'heal') parts.push(`回血${u.special.amount}`);
  return parts.join(' · ');
}
