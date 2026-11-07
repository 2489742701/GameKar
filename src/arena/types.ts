/**
 * 对战模式的全部**数据结构**（没有逻辑）。
 *
 * 为什么单独一个文件：`ArenaWorld.ts` 原来 1221 行里，前 180 行全是 interface/type，
 * 读代码时要在"结构定义"和"每帧规则"之间来回滚。
 * 现在这里只放"世界长什么样"，`ArenaWorld.ts` 只放"世界怎么动"。
 *
 * 这些类型对外仍然从 `./ArenaWorld` 拿（那边有一行 re-export），
 * 所以 `ArenaApp` / `damage.ts` / `visuals/labels.ts` 的 import 一行都不用改 ——
 * **定义只有这一份**，转发只是为了不把 import 路径散到十几个文件里。
 */

import { BALLISTA, MOBILE, type ArenaCard, type BuildingKind, type FieldSpec, type Side } from './config';
import { unitDef } from '@game/data/units';

export type { Side };

/**
 * **一个玩家的家当**（2026-11-07 抽出来给 PVE 多人用）。
 *
 * 以前这些东西是 `Record<Side, …>` —— 一个阵营只能有一个操作者。
 * 但 PVE 的"多人打"是**合作守家**：两个玩家都在 blue 一侧，
 * 各有一份金币和手牌（建筑/单位靠 `owner` 认人），
 * 所以状态必须按"玩家"索引，而不是按"阵营"。
 *
 * 1v1 的映射：players[0] = blue（人）、players[1] = red（AI）——
 * 对打的手感一个字节都不变。
 */
export interface PlayerSlot {
  /** 玩家序号（0 起）。同阵营两人时靠它区分 */
  readonly id: number;
  readonly side: Side;
  gold: number;
  /** 距下一格金还差几秒（每条金线各自计时） */
  goldTick: number;
  /** 手牌 4 格（null = 冷却中） */
  hand: (ArenaCard | null)[];
  /** 每格的补牌倒计时 */
  cooldowns: number[];
  /** 每格"刚打出去的那张"（补牌时排除，防止原样发回） */
  lastPlayed: (string | null)[];
  /** 托管（AI 代打）。红方恒 true；蓝方默认 false */
  auto: boolean;
  /** 下次"想一想"倒计时 */
  aiIn: number;
  /** AI 两次刷新之间的冷却（秒） */
  aiRerollIn: number;
}

/**
 * 打建筑的是哪种伤害 —— 只用来决定"墙怎么崩"：
 * 刀砍/箭射是正常掉一块；炮弹是**炸散开**（板子飞得更远、转得更野）。
 */
export type HitKind = 'blade' | 'arrow' | 'cannon' | 'magic';

export interface ArenaBuilding {
  id: number;
  side: Side;
  /** 'core' = 大本营（术语按用户 2026-11-01 的纠正） */
  kind: BuildingKind | 'core';
  col: number;
  row: number;
  cols: number;
  rows: number;
  hp: number;
  maxHp: number;
  /**
   * 施工进度 0 → 1（1 = 完工）。
   *
   * 2026-11-02 用户："这个建筑建起来是要时间的……有几个脚手架，建筑慢慢升起来，
   * 那个墙壁就慢慢地凭空垒上来了。"
   * **施工中的楼不干活**：塔不开火、兵营不出兵、磨坊不生金 —— 和"缺后勤"同一条口径。
   * 视图拿它决定脚手架与墙体露出的高度，逻辑层只认"到没到 1"。
   */
  build: number;
  /** 兵营/磨坊的节拍计时 */
  timer: number;
  /** 塔的下一发 */
  fireIn: number;
  /** 兵营的出兵点（旗）。null = 用默认位置 */
  flag: { col: number; row: number } | null;
  /**
   * 塔口朝向（弧度，绕 y 轴）与最近一次开火的方向。
   * 这两个字段**只给视图用**：伤害在开火那一刻就结算了，弹丸纯属装饰。
   */
  aim: number;
  shotsMuzzle: number;
  /** 最近一次挨的是什么伤害（视图拿它决定墙板怎么崩，逻辑层不看） */
  lastHit: HitKind;
  /**
   * **最后一次挨打的世界时刻**（秒）。脱战计时（`REPAIR.idleSeconds`）和
   * "挨打就中断修复"都读它 —— 不放在视图层，否则动画和判据会各算一套时间。
   */
  lastHitAt: number;
  /**
   * 剩余修复时长（秒）；0 = 没在修。
   * 视图的锤子动画只在 `repairLeft > 0` 时播，**不自己设 setTimeout**。
   */
  repairLeft: number;
}

export interface UnitStats {
  hp: number;
  speed: number;
  range: number;
  damage: number;
  cooldown: number;
  sight: number;
  defense: number;
  /** 只打建筑（移动火炮就是这么白嫖塔的） */
  buildingsOnly: boolean;
  /** 只打兵（移动弩箭：专克步兵，拆不了楼） */
  unitsOnly: boolean;
  /** 画成"推车 + 小人" */
  siege: boolean;
}

/** 一个兵种的口径。兵走 UNITS 表，移动火炮 / 弩车走 config 里的 MOBILE / BALLISTA —— 判据只在这里分一次。 */
export function statsOf(defId: string): UnitStats {
  if (defId === 'mobileCannon') {
    return {
      hp: MOBILE.hp,
      speed: MOBILE.speed,
      range: MOBILE.range,
      damage: MOBILE.damage,
      cooldown: MOBILE.cooldown,
      sight: MOBILE.sight,
      defense: 0,
      // 用户 2026-10-27 修正：它也要能打兵（"移动火炮不攻击军队"）
      buildingsOnly: false,
      unitsOnly: false,
      siege: true,
    };
  }
  if (defId === 'ballista') {
    return {
      hp: BALLISTA.hp,
      speed: BALLISTA.speed,
      range: BALLISTA.range,
      damage: BALLISTA.damage,
      cooldown: BALLISTA.cooldown,
      sight: BALLISTA.sight,
      defense: 0,
      buildingsOnly: false,
      unitsOnly: true,
      siege: true,
    };
  }
  const d = unitDef(defId);
  return {
    hp: d.hp,
    speed: d.speed,
    range: d.range,
    damage: d.attack,
    cooldown: d.cooldown,
    sight: d.sight,
    defense: d.defense,
    buildingsOnly: false,
    unitsOnly: false,
    siege: false,
  };
}

export interface ArenaUnit {
  id: number;
  side: Side;
  defId: string;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  cooldown: number;
  stun: number;
  /** 玩家下达的移动目标（世界坐标）。null = 自己朝对面大本营推进 */
  order: { x: number; z: number } | null;
  /** 绕障方向：撞墙时先往这一侧偏（±1）。固定住就不会在墙角左右抖 */
  detour?: 1 | -1;
  /** 牧师的下一次回血倒计时（只有治疗兵种有） */
  healIn?: number;
  /** 扑翼轰炸机的下一次投弹倒计时（只有 bomber 有） */
  bombIn?: number;
  /** 这个兵实际吃几份面包（默认 1；民兵 0.5、兽人 2） */
  breadCost?: number;
  /**
   * 这个兵占几格人口（默认 1；兵营自动兵 / 民兵 / 兽人 = 0）。
   * 2026-11-07 与 `armySupplyOf()` 同一套判据，卡面 SVG 也读它。
   */
  popCost?: number;
  /**
   * 当前朝向（弧度，世界坐标 +x=0）。2026-11-06 用户："移动弩车/炮没把头对准敌人"、
   * "两个军队背对背开打" —— 旧视图只拿**位移方向**当朝向，站着开火时位移为 0，
   * 朝向永远停在行军方向。现在逻辑层在**锁敌时对准目标、行军时朝行进方向**，
   * 视图（普通小人的 flipX / 弩车火炮的 rotation.y）一律读这里。
   */
  aim?: number;
  /**
   * 是不是兵营自动出的兵（2026-11-06 用户："兵营里面出的兵不占人口"）。
   *
   * true ⇒ **不占人口**（兵营是建筑，人口名额已经被楼本身占过了；
   * 卡牌出的兵仍然各占 1 人口 —— 容器限制管的是"玩家一次放多少兵"）。
   * 面包照吃：不占人口 ≠ 白吃饭，磨坊依然是出多少兵的真闸门。
   */
  fromBarracks?: boolean;
}

/** 一发"看得见的"弹丸。伤害已结算，这里只是让玩家看到"从塔顶飞过去"的那一下。 */
export interface ArenaShot {
  id: number;
  ammo: 'arrow' | 'cannon' | 'magic';
  /** 谁打出来的：视图拿它决定炮口高度与弹丸样子（箭塔顶 / 炮塔台 / 车头 / 兵的手上 / 大本营水晶顶） */
  source: 'arrowTower' | 'cannonTower' | 'siege' | 'ballista' | 'unit' | 'core';
  /**
   * 被打目标的单位 id（打建筑时不填）——**渲染器**在弹丸命中帧给这个小人来一下
   * 闪白（2026-11-06 用户："小人被攻击的时候明显的变白一下"）。
   * 远程伤害是开火瞬间结算的，闪白不挂 hurtUnit，挂弹丸命中帧才不穿帮。
   */
  targetId?: number;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  /** 0..1 飞行进度 */
  t: number;
  seconds: number;
}

export interface ArenaRuin {
  id: number;
  kind: string;
  side: Side;
  col: number;
  row: number;
  cols: number;
  rows: number;
  /** 还剩几秒（到 0 就从名单里消失） */
  ttl: number;
  total: number;
}

/**
 * 一局的结果。
 *
 * `draw` 是 2026-10-31 加的：时间到之后双方大本营血量、被拆的楼数都一样时才成立
 * （以前只有 win/lose，那时"同时被拆"会被判成赢 —— 先判红方那一条兜住了）。
 */
export type Outcome = 'playing' | 'win' | 'lose' | 'draw';

/**
 * 怎么结束的：
 * - `core` 大本营被拆；
 * - `time` 常规时间到比判据 / `overtime` 加时打满比判据 / `draw` 加时打平（**1v1 专用**）；
 * - `waves` PVE 守住全部波次（2026-11-07 加）。
 */
export type OutcomeReason = 'core' | 'time' | 'overtime' | 'draw' | 'waves' | null;

export interface PlayResult {
  ok: boolean;
  /** 失败原因，直接给 HUD 显示 */
  reason?: string;
}

export interface ArenaOptions {
  seed?: number;
  /**
   * 玩法模式（2026-11-07）：`'arena'` 是对战（默认），`'pve'` 是守波次。
   *
   * PVE 只换三件事：**场地**（`PVE_FIELD`）、**出怪方式**（波次表替代 AI 出牌）、
   * **判据**（守完全部波次 / 大本营被打穿）。数值、后勤、碰撞、科技一行不动。
   */
  mode?: 'arena' | 'pve';
  /** PVE 的玩家人数（1 或 2）。两人时都在 blue 一侧合作守家 */
  players?: number;
  /** PVE 的关卡 id（不给就用第一关；场地尺寸也跟着关卡走） */
  level?: string;
  /** 开局手牌（测试用；不给就按 seed 随机发 4 张） */
  hand?: string[];
  /**
   * 托管开关：**哪几边由 AI 代打**。
   * 红方默认开（它本来就是 AI）；蓝方默认关（那是玩家的位置）。
   * 自动化测试要跑完整局时把蓝方也打开 —— 否则蓝方全程挂机，60 秒必输，
   * 测出来的只是"没人操作会怎样"，不是这局游戏本身。
   */
  auto?: Partial<Record<Side, boolean>>;
  /**
   * 场地尺寸（2026-11-07）：不给就用 1v1 的 `FIELD`。
   * PVE 传 `PVE_FIELD` —— 世界、地面、看台、彩带全都跟着这个数建。
   */
  field?: FieldSpec;
}
