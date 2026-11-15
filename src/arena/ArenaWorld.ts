/**
 * 对战模式的世界状态 —— **纯逻辑**，不 import three、不碰 DOM。
 *
 * 所以一局能在 node 里跑完（tests/arena.test.ts 就是这么验的）：
 * 金币、手牌、建筑节拍、兵的前进与互殴、AI、胜负，全在这里。
 *
 * 三条规则写死在这里，别处不许再判一遍：
 * 1. **建筑没有寿命**：不会自己掉血、不会定时消失，只有被打掉。
 * 2. **兵只能放在自己半场**；建筑同理（防止一开局就往对面脸上丢兵营）。
 * 3. **一局有两条出路**：拆掉对方大本营，或者 3 分钟到点比大本营剩血（再比楼数）。
 *    兵死光了不算输 —— 没有兵只是推不动，不是失败。
 */

import { Random } from '@engine/math/Random';
import { damageOf, unitDef } from '@game/data/units';
import {
  AI,
  BARRACKS,
  BOMBER,
  TECH,
  BUILD,
  BUILDING_DAMAGE_SCALE,
  BUILDING_SPECS,
  CARDS,
  CORE,
  ECONOMY,
  NO_BUILD,
  ORC_LAIR,
  FIELD,
  HAND,
  LOGISTICS,
  MATCH,
  REPAIR,
  REROLL,
  RUIN,
  SPELL,
  SPELL_FORGE,
  SUPPLY,
  TOWER,
  UNIT,
  armySupplyOf,
  cardWeightOf,
  BUILDING_LABEL,
  buildingLabelOf,
  buildingPopOf,
  goldIncomeOf,
  needsHouse,
  canHitAir,
  cardById,
  type ArenaCard,
  type BuildingKind,
  type FieldSpec,
} from './config';

// 结构与'世界长什么样'在 ./types（这边只留 re-export，免得十几个文件的 import 全改）
import { statsOf } from './types';
import { decide, placementBand, type AiView } from './ai';
import { PVE_LEVELS, pveLevel, type PveLevel } from './pve/levels';
import type { Wave } from './pve/waves';
import type { GridPos } from '@engine/math/Grid';
import { cellToWorld, pos } from '@engine/math/Grid';
import type {
  ArenaBuilding,
  ArenaOptions,
  ArenaRuin,
  ArenaShot,
  ArenaUnit,
  BattleLedger,
  DestroyRecord,
  HitKind,
  LedgerCriterion,
  LedgerDecider,
  LedgerWreck,
  Outcome,
  OutcomeReason,
  PlayResult,
  PlayerSlot,
  Side,
  SideLedger,
} from './types';

export type {
  ArenaBuilding,
  ArenaOptions,
  ArenaRuin,
  ArenaShot,
  ArenaUnit,
  BattleLedger,
  DestroyRecord,
  HitKind,
  LedgerCriterion,
  LedgerDecider,
  LedgerWreck,
  Outcome,
  OutcomeReason,
  PlayResult,
  PlayerSlot,
  Side,
  SideLedger,
  UnitStats,
} from './types';
export { statsOf } from './types';

/**
 * **人口三分 + 面包容器**的读数（P-094，2026-11-09）。
 *
 * 这是 `ArenaWorld.supplyOf()` 的唯一返回形状，HUD 顶栏、结算账单、
 * 落牌校验、AI 的 `SupplyView` 全读它，谁也不许自己再算一遍人口。
 *
 * `pop` / `popMax` 是**兼容旧代码**的两个别名：`pop = used + debt`、
 * `popMax = total`。它们现在叫「总占用 / 全部人口」，不再等于"活兵实时占用"。
 * 新代码请直接读 `idle / used / total` 这三个语义明确的字段。
 */
export interface SupplyReadout {
  /** 能立刻拿来盖楼 / 出兵的人口，会按 SUPPLY.idleRegenSeconds 一格一格回升 */
  idle: number;
  /** 场上所有建筑物占用的人口：被卡死，拆楼才释放，绝不随时间自己回 */
  used: number;
  /** 全部人口上限 = basePop + 民居 × housePop */
  total: number;
  /** 军队卡借走、还没还的那笔（整数格，按 idleRegenSeconds 跳着销账） */
  debt: number;
  /** 兼容旧字段：总占用 = used + debt */
  pop: number;
  /** 兼容旧字段：= total */
  popMax: number;
  /** 面包仍是容器：活着的兵实时吃，兵死立刻退 */
  bread: number;
  breadMax: number;
}

/**
 * 造一个玩家槽（1v1 两人 / PVE 一人或两人）。
 *
 * 只在这里给初值：**金币起点、手牌格数、AI 计时**都读 config，
 * 以后调配额不用满世界找字面量。
 */
function makePlayer(id: number, side: Side, auto: boolean): PlayerSlot {
  return {
    id,
    side,
    gold: ECONOMY.start,
    goldTick: 0,
    hand: new Array<ArenaCard | null>(HAND.size).fill(null),
    cooldowns: new Array<number>(HAND.size).fill(0),
    lastPlayed: new Array<string | null>(HAND.size).fill(null),
    auto,
    aiIn: AI.thinkSeconds,
    aiRerollIn: 0,
  };
}

/**
 * 把一个"按阵营读写的普通对象"接到玩家槽上。
 *
 * 为什么需要：`world.gold.blue = 20` 这种写法在测试里出现 40 多次（给钱造场景）。
 * 玩家槽化之后如果换成只读快照，这些写入会**静默丢失**（测试会红一片，而且原因很难看出来）。
 * 用 defineProperty 做成 getter/setter 桥，读写都真正落到 `players` 上 ——
 * 老代码和老测试一行不用改，语义仍然是"这个阵营主玩家的那一份"。
 */
function sideBridge<T>(
  get: (s: Side) => T,
  set: (s: Side, v: T) => void,
): Record<Side, T> {
  const view = {} as Record<Side, T>;
  for (const s of ['blue', 'red'] as Side[]) {
    Object.defineProperty(view, s, {
      get: () => get(s),
      set: (v: T) => set(s, v),
      enumerable: true,
      configurable: true,
    });
  }
  return view;
}

/**
 * PVE 的波次进度（只读给 HUD 用，写只有 `tickWaves` 一处）。
 *
 * `countdown` 是**距下一波**的秒数；全部波次放完之后是 `Infinity`（HUD 写"最后一波"）。
 */
export interface PveState {
  level: PveLevel;
  /** 下一波是第几波（0 起） */
  next: number;
  countdown: number;
  /** 已经放出去多少怪 */
  spawned: number;
  /** 已经清掉多少怪（死在界面上的 + 飞出地图的） */
  slain: number;
}

/**
 * 纯逻辑世界 —— 不 import three，所以**服务器可以直接跑这一份**（未来联机的前提）。
 *
 * 当前实现的是「竞技场 1v1」。给后面两种模式留的扩展点（**只是留，没有开工**）：
 * - **单人 PVE**：`tickAi` 换成按波次表出怪；`checkOutcome` 换成"守 N 波 / 大本营血量"；
 *   手牌、建筑产能、人口面包容器都不用改。
 * - **多人 PVE**：`hands` 已经是按 side 分开的，加第三个玩家槽即可；
 *   但 `side` 目前只有 blue/red，PVE 的怪需要引入中立阵营，这一步要单独设计。
 *
 * 详见 `docs/工作笔记/产品路线图_20261106.md`。
 */
export class ArenaWorld {
  readonly seed: number;
  readonly rng: Random;
  /**
   * 这块场地的尺寸（2026-11-07 参数化）。
   *
   * 1v1 永远是 `FIELD`（44×20）；PVE 传 `PVE_FIELD`（56×36，"场地贼拉大"）。
   * 逻辑层所有越界判定、半场归属、禁建带、随机落点都读这里，
   * **不再有第二处写死尺寸的地方** —— 视图也读 `world.fieldSize`。
   */
  readonly field: FieldSpec;
  /**
   * 玩法模式：`arena` 对战（默认，3 分钟 + 加时）、`pve` 守波次、
   * `endless` **1v1 无尽**（同一张 1v1 图、同一个 AI，只是没有时限）。
   */
  readonly mode: 'arena' | 'pve' | 'endless';
  /**
   * PVE 的波次进度（`mode === 'arena'` 时是 null）。
   *
   * 为什么记在这里而不是单独一个 `PveWorld` 类：PVE 与 1v1 的差别只有
   * **场地 / 出怪方式 / 判据**这三处，产能、后勤、碰撞、科技、拆楼全都一样。
   * 拆成两个类就得把那一千多行复制一份，然后两边慢慢长歪 —— 那才是真返工。
   */
  pve: PveState | null = null;

  /**
   * **玩家槽**（2026-11-07 抽出来给 PVE 多人用）。
   *
   * 以前金币 / 手牌 / 托管都是 `Record<Side, …>` —— 一个阵营只能有一个操作者。
   * PVE 的"多人打"是**合作守家**：两个玩家都在 blue 一侧，各有一份金币和手牌
   * （建筑与单位靠 `owner` 认人），所以状态必须按"玩家"索引，而不是按"阵营"。
   *
   * - 1v1：`[blue 玩家, red AI]` —— 对打，手感不变；
   * - PVE 单人：`[blue 玩家]`；
   * - PVE 双人：`[blue 玩家0, blue 玩家1]` —— 两人共守一条线。
   *
   * 于是"联机再来一个远端玩家"只是往这个数组里多推一个槽，
   * 规则层（产能 / 后勤 / 出牌 / 判据）一行都不用改。
   */
  readonly players: PlayerSlot[] = [];

  readonly buildings = new Map<number, ArenaBuilding>();
  units: ArenaUnit[] = [];
  /** 在飞的弹丸（纯视觉，不参与结算） */
  shots: ArenaShot[] = [];
  /**
   * **法术施放的视觉事件**（P-103，纯装饰，到点自己消失）。
   *
   * 为什么放在世界层而不是让视图自己判：命中判定需要**半径内的目标清单**，
   * 那是逻辑层才知道的事。所以逻辑层算完就把"打了哪、多大圈、命中几个"报出来，
   * 视图只负责画（和 `hits` / `heals` 同一条约定）。
   */
  readonly spellCasts: {
    id: number;
    side: Side;
    spell: string;
    col: number;
    row: number;
    /** 落点世界坐标（视图直接用，不用再换算一次） */
    x: number;
    z: number;
    radius: number;
    hitUnits: number;
    hitBuildings: number;
    t: number;
    seconds: number;
  }[] = [];
  /** 法术事件的自增 id（和 shots / hits 各自的 id 空间分开，互不干扰） */
  private spellCastId = 1;
  /** 回血的视觉事件（纯装饰，到点自己消失） */
  heals: { id: number; x: number; z: number; ttl: number }[] = [];
  /**
   * **近战命中**的视觉事件（2026-11-05 用户："近战和远程都要有不同的粒子放射"）。
   *
   * 只上报近战：远程有弹丸，视图在弹丸飞到目标那一刻自己放 `impact`，
   * 这里再报一次就是双重特效（炮弹落地会炸两次）。
   */
  hits: { id: number; x: number; z: number; y: number; dirX: number; dirZ: number; heavy: boolean; ttl: number; /** 被打目标单位 id（渲染器闪白用） */ unitId?: number }[] = [];
  /** 飞出地图消失的单位（视图据此跳过解体特效；只增不减，一局最多几十条） */
  readonly leftField = new Set<number>();
  /** 废墟：被拆掉的楼在原地留一堆碎石，RUIN.seconds 之后塌平 */
  ruins: ArenaRuin[] = [];
  /**
   * 累计**被拆掉**的楼数（键是"谁被拆"）。
   * 时间到之后拿它判高低：我拆掉对方的楼多于对方拆掉我的，就是我压住了对方 ——
   * 这是"攻防围绕建筑的消耗"这条设计的记分牌，不是"谁盖得多"。
   */
  readonly destroyed: Record<Side, number> = { blue: 0, red: 0 };

  /**
   * **拆楼明细**（P-094）：结算账单的数据源。只在 `hurtBuilding()` 里 push，
   * 一局最多几十条；对局中 HUD 不读它，所以正常帧零开销。
   * `owner` 是谁被拆、`by` 是谁动的手，别搞反 —— 账单左右两栏靠它分。
   */
  readonly destroyLog: DestroyRecord[] = [];

  /**
   * **军队人口债务**（P-094，见 config.SUPPLY 的三分口径）。
   *
   * 出一张军队卡就从「闲置人口」里借走 `人数 × popPerMan`，之后按
   * `SUPPLY.idleRegenSeconds` 每格一次地归还，直到还清。
   * **兵死了不销账**：用户要的是「放置一个军队之后，闲置人口会慢慢增长」，
   * 兵在不在场都一样慢慢回；面包才是兵死立刻退（容器）。
   *
   * 建筑占用**不走这里**：那部分是 `used`，只由场上建筑实时算、被卡死。
   * 把债务单独存一个数的好处是盖楼/拆楼/盖民居都不用手写同步 ——
   * `total` 和 `used` 每次从建筑表重算，闲置自动跟着变。
   */
  private readonly popDebt: Record<Side, number> = { blue: 0, red: 0 };
  /** 距下一格人口归还还差几秒（和金币的 `goldTick` 同一套跳格写法）。 */
  private readonly popDebtTick: Record<Side, number> = { blue: 0, red: 0 };

  /** 结算时到底停在第几级判据（`finish()` 写入，账单不许事后重算）。 */
  private ledgerDecider: LedgerDecider = null;
  /** 结算账单只算一次：`summary()` 是 20Hz 的读数出口，别每帧重建数组。 */
  private cachedLedger: BattleLedger | null = null;

  outcome: Outcome = 'playing';
  /** 怎么结束的（HUD 拿它写结算面板的第二行） */
  outcomeReason: OutcomeReason = null;
  /** 开打到现在多少秒（含加时期；原来记了没人读，现在是倒计时的唯一真相） */
  elapsed = 0;

  private nextId = 1;

  constructor(options: ArenaOptions = {}) {
    this.seed = options.seed ?? 1;
    this.rng = new Random(this.seed);
    this.mode = options.mode ?? 'arena';

    // PVE 的场地跟着关卡走（"场地贼拉大"就写在关卡表里，不写死在这里）
    const level = this.mode === 'pve' ? pveLevel(options.level ?? PVE_LEVELS[0]!.id) : null;
    this.field = options.field ?? level?.field ?? FIELD;
    if (level) {
      this.pve = { level, next: 0, countdown: level.waves[0]?.at ?? Infinity, spawned: 0, slain: 0 };
    }

    // ---- 玩家槽（口径见 players 字段注释）
    this.players.push(makePlayer(0, 'blue', false));
    if (this.mode === 'pve') {
      // PVE 的怪是 red，不占玩家槽；第二个槽是**同阵营的第二个玩家**
      if ((options.players ?? 1) >= 2) this.players.push(makePlayer(1, 'blue', false));
    } else {
      this.players.push(makePlayer(1, 'red', true));
    }
    /**
     * 托管开关要落到**这个阵营的每一个玩家**上（2026-11-07 双人同屏）。
     *
     * 原来写的是 `this.playerOf('blue').auto = ...` —— `playerOf` 只返回 0 号槽，
     * 于是双人局里 **玩家 1 永远不是托管**：它拿着满格金币、四张手牌一动不动。
     * 表现是"双人比单人还难"（5/12 vs 8/12），因为实际上只有一个人在守。
     * 这和 `update()` 的涨金遍历、`tickAi()` 的驱动遍历是同一类漏，改一处要一起看。
     */
    if (options.auto?.blue !== undefined) {
      for (const p of this.playersOf('blue')) p.auto = options.auto.blue;
    }
    if (options.auto?.red !== undefined) {
      for (const p of this.playersOf('red')) p.auto = options.auto.red;
    }

    const midRow = Math.floor((this.field.rows - CORE.rows) / 2);
    // 横版：蓝在左端、红在右端，各留一格边
    this.place('blue', 'core', 1, midRow, CORE.hp);
    // PVE 没有对面的家：怪的终点是 blue 大本营，不是"拆掉红方水晶"
    if (this.mode !== 'pve') this.place('red', 'core', this.field.cols - CORE.cols - 1, midRow, CORE.hp);

    const fixed = options.hand ?? [];
    for (const p of this.players) {
      for (let i = 0; i < HAND.size; i++) {
        // 开局手牌只固定蓝方玩家 0 那一副（测试用）；其它槽照常随机
        p.hand[i] = p.side === 'blue' && p.id === 0 && fixed[i] ? cardById(fixed[i]!) : this.draw(p.side);
      }
    }
  }

  /** 这个阵营的**主玩家**（1v1 恒定一个；PVE 双人取第一个）。手牌/金币的默认落点。 */
  playerOf(side: Side): PlayerSlot {
    for (const p of this.players) if (p.side === side) return p;
    // PVE 里 red 没有玩家槽（它是怪），落到第一个人类玩家，避免 undefined 炸穿调用方
    return this.players[0]!;
  }

  /** 这个阵营的**全部玩家**（PVE 双人是 2 个）—— HUD 按它渲染两副手牌。 */
  playersOf(side: Side): PlayerSlot[] {
    return this.players.filter((p) => p.side === side);
  }

  /** 这个玩家槽还归不归人类操作（不是 AI、也不是波次怪）。 */
  isHuman(p: PlayerSlot): boolean {
    return p.side === 'blue' && !p.auto;
  }

  /**
   * **要显示座位的玩家**（= HUD 该渲染几套手牌的那几个槽）。
   *
   * 只看玩家阵营，不看 `players.length` —— 那是个坑（2026-11-07 实机踩到）：
   * 1v1 的 `players` 是 `[蓝方玩家, 红方 AI]`，长度也是 2，
   * 拿长度当座位数会**把红方 AI 的手牌和金币一起摆到屏幕上**，等于亮出敌方全部底牌
   * （用户原话："我甚至能看到敌方的卡牌和敌方的经济"）。
   *
   * 1v1 恒 1；PVE 单人 1；PVE 双人 2。红方 AI 永远不占座位。
   * `isHuman` 不能代替它 —— 蓝方玩家自己开了托管，手牌也照样要显示（还能取消托管）。
   */
  seatPlayers(): PlayerSlot[] {
    return this.playersOf('blue');
  }

  /** 座位数（HUD 的手牌套数 / 相机让位判据都用它）。 */
  get seatCount(): number {
    return this.seatPlayers().length;
  }

  /**
   * 抽一张**手里没有的**牌。
   *
   * 用户 2026-10-28：「用掉 1 张，默认在卡牌库里面就不会抽出和这张相同的，应该抽出其他的」。
   * 上一版是 `rng.pick(CARDS)` 有放回地抽 —— 40 局里 **17 局**的手牌带重复
   * （实测 `orcs/cannonTower/house/house`、`archers/ballista/golem/golem`），
   * 四格里出现两张一样的牌，等于白白少一个选择。
   * 卡池（17 张）远大于手牌（4 张），所以正常不会抽干；真抽干了才退回全池，不留死路。
   *
   * **建筑保底（2026-10-31）**：只要当前手牌里一张建筑卡都没有，这一张就从建筑卡里抽。
   *
   * 为什么加这一条：用户这一版的设计是"以建筑为主、建筑协调经济"，但军队卡便宜
   * （6–11）而建筑卡贵（6–14），实测开局手牌全发军队时（seed 11：骑士/法师/石怪/牧师），
   * AI 会一直出军队、金永远贴着 0 —— 等建筑卡补进来也已经没钱了，实测 **53 秒才立起第一栋楼**。
   * 这不是"加权"：池子里每张牌仍然等概率，只是**名额上留一个给建筑**，
   * 相当于皇室战争里"玩家自己配卡组"那件事的替代品。
   */
  private draw(side: Side, exclude?: string): ArenaCard {
    const hand = this.playerOf(side).hand.filter((c): c is ArenaCard => c !== null);
    const taken = new Set(hand.map((c) => c.id));
    if (exclude) taken.add(exclude);
    let pool = CARDS.filter((c) => !taken.has(c.id));
    if (pool.length === 0) pool = CARDS;
    /**
     * **科技前置 + 发牌裁量**（2026-11-07）：池子先按「有没有前置建筑 /
     * 有没有对应尺寸空位」过滤；判据与落牌共用 `buildingPlacementIssue`。
     * 过滤后两个建筑保底自然失效（池里没有建筑卡）—— 不会刚过滤完又塞回来。
     */
    const room = new Map<string, boolean>();
    pool = pool.filter((c) => this.techAllows(side, c, room));
    if (pool.length === 0) {
      pool = CARDS.filter((c) => this.techAllows(side, c, room));
      if (pool.length === 0) pool = [cardById(TECH.militia)]; // 极端兜底：民兵永远能发
    }

    // ① 后勤保底（2026-10-31）：场上缺民居/磨坊，而手里一张都没有 ⇒ 这一张发它。
    //    没有这一条，实测 seed 20261027 打 120 秒双方**一兵未出**：
    //    蓝方立了 4 座磨坊、0 座民居，兵营一直冷着 —— 随机手牌把"建筑协调经济"这条主线掐断了。
    for (const need of this.missingLogisticsAll(side)) {
      // 手上已经有这张就不再重复发；缺两个时下一张补给第二个缺口
      // （旧版只取第一个 = house 优先，民居永远追不上 consumers ⇒ 磨坊永远发不出来）
      if (hand.some((c) => c.id === need)) continue;
      const pick = pool.find((c) => c.id === need);
      if (pick) return pick;
      break; // 池里没有这张（被 exclude 挡了），别再往后找
    }

    // ② 建筑保底：只要手里一张建筑卡都没有，这一张就从建筑卡里抽。
    if (!hand.some((c) => c.kind === 'building')) {
      const buildings = pool.filter((c) => c.kind === 'building');
      if (buildings.length > 0) pool = buildings;
    }
    /**
     * **建筑卡降权**（2026-11-16 用户："建筑卡现在刷出来的概率更少一些，
     * 更多的军队帮忙处理一下"）。
     *
     * 上面两条保底（后勤缺口 / 手里没建筑卡）是**硬性**的，它们先跑 ——
     * 这一层只影响"两条保底都没触发"时的自由发牌，所以不会把
     * 「缺民居就补民居」那条主约束冲掉。
     *
     * 权重取 `AI.cardWeightOf`，1 = 军/法术，低于 1 = 建筑。
     * 用 `rng.weighted` 而不是"先筛掉一部分"：后者会让 pool 大小随权重变，
     * 抽卡序列的随机性被削弱（同一 seed 下出牌顺序会变得可预测）。
     */
    return this.rng.weighted({ items: pool.map((c) => ({ item: c, weight: cardWeightOf(c) })) });
  }

  /**
   * 这一侧场上**缺哪种后勤卡**（`house` / `mill` / 不缺 = null）。
   *
   * 口径和 `staffedIds` 对得上：要干活的楼各要 1 座民居，兵营再要 1 座磨坊。
   * 这里只看"数量够不够"，不管名额怎么分 —— 分名额是 `staffedIds` 的事。
   */
  /**
   * 这一侧**所有**后勤缺口（可能同时缺民居和磨坊）。
   *
   * 旧版是单一返回值且 house 优先 —— 每盖一座塔 consumers 就 +1，民居永远追不上，
   * 于是 `mill` 这张牌几乎没被保底发过。实测 seed 20261027：红方 180 秒 0 磨坊、
   * 面包永远 3/3、军队一个出不来。改成数组后 draw() 与 reroll() 能分别/同时补两个缺口。
   */
  private missingLogisticsAll(side: Side): ('house' | 'mill')[] {
    const mine = [...this.buildings.values()].filter((b) => b.side === side && b.hp > 0 && b.build >= 1);
    const houses = mine.filter((b) => b.kind === 'house').length;
    const mills = mine.filter((b) => b.kind === 'mill').length;
    const consumers = mine.filter((b) => needsHouse(b.kind)).length;
    const barracks = mine.filter((b) => b.kind === 'barracks').length;
    const out: ('house' | 'mill')[] = [];
    if (houses < consumers) out.push('house');
    /**
     * 至少要有**一座**磨坊，哪怕还没盖兵营（2026-11-06 实测纠错）。
     *
     * 旧判据是 `mills < barracks`：兵营盖得晚，早期 `barracks=0` ⇒ 永远不认为缺磨坊
     * ⇒ `mill` 卡几乎没被后勤保底发过（seed 20261027 全程只在手牌里待了 89 帧）。
     * 而磨坊是**唯一**能扩面包上限的建筑：基础 3 点，一队 3 人弓箭手一次吃光，
     * 之后所有军队卡都被 `canPlay` 拦死。只读实验把 baseBread 提到 4 时拆楼 +33%，
     * 提到 5/6 就饱和 —— 所以正解是让磨坊早点进牌池，而不是改基础数值。
     */
    if (mills < Math.max(1, barracks)) out.push('mill');
    return out;
  }


  // ---------------------------------------------------------------- 查询

  /** 场地尺寸（视图层建地面要它，别自己再去读一遍配置）。 */
  get fieldSize(): { cols: number; rows: number } {
    return { cols: this.field.cols, rows: this.field.rows };
  }

  /** 蓝方的手牌（HUD、测试与老代码都读它；红方的那份在 `hands.red`）。 */
  get hand(): (ArenaCard | null)[] {
    return this.playerOf('blue').hand;
  }

  /** 蓝方的手牌冷却（同上，是 `handCooldowns.blue` 的快捷读法）。 */
  get handCooldown(): number[] {
    return this.playerOf('blue').cooldowns;
  }

  /**
   * **兼容读数**（2026-11-07 玩家槽化之后留下的旧形状）。
   *
   * 老代码和 500 条测试到处在写 `world.gold.blue = 20` / `world.auto.red = false`。
   * 这两份用 `sideBridge` 做成了**真的可写**（读写都落到 players 上），
   * 所以"给钱造场景 / 关掉对方 AI"这些老写法语义完全不变。
   */
  readonly gold = sideBridge<number>(
    (s) => this.playerOf(s).gold,
    (s, v) => {
      this.playerOf(s).gold = v;
    },
  );

  readonly auto = sideBridge<boolean>(
    (s) => this.playerOf(s).auto,
    (s, v) => {
      this.playerOf(s).auto = v;
    },
  );

  /** 手牌与冷却：只读快照（数组本身是**真引用**，元素读写都生效）。 */
  get hands(): Record<Side, (ArenaCard | null)[]> {
    return { blue: this.playerOf('blue').hand, red: this.playerOf('red').hand };
  }

  get handCooldowns(): Record<Side, number[]> {
    return { blue: this.playerOf('blue').cooldowns, red: this.playerOf('red').cooldowns };
  }

  /**
   * 这一局还剩几秒（到 0 就判负/判胜，不会变负）。
   *
   * 2026-11-06 加时赛：常规 180 秒打满、两边大本营都还立着 ⇒ 剩余秒数**重置成 60**
   *（加时是 sudden death：谁先拆掉对面大本营谁赢）。
   * HUD 拿 `summary().overtime` 区分「最后 30 秒告急」和「加时告急」，两边都是红的。
   */
  get timeLeft(): number {
    // 无尽没有倒计时：返回 Infinity 而不是 MATCH.seconds − elapsed 的负数，
    // 免得别处拿这个数当"还剩多久"报一个假读数。HUD 改显示 elapsed（向上计时）。
    if (this.mode === 'endless') return Number.POSITIVE_INFINITY;
    const total = this.elapsed >= MATCH.seconds ? MATCH.seconds + MATCH.overtimeSeconds : MATCH.seconds;
    return Math.max(0, total - this.elapsed);
  }

  /** 是不是已经进了加时赛（判负在 `checkOutcome`）。无尽永远不进加时。 */
  get overtime(): boolean {
    if (this.mode === 'endless') return false;
    return this.elapsed >= MATCH.seconds && this.outcome === 'playing';
  }

  /**
   * 这一列是不是中间的禁建带（楼和兵都不许**放**进去）。
   *
   * ⚠️ 只禁「落位」、不禁「开火」（用户 2026-11-06）：塔对站在带子里的单位照常开火，
   * 索敌（`nearestTowerTarget`）不读这里，也不许读 —— 判据钉在
   * tests「黄区只禁落位、不禁开火」那一组锁里，塞黄区过滤会红。
   */
  inNoBuild(col: number): boolean {
    return col >= this.field.midCol - NO_BUILD.halfWidth && col <= this.field.midCol + NO_BUILD.halfWidth;
  }

  coreOf(side: Side): ArenaBuilding | undefined {
    for (const b of this.buildings.values()) if (b.side === side && b.kind === 'core') return b;
    return undefined;
  }

  /** 这一格（以及它右下一格）能不能放 */
  cellFree(col: number, row: number, cols: number, rows: number): boolean {
    for (const b of this.buildings.values()) {
      if (col < b.col + b.cols && col + cols > b.col && row < b.row + b.rows && row + rows > b.row) return false;
    }
    return true;
  }

  /** 己方半场：蓝在左（col < midCol），红在右。 */
  inOwnHalf(side: Side, col: number): boolean {
    return side === 'blue' ? col < this.field.midCol : col >= this.field.midCol;
  }

  /**
   * **建筑落位判据（唯一一处，2026-11-07 设计文档 A 节）**：
   * 半场 / 3×3 不越界 / 三列不压黄区 / 不与任何楼重叠。
   * `placementProblem` 的建筑分支直接返回它，`buildingRoom` 与发牌裁量也读它——
   * 卡面提示、落牌拒绝、发牌过滤三件事不会算出两套账。
   */
  private buildingPlacementIssue(side: Side, col: number, row: number, cols = 3, rows = 3): string | null {
    void side;
    // 尺寸按 BUILDING_SPECS 传进来：齿轮工厂是 4×3，黄区要遍历 4 列，不能写死 3
    if (col < 0 || row < 0 || col + cols > this.field.cols || row + rows > this.field.rows) return '出界了';
    for (let c = col; c < col + cols; c++) if (this.inNoBuild(c)) return '中间黄区不能盖楼';
    if (!this.cellFree(col, row, cols, rows)) return '这格被占了';
    return null;
  }

  /** 这一侧有没有放得下 cols×rows 的空位（逐尺寸扫描，一次抽牌只算一遍）。 */
  private scanRoom(side: Side, cols: number, rows: number): boolean {
    for (let row = 0; row <= this.field.rows - rows; row++) {
      for (let col = 0; col <= this.field.cols - cols; col++) {
        if (!this.inOwnHalf(side, col)) continue;
        if (this.buildingPlacementIssue(side, col, row, cols, rows) === null) return true;
      }
    }
    return false;
  }

  /** 还有没有能放这座楼的空位。 */
  hasRoomFor(side: Side, building: keyof typeof BUILDING_SPECS): boolean {
    const spec = BUILDING_SPECS[building];
    return this.scanRoom(side, spec.cols, spec.rows);
  }

  /**
   * 这一侧**所有**能放 cols×rows 的格子（row → col 顺序）。
   *
   * 和 `scanRoom` 共用同一个合法性判据 `buildingPlacementIssue`，只是不提前返回：
   * `scanRoom` 是每帧影子/AI 都要问的布尔快路径，`freeCellsFor` 只在玩家
   * **点到一个放不下的格子**时才跑一次完整扫描，为 P-098 的「最后一个位置」数空位。
   */
  private freeCellsFor(side: Side, cols: number, rows: number): GridPos[] {
    const out: GridPos[] = [];
    for (let row = 0; row <= this.field.rows - rows; row++) {
      for (let col = 0; col <= this.field.cols - cols; col++) {
        if (!this.inOwnHalf(side, col)) continue;
        if (this.buildingPlacementIssue(side, col, row, cols, rows) === null) out.push({ col, row });
      }
    }
    return out;
  }

  /**
   * **P-098（2026-11-13）「无论往哪放，就放到最后一个位置上」**：把玩家点的格子
   * 解析成这张牌的**最终落点**。判据只有这一处，`playCardOf`（落牌）与
   * `ArenaApp.moveCardDrag`（影子）都调它，所以永远「影子在哪就落在哪」。
   *
   * 口径（用户 P-096 两句其实是同一件事的两半，不冲突）：
   * - 点的格子本来就合法 ⇒ 原地，**零额外扫描**；
   * - 建筑卡点了个放不下的格子、且全场**只剩最后一处空位** ⇒ 吸附过去；
   * - 一处空位都没有 ⇒ 返回 null ⇒ 拒绝生成（P-096「场地已满」红线不变）；
   * - 还有 2 处以上空位 ⇒ 不吸附，照旧回「这格被占了」——
   *   否则开局手滑点一下，楼会瞬移到地图另一头，那才叫见鬼。
   *
   * 军队卡不参与：它们是 1×1、要落在玩家指定的行军起点，吸附没有意义。
   */
  snapCellOf(p: PlayerSlot, slot: number, col: number, row: number): GridPos | null {
    const card = p.hand[slot];
    const at = { col, row };
    if (!card || card.kind !== 'building') return at;
    const spec = BUILDING_SPECS[card.building!];
    if (this.buildingPlacementIssue(p.side, col, row, spec.cols, spec.rows) === null) return at;
    const free = this.freeCellsFor(p.side, spec.cols, spec.rows);
    if (free.length === 0) return null;
    if (free.length === 1) return free[0]!;
    return at;
  }

  /** 这一侧还有没有能放下任意建筑（3×3 或 4×3）的空位。 */
  buildingRoom(side: Side): boolean {
    return this.scanRoom(side, 3, 3) || this.scanRoom(side, 4, 3);
  }

  /** 完工（build>=1）才算科技解锁；施工中的楼不干活（项目红线）。 */
  hasBuilt(side: Side, kind: Extract<BuildingKind, 'barracks' | 'gearFactory' | 'orcLair' | 'spellForge'>): boolean {
    for (const b of this.buildings.values()) {
      if (b.side === side && b.kind === kind && b.hp > 0 && b.build >= 1) return true;
    }
    return false;
  }

  /**
   * 场上是否**已经有一座自家齿轮工厂**（2026-11-07 用户："如果场上有一个工业工厂，
   * 玩家不会再被发到这个手牌，除非自己的工厂被摧毁"）。
   *
   * 和 `hasBuilt` 的区别是**故意的**：这里连施工中（build<1）都算。
   * 工厂一落地就吃掉一个 4×3 的坑，第二张工厂卡在它盖好之前根本没地方放，
   * 发下来就是一张死牌；等到盖完再禁，玩家已经白白攥了几秒废卡。
   *
   * `hurtBuilding` 拆楼时会 `buildings.delete(b.id)`，所以"被摧毁"不需要额外标记：
   * 楼一没，这里自然变 false，工厂卡自动回到卡池（废墟 `ruins` 不算楼，不拦发牌）。
   */
  hasFactory(side: Side): boolean {
    for (const b of this.buildings.values()) {
      if (b.side === side && b.kind === 'gearFactory' && b.hp > 0) return true;
    }
    return false;
  }

  /**
   * **科技前置**（2026-11-07 设计文档 A 节）：
   * 民兵永远可发；其它地面军队要兵营；三架飞行器要齿轮工厂；
   * 建筑卡还要有对应尺寸的空位（P-056 的裁量，按卡逐一判）。
   */
  techAllows(side: Side, card: ArenaCard, cache = new Map<string, boolean>()): boolean {
    if (card.kind === 'building' && card.building) {
      /**
       * **唯一建筑**：场上已有自家工厂 ⇒ 这张牌整个退出卡池（2026-11-07 用户）。
       * 放在 `scanRoom` 前面，是为了让它跟场地有没有空位无关 —— 哪怕场地空得能再
       * 盖十座，也不该发第二张。判据与落牌/`purgeLocked` 共用这一处，不另算账。
       */
      if (card.building === 'gearFactory' && this.hasFactory(side)) return false;
      const spec = BUILDING_SPECS[card.building];
      const key = `${spec.cols}x${spec.rows}`;
      if (!cache.has(key)) cache.set(key, this.scanRoom(side, spec.cols, spec.rows));
      return cache.get(key)!;
    }
    /**
     * **法术卡**（P-104）—— 不进科技链，但要看"这个模式里有没有它能打的东西"。
     *
     * 踩过的坑：PVE 里**没有敌方建筑**（连红方大本营都不生成），而导弹是专打楼的，
     * 发到手上就是一张永远打不出去的废牌，白占一个手牌位。实测 12 局托管
     * 从 9 胜掉到 7 胜，就是这么来的。
     *
     * 判据是 **"能不能打到任何一类当前存在的目标"**，不是"能不能打到楼"：
     * - 导弹 `vsUnits: false` + 对面没楼 ⇒ 废牌，不发；
     * - 火球 `vsUnits: true` 但对面没楼 ⇒ **照样发**（它还能打兵，只是对兵打折）；
     * - 剑雨 `vsUnits: true` ⇒ 永远发。
     *
     * 早先写成"只要 vsBuildings 就查对面有没有楼"，把火球也在 PVE 里禁掉了 ——
     * 那等于替玩家决定"火球没用"，而实际上它在 PVE 里是能用的次优解。
     */
    if (card.kind === 'spell') {
      const spec = card.spell ? SPELL[card.spell] : null;
      if (!spec) return false; // 配置错误：不存在的法术 id 不发
      /**
       * **剑雨要法术工厂**（2026-11-16 用户："箭雨不需要其他的，需要一个法术工厂"）。
       * 表在 `TECH.forgeCards`，判据只留这一处；火球 / 导弹不设前置。
       */
      if (TECH.forgeCards.includes(card.id) && !this.hasBuilt(side, 'spellForge')) return false;
      const canHitUnits = spec.vsUnits && spec.unitScale > 0;
      const canHitBuildings = spec.vsBuildings && this.hasEnemyBuildingTarget(side);
      return canHitUnits || canHitBuildings;
    }
    if (card.id === TECH.militia) return true;
    // 飞行器 + 攻城车都要齿轮工厂（同一张表，见 config.TECH.factoryCards）
    if (TECH.factoryCards.includes(card.id)) return this.hasBuilt(side, 'gearFactory');
    // 兽人军队要兽人巢穴（2026-11-07 用户新增建筑）
    if (TECH.orcCards.includes(card.id)) return this.hasBuilt(side, 'orcLair');
    return this.hasBuilt(side, 'barracks');
  }

  /**
   * 对面还有没有**可被法术打到**的常规建筑（大本营不算 —— 法术本来就打不到它）。
   * 给 `techAllows` 的发牌裁量用，和 `castSpell` 的命中判据同一条口径。
   */
  hasEnemyBuildingTarget(side: Side): boolean {
    for (const b of this.buildings.values()) {
      if (b.side !== side && b.hp > 0 && b.kind !== 'core') return true;
    }
    return false;
  }

  /** HUD 小标：场地 > 兵营 > 工厂 > 兽人巢穴，按解锁顺序给下一句提示。 */
  techHint(side: Side): string | null {
    if (!this.buildingRoom(side)) return '场地已满 · 只发军队';
    if (!this.hasBuilt(side, 'barracks')) return '需要军营解锁军队';
    if (!this.hasBuilt(side, 'gearFactory')) return '需要齿轮工厂解锁空军与攻城车';
    if (!this.hasBuilt(side, 'orcLair')) return '需要兽人巢穴解锁兽人军队';
    return null;
  }

  buildingCenter(b: ArenaBuilding): { x: number; z: number } {
    return { x: b.col + b.cols / 2, z: b.row + b.rows / 2 };
  }

  // ---------------------------------------------------------------- 落位

  private place(side: Side, kind: ArenaBuilding['kind'], col: number, row: number, hp: number): ArenaBuilding {
    const spec = kind === 'core' ? { cols: CORE.cols, rows: CORE.rows } : BUILDING_SPECS[kind];
    const b: ArenaBuilding = {
      id: this.nextId++,
      side,
      kind,
      col,
      row,
      cols: spec.cols,
      rows: spec.rows,
      hp,
      maxHp: hp,
      // 核心开局就是完工的（它本来就是地图的一部分）；其余从 0 开始垒
      build: kind === 'core' ? 1 : 0,
      timer: 0,
      fireIn: 0,
      flag: null,
      // 默认朝向就是冲着对面：蓝朝右(+x)、红朝左(-x)。
      // 之前写的是 ±π/2（上下对峙时代的朝向），横版之后全歪了
      aim: side === 'blue' ? 0 : Math.PI,
      shotsMuzzle: 0,
      lastHit: 'blade',
      // 开局没挨过打；残血只可能由 hurtBuilding 造成，那时这个时刻会被改写
      lastHitAt: 0,
      repairLeft: 0,
    };
    this.buildings.set(b.id, b);
    return b;
  }

  /** 兵营的出兵点：没挪过就用"朝对手那一面"的第一格空地。 */
  spawnCellOf(b: ArenaBuilding): { col: number; row: number } {
    if (b.flag) return b.flag;
    // 横版：蓝方朝右打，出兵点在自己右沿外侧；红方反过来
    const col = b.side === 'blue' ? b.col + b.cols : b.col - 1;
    const row = b.row + Math.floor(b.rows / 2);
    return {
      col: Math.min(this.field.cols - 1, Math.max(0, col)),
      row: Math.min(this.field.rows - 1, Math.max(0, row)),
    };
  }

  /** 挪出兵旗。返回 false = 那格放不了（越界/压着楼）。 */
  setFlag(buildingId: number, col: number, row: number): boolean {
    const b = this.buildings.get(buildingId);
    if (!b || b.kind !== 'barracks' || !b.side) return false;
    if (col < 0 || row < 0 || col >= this.field.cols || row >= this.field.rows) return false;
    if (!this.cellFree(col, row, 1, 1)) return false;
    b.flag = { col, row };
    return true;
  }

  // ---------------------------------------------------------------- 出牌

  /**
   * **内部 API**：让一方的所有兵朝某一点推进（到达后自动清空，恢复默认推进）。
   *
   * 2026-11-07 起**玩家点地面不再调用它**（用户："军队是棋子，落下之后就不归
   * 我们管了，他会自己走"）。保留给 PVE 波次脚本 / 观战回放 / 调试，别顺手删：
   * `order` 字段在几十处测试对象里，删它要重排一大片，收益是零。
   */
  command(side: Side, col: number, row: number): number {
    const at = { x: col + 0.5, z: row + 0.5 };
    let n = 0;
    for (const u of this.units) {
      if (u.side !== side || u.hp <= 0) continue;
      u.order = { ...at };
      n++;
    }
    return n;
  }

  /**
   * 打出手牌第 slot 张。
   * 失败原因会原样给 HUD 用：金不够 / 半场不对 / 这格被占 / 卡还在冷却。
   */
  playCard(side: Side, slot: number, col: number, row: number): PlayResult {
    return this.playCardOf(this.playerOf(side), slot, col, row);
  }

  /**
   * **指定玩家出牌**（2026-11-07 双人 PVE）。
   *
   * 两个人都在 blue 一侧，所以"半场 / 供给 / 后勤"照旧按阵营判，
   * 只有**金币和手牌**按玩家槽走 —— 谁掏钱、谁那张牌进冷却。
   */
  playCardOf(p: PlayerSlot, slot: number, col: number, row: number): PlayResult {
    /**
     * P-098：先把玩家点的格子解析成最终落点（只剩一处空位时吸附过去）。
     * 放在 `playCardOf` 而不是 UI 里，是为了让 AI / 测试 / 点击 / 拖拽四条路
     * 都走同一条规则；`placementProblem` 也用解析后的格子，不会算出两套账。
     */
    const target = this.snapCellOf(p, slot, col, row);
    if (!target) return { ok: false, reason: '场地已满 · 这座楼放不下了' };
    const problem = this.placementProblem(p, slot, target.col, target.row);
    if (problem) return { ok: false, reason: problem };
    const card = p.hand[slot]!;

    this.execute(p, card, target.col, target.row);
    // 这栋楼落地后可能刚好把最后一处空位占掉：手里剩下的建筑卡立刻换成军队卡
    this.purgeLocked(p.side);
    // 打出去就进冷却，冷却完补一张新的（配卡组以后再做）
    p.lastPlayed[slot] = card.id;
    p.hand[slot] = null;
    p.cooldowns[slot] = HAND.refillSeconds;
    return { ok: true };
  }

  /**
   * **只校验、不落牌**（2026-11-06 拖放影子用）：判据只有这一份 ——
   * 落牌（playCard）和影子的绿/红显色都从这里出，不会算出两套账。
   */
  canPlaceAt(side: Side, slot: number, col: number, row: number): { ok: boolean; reason?: string } {
    return this.canPlaceAtOf(this.playerOf(side), slot, col, row);
  }

  canPlaceAtOf(p: PlayerSlot, slot: number, col: number, row: number): { ok: boolean; reason?: string } {
    const problem = this.placementProblem(p, slot, col, row);
    return problem ? { ok: false, reason: problem } : { ok: true };
  }

  private placementProblem(p: PlayerSlot, slot: number, col: number, row: number): string | null {
    const side = p.side;
    if (this.outcome !== 'playing') return '这一局已经结束';
    const card = p.hand[slot];
    if (!card) return '这格是空的';
    if (p.cooldowns[slot]! > 0) return '这张还在冷却';
    if (p.gold < card.cost) return `金币不够（要 ${card.cost}）`;
    const blocked = this.supplyBlocked(side, card);
    if (blocked) return blocked;

    /**
     * **法术卡：唯一能越过半场与黄区的卡**（P-103）。
     *
     * 三条判据顺序有讲究：
     * ① 边界 —— 必须在地图内（法术也不能扔到图外）；
     * ② **不查 `inOwnHalf` / `inNoBuild`** —— 这就是"远程攻击"的意义，
     *    不然玩家只能往自己脚下丢火球，牌就没用了；
     * ③ 不查格子占用 —— 法术打在空地上也允许（提前封锁、封走位）。
     *    打空地＝白花 5 金，这是玩家的判断，不由规则替他兜。
     */
    if (card.kind === 'spell') {
      if (col < 0 || row < 0 || col >= this.field.cols || row >= this.field.rows) return '落在地图外了';
      return null;
    }

    if (!this.inOwnHalf(side, col)) return '只能放在自己半场';

    if (card.kind === 'building') {
      /**
       * **场地满 = 绝不生成建筑**（P-096 用户："如果已经没有位置了，
       * 就不会再出现这个建筑单位，即使建筑卡片已经给我们了"）。
       *
       * `buildingPlacementIssue` 只会说"这格被占了"，玩家会以为换个格子就行；
       * 这里先用 `hasRoomFor` 扫一遍整张图，一个能放这座楼的位置都没有时
       * 直接给"场地已满"，并且**不进 execute()** ⇒ 不扣钱、不生成建筑、不占人口。
       * 判据与影子 / 发牌裁量同源，都是 hasRoomFor → buildingPlacementIssue。
       */
      if (!this.hasRoomFor(side, card.building!)) return '场地已满 · 这座楼放不下了';
      const spec = BUILDING_SPECS[card.building!];
      return this.buildingPlacementIssue(side, col, row, spec.cols, spec.rows);
    }
    // 军队卡仍占 1×1（飞行单位也一样：落牌位置维持与现有锁一致）
    if (col + 1 > this.field.cols || row + 1 > this.field.rows) return '出界了';
    if (!this.cellFree(col, row, 1, 1)) return '这格被占了';
    if (this.inNoBuild(col)) return '中间黄区不能放兵';
    return null;
  }

  /** 真正的花钱与落位。AI 也用这一条，保证两边走同一套规则。 */
  private execute(p: PlayerSlot, card: ArenaCard, col: number, row: number): void {
    this.spend(p, card.cost);
    if (card.kind === 'spell') {
      /**
       * **法术不生成任何实体**（P-103）：当场在落点结算一次范围伤害就结束。
       * 不借人口、不占面包、不吃后勤名额 —— 这三件事都由"没有 squad"天然满足。
       */
      this.castSpell(p.side, card, col, row);
      return;
    }
    if (card.kind === 'building') {
      this.place(p.side, card.building!, col, row, BUILDING_SPECS[card.building!].hp);
    } else {
      // 人口 / 口粮从卡面判据的同一张表取，别在这里重写一份
      const sup = armySupplyOf(card);
      const men = (card.squad ?? []).reduce((sum, g) => sum + g.count, 0);
      /**
       * **从闲置人口里借一笔**（P-094）：借多少 = 人数 × 这张卡的 popPerMan。
       * 民兵 / 兽人 popPerMan=0 ⇒ 不借（旧口径不变）；兵营自动兵不走 execute，
       * 也不借。这笔债按 SUPPLY.idleRegenSeconds 一格一格归还，见 update()。
       */
      this.popDebt[p.side] += men * sup.popPerMan;
      this.spawnSquad(p.side, card.squad ?? [], col, row, false, sup.breadPerMan, sup.popPerMan);
    }
  }

  /**
   * 施放一次法术（P-103；P-104 扩到"打兵 / 打楼 / 两样都打"三种分工）。
   *
   * 结算顺序刻意分成「先算命中、再统一结算」，而不是边遍历边打：
   * 后者会让**同一个目标被重复命中**（`this.units` 里同一帧可能被 push 进来两次），
   * 而且 `hurtBuilding` 会把被拆的楼从 Map 里删掉，边遍历边删是经典的踩坑点。
   *
   * 只打**敌方**：打自己人与"花金币买伤害"的直觉相反，AI 也会误伤前排。
   * 命中判定用**圆心距离**（`Math.hypot`），不是格子的切比雪夫距离 ——
   * 半径 1.6 格要的是"贴在一起的一队兵"，圆比方更符合直觉。
   *
   * 三种法术的分工全在 `SPELL` 的 `vsUnits` / `vsBuildings` / `unitScale` 里，
   * **这里一行数据都不写死**：加第四种法术只加一行表项。
   */
  private castSpell(side: Side, card: ArenaCard, col: number, row: number): void {
    const spec = card.spell ? SPELL[card.spell] : null;
    if (!spec) return; // 卡上写了不存在的法术 id：不结算（配置错误，测试会抓）
    const at = cellToWorld(pos(col, row));

    // ① 先把命中清单定下来（此时还不动任何血）
    const foes = spec.vsUnits
      ? this.units.filter(
        (u) => u.side !== side && u.hp > 0 && Math.hypot(u.x - at.x, u.z - at.z) <= spec.radius,
      )
      : [];
    /**
     * 只算 `BUILDING_SPECS` 里的常规建筑。
     *
     * ⚠️ **大本营（kind === 'core'）被显式排除**：它不在这张表里，本身也没有
     * 「3×3 占地中心」这套口径。更重要的是**这是刻意的**：法术如果能砸
     * 1200 血的主城，「拆家要靠推兵线」这条攻防抓手就废了 —— 20 金的导弹尤其危险。
     * 要改这一点得单独拍板，不能顺手加。
     */
    const foeBuildings = spec.vsBuildings
      ? [...this.buildings.values()].filter((b) => {
        if (b.side === side || b.hp <= 0 || b.kind === 'core') return false;
        // 建筑按**占地中心**算距离：3×3 的楼，圆心是它占格的中间那一格
        const bs = BUILDING_SPECS[b.kind];
        const cx = b.col + (bs.cols - 1) / 2;
        const cz = b.row + (bs.rows - 1) / 2;
        const w = cellToWorld(pos(cx, cz));
        return Math.hypot(w.x - at.x, w.z - at.z) <= spec.radius + Math.max(bs.cols, bs.rows) / 2;
      })
      : [];

    // ② 统一结算：兵走 hurtUnit（吃防御 + 法术的对兵倍率），楼走 hurtBuilding（吃拆楼倍率）
    //
    // 对兵倍率**乘在这里**而不是改 spec.damage：楼不该跟着打折（拆楼有自己那条倍率）。
    // `damageOf` 自带 max(1, …) 下限，所以 `unitScale: 0`（导弹）要给 0 就直接跳过 ——
    // 否则 max(1, 0 - 防御) 仍会打出 1 点伤害，"打不到兵"就成了谎话。
    const unitDamage = spec.damage * spec.unitScale;
    if (unitDamage > 0) {
      for (const u of foes) this.hurtUnit(u, unitDamage);
    } else {
      foes.length = 0; // 倍率 0 = 这一类根本不参战，别虚报命中数
    }
    for (const b of foeBuildings) this.hurtBuilding(b, spec.damage, 'magic', side);

    // ③ 记账 + 通知视图层播特效（视图只读事件，不自己判命中）
    this.spellCasts.push({
      id: this.spellCastId++,
      side,
      spell: card.spell!,
      col,
      row,
      x: at.x,
      z: at.z,
      radius: spec.radius,
      hitUnits: foes.length,
      hitBuildings: foeBuildings.length,
      t: 0,
      seconds: 0.55,
    });
    const label = card.name ?? '法术';
    this.noteSpell(`${side === 'blue' ? '蓝方' : '红方'}${label}命中 ${foes.length} 兵 / ${foeBuildings.length} 楼`);
  }

  /**
   * 法术播报（P-103）。战斗层没有通用的 `log()`（那是模组规则层的东西），
   * 这里走和 `destroyLog` 同一条思路：**留一份可读的最近事件**，给 HUD 与探针用。
   *
   * 只保留最近若干条 —— 这是"给玩家看的一句提示"，不是审计日志。
   */
  readonly spellNotes: { at: number; text: string }[] = [];
  private noteSpell(text: string): void {
    this.spellNotes.push({ at: this.elapsed, text });
    if (this.spellNotes.length > 8) this.spellNotes.shift();
  }

  /**
   * 花 5 金重抽全部 4 张手牌，**保底一张民居**。
   *
   * 为什么要保底：民居是塔/兵营能否开工的唯一名额来源，纯随机重抽可能抽到一手
   * 没有民居的牌 —— 那这 5 金就白花了，玩家会更不敢点刷新。
   * `draw()` 自己的「缺后勤保底」只在场上缺民居时触发，所以这里再补一道硬保底。
   */
  reroll(side: Side): PlayResult {
    return this.rerollOf(this.playerOf(side));
  }

  /** 指定玩家刷新（双人 PVE：各花各的 5 金）。 */
  rerollOf(p: PlayerSlot): PlayResult {
    if (this.outcome !== 'playing') return { ok: false, reason: '这一局已经结束' };
    if (p.gold < REROLL.cost) return { ok: false, reason: `金币不够（刷新要 ${REROLL.cost}）` };

    // 先清空，让 draw() 的去重从零开始，保证 4 张互不重复
    p.hand.fill(null);
    const fresh: ArenaCard[] = [];
    for (let i = 0; i < HAND.size; i++) {
      const card = this.draw(p.side, fresh.at(-1)?.id);
      fresh.push(card);
      p.hand[i] = card;
    }
    // 没空位时**不塞** house/mill 保底（否则刷新完又是一张盖不下去的楼）
    if (this.hasRoomFor(p.side, 'house')) {
      const needs = this.missingLogisticsAll(p.side);
      const wanted: string[] = needs.length > 0 ? [...needs] : ['house'];
      // 用户原话「刷新默认会给一张房屋」：即使只缺磨坊，房屋也照保
      if (!wanted.includes('house')) wanted.push('house');
      let slot = HAND.size - 1;
      for (const id of wanted) {
        if (p.hand.some((c) => c?.id === id)) continue;
        p.hand[slot--] = cardById(id);
      }
    }

    // 牌全换了，冷却与「刚打出去那张」的记录一起清掉
    p.cooldowns.fill(0);
    p.lastPlayed.fill(null);
    this.spend(p, REROLL.cost);
    return { ok: true };
  }

  /**
   * 手牌里不满足前置的卡（科技被拆回去 / 场地被占满）当场换成允许卡。
   * 只换卡面，槽位/冷却不动。触发：出牌后、拆楼后、刷新后。
   */
  private purgeLocked(side: Side): void {
    const room = new Map<string, boolean>();
    for (let i = 0; i < HAND.size; i++) {
      const card = this.playerOf(side).hand[i];
      if (card && !this.techAllows(side, card, room)) {
        this.playerOf(side).hand[i] = this.draw(side, card.id);
        room.clear(); // 刚换的牌可能改变占地判断，缓存作废
      }
    }
  }

  /** 立刻补一张牌到那一格（补的是**手上还没有的**牌，也不补刚打出去那张）。 */
  private drawInto(p: PlayerSlot, slot: number): void {
    const exclude = p.lastPlayed[slot] ?? undefined;
    p.lastPlayed[slot] = null;
    p.hand[slot] = this.draw(p.side, exclude);
  }

  /** 花钱（PVE 双人时各花各的，所以按玩家槽扣，不按阵营）。 */
  private spend(p: PlayerSlot, amount: number): void {
    p.gold = Math.max(0, p.gold - amount);
  }

  private spawnSquad(
    side: Side,
    squad: { unitId: string; count: number }[],
    col: number,
    row: number,
    /** true = 兵营自动出的兵：不占人口（用户 2026-11-06），面包照吃 */
    fromBarracks = false,
    /** 民兵自带干粮：每人只吃 0.5 面包（默认 1）；兽人吃 2 */
    breadPerMan = 1,
    /** 每人占几格人口（默认 1）；民兵 / 兽人 = 0，兵营自动兵在 fromBarracks 里处理 */
    popPerMan = SUPPLY.unitPop,
  ): void {
    let i = 0;
    for (const part of squad) {
      for (let n = 0; n < part.count; n++) {
        const st = statsOf(part.unitId);
        // 以落点为中心散开：一格塞不下三个，错开成 3×3 的小方阵
        const dc = (i % 3) - 1;
        const dr = Math.floor(i / 3) - 1;
        const uid = this.nextId++;
        this.units.push({
          id: uid,
          side,
          defId: part.unitId,
          x: col + 0.5 + dc * 0.32,
          z: row + 0.5 + dr * 0.32,
          hp: st.hp,
          maxHp: st.hp,
          cooldown: 0,
          stun: 0,
          order: null,
          detour: uid % 2 === 0 ? 1 : -1,
          fromBarracks,
          // 默认朝向就是冲着对面：蓝朝右(+x)、红朝左(π)
          aim: side === 'blue' ? 0 : Math.PI,
          healIn: part.unitId === 'mobileCannon' ? undefined : unitDef(part.unitId).special?.kind === 'heal' ? unitDef(part.unitId).special!.every : undefined,
          bombIn: this.bomberOf(part.unitId) ? BOMBER.interval * 0.5 : undefined,
          breadCost: breadPerMan,
          // 民兵 / 兽人不占人口；兵营自动兵沿用 fromBarracks 的 0
          popCost: fromBarracks ? 0 : popPerMan,
        });
        i++;
      }
    }
  }

  // ---------------------------------------------------------------- 每帧

  update(dt: number): void {
    if (this.outcome !== 'playing') return;
    this.elapsed += dt;

    /**
     * **闲置人口慢慢提回来**（P-094）：只销军队那笔债，建筑占用一分不动。
     * 和金币同款**按整格跳**（攒够 idleRegenSeconds 才还 1 格），
     * 所以顶栏三个读数永远是整数、加起来对得上账。
     * 结算后 `update()` 整段 return，账单里的读数不会在结算页继续漂。
     */
    for (const side of ['blue', 'red'] as const) {
      if (this.popDebt[side] <= 0) {
        this.popDebtTick[side] = 0;
        continue;
      }
      this.popDebtTick[side] += dt;
      while (this.popDebtTick[side] >= SUPPLY.idleRegenSeconds && this.popDebt[side] > 0) {
        this.popDebtTick[side] -= SUPPLY.idleRegenSeconds;
        this.popDebt[side] -= 1;
      }
    }

    // 金：每 ECONOMY.tickSeconds 跳 +perTick，到上限就不涨。
    // 用"攒够一格再加"而不是 perSecond*dt，是为了大 dt（快进/掉帧）时也按整格补，
    // 不会出现 12.7333 这种读数。
    for (const p of this.players) {
      p.goldTick += dt;
      while (p.goldTick >= ECONOMY.tickSeconds) {
        p.goldTick -= ECONOMY.tickSeconds;
        p.gold = Math.min(ECONOMY.cap, p.gold + ECONOMY.perTick);
      }
    }

    // 手牌冷却：**按玩家槽**各自补（PVE 双人时第二个玩家也要补牌）
    for (const p of this.players) {
      const cool = p.cooldowns;
      for (let i = 0; i < cool.length; i++) {
        if (cool[i]! <= 0) continue;
        cool[i] = Math.max(0, cool[i]! - dt);
        if (cool[i] === 0) this.drawInto(p, i);
      }
    }

    this.tickBuildings(dt);
    this.tickShots(dt);
    for (const r of this.ruins) r.ttl -= dt;
    this.ruins = this.ruins.filter((r) => r.ttl > 0);
    for (const h of this.heals) h.ttl -= dt;
    this.heals = this.heals.filter((h) => h.ttl > 0);
    for (const h of this.hits) h.ttl -= dt;
    this.hits = this.hits.filter((h) => h.ttl > 0);
    // 法术特效：走自己的 t 计时到 seconds 就摘掉（和上面三个同一条约定）
    for (const s of this.spellCasts) s.t += dt;
    // 数组是 readonly，所以**原地压缩**而不是重新赋值（视图持有的就是这一个引用）
    for (let i = this.spellCasts.length - 1; i >= 0; i--) {
      if (this.spellCasts[i]!.t >= this.spellCasts[i]!.seconds) this.spellCasts.splice(i, 1);
    }
    this.tickUnits(dt);
    // 修复放在伤害之后：同一帧挨打会先把 repairLeft 清零，这一帧就不会还回血
    this.tickRepairs(dt);
    this.separateUnits();
    this.tickAi(dt);
    // PVE：AI 只管"玩家的托管"，出怪走波次表（两条独立的驱动，不互相顶）
    if (this.mode === 'pve') this.tickWaves(dt);
    this.checkOutcome();
  }

  /**
   * **单位碰撞分离**（2026-11-06 用户："每个单位脚下会有一个看不见的小圆圈
   * 碰撞体积，不然的话它们会叠在一起"）。
   *
   * 每帧对活着的单位做两两位置修正：圆心距 < 2×半径就沿连线各退一半。
   * 完全重合（同点落兵）时按 id 的稳定角度掰开，不会抖。
   * 只挪位置、不产生速度/反弹，所以不会和寻路/索敌抢控制权；
   * 帧率 20Hz 下一帧推不完的重叠下一帧接着推，自然收敛。
   */
  private separateUnits(): void {
    const min = UNIT.radius * 2;
    const us = this.units;
    for (let i = 0; i < us.length; i++) {
      const a = us[i]!;
      if (a.hp <= 0) continue;
      for (let j = i + 1; j < us.length; j++) {
        const b = us[j]!;
        if (b.hp <= 0) continue;
        // 飞行单位不与地面兵互挤（空中分层，v1 简单口径）
        if (this.flyingOf(a.defId) || this.flyingOf(b.defId)) continue;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let d = Math.hypot(dx, dz);
        if (d >= min) continue;
        if (d < 1e-4) {
          // 完全重合：按 id 定出稳定角度掰开（同 seed 同摆法结果可复现）
          const a1 = ((a.id % 8) + 0.5) * (Math.PI / 4);
          dx = Math.cos(a1) * 0.01;
          dz = Math.sin(a1) * 0.01;
          d = 0.01;
        }
        const push = (min - d) / 2;
        const ux = dx / d;
        const uz = dz / d;
        a.x -= ux * push;
        a.z -= uz * push;
        b.x += ux * push;
        b.z += uz * push;
      }
    }
    // 推出场地边界就算了：按回场内，别让分离把兵挤出场外。
    // 飞行单位**不 clamp**：轰炸机要靠飞出地图来消失（2026-11-07 设计文档 E 节）。
    for (const u of us) {
      if (u.hp <= 0 || this.flyingOf(u.defId)) continue;
      u.x = Math.min(this.field.cols - 0.4, Math.max(0.4, u.x));
      u.z = Math.min(this.field.rows - 0.4, Math.max(0.4, u.z));
    }
  }

  /**
   * 大本营的水晶**魔法攻击**（2026-11-06 用户："主城顶上的水晶可以魔法攻击"）。
   *
   * 与塔的三点不同（口径都写在 config.CORE.attack 注释里）：
   * - **只打地面兵**：敌建筑让移动火炮去白嫖，水晶是最后防线不是主炮台；
   *   空军也不归它管 —— 对空来源只有 `AA_SOURCES` 里那一座箭塔；
   * - **不配给**：大本营是地图本身，不受民居名额管；
   * - 射程从占地边缘量（+1.5），和塔同一口径。
   */
  private tickCore(b: ArenaBuilding, dt: number): void {
    b.fireIn = Math.max(0, b.fireIn - dt);
    if (b.fireIn > 0) return;
    const spec = CORE.attack;
    const c = this.buildingCenter(b);
    const reach = spec.range + Math.max(b.cols, b.rows) / 2;
    let best: { d: number; u: ArenaUnit } | null = null;
    for (const u of this.units) {
      // 水晶只打地面兵：火炮/水晶都够不着天上的东西（对空规则只在 config.AA_SOURCES 一处）
      if (u.side === b.side || u.hp <= 0 || (!canHitAir('core') && this.flyingOf(u.defId))) continue;
      const d = Math.hypot(u.x - c.x, u.z - c.z);
      if (d > reach) continue;
      if (!best || d < best.d) best = { d, u };
    }
    if (!best) return;
    b.fireIn = spec.interval;
    b.aim = Math.atan2(best.u.z - c.z, best.u.x - c.x);
    b.shotsMuzzle = 0.18;
    this.shots.push({
      id: this.nextId++,
      ammo: 'magic',
      source: 'core',
      fromX: c.x,
      fromZ: c.z,
      toX: best.u.x,
      toZ: best.u.z,
      t: 0,
      seconds: 0.4,
      targetId: best.u.id,
    });
    this.hurtUnit(best.u, spec.damage);
  }

  private tickBuildings(dt: number): void {    // 一次 tick 只算一遍"哪些楼配齐了后勤"：以前每座兵营各算一遍是 O(n²)，
    // 现在塔也要位置（民居），消费者多了一倍，更不能逐楼重算。
    const support = { blue: this.staffedIds('blue'), red: this.staffedIds('red') };
    for (const b of this.buildings.values()) {
      if (b.kind === 'core') {
        this.tickCore(b, dt);
        continue;
      }
      // 施工：按各自的秒数推进；没完工就什么都不干（塔不开火、兵营不出兵、磨坊不生金）
      if (b.build < 1) {
        const total = BUILD.seconds[b.kind as keyof typeof BUILD.seconds] ?? 3;
        b.build = Math.min(1, b.build + dt / total);
        if (b.build < 1) continue;
      }
      if (b.kind === 'barracks') {
        // 用户 2026-10-27：1 座兵营要配 1 座磨坊 + 1 座民居，否则不出兵。
        // 后勤断了连计时也停：补上之后从 0 开始，不会一配齐就蹦一个兵出来。
        if (!support[b.side].has(b.id)) {
          b.timer = 0;
          continue;
        }
        b.timer += dt;
        if (b.timer < BARRACKS.interval) continue;
        b.timer = 0;
        const mine = this.units.filter((u) => u.side === b.side).length;
        if (mine >= BARRACKS.cap) continue;
        /**
         * 人口 / 面包满了就**堵住**（2026-11-05）。
         *
         * 少了这一条，人口上限就是个摆设：出牌时会查，但兵营每 6 秒自己吐一个兵不查 ——
         * 实测 12 局里出现了"人口 11/8"这种超员，面包也永远吃不掉（占用率只有 41%）。
         *
         * 2026-11-06 用户改口径："兵营里面出的兵不占人口。" ⇒ 兵营的兵**不再查人口**
         *（卡牌出的兵照旧）。面包照查 —— 不占人口 ≠ 白吃饭，磨坊仍是真闸门。
         */
        const sup = this.supplyOf(b.side);
        if (sup.bread + SUPPLY.unitBread > sup.breadMax) {
          continue;
        }
        const at = this.spawnCellOf(b);
        this.spawnSquad(b.side, [{ unitId: b.side === 'blue' ? 'knight' : 'orc', count: 1 }], at.col, at.row, true);
        continue;
      }
      /**
       * **兽人巢穴自动出兵**（P-095，用户："应该也自动出一个普通兽人兵，和这个军营一样"）。
       *
       * 和兵营同一条链：每 `BARRACKS.interval` 秒吐 1 个、不花金、
       * `fromBarracks=true` 不借闲置人口、场上总兵数受 `BARRACKS.cap` 限制。
       * 出的是**普通近战兽人 `orc`**（不是投矛手）—— 用户点名"普通兽人兵"。
       *
       * 两条和兵营刻意不同的地方（别"顺手对齐"）：
       * ① **不查后勤**：兽人巢穴的既有口径是"只要花钱 + 有空位就能盖"，
       *    `needsHouse()` 不列它，加一道民居/磨坊闸等于偷偷改掉这条设定；
       * ② **面包按兵营口径吃 1 份**（`ORC_LAIR.breadPerMan = 1`）。
       *    试过给自动兽人按卡牌兽人的双份口粮：它会把面包容器挤满、
       *    反而卡住真正拆楼的卡牌兵，48 局台账从 2.0 掉到 1.94 栋/局。
       *    白送的守兵和花牌买的兽人军队不是一回事，别把两条口径混成一个数。
       */
      if (b.kind === 'orcLair') {
        b.timer += dt;
        if (b.timer < BARRACKS.interval) continue;
        b.timer = 0;
        const mine = this.units.filter((u) => u.side === b.side).length;
        if (mine >= BARRACKS.cap) continue;
        const sup = this.supplyOf(b.side);
        if (sup.bread + ORC_LAIR.breadPerMan * SUPPLY.unitBread > sup.breadMax) continue;
        const at = this.spawnCellOf(b);
        this.spawnSquad(b.side, [{ unitId: 'orc', count: 1 }], at.col, at.row, true, ORC_LAIR.breadPerMan, 0);
        continue;
      }
      // 产金建筑：磨坊 +1、商行 +2，数量只从 config.GOLD_INCOME 读
      const income = goldIncomeOf(b.kind);
      if (income > 0) {
        // 商行要配 1 座民居才开工；缺配连计时也停，补上后从 0 开始（和兵营同款）
        if (b.kind === 'guild' && !support[b.side].has(b.id)) {
          b.timer = 0;
          continue;
        }
        b.timer += dt;
        if (b.timer < ECONOMY.millInterval) continue;
        b.timer = 0;
        const p = this.playerOf(b.side);
        p.gold = Math.min(ECONOMY.cap, p.gold + income);
        continue;
      }
      // 塔也要人手：没配到民居的那座**不开火**（用户 2026-10-31："防御建筑也占一处民房"）。
      // 缺配时不动 fireIn —— 补上人手立刻能打，不用再等一个装填周期。
      if (!support[b.side].has(b.id)) continue;
      // 塔打最近的敌兵或敌方建筑（用户 2026-10-27 追加："防御性建筑之间互相也会攻击"）
      b.fireIn = Math.max(0, b.fireIn - dt);
      if (b.fireIn > 0) continue;
      const spec = b.kind === 'arrowTower' ? TOWER.arrow : TOWER.cannon;
      const c = this.buildingCenter(b);
      /**
       * 射程一律**从占地边缘量**，和"兵打建筑时按边缘算距离"同一口径。
       * 3×3 之后这条必须改：以前塔从中心量 4.4 格，只够到边缘外 2.9 格，
       * 而弓箭手在边缘外 3.6 格就能打到它 —— 差 0.7 格，正好白嫖整座炮塔。
       */
      const edge = Math.max(b.cols, b.rows) / 2;
      /**
       * 塔的目标不再是"只有兵"：**敌方的塔/楼也打**（用户 2026-10-27：
       * "防御性建筑之间互相也会攻击，只要瞄准到了"）。取"最近的敌对目标"，
       * 兵和建筑放在同一个池子里比距离 —— 打建筑时按占地边缘算，和兵那套同一口径。
       */
      const target = this.nearestTowerTarget(b, c.x, c.z, spec.range + edge);
      if (!target) continue;
      b.fireIn = spec.interval;
      b.aim = Math.atan2(target.z - c.z, target.x - c.x);
      b.shotsMuzzle = 0.18;
      this.shots.push({
        id: this.nextId++,
        ammo: b.kind === 'arrowTower' ? 'arrow' : 'cannon',
        source: b.kind === 'arrowTower' ? 'arrowTower' : 'cannonTower',
        fromX: c.x,
        fromZ: c.z,
        toX: target.x,
        toZ: target.z,
        t: 0,
        seconds: b.kind === 'arrowTower' ? 0.22 : 0.45,
        targetId: target.unit?.id,
      });
      const dmg = spec.damage;
      if ('splash' in spec && spec.splash) {
        for (const u of this.units) {
          if (u.side === b.side || u.hp <= 0) continue;
          if (!canHitAir(b.kind) && this.flyingOf(u.defId)) continue;
          if (Math.hypot(u.x - target.x, u.z - target.z) <= spec.splash) this.hurtUnit(u, dmg);
        }
      } else if (target.unit) {
        this.hurtUnit(target.unit, dmg);
      } else if (target.building) {
        // 箭塔打出来的是箭（墙正常掉一块），炮塔打出来的是炮弹（墙炸散）
        this.hurtBuilding(target.building, dmg, b.kind === 'arrowTower' ? 'arrow' : 'cannon', b.side);
      }
    }
    this.units = this.units.filter((u) => u.hp > 0);
  }

  /** 弹丸只是视觉：到点就删，不影响任何判据。 */
  private tickShots(dt: number): void {
    for (const s of this.shots) s.t = Math.min(1, s.t + dt / s.seconds);
    this.shots = this.shots.filter((s) => s.t < 1);
    for (const b of this.buildings.values()) {
      if (b.shotsMuzzle > 0) b.shotsMuzzle = Math.max(0, b.shotsMuzzle - dt);
    }
  }

  /**
   * **扑翼轰炸机**（2026-11-07 设计文档 E 节，用户第二份 HTML）：
   * 从己方直冲敌方，不索敌；检测「下方」半径内有敌方军队就投弹（溅射）；
   * 飞出地图直接消失（记进 leftField，视图不播解体）；在地图内被打掉则走正常死亡
   * ⇒ 视图按「飞行单位被击毁」播解体 + 火。
   */
  /** mobileCannon / ballista 不在 UNITS 表里（statsOf 特判），直接 unitDef 会抛异常 */
  private flyingOf(defId: string): boolean {
    if (defId === 'mobileCannon' || defId === 'ballista') return false;
    return unitDef(defId).flying === true;
  }

  private bomberOf(defId: string): boolean {
    if (defId === 'mobileCannon' || defId === 'ballista') return false;
    return unitDef(defId).bomber === true;
  }

  private tickBomber(u: ArenaUnit, speed: number, dt: number): void {
    const dir = u.side === 'blue' ? 1 : -1;
    u.x += dir * speed * dt;
    u.aim = dir > 0 ? 0 : Math.PI;
    u.bombIn = Math.max(0, (u.bombIn ?? 0) - dt);
    if (u.bombIn <= 0) {
      let target: ArenaUnit | null = null;
      let best = BOMBER.detect;
      for (const e of this.units) {
        // 炸弹是往下掉的，够不着空中；判据仍统一读 AA_SOURCES
        //（'bomber' 不在表里），别在这里另写一份"飞行单位不算靶子"。
        if (e.side === u.side || e.hp <= 0 || this.bomberOf(e.defId)) continue;
        if (!canHitAir('bomber') && this.flyingOf(e.defId)) continue;
        const d = Math.hypot(e.x - u.x, e.z - u.z);
        if (d <= best) { best = d; target = e; }
      }
      if (target) {
        u.bombIn = BOMBER.interval;
        this.shots.push({
          id: this.nextId++,
          ammo: 'cannon',
          source: 'unit',
          fromX: u.x,
          fromZ: u.z,
          toX: target.x,
          toZ: target.z,
          t: 0,
          seconds: 0.5,
        });
        for (const e of this.units) {
          if (e.side === u.side || e.hp <= 0) continue;
          if (!canHitAir('bomber') && this.flyingOf(e.defId)) continue;
          if (Math.hypot(e.x - target.x, e.z - target.z) <= BOMBER.splash) this.hurtUnit(e, BOMBER.damage);
        }
      }
    }
    if (u.x < -BOMBER.exitMargin || u.x > this.field.cols + BOMBER.exitMargin) {
      u.hp = 0;
      this.leftField.add(u.id);
    }
  }

  private tickUnits(dt: number): void {
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const st = statsOf(u.defId);
      u.cooldown = Math.max(0, u.cooldown - dt);
      u.stun = Math.max(0, u.stun - dt);
      if (u.stun > 0) continue;

      // 扑翼轰炸机：一次性直冲 + 下方投弹 + 飞出界消失，不参与常规索敌
      if (this.bomberOf(u.defId)) {
        this.tickBomber(u, st.speed, dt);
        continue;
      }

      // 牧师：每 spec.every 秒给身边 radius 格内的自己人回 amount 血（兵种表里的 special）
      if (u.defId === 'priest') {
        const spec = unitDef('priest').special!;
        const radius = spec.radius ?? 3;
        const amount = spec.amount ?? 6;
        /**
         * **优先照顾队友**（P-096 用户："他会优先跑到队友旁边回血，
         * 在没有队友的时候会自己攻击"）。
         *
         * 旧版是"边站着边奶边打"：治疗分支不 continue，牧师照旧索敌开火。
         * 现在分三种情况，且只有第三种会落到下面的通用攻击流程：
         *  ① 半径 `UNIT.priestSeek` 内有残血队友但**离得远** ⇒ 跑过去，不攻击；
         *  ② 已经站在队友旁边 ⇒ 按节拍治疗，不攻击；
         *  ③ 没有需要治疗的队友 ⇒ 不当奶妈了，走通用索敌，用法术弹道低攻输出。
         *
         * 「没有队友」按"没有**需要治疗**的队友"理解，不是字面上的孤身一人：
         * 否则牧师和一群满血队友站一起会永远不开火，那就废了。
         * 找队友时排除自己，避免残血牧师原地自奶、再也不推进。
         */
        let patient: ArenaUnit | null = null;
        let best = Infinity;
        for (const ally of this.units) {
          if (ally === u || ally.side !== u.side || ally.hp <= 0 || ally.hp >= ally.maxHp) continue;
          const d = Math.hypot(ally.x - u.x, ally.z - u.z);
          if (d <= UNIT.priestSeek && d < best) {
            best = d;
            patient = ally;
          }
        }
        if (patient) {
          // 节拍照走：追赶途中也在攒治疗，一进半径就能立刻奶，不用再等 2.5 秒
          u.healIn = (u.healIn ?? spec.every) - dt;
          if (best > radius * 0.75) {
            /**
             * 追赶要**比被奶的兵快**，否则残血队友带行军指令一路往前跑时，
             * 牧师永远追不上 ⇒ 既不治疗也不攻击，整张卡变废兵（实测探针：
             * 牧师 1.3 格/s 追骑士 1.35 格/s，healIn 卡在 1.45 再也不动）。
             * 1.4 倍是给"优先照顾队友"这条口径的通行保障，不是加战斗力。
             */
            const step = Math.min(best - radius * 0.5, st.speed * 1.4 * dt);
            this.stepUnit(u, ((patient.x - u.x) / best) * step, ((patient.z - u.z) / best) * step);
          } else if (u.healIn <= 0) {
            u.healIn = spec.every;
            let healed = 0;
            for (const ally of this.units) {
              if (ally.side !== u.side || ally.hp <= 0 || ally.hp >= ally.maxHp) continue;
              if (Math.hypot(ally.x - u.x, ally.z - u.z) > radius) continue;
              ally.hp = Math.min(ally.maxHp, ally.hp + amount);
              healed += 1;
            }
            if (healed > 0) this.heals.push({ id: this.nextId++, x: u.x, z: u.z, ttl: 0.6 });
          }
          continue; // 有伤员要照顾：这一帧不索敌、不开火
        }
      }

      /**
       * **守家拦截**（2026-11-06 用户："敌人已经过境了，我方的军队还在家里面，
       * 并没有保护家园，而是往对面冲"）。
       *
       * 敌兵摸进我方腹地（距我方大本营 < UNIT.defendRadius）⇒ 索敌视野扩到
       * UNIT.alertSight：过境的敌人会被家里的兵转身追打。敌人没入侵腹地时
       * 视野照旧 —— 全员回头追击会让"拖建筑"的推进打法消失。
       */
      let sight = st.sight;
      const myCore = this.coreOf(u.side);
      if (myCore) {
        const hx = myCore.col + myCore.cols / 2;
        const hz = myCore.row + myCore.rows / 2;
        for (const e of this.units) {
          if (e.side === u.side || e.hp <= 0) continue;
          if (Math.hypot(e.x - hx, e.z - hz) < UNIT.defendRadius) {
            sight = Math.max(sight, UNIT.alertSight);
            break;
          }
        }
      }
      const foe = this.nearestHostile(u, sight, st.buildingsOnly, st.unitsOnly);
      if (foe && foe.dist <= st.range) {
        // 锁敌即转向目标（哪怕还在装填）—— 站着开火时位移为 0，
        // 旧视图会保持行军朝向，于是敌兵从背后压上来就出现"背对背开打"。
        u.aim = Math.atan2(foe.z - u.z, foe.x - u.x);
        if (u.cooldown > 0) continue;
        u.cooldown = st.cooldown;
        // 远程单位/移动火炮都要有"打出去一发"的视觉：弹道飞过去 + 枪口冒烟
        if (st.siege) {
          const isBolt = u.defId === 'ballista';
          this.shots.push({
            id: this.nextId++,
            ammo: isBolt ? 'arrow' : 'cannon',
            source: isBolt ? 'ballista' : 'siege',
            fromX: u.x,
            fromZ: u.z,
            toX: foe.x,
            toZ: foe.z,
            t: 0,
            seconds: isBolt ? 0.3 : 0.5,
          });
        } else {
          const def = unitDef(u.defId);
          if (def.projectile) {
      this.shots.push({
        id: this.nextId++,
        ammo: def.projectile,
        source: 'unit',
        fromX: u.x,
        fromZ: u.z,
        toX: foe.x,
        toZ: foe.z,
        t: 0,
        seconds: def.projectile === 'cannon' ? 0.45 : def.projectile === 'magic' ? 0.4 : 0.28,
        targetId: foe.unit?.id,
      });
          }
        }
        if (foe.unit) this.hurtUnit(foe.unit, st.damage);
        else if (foe.building) {
          // 拆楼的墙崩法看这一条：近战=刀砍、法师=法术、弩车=箭、移动火炮=炮弹
          const proj = st.siege ? (u.defId === 'ballista' ? 'arrow' : 'cannon') : unitDef(u.defId).projectile;
          const hit: HitKind = proj === 'magic' ? 'magic' : proj === 'arrow' ? 'arrow' : 'blade';
          this.hurtBuilding(foe.building, st.damage, hit, u.side);
        }
        // 近战命中报给视图（远程有弹丸，到点自己放特效；这里再报就是双重特效）
        if (!st.siege && !unitDef(u.defId).projectile) {
          const def = unitDef(u.defId);
          const dx = foe.x - u.x;
          const dz = foe.z - u.z;
          const len = Math.hypot(dx, dz) || 1;
          this.hits.push({
            id: this.nextId++,
            x: foe.x,
            z: foe.z,
            y: (def.heightTiles ?? 1.45) * 0.62,
            dirX: dx / len,
            dirZ: dz / len,
            heavy: def.role === 'tank',
            ttl: 0.08,
            unitId: foe.unit?.id,
          });
        }
        continue;
      }

      // 有玩家指令就先朝那儿走；走到了自动清空、恢复默认推进
      if (u.order) {
        const dx = u.order.x - u.x;
        const dz = u.order.z - u.z;
        const d = Math.hypot(dx, dz);
        if (d <= 0.35) u.order = null;
        else {
          const step = Math.min(d, st.speed * dt);
          this.stepUnit(u, (dx / d) * step, (dz / d) * step);
          continue;
        }
      }

      // 没得打就朝对方大本营走；路上被谁挡住就贴上去打（下面这一支）
      const goal = this.coreOf(u.side === 'blue' ? 'red' : 'blue');
      const gx = goal ? goal.col + goal.cols / 2 : this.field.cols / 2;
      const gz = goal ? goal.row + goal.rows / 2 : this.field.rows / 2;
      const tx = foe ? foe.x : gx;
      const tz = foe ? foe.z : gz;
      const dist = Math.hypot(tx - u.x, tz - u.z);
      if (dist < 0.001) continue;
      const step = Math.min(dist, st.speed * dt);
      this.stepUnit(u, ((tx - u.x) / dist) * step, ((tz - u.z) / dist) * step);
    }
    this.units = this.units.filter((u) => u.hp > 0);
  }

  /** 最近的敌对目标：先看兵，再看建筑。 */
  private nearestHostile(
    u: ArenaUnit,
    sight: number,
    buildingsOnly: boolean,
    unitsOnly = false,
  ): { dist: number; x: number; z: number; unit?: ArenaUnit; building?: ArenaBuilding } | null {
    let best: { dist: number; x: number; z: number; unit?: ArenaUnit; building?: ArenaBuilding } | null = null;

    /**
     * **对空兵优先打空中**（2026-11-09 用户："为什么这个弓箭手先打地面呢？
     * 弓箭手优先打空中单位啊"）。
     * 有对空资格的兵种（弓箭手 / 兽人投矛手）在**射程内**只要看到空中单位，
     * 无条件先打它，压过贴脸的地面兵和建筑。
     * 用 min(sight, range) 而不是只用 sight：选了"看得见却够不着"的空中目标
     * 会让兵站着不开火也不推进。
     */
    if (!buildingsOnly && canHitAir(u.defId)) {
      const reach = Math.min(sight, statsOf(u.defId).range);
      let air: { dist: number; x: number; z: number; unit?: ArenaUnit } | null = null;
      for (const other of this.units) {
        if (other.side === u.side || other.hp <= 0 || !this.flyingOf(other.defId)) continue;
        const d = Math.hypot(other.x - u.x, other.z - u.z);
        if (d <= reach && (!air || d < air.dist)) air = { dist: d, x: other.x, z: other.z, unit: other };
      }
      if (air) return air;
    }

    // buildingsOnly 现在对移动火炮是 false（它要能打兵）；字段留着给以后"纯攻城"的兵种
    for (const other of buildingsOnly ? [] : this.units) {
      if (other.side === u.side || other.hp <= 0) continue;
      // 空中目标统一交给上面那段对空优先逻辑：没有对空资格 / 空中在射程外，都只比地面兵
      if (this.flyingOf(other.defId)) continue;
      const d = Math.hypot(other.x - u.x, other.z - u.z);
      if (d <= sight && (!best || d < best.dist)) best = { dist: d, x: other.x, z: other.z, unit: other };
    }
    // 贴脸的敌兵仍然先还手，否则兵会被围死（这条不动）
    if (best || unitsOnly) return best;

    /**
     * 建筑按「距离 − 威胁加权」排序（用户 2026-11-06）：
     *   ① 防御设施（箭塔 / 炮塔）优先 —— 等效把塔拉近 4 格；
     *   ② 路上碰到其它建筑就先拆 —— 等效拉近 1.5 格；
     *   ③ 大本营最后 —— 不加权重，只有没别的目标时才轮到它。
     *
     * 用权重而不是硬性分类：近处的挡路民居（1 格）依然会压过远处那座塔（6 格），
     * 这正是「除非路上有其他的建筑物，就优先攻击建筑物」的意思。
     * 返回的 `dist` 仍是**真实边缘距离**，不给后续的射程判定掺水。
     */
    let bestScore = Number.POSITIVE_INFINITY;
    for (const b of this.buildings.values()) {
      if (b.side === u.side) continue;
      const c = this.buildingCenter(b);
      const d = Math.hypot(c.x - u.x, c.z - u.z);
      // 打建筑要看"贴到占地边缘"，不然大建筑永远够不着
      const edge = Math.max(0, d - Math.max(b.cols, b.rows) / 2);
      if (edge > sight) continue;
      const score = edge - this.buildingThreat(b);
      if (score < bestScore) {
        bestScore = score;
        best = { dist: edge, x: c.x, z: c.z, building: b };
      }
    }
    return best;
  }

  /** 军队眼里这栋楼有多"该先拆"（等效缩短的格数）。 */
  private buildingThreat(b: ArenaBuilding): number {
    if (b.kind === 'core') return 0;
    if (b.kind === 'arrowTower' || b.kind === 'cannonTower') return 4;
    return 1.5;
  }

  /** 塔的目标池：敌兵与敌方建筑放在一起比距离（建筑按占地边缘算）。 */
  private nearestTowerTarget(
    tower: ArenaBuilding,
    x: number,
    z: number,
    range: number,
  ): { dist: number; x: number; z: number; unit?: ArenaUnit; building?: ArenaBuilding } | null {
    let best: { dist: number; x: number; z: number; unit?: ArenaUnit; building?: ArenaBuilding } | null = null;
    const aa = canHitAir(tower.kind);
    for (const u of this.units) {
      if (u.side === tower.side || u.hp <= 0) continue;
      if (!aa && this.flyingOf(u.defId)) continue;
      const d = Math.hypot(u.x - x, u.z - z);
      if (d <= range && (!best || d < best.dist)) best = { dist: d, x: u.x, z: u.z, unit: u };
    }
    for (const other of this.buildings.values()) {
      if (other.side === tower.side || other.id === tower.id) continue;
      const c = this.buildingCenter(other);
      const edge = Math.max(0, Math.hypot(c.x - x, c.z - z) - Math.max(other.cols, other.rows) / 2);
      if (edge <= range && (!best || edge < best.dist)) best = { dist: edge, x: c.x, z: c.z, building: other };
    }
    return best;
  }

  /** 这一格被楼占着吗（兵不许走进去，但可以贴着站）。 */
  /**
   * 这个点是不是被楼挡住（P-096 内缩）。
   *
   * 旧版按 `Math.floor(x)` 落在整格里就判挡住 —— 两栋楼贴在一起时中间
   * 一个可站的格子都没有，兵绕障转 11 个角度也出不去（用户："建筑物建得太满，
   * 军队会无法通行"）。现在把每栋楼的阻挡矩形四边各收 `UNIT.buildingInset`，
   * 紧贴的两栋之间就留出一条缝；**落牌的 `cellFree` 不读这里**，仍按整格占位，
   * 所以楼不会盖到彼此身上。
   */
  private blockedBy(x: number, z: number): boolean {
    const inset = UNIT.buildingInset;
    for (const b of this.buildings.values()) {
      if (
        x > b.col + inset && x < b.col + b.cols - inset &&
        z > b.row + inset && z < b.row + b.rows - inset
      ) return true;
    }
    return false;
  }

  /**
   * 走一步；撞到楼就**换角度绕过去**（±0.55 / ±0.95 / ±1.4 弧度）。
   *
   * 上一版是"沿 x 轴、再沿 z 轴滑一格，两边都堵住就原地不动"——正对着一面墙走过去，
   * 两个轴都被堵住，兵就永远贴在那儿（用户："撞到建筑然后不动了"）。
   * 现在先试直走，不行就按 `detour` 那一侧斜着绕；哪边通了就记住那边。
   */
  private stepUnit(u: ArenaUnit, dx: number, dz: number): void {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    // 行军时朝向跟着这一步走（攻击分支会先把它覆盖成"对准目标"）
    u.aim = Math.atan2(dz, dx);
    // 飞行单位：越过建筑/黄区，不做绕障（设计文档 C 节 v1）
    if (this.flyingOf(u.defId)) {
      u.x += dx;
      u.z += dz;
      return;
    }
    const base = Math.atan2(dz, dx);
    const side = u.detour ?? 1;
    // 必须包含 ±90°：贴着墙走时任何带前进分量的方向都会撞墙，只有纯侧移能滑出去
    const turns = [
      0,
      0.55 * side,
      0.95 * side,
      1.35 * side,
      1.57 * side,
      2.1 * side,
      0.55 * -side,
      0.95 * -side,
      1.35 * -side,
      1.57 * -side,
      2.1 * -side,
    ];
    for (const turn of turns) {
      const a = base + turn;
      const nx = u.x + Math.cos(a) * len;
      const nz = u.z + Math.sin(a) * len;
      if (this.blockedBy(nx, nz)) continue;
      if (turn * side < 0) u.detour = side === 1 ? -1 : 1;
      u.x = nx;
      u.z = nz;
      return;
    }
    // 四面都堵死、而且自己已经站在楼里：先挪出去，避免永久卡死
    if (this.blockedBy(u.x, u.z)) {
      u.x += dx;
      u.z += dz;
    }
  }

  private hurtUnit(u: ArenaUnit, attack: number): void {
    const before = u.hp;
    u.hp -= damageOf(attack, statsOf(u.defId).defense);
    if (u.hp < 0) u.hp = 0;
    /**
     * PVE 的击杀计数放在这里，不放在 `filter` 之前 ——
     * 单位会在**三个地方**被清掉（塔开火后、`tickUnits` 末尾、离场），
     * 挂在清场旁边就会漏数一半（实测 48 个怪只数到 10 个）。
     * 挂在"血量跨过 0 的那一刻"才是唯一正确的位置。
     */
    if (before > 0 && u.hp === 0 && u.side === 'red' && this.pve) this.pve.slain++;
  }

  /**
   * 这一侧"配齐后勤"的楼 —— 能干活的那一批。
   *
   * 规则（用户 2026-10-31："必须要有一个磨坊提供食物，还有一处民房，
   * 防御建筑也占一处民房。要求是严格的，咱们是要拖他的建筑，去处理攻防"）：
   *
   * | 楼 | 要什么 |
   * | --- | --- |
   * | 兵营 | 1 座磨坊 + 1 座民居 |
   * | 箭塔 / 炮塔 | 1 座民居 |
   * | 磨坊 / 民居 | 自己不吃名额 |
   *
   * 名额**先盖先得**（楼号升序），和以前"两座兵营只配了一套后勤时先盖的那座开工"同一口径，
   * 所以同 seed 同摆法的结果一定可复现。
   *
   * 这条规则把"金币"从主约束降成次约束：一局能同时养多少楼，看的是**民居/磨坊**，
   * 不是看你攒了多少钱。拆掉对方两座民居，对方后配的两座塔立刻哑火 —— 这才是攻防抓手。
   */
  private staffedIds(side: Side): Set<number> {
    // 施工中的楼**不吃名额**：还没干活的楼凭什么抢民居（抢了会让兵营停工）
    const mine = [...this.buildings.values()].filter((b) => b.side === side && b.hp > 0 && b.build >= 1);
    let mills = mine.filter((b) => b.kind === 'mill').length;
    let houses = mine.filter((b) => b.kind === 'house').length;
    const consumers = mine
      .filter((b) => needsHouse(b.kind))
      .sort((a, b) => {
        // **兵营优先**（它要两样，是产兵的主路径），同档内才按楼号先盖先得。
        // 纯按楼号排过一次，结果民居被先盖的塔抢走、兵营一直冷着（实测 seed 11 红方 0 兵）。
        const rank = (kind: string) => (kind === 'barracks' ? 0 : 1);
        return rank(a.kind) - rank(b.kind) || a.id - b.id;
      });

    const out = new Set<number>();
    for (const b of consumers) {
      const needMill = b.kind === 'barracks' ? LOGISTICS.barracksMill : 0;
      const needHouse = b.kind === 'barracks' ? LOGISTICS.barracksHouse
        : b.kind === 'guild' ? LOGISTICS.guildHouse : LOGISTICS.towerHouse;
      if (mills < needMill || houses < needHouse) continue;
      mills -= needMill;
      houses -= needHouse;
      out.add(b.id);
    }
    return out;
  }

  /** 当前有几座兵营在开工（HUD/提示用）。 */
  supportedBarracks(side: Side): number {
    const staffed = this.staffedIds(side);
    let n = 0;
    for (const b of this.buildings.values()) {
      if (b.side === side && b.kind === 'barracks' && staffed.has(b.id)) n++;
    }
    return n;
  }

  /** 这一侧"要后勤的楼"总共几座（HUD 拿来写 `2/3 配齐`）。 */
  needStaffing(side: Side): number {
    let n = 0;
    for (const b of this.buildings.values()) {
      if (b.side === side && needsHouse(b.kind)) n++;
    }
    return n;
  }

  /** 这一侧已经配齐的楼数。 */
  staffedCount(side: Side): number {
    return this.staffedIds(side).size;
  }

  /**
   * 这座楼配齐后勤了吗（视图用它挂"缺磨坊/民居"的提示）。
   * 磨坊/民居/大本营自己没有后勤要求，恒为 true —— 它们不是"要干活的楼"。
   * 商行是：没配到民居就不产金（2026-11-09 用户："要占用两个人口和一个房子"）。
   */
  isStaffed(id: number): boolean {
    const b = this.buildings.get(id);
    if (!b) return true;
    if (!needsHouse(b.kind)) return true;
    return this.staffedIds(b.side).has(id);
  }

  // ---------------------------------------------------------------- 手动修复

  /**
   * **这栋楼现在该不该冒小锤子**。判据全在纯逻辑层，视图只读结果 ——
   * 否则"按钮出现了但点了没反应"这种假读数又会出现。
   */
  /**
   * `side` 传了 = 额外校验阵营（手动派单 / 玩家侧查询用）；
   * **不传 = 只看规则本身，给自动派单用** —— 双方对称，AI 也受同一条规则管。
   */
  repairEligible(b: ArenaBuilding, side?: Side): boolean {
    if (side && b.side !== side) return false;
    if (REPAIR.excludeCore && b.kind === 'core') return false; // 大本营是胜负判据
    if (b.hp <= 0 || b.hp >= b.maxHp) return false;           // 满血 / 已拆不修
    if (b.build < 1) return false;                             // 施工中不修
    if (b.repairLeft > 0) return false;                        // 正在修，不重复派单
    return this.elapsed - b.lastHitAt >= REPAIR.idleSeconds;   // 脱战
  }

  isRepairing(id: number): boolean {
    return (this.buildings.get(id)?.repairLeft ?? 0) > 0;
  }

  /**
   * 手动派单入口（UI 已经不点了，留给测试与以后可能的手工操作）。
   * 正常对局里 `tickRepairs` 会自动派单，不经过这里。
   */
  startRepair(id: number, side: Side): boolean {
    const b = this.buildings.get(id);
    if (!b || !this.repairEligible(b, side)) return false;
    b.repairLeft = REPAIR.seconds;
    return true;
  }

  /**
   * 每帧：脱战够久就**自动开工**（2026-11-08 用户："不需要点按钮，就是自动修复"），
   * 然后按各楼 maxHp 的比例回血。一段结束还没满就自动接下一段，直到修满或再次挨打。
   * 挨打时 `hurtBuilding` 会把 `repairLeft` 清零，这一帧就停。
   */
  private tickRepairs(dt: number): void {
    for (const b of this.buildings.values()) {
      if (b.repairLeft <= 0) {
        // 不带 side ⇒ 双方对称。放在这里而不是视图层，是为了让托管/AI 局也走同一条规则。
        if (!this.repairEligible(b)) continue;
        b.repairLeft = REPAIR.seconds;
      }
      b.repairLeft = Math.max(0, b.repairLeft - dt);
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * REPAIR.fractionPerSecond * dt);
      if (b.hp >= b.maxHp) b.repairLeft = 0;
    }
  }

  /**
   * 唯一的**对楼伤害入口**（P-094 起同时也是**拆楼账本的唯一写入口**）。
   *
   * `by` 是谁动的手：塔开火传塔的阵营、兵砍楼传兵的阵营。判不到就按
   * 「被拆方的对面」兜底 —— 塔索敌只找敌对目标，正常不会走到兜底。
   * 账单左右两栏、判据③「拆掉对方多少」都从 `destroyLog` 读，别在别处另记一份。
   */
  private hurtBuilding(b: ArenaBuilding, attack: number, kind: HitKind = 'blade', by: Side | null = null): void {
    // 唯一的对楼伤害入口：兵砍 / 塔炮 / 炮弹都在这里乘平衡倍率，
    // 兵种互殴走 hurtUnit → damageOf(attack, defense)，不受影响（P-066）。
    //
    // **PVE 不吃这个倍率**：PVE 没有敌方建筑可拆（连红方大本营都不生成），
    // 会走 hurtBuilding 的只有怪拆玩家的楼 —— 给怪翻倍是单方面削玩家。
    // 实测 12 局教学关从 9 胜掉到 4 胜就是这么来的。
    // 1v1 与 **1v1 无尽** 都吃倍率：无尽只是去掉时限，拆楼手感必须和对战一致。
    const scale = this.mode === 'pve' ? 1 : BUILDING_DAMAGE_SCALE;
    b.hp -= damageOf(attack * scale, 0);
    b.lastHit = kind;
    // 挨打 = 重新进入战斗：脱战计时归零、正在进行的修复立刻打断。
    // 这两行和 tickRepairs / repairEligible 共用同一对字段，别在视图层另记一份时间。
    b.lastHitAt = this.elapsed;
    b.repairLeft = 0;
    if (b.hp < 0) b.hp = 0;
    if (b.hp > 0) return;
    this.buildings.delete(b.id);
    // 科技载体被拆 ⇒ 立刻重新上锁（手牌里的高级卡换成允许卡）
    if (b.kind === 'barracks' || b.kind === 'gearFactory') this.purgeLocked(b.side);
    // "拖他的建筑"的账本：记的永远是**谁被拆了**，判胜时反过来看（我拆掉对方多少）
    this.destroyed[b.side] += 1;
    // P-094 结算账单：一栋楼一条明细，含种类、归属、动手方、时间、坐标。
    // `destroyed[]` 只留总数给旧判据用，明细给玩家看「到底拆了哪些」。
    this.destroyLog.push({
      id: b.id,
      kind: b.kind,
      owner: b.side,
      by: by ?? (b.side === 'blue' ? 'red' : 'blue'),
      at: this.elapsed,
      col: b.col,
      row: b.row,
    });
    // 留一堆废墟，过一会儿自己塌平（用户：被摧毁的地方要留废墟，等一段时间才消失）
    this.ruins.push({
      id: this.nextId++,
      kind: b.kind,
      side: b.side,
      col: b.col,
      row: b.row,
      cols: b.cols,
      rows: b.rows,
      ttl: RUIN.seconds,
      total: RUIN.seconds,
    });
  }

  // ---------------------------------------------------------------- PVE 波次

  /**
   * 按波次表放怪（2026-11-07）。
   *
   * 三条口径（`docs/工作笔记/PVE模式设计_20261107.md` §4）：
   * - **一条推进方向、多个出生行**：怪沿 -col 走，目标永远是 blue 大本营；
   * - **不追远处的兵**：索敌半径照旧（只打贴脸的），用的还是同一套 `tickUnits`；
   * - **不吃面包、不占人口、不产金** —— 所以波次可以随便加怪，不牵动后勤经济。
   */
  private tickWaves(dt: number): void {
    const s = this.pve;
    if (!s || this.outcome !== 'playing') return;
    if (s.next >= s.level.waves.length) return;

    s.countdown -= dt;
    if (s.countdown > 0) return;

    const wave = s.level.waves[s.next]!;
    this.spawnWave(wave, s.level, s);
    s.next++;
    const nextWave = s.level.waves[s.next];
    // 间隔用"两波 at 之差"而不是绝对值 —— 掉帧/快进时不会一口气连放三波
    s.countdown = nextWave ? Math.max(0.5, nextWave.at - wave.at) : Number.POSITIVE_INFINITY;
  }

  /** 把一波里的每组怪摆到出生带上。同组沿 row 方向错开，不会叠成一坨。 */
  private spawnWave(wave: Wave, level: PveLevel, s: PveState): void {
    const col = wave.col ?? level.spawnCol;
    const lane = wave.lane ?? level.lane;
    for (const part of wave.spawns) {
      const row = part.row ?? this.rng.int(lane[0], lane[1]);
      const gap = part.gap ?? 0.62;
      const span = (part.count - 1) * gap;
      for (let n = 0; n < part.count; n++) {
        this.spawnWaveUnit(part.unitId, col + 0.5, row + 0.5 + n * gap - span / 2);
        s.spawned++;
      }
    }
  }

  /** 放一个波次怪。字段口径与 `spawnSquad` 一致，差别只有：**不吃面包**、不占人口。 */
  private spawnWaveUnit(unitId: string, x: number, z: number): void {
    const st = statsOf(unitId);
    const uid = this.nextId++;
    // 移动火炮/弩车不在 UNITS 表（走 MOBILE/BALLISTA 特判），读 special 会抛
    const healer = unitId === 'mobileCannon' || unitId === 'ballista' ? null : unitDef(unitId).special;
    this.units.push({
      id: uid,
      side: 'red',
      defId: unitId,
      x: Math.min(this.field.cols - 0.5, Math.max(0.5, x)),
      z: Math.min(this.field.rows - 0.5, Math.max(0.5, z)),
      hp: st.hp,
      maxHp: st.hp,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: uid % 2 === 0 ? 1 : -1,
      // 波次怪等价于"兵营出来的兵"：不占人口（PVE 里也没人统计它们的人口）
      fromBarracks: true,
      aim: Math.PI,
      healIn: healer?.kind === 'heal' ? healer.every : undefined,
      bombIn: this.bomberOf(unitId) ? BOMBER.interval * 0.5 : undefined,
      // 怪自带干粮：不吃玩家的面包
      breadCost: 0,
    });
  }


  // ---------------------------------------------------------------- AI

  /**
   * 托管方的节拍：**两边各一份倒计时**，谁开着谁就想。
   *
   * 原来只有一个 `aiIn` 且只喂红方 —— 蓝方托管后如果共用同一个计时器，
   * 两边会抢同一份倒计时（一边想完就清零，另一边这轮直接跳过），
   * 表现出来就是"红方一直在动、蓝方偶尔才动一下"。
   */
  private tickAi(dt: number): void {
    /**
     * 遍历**玩家槽**而不是阵营（2026-11-07 双人同屏）。
     *
     * 原来写的是 `for (const side of ['blue','red'])` + `playerOf(side)`，
     * 双人时 `playerOf('blue')` 只返回 players[0] ——
     * **玩家 1 永远不会被托管**：白拿金币、一栋楼不出，探针读数还看不出来
     * （因为托管只驱动了 0 号，看起来"打输了"其实是只有一个人在守）。
     * PVE 的波次怪本来就没有玩家槽，这里天然不会驱动到它。
     */
    for (const p of this.players) {
      if (!p.auto) continue;
      p.aiRerollIn = Math.max(0, p.aiRerollIn - dt);
      p.aiIn -= dt;
      if (p.aiIn > 0) continue;
      p.aiIn = AI.thinkSeconds;
      this.think(p);
    }
  }

  /**
   * 打开/关掉托管。红方不允许关（它没有手牌，关了就再也不动了）；
   * 双人同屏时按 `side` 一次设**所有**该阵营的玩家（两人的托管开关不分开做 UI）。
   */
  setAuto(side: Side, on: boolean): void {
    for (const p of this.playersOf(side)) {
      p.auto = side === 'red' ? true : on;
      if (on) p.aiIn = 0; // 开了就立刻想一次，别让玩家等 2.5 秒
    }
  }

  /**
   * ③ 执行层：把局面打包给 `ai.decide()`（纯函数），只按它返回的 action 动手。
   *
   * 这一层**不做任何判断** —— 「要不要刷新、该出第几张」全在 `ai.ts`，
   * 所以改动策略时不用碰世界状态，给一份 `AiView` 就能单测。
   */
  private think(p: PlayerSlot): void {
    const side = p.side;
    const mine = [...this.buildings.values()].filter((b) => b.side === side && b.kind !== 'core');
    const view: AiView = {
      hand: p.hand,
      gold: p.gold,
      count: (kind) => mine.filter((b) => b.kind === kind).length,
      // 容器读数直接复用 `supplyOf()`：AI 和 HUD 读同一份，不会算出两套账
      supply: this.supplyOf(side),
      rerollIn: p.aiRerollIn,
    };
    const action = decide(view);
    if (action.kind === 'reroll') {
      // 刷新保底一张民居；成功后上冷却，避免每 2.5 秒把钱刷光
      if (this.rerollOf(p).ok) p.aiRerollIn = AI.rerollCooldown;
      return;
    }
    if (action.kind === 'wait') return;
    const card = p.hand[action.slot];
    if (card) this.play(p, action.slot, card);
  }

  /** 把第 slot 张牌落到半场里一个随机空位（法术走另一条：它要在对面找目标）。 */
  private play(p: PlayerSlot, slot: number, card: ArenaCard): void {
    if (slot < 0) return;
    const cell = card.kind === 'spell'
      ? this.spellSpot(p.side, card)
      : this.randomSpot(p.side, card);
    if (!cell) return;
    this.playCardOf(p, slot, cell.col, cell.row);
  }

  /**
   * **AI 的法术落点**（P-104）—— 和 `randomSpot` 是两个完全不同的题。
   *
   * 为什么必须单独写：`randomSpot` 只在**自家半场**找空位（`lo/hi` 按 `midCol` 切），
   * 而法术的落点必须越过中线才有价值。如果让 AI 复用 `randomSpot`，
   * 它抽到法术卡会**永远放不出去**（落点在自己半场 ⇒ 打不到任何敌人 ⇒ 这张牌烂在手里），
   * 而且 `randomSpot` 还要求"格子空着"，法术所在的位置往往正好有敌兵。
   *
   * 策略：在**敌方一侧**按网格采样候选落点，给每个候选打分 = 圈内目标数（按法术的
   * `vsUnits` / `vsBuildings` 加权），挑最高的那个。**只打兵的剑雨不会往楼堆里丢**，
   * 只打楼的导弹不会浪费在兵线上 —— 分工由 `SPELL` 表决定，这里不写死。
   *
   * 打分全为空（对面没有任何它打得到的敌人）⇒ 返回 `null`，**这张牌这轮不出**。
   * 宁可烂在手里也不往空地上丢 20 金，这和玩家判断一致。
   */
  private spellSpot(side: Side, card: ArenaCard): { col: number; row: number } | null {
    const spec = card.spell ? SPELL[card.spell] : null;
    if (!spec) return null;

    // 只在敌方一侧找：蓝方打 col 大的一半，红方打 col 小的一半
    const cols = this.field.cols;
    const lo = side === 'blue' ? this.field.midCol : 1;
    const hi = side === 'blue' ? cols - 2 : this.field.midCol - 1;
    if (hi < lo) return null;

    // 每 2 格采一次样就够：半径都是 ≥1.6 格，再密只是重复命中同一批目标
    const STEP = 2;
    let best: { col: number; row: number; score: number } | null = null;
    for (let col = lo; col <= hi; col += STEP) {
      for (let row = 1; row < this.field.rows - 1; row += STEP) {
        const at = cellToWorld(pos(col, row));
        let score = 0;
        if (spec.vsUnits) {
          for (const u of this.units) {
            if (u.side === side || u.hp <= 0) continue;
            if (Math.hypot(u.x - at.x, u.z - at.z) <= spec.radius) score += 1;
          }
        }
        if (spec.vsBuildings) {
          for (const b of this.buildings.values()) {
            if (b.side === side || b.hp <= 0 || b.kind === 'core') continue;
            const bs = BUILDING_SPECS[b.kind];
            const w = cellToWorld(pos(b.col + (bs.cols - 1) / 2, b.row + (bs.rows - 1) / 2));
            const reach = spec.radius + Math.max(bs.cols, bs.rows) / 2;
            if (Math.hypot(w.x - at.x, w.z - at.z) <= reach) {
              // 楼给更高的权重：一发法术打掉一栋楼的价值远大于打死一个兵
              score += 3;
            }
          }
        }
        if (score <= 0) continue;
        // 同分时用 rng 打散，否则 AI 每一局都往同一个点丢，看起来像脚本
        if (!best || score > best.score || (score === best.score && this.rng.next() < 0.35)) {
          best = { col, row, score };
        }
      }
    }
    return best ? { col: best.col, row: best.row } : null;
  }

  /**
   * AI 的落点：自己半场、不压楼，**按卡种分层**（2026-11-07 用户："经济类建筑放后面，
   * 防御类建筑放前面"）。
   *
   * 上一版是整段 `[lo,hi]` 里纯随机 24 次，结果磨坊和箭塔混着盖 —— 塔缩在自家底线
   * 拦不到人、磨坊顶到前线白挨打。`placementBand()` 给出这类牌该待的纵深带
   * （t=0 自家底线 / t=1 最靠中场），这里按阵营把 t 翻成 col：
   * 蓝方前线是 col 大的一端，红方是 col 小的一端。
   *
   * **先试理想带 18 次，整段被占满再退回全范围 8 次** —— 策略是偏好不是硬限制，
   * 场地塞满时不能因为"挑位置"就把一张能出的牌烂在手里。
   */
  private randomSpot(side: Side, card: ArenaCard): { col: number; row: number } | null {
    const spec = card.kind === 'building' ? BUILDING_SPECS[card.building!] : { cols: 1, rows: 1 };
    // 禁建带要整段避开，而且**再多留一格**：建筑模型比占地宽（兵营 3.6 格 vs 占地 3 格），
    // 贴着黄线盖会看起来"楼压进了黄区"（用户 2026-11-02 就是这么以为的，其实格子没压）
    const margin = NO_BUILD.halfWidth + 2;
    const lo = side === 'red' ? this.field.midCol + margin : 1;
    const hi = side === 'red' ? this.field.cols - spec.cols - 1 : this.field.midCol - margin - spec.cols - 1;
    if (hi < lo) return null;

    const span = hi - lo;
    const band = placementBand(card);
    const near = side === 'blue' ? lo + band.lo * span : hi - band.hi * span;
    const far = side === 'blue' ? lo + band.hi * span : hi - band.lo * span;
    const clampCol = (v: number): number => Math.min(hi, Math.max(lo, v));
    const bandLo = clampCol(Math.floor(Math.min(near, far)));
    const bandHi = clampCol(Math.ceil(Math.max(near, far)));

    for (const [cLo, cHi, tries] of [
      [bandLo, bandHi, 18],
      [lo, hi, 8],
    ] as const) {
      for (let t = 0; t < tries; t++) {
        const col = this.rng.int(cLo, cHi + 1);
        const row = this.rng.int(1, this.field.rows - spec.rows - 1);
        if (col + spec.cols > this.field.cols || row + spec.rows > this.field.rows) continue;
        if (!this.cellIsFree(col, row, spec.cols, spec.rows)) continue;
        return { col, row };
      }
    }
    return null;
  }

  cellIsFree(col: number, row: number, cols: number, rows: number): boolean {
    return this.cellFree(col, row, cols, rows);
  }

  // ---------------------------------------------------------------- 胜负

  /**
   * 一局怎么结束 —— **三种半出路**，顺序写死在这里。
   *
   * ① **大本营被拆**（谁的没了谁输）。这条优先于时间轴：大本营在第 179 秒倒下就是输，
   *    不能因为"再过一秒时间到、比血量"就翻案。加时赛里也是这一条收场（sudden death）。
   * ② **加时赛**（2026-11-06 用户："一般来说没拆掉大本营有一个加时赛"）：
   *    常规 180 秒打满、两边大本营都还立着 ⇒ **不判胜负**，续 60 秒加时；
   *    加时里先拆掉对面大本营的赢；加时也打满，才回落到 ③。
   * ③ **打满加时**（总 5 分钟，2026-11-06 用户定）：**按积分判** ——
   *    比双方存活建筑数（多者胜）→ 一样比大本营剩血 → 再比**拆掉对方的楼数**
   *    （我拆你 3 栋、你拆我 1 栋，就是我压住了你）→ 再一样才判平。
   *    老的「时间到比判据」只在加时结束才生效 —— 没拆掉大本营不该提前判输赢。
   *
   * 上一版只有 ①和直接判。实测 8 个 seed 双方托管跑 600 秒，**一半的局到 10 分钟仍分不出胜负**，
   * 双方大本营 1200 满血 —— 不是数值问题，是根本没有时间出口。
   *
   * ③ 的第二判据**刻意不是"还剩几栋楼"**：那个判据奖励铺楼，和"建筑要协调经济"正好打架。
   * 实测 12 局按"剩楼数"判是蓝 1 胜 / 红 9 胜，而蓝方只是盖得少（6 栋 vs 9 栋），
   * 并不是打输了 —— 用"拆掉对方多少"才回到真正的攻防账本上。
   */
  private checkOutcome(): void {
    if (this.mode === 'pve') return this.checkPveOutcome();
    // 1v1 无尽：只判拆家，不判时间（见 checkEndlessOutcome）
    if (this.mode === 'endless') return this.checkEndlessOutcome();
    const blueCore = this.coreOf('blue');
    const redCore = this.coreOf('red');

    if (!blueCore && !redCore) return this.finish('draw', 'core', 'core');
    if (!redCore) return this.finish('win', 'core', 'core');
    if (!blueCore) return this.finish('lose', 'core', 'core');

    // ② 常规时间到、加时还没打满：**什么都不判**，接着打（sudden death）
    if (this.elapsed < MATCH.seconds + MATCH.overtimeSeconds) return;

    // ③ 加时打满（总 5 分钟，2026-11-06 用户定口径）：按**积分**判 ——
    //    ① 双方**存活建筑数**多者胜（用户："按照局内双方建筑的存活数来比拼积分"）；
    //    ② 一样多再比大本营剩血；
    //    ③ 再一样比拆掉对方的楼数；④ 都一样判平。
    //    注意：①是用户 2026-11-06 的新口径，**推翻**了 10-31"刻意不用剩楼数"的旧决策
    //    —— 铺楼从此有积分价值，理由写进 config.MATCH 注释。
    const blueFrac = blueCore.hp / CORE.hp;
    const redFrac = redCore.hp / CORE.hp;
    const blueAlive = this.countBuildings('blue');
    const redAlive = this.countBuildings('red');
    if (blueAlive !== redAlive) {
      return this.finish(blueAlive > redAlive ? 'win' : 'lose', 'overtime', 'alive');
    }
    // 浮点比较：大本营血量是整数减伤后的整数，但归一化会带误差，留一道细缝
    if (Math.abs(blueFrac - redFrac) > 1e-9) {
      return this.finish(blueFrac > redFrac ? 'win' : 'lose', 'overtime', 'coreHp');
    }
    const blueLost = this.destroyed.blue;
    const redLost = this.destroyed.red;
    if (blueLost !== redLost) return this.finish(redLost > blueLost ? 'win' : 'lose', 'overtime', 'destroyed');
    // 每级判据都分不出高低 ⇒ 平；账单会把这三级都列出来，玩家看得到「真的一样」
    this.finish('draw', 'draw', 'draw');
  }

  /**
   * **1v1 无尽判据**（2026-11-08 用户："无尽模式是 1V1 无尽，就是不限时间一直打"）。
   *
   * 和 `arena` 唯一的区别：**没有时间出口**。
   * 不读 `MATCH.seconds`、不进加时、不按存活楼数积分 ——
   * 只有拆掉对方大本营才结束，所以一局可以打十分钟、一小时，直到推平为止。
   * 场地、双方 AI、出牌、后勤、对楼伤害倍率全都和对战一模一样。
   *
   * 反证锁在 `tests/endless_20261108.test.ts`：把 MATCH.seconds 塞回这里会红。
   */
  private checkEndlessOutcome(): void {
    const blueCore = this.coreOf('blue');
    const redCore = this.coreOf('red');
    if (!blueCore && !redCore) return this.finish('draw', 'core', 'core');
    if (!redCore) return this.finish('win', 'core', 'core');
    if (!blueCore) return this.finish('lose', 'core', 'core');
    // 两边都还立着 ⇒ 继续打，没有 else
  }

  /**
   * **PVE 判据**（2026-11-07）—— 刻意与 1v1 完全分开：
   *
   * - 大本营被打穿 ⇒ `lose`（理由 `core`）；
   * - 全部波次放完 **且** 场上再没有活着的怪 ⇒ `win`（理由 `waves`）；
   * - **守满关卡的 `seconds`（5 分钟）且大本营还在** ⇒ 也算 `win` —— 残局会僵持
   *   （一只石怪拆一栋塔要 137 秒，实测拖到 376 秒），塔防不该没有尽头；
   * - 没有"倒计时判负"：时间本身不会让人输，输只有一种 —— 大本营被拆。
   *
   * 1v1 那套"加时 / 存活楼数 / 拆楼数"在这里**一条都不用** —— 这也是
   * `docs/工作笔记/PVE模式设计_20261107.md` §5 写死的那条红线。
   */
  private checkPveOutcome(): void {
    const s = this.pve;
    if (!s) return;
    if (!this.coreOf('blue')) return this.finish('lose', 'core');
    if (this.elapsed >= s.level.seconds) return this.finish('win', 'waves');
    if (s.next < s.level.waves.length) return;
    for (const u of this.units) {
      if (u.side === 'red' && u.hp > 0) return;
    }
    this.finish('win', 'waves');
  }

  /**
   * 结束一局（P-094 起顺手记下「到底哪一级判据分出的胜负」）。
   *
   * `decidedBy` 必须由**判定的那一刻**传进来，账单不许事后拿终局数据重算：
   * 判定之后 `update()` 就整段停了，但测试中手动改血/拆楼很容易让重算结果
   * 和当时的 winner 对不上，那种账单比没有还误导人。
   */
  private finish(outcome: Outcome, reason: OutcomeReason, decidedBy: LedgerDecider = null): void {
    this.outcome = outcome;
    this.outcomeReason = reason;
    this.ledgerDecider = decidedBy;
    this.cachedLedger = null;
  }

  /** 场上还立着的非大本营建筑数（HUD 读数用）。 */
  private countBuildings(side: Side): number {
    let n = 0;
    for (const b of this.buildings.values()) if (b.side === side && b.kind !== 'core' && b.hp > 0) n++;
    return n;
  }

  // ---------------------------------------------------------------- 结算账单（P-094）

  /**
   * 结算账单（对局中是 `null`；结算后惰性算一次并缓存）。
   *
   * `summary()` 是 20Hz 的读数出口，不能每帧重建账单数组 —— 所以这里
   * 只在第一帧真算，之后一直复用。`finish()` 会把缓存清空，避免「再来一局」
   * 之外手动改状态后账单还是旧的。
   */
  get ledger(): BattleLedger | null {
    if (this.outcome === 'playing') return null;
    if (!this.cachedLedger) this.cachedLedger = this.buildLedger();
    return this.cachedLedger;
  }

  /**
   * **把「为什么积分更多」拆成看得懂的左右两栏**（2026-11-09 用户：
   * "左右两边就像有个账单一样，显示销毁了哪些建筑，为什么积分更多"）。
   *
   * 数据源只有四样：`destroyLog`（谁拆了什么）、`countBuildings()`（终局存活）、
   * `coreOf()` 剩血、`finish()` 当时记下的 `ledgerDecider`。
   * 这里**不判胜负**，只把判定用过的那几级数摆出来 —— 判据在 `checkOutcome`，
   * 账单是它的镜子，别在这儿另算一遍谁赢。
   *
   * 三级比较的顺序必须和 `checkOutcome()` 一一对应（① 存活楼 ② 剩血 ③ 拆楼数），
   * 改判据时两边都要改；`tests/ledger_20261109.test.ts` 有顺序锁。
   */
  private buildLedger(): BattleLedger {
    const blue = this.sideLedger('blue');
    const red = this.sideLedger('red');
    const raw: Omit<LedgerCriterion, 'decided'>[] = [
      { key: 'alive', name: '存活建筑', hint: '多者胜：铺出来又没被拆掉的楼', blue: blue.alive, red: red.alive },
      { key: 'coreHp', name: '大本营剩血', hint: '存活楼数一样才比', blue: blue.coreHp, red: red.coreHp },
      { key: 'destroyed', name: '拆掉对方', hint: '前两项都一样才比', blue: blue.wreckedTotal, red: red.wreckedTotal },
    ];
    const criteria: LedgerCriterion[] = raw.map((c) => ({ ...c, decided: c.key === this.ledgerDecider }));
    return {
      blue,
      red,
      criteria,
      decidedBy: this.ledgerDecider,
      headline: this.ledgerHeadline(criteria),
    };
  }

  /** 一句话回答「为什么积分更多」；没走到三级判据就直说（PVE / 无尽 / 拆家）。 */
  private ledgerHeadline(criteria: LedgerCriterion[]): string {
    if (this.ledgerDecider === 'core') return '拆掉对方大本营 —— 直接结束，不用比积分';
    if (this.ledgerDecider === 'draw') return '三级判据全都一样 —— 平局';
    const hit = criteria.find((c) => c.decided);
    if (!hit) return '这一局不走 1v1 的三级积分判据（PVE / 无尽有自己的结算）';
    const who = hit.blue === hit.red ? '两边' : hit.blue > hit.red ? '蓝方' : '红方';
    return `${hit.name} 蓝 ${hit.blue} : 红 ${hit.red} ⇒ ${who}在这一项上更多，胜负就停在这一级`;
  }

  /** 一栏（左蓝 / 右红）：拆掉对方什么、自己丢了什么、终局还剩多少。 */
  private sideLedger(side: Side): SideLedger {
    const wrecked = this.aggregateWrecks(this.destroyLog.filter((r) => r.by === side));
    const lost = this.aggregateWrecks(this.destroyLog.filter((r) => r.owner === side));
    return {
      side,
      wrecked,
      wreckedTotal: wrecked.reduce((n, w) => n + w.count, 0),
      lost,
      lostTotal: lost.reduce((n, w) => n + w.count, 0),
      alive: this.countBuildings(side),
      coreHp: Math.round(this.coreOf(side)?.hp ?? 0),
    };
  }

  /**
   * 按建筑种类聚合（同名楼只占一行，不逐条刷屏），顺序跟 `BUILDING_LABEL`
   * 的声明顺序走 —— 表驱动，加新楼不用改这里。
   */
  private aggregateWrecks(records: DestroyRecord[]): LedgerWreck[] {
    const byKind = new Map<string, LedgerWreck>();
    for (const r of records) {
      const cur = byKind.get(r.kind);
      if (cur) {
        cur.count += 1;
        cur.firstAt = Math.min(cur.firstAt, r.at);
        cur.lastAt = Math.max(cur.lastAt, r.at);
      } else {
        byKind.set(r.kind, {
          kind: r.kind,
          name: buildingLabelOf(r.kind),
          count: 1,
          firstAt: r.at,
          lastAt: r.at,
        });
      }
    }
    const order = Object.keys(BUILDING_LABEL);
    return [...byKind.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  }

  /** 给 HUD 的一行读数：金、手牌、双方大本营血量、倒计时。 */
  /**
   * 这一侧的**人口三分 + 面包容器**读数（P-094，2026-11-09 重新分配）。
   *
   * ┌ 全部 `total` ─────────────────────────────────────────────────┐
   * │ = basePop + 民居 × housePop                                   │
   * ├── 占用 `used` ────────────────────────────────────────────────┤
   * │ = Σ BUILDING_POP[建筑种类]（**施工中的楼也算**：人手已派出去了，│
   * │   否则会出现"先把地盘占满再慢慢盖"的漏洞）                    │
   * │   **卡死**：只要楼还在就一直占，不随时间回血；拆楼才释放。     │
   * ├── 闲置 `idle` ────────────────────────────────────────────────┤
   * │ = max(0, total − used − debt)                                 │
   * │   debt = 军队卡借走还没还的人口，按 idleRegenSeconds 归还，  │
   * │   **兵死了也不立刻销账**（用户："放一个军队之后闲置人口慢慢涨"）│
   * └───────────────────────────────────────────────────────────────┘
   *
   * 面包照旧是**容器**（基础 + 磨坊，只由建筑决定；兵死立刻退还），
   * 和人口故意不同 —— 完整口径见 `config.SUPPLY` 的长注释。
   *
   * 兼容：`pop = used + debt`、`popMax = total` 是旧字段名，落牌校验与 AI 的
   * `SupplyView` 继续读它们；语义从「活兵实时占用」变成「占用 + 未还的债」，
   * 判定方向不变（数字越大越不能盖）。兵营自动兵 / 民兵 / 兽人
   * `popPerMan = 0` ⇒ 不借人口，面包照吃，旧口径一条没动。
   */
  supplyOf(side: Side): SupplyReadout {
    let total = SUPPLY.basePop;
    let breadMax = SUPPLY.baseBread;
    let used = 0;

    for (const b of this.buildings.values()) {
      if (b.side !== side) continue;
      if (b.kind === 'core') continue;
      if (b.kind === 'house') {
        total += SUPPLY.housePop;
        used += SUPPLY.housePopCost;
      } else {
        // 建筑占用按种类读同一张表：磨坊 1、箭塔 1、炮塔 2……
        used += buildingPopOf(b.kind);
        if (b.kind === 'mill') breadMax += SUPPLY.millBread;
      }
    }

    let bread = 0;
    for (const u of this.units) {
      if (u.side !== side || u.hp <= 0) continue;
      bread += (u.breadCost ?? 1) * SUPPLY.unitBread;
      // 人口不再按活兵实时累加：借走的那笔记在 popDebt，兵死也不立刻销账
    }
    /**
     * **法术工厂吃面包**（2026-11-16 用户："占用两个人口，一个面包"）。
     *
     * 这是第一座**有口粮开销的楼** ——  bisher 面包只被兵吃。所以判据单独写在这里，
     * 不混进上面那个"按 buildingPopOf 累加"的循环（那循环算的是人口，不是粮）。
     *
     * 为什么不塞进 `BUILDING_POP`：那张表是**人口**表，语义不同；
     * 混在一起以后想给某座楼单独调口粮就没地方放了。
     * 口粮口径集中在 `SPELL_FORGE.breadCost` 一处。
     */
    for (const b of this.buildings.values()) {
      if (b.side !== side || b.hp <= 0) continue;
      if (b.kind === 'spellForge') bread += SPELL_FORGE.breadCost;
    }

    const debt = this.popDebt[side];
    return {
      idle: Math.max(0, total - used - debt),
      used,
      total,
      debt,
      pop: used + debt,
      popMax: total,
      bread,
      breadMax,
    };
  }

  /**
   * 这张牌能不能落下去（人口 / 面包不够就返回理由）。
   *
   * 民居是个例外：它**自己提供** 2 人口，所以判定要「先加容器、再看占用」——
   * 否则 6/6 满的时候连民居都盖不出来，人口就永远回不去了（死锁）。
   *
   * **槽位制衡**（2026-11-06 用户）：建筑占用最多到 `人口上限 − SUPPLY.armyReserve`，
   * 永远给军队留 2 格 —— 理由文本带「人口」二字，HUD 胶囊闪红走同一条路。
   * 军队卡不受这条限制（保留槽就是留给它的）。
   *
   * public（2026-11-06）：HUD 卡面要拿它给「几人几包」的图标标红 ——
   * 玩家造不出来时，红的就是差的那一样，而不是让玩家去猜。
   *
   * P-094：拒绝理由直接把「闲置 / 占用 / 全部」三个数摆出来，
   * 和顶栏读数同一套字段，玩家一眼能看出是楼占了坑还是兵借走没还。
   */
  supplyBlocked(side: Side, card: ArenaCard): string | null {
    const s = this.supplyOf(side);
    const tri = `闲置 ${s.idle} / 占用 ${s.used} / 共 ${s.total}`;
    if (card.kind === 'building') {
      const isHouse = card.building === 'house';
      const cost = isHouse ? SUPPLY.housePopCost : buildingPopOf(card.building!);
      const maxAfter = s.popMax + (isHouse ? SUPPLY.housePop : 0);
      // 民居看的是加容器之后的真上限；其它建筑还要给军队留出保留槽
      const budget = maxAfter - (isHouse ? 0 : SUPPLY.armyReserve);
      if (s.pop + cost > budget) {
        return isHouse
          ? `人口不够（${tri}，先盖民居）`
          : `人口不够（${tri}，建筑最多占 ${s.popMax - SUPPLY.armyReserve}，给军队留 ${SUPPLY.armyReserve} 格）`;
      }
      return null;
    }
    const n = (card.squad ?? []).reduce((sum, g) => sum + g.count, 0);
    const supply = armySupplyOf(card);
    // 民兵 / 兽人 popPerMan=0 ⇒ 跳过人口检查，但面包照算（兽人还是双倍）
    if (supply.popPerMan > 0 && s.pop + n * supply.popPerMan > s.popMax) {
      return `人口不够（${tri}，盖民居扩上限，或等闲置人口回来）`;
    }
    if (s.bread + n * supply.breadPerMan * SUPPLY.unitBread > s.breadMax) {
      return `面包不够（${s.bread}/${s.breadMax}，先盖磨坊）`;
    }
    return null;
  }

  summary() {
    return {
      gold: Math.floor(this.playerOf('blue').gold),
      goldCap: ECONOMY.cap,
      blueCore: Math.round(this.coreOf('blue')?.hp ?? 0),
      redCore: Math.round(this.coreOf('red')?.hp ?? 0),
      coreMax: CORE.hp,
      units: { blue: this.units.filter((u) => u.side === 'blue').length, red: this.units.filter((u) => u.side === 'red').length },
      outcome: this.outcome,
      /** 怎么结束的（结算面板第二行） */
      reason: this.outcomeReason,
      /** 倒计时（向上取整：显示 0.4 秒时写 1，写 0 会有"时间到了但还没结束"的一格） */
      timeLeft: Math.ceil(this.timeLeft),
      /** 1v1 无尽：没有倒计时，HUD 改显示这个「已打了多久」（向上计时） */
      endless: this.mode === 'endless',
      // 0.05 为一步累加 120 次会得 5.999999999999998，floor 直接慢一秒；
      // 加一个远小于帧长的 epsilon 消除浮点误差，不提前跳秒。
      elapsed: Math.floor(this.elapsed + 1e-6),
      matchSeconds: MATCH.seconds,
      /** 是不是在加时赛里（HUD 拿它把时钟切成红色加时态） */
      overtime: this.overtime,
      /** 双方还剩几栋楼（读数用，**不是判据**） */
      buildings: { blue: this.countBuildings('blue'), red: this.countBuildings('red') },
      /** 被拆掉的楼数（时间到时的第二判据，也是"拖建筑"的记分牌） */
      destroyed: { blue: this.destroyed.blue, red: this.destroyed.red },
      /** 后勤：已配齐 / 总共需要（HUD 写 "2/3 配齐"；缺的楼不开火、不产兵） */
      staffed: { blue: this.staffedCount('blue'), red: this.staffedCount('red') },
      staffingNeeded: { blue: this.needStaffing('blue'), red: this.needStaffing('red') },
      /** 人口三分 + 面包容器（P-094）：HUD 顶栏读 idle/used/total，AI 仍读 pop/popMax */
      supply: { blue: this.supplyOf('blue'), red: this.supplyOf('red') },
      /**
       * **结算账单**（P-094）：对局中恒 null（20Hz 零开销），结束后由 world.ledger
       * 惰性算一次。HUD 左右两栏、三级判据、决定项全从这里读，不在 UI 里重算。
       */
      ledger: this.ledger,
      /**
       * PVE 读数（`arena` 模式是 null）—— 波次条与结算文案**只读这里**，
       * 不在 UI 里重算一遍（"规则与文案同表"那条红线）。
       */
      pve: this.pve
        ? {
            level: this.pve.level.name,
            /** 已经放完几波（0 起；显示时用 wave+1） */
            wave: this.pve.next,
            total: this.pve.level.waves.length,
            /** 距下一波还有几秒（全部放完是 Infinity ⇒ UI 要自己判） */
            nextIn: this.pve.countdown,
            spawned: this.pve.spawned,
            slain: this.pve.slain,
            /** 场上还活着的怪 */
            alive: this.units.filter((u) => u.side === 'red' && u.hp > 0).length,
            /** 这一关的守满时限 / 还剩几秒 */
            seconds: this.pve.level.seconds,
            left: Math.max(0, this.pve.level.seconds - this.elapsed),
            /** 最后一波是不是已经开始（HUD 切"清剿"文案） */
            lastWaveOut: this.pve.next >= this.pve.level.waves.length,
          }
        : null,
    };
  }
}
