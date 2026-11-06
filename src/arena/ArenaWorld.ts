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
  BUILD,
  BUILDING_SPECS,
  CARDS,
  CORE,
  ECONOMY,
  NO_BUILD,
  FIELD,
  HAND,
  LOGISTICS,
  MATCH,
  REROLL,
  RUIN,
  SUPPLY,
  TOWER,
  UNIT,
  cardById,
  type ArenaCard,
} from './config';

// 结构与'世界长什么样'在 ./types（这边只留 re-export，免得十几个文件的 import 全改）
import { statsOf } from './types';
import { decide, type AiView } from './ai';
import type {
  ArenaBuilding,
  ArenaOptions,
  ArenaRuin,
  ArenaShot,
  ArenaUnit,
  HitKind,
  Outcome,
  OutcomeReason,
  PlayResult,
  Side,
} from './types';

export type {
  ArenaBuilding,
  ArenaOptions,
  ArenaRuin,
  ArenaShot,
  ArenaUnit,
  HitKind,
  Outcome,
  OutcomeReason,
  PlayResult,
  Side,
  UnitStats,
} from './types';
export { statsOf } from './types';

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

  gold: Record<Side, number> = { blue: ECONOMY.start, red: ECONOMY.start };
  /** 距下一格金币还差几秒（每侧各一个计时） */
  private readonly goldTick: Record<Side, number> = { blue: 0, red: 0 };
  /**
   * **两边各一副手牌**（原来只有蓝方有，红方是从整池里随手挑 —— 那就是"一直出弓箭手"的来源）。
   * 红方也走手牌之后，两边受同样的限制：能出的牌只有手上那 4 张，规矩对等。
   */
  readonly hands: Record<Side, (ArenaCard | null)[]> = {
    blue: [null, null, null, null],
    red: [null, null, null, null],
  };
  readonly handCooldowns: Record<Side, number[]> = {
    blue: [0, 0, 0, 0],
    red: [0, 0, 0, 0],
  };
  /**
   * 每一格"刚打出去的那张牌"。
   *
   * 为什么需要它：补牌是在冷却结束时发生的，那时格子里已经是 null，
   * 只靠"手上剩下的三张"排除不掉刚打出去的那张 —— 于是同 seed 下真会把同一张牌原样发回来。
   * 以前那条锁能过只是因为卡池 17 张、抽样运气好（1/14 的概率），不是真的挡住了。
   */
  private readonly lastPlayed: Record<Side, (string | null)[]> = {
    blue: [null, null, null, null],
    red: [null, null, null, null],
  };

  readonly buildings = new Map<number, ArenaBuilding>();
  units: ArenaUnit[] = [];
  /** 在飞的弹丸（纯视觉，不参与结算） */
  shots: ArenaShot[] = [];
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
   * 托管开关。红方恒为 true（它没有手牌，永远由 AI 打）；蓝方默认 false —— 那是玩家的位置。
   * 打开蓝方 = 我方也自动出牌，自动化测试与"放着自己看"都用它。
   */
  readonly auto: Record<Side, boolean> = { blue: false, red: true };
  /** 两边各自的"下次想一想"倒计时（原来只有红方一个，蓝方托管后必须各记一份） */
  private readonly aiIn: Record<Side, number> = { blue: AI.thinkSeconds, red: AI.thinkSeconds };
  /** AI 两次刷新之间的冷却（秒）；玩家手动刷新不占这个计时器 */
  private readonly aiRerollIn: Record<Side, number> = { blue: 0, red: 0 };

  outcome: Outcome = 'playing';
  /** 怎么结束的（HUD 拿它写结算面板的第二行） */
  outcomeReason: OutcomeReason = null;
  /** 开打到现在多少秒（含加时期；原来记了没人读，现在是倒计时的唯一真相） */
  elapsed = 0;

  private nextId = 1;

  constructor(options: ArenaOptions = {}) {
    this.seed = options.seed ?? 1;
    this.rng = new Random(this.seed);
    if (options.auto?.blue !== undefined) this.auto.blue = options.auto.blue;

    const midRow = Math.floor((FIELD.rows - CORE.rows) / 2);
    // 横版：蓝在左端、红在右端，各留一格边
    this.place('blue', 'core', 1, midRow, CORE.hp);
    this.place('red', 'core', FIELD.cols - CORE.cols - 1, midRow, CORE.hp);

    const fixed = options.hand ?? [];
    for (const side of ['blue', 'red'] as Side[]) {
      for (let i = 0; i < HAND.size; i++) {
        // 开局手牌只固定蓝方那一副（测试用）；红方也发一副，两边对等
        this.hands[side][i] = side === 'blue' && fixed[i] ? cardById(fixed[i]!) : this.draw(side);
      }
    }
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
    const hand = this.hands[side].filter((c): c is ArenaCard => c !== null);
    const taken = new Set(hand.map((c) => c.id));
    if (exclude) taken.add(exclude);
    let pool = CARDS.filter((c) => !taken.has(c.id));
    if (pool.length === 0) pool = CARDS;

    /**
     * **发牌裁量（2026-11-07 设计文档 A 节）**：没地方放楼了就别再发建筑卡。
     * 判据 `buildingRoom` 与落牌共用 `buildingPlacementIssue`，不另算一套账；
     * 没空位时两个建筑保底（后勤 / 建筑）也必须跳过，否则刚过滤完又塞回来。
     */
    if (!this.buildingRoom(side)) {
      const army = pool.filter((c) => c.kind !== 'building');
      pool = army.length > 0 ? army : pool;
      return this.rng.pick(pool);
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
    return this.rng.pick(pool);
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
    const consumers = mine.filter(
      (b) => b.kind === 'barracks' || b.kind === 'arrowTower' || b.kind === 'cannonTower',
    ).length;
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
    return { cols: FIELD.cols, rows: FIELD.rows };
  }

  /** 蓝方的手牌（HUD、测试与老代码都读它；红方的那份在 `hands.red`）。 */
  get hand(): (ArenaCard | null)[] {
    return this.hands.blue;
  }

  /** 蓝方的手牌冷却（同上，是 `handCooldowns.blue` 的快捷读法）。 */
  get handCooldown(): number[] {
    return this.handCooldowns.blue;
  }

  /**
   * 这一局还剩几秒（到 0 就判负/判胜，不会变负）。
   *
   * 2026-11-06 加时赛：常规 180 秒打满、两边大本营都还立着 ⇒ 剩余秒数**重置成 60**
   *（加时是 sudden death：谁先拆掉对面大本营谁赢）。
   * HUD 拿 `summary().overtime` 区分「最后 30 秒告急」和「加时告急」，两边都是红的。
   */
  get timeLeft(): number {
    const total = this.elapsed >= MATCH.seconds ? MATCH.seconds + MATCH.overtimeSeconds : MATCH.seconds;
    return Math.max(0, total - this.elapsed);
  }

  /** 是不是已经进了加时赛（读数用；判负在 `checkOutcome`）。 */
  get overtime(): boolean {
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
    return col >= FIELD.midCol - NO_BUILD.halfWidth && col <= FIELD.midCol + NO_BUILD.halfWidth;
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
    return side === 'blue' ? col < FIELD.midCol : col >= FIELD.midCol;
  }

  /**
   * **建筑落位判据（唯一一处，2026-11-07 设计文档 A 节）**：
   * 半场 / 3×3 不越界 / 三列不压黄区 / 不与任何楼重叠。
   * `placementProblem` 的建筑分支直接返回它，`buildingRoom` 与发牌裁量也读它——
   * 卡面提示、落牌拒绝、发牌过滤三件事不会算出两套账。
   */
  private buildingPlacementIssue(side: Side, col: number, row: number): string | null {
    void side;
    const spec = { cols: 3, rows: 3 }; // 五栋楼全是 3×3（BUILDING_SPECS）
    if (col < 0 || row < 0 || col + spec.cols > FIELD.cols || row + spec.rows > FIELD.rows) return '出界了';
    for (let c = col; c < col + spec.cols; c++) if (this.inNoBuild(c)) return '中间黄区不能盖楼';
    if (!this.cellFree(col, row, spec.cols, spec.rows)) return '这格被占了';
    return null;
  }

  /** 这一侧还有没有能放下一栋 3×3 楼的空位。 */
  buildingRoom(side: Side): boolean {
    for (let row = 0; row <= FIELD.rows - 3; row++) {
      for (let col = 0; col <= FIELD.cols - 3; col++) {
        if (!this.inOwnHalf(side, col)) continue;
        if (this.buildingPlacementIssue(side, col, row) === null) return true;
      }
    }
    return false;
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
      col: Math.min(FIELD.cols - 1, Math.max(0, col)),
      row: Math.min(FIELD.rows - 1, Math.max(0, row)),
    };
  }

  /** 挪出兵旗。返回 false = 那格放不了（越界/压着楼）。 */
  setFlag(buildingId: number, col: number, row: number): boolean {
    const b = this.buildings.get(buildingId);
    if (!b || b.kind !== 'barracks' || !b.side) return false;
    if (col < 0 || row < 0 || col >= FIELD.cols || row >= FIELD.rows) return false;
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
    const problem = this.placementProblem(side, slot, col, row);
    if (problem) return { ok: false, reason: problem };
    const card = this.hands[side][slot]!;

    this.execute(side, card, col, row);
    // 这栋楼落地后可能刚好把最后一处空位占掉：手里剩下的建筑卡立刻换成军队卡
    if (card.kind === 'building') this.purgeBuildingsIfNoRoom(side);
    // 打出去就进冷却，冷却完补一张新的（配卡组以后再做）
    this.lastPlayed[side][slot] = card.id;
    this.hands[side][slot] = null;
    this.handCooldowns[side][slot] = HAND.refillSeconds;
    return { ok: true };
  }

  /**
   * **只校验、不落牌**（2026-11-06 拖放影子用）：判据只有这一份 ——
   * 落牌（playCard）和影子的绿/红显色都从这里出，不会算出两套账。
   */
  canPlaceAt(side: Side, slot: number, col: number, row: number): { ok: boolean; reason?: string } {
    const problem = this.placementProblem(side, slot, col, row);
    return problem ? { ok: false, reason: problem } : { ok: true };
  }

  private placementProblem(side: Side, slot: number, col: number, row: number): string | null {
    if (this.outcome !== 'playing') return '这一局已经结束';
    const card = this.hands[side][slot];
    if (!card) return '这格是空的';
    if (this.handCooldowns[side][slot]! > 0) return '这张还在冷却';
    if (this.gold[side] < card.cost) return `金币不够（要 ${card.cost}）`;
    const blocked = this.supplyBlocked(side, card);
    if (blocked) return blocked;
    if (!this.inOwnHalf(side, col)) return '只能放在自己半场';

    if (card.kind === 'building') return this.buildingPlacementIssue(side, col, row);
    // 军队卡仍占 1×1（飞行单位也一样：落牌位置维持与现有锁一致）
    if (col + 1 > FIELD.cols || row + 1 > FIELD.rows) return '出界了';
    if (!this.cellFree(col, row, 1, 1)) return '这格被占了';
    if (this.inNoBuild(col)) return '中间黄区不能放兵';
    return null;
  }

  /** 真正的花钱与落位。AI 也用这一条，保证两边走同一套规则。 */
  private execute(side: Side, card: ArenaCard, col: number, row: number): void {
    this.spend(side, card.cost);
    if (card.kind === 'building') {
      this.place(side, card.building!, col, row, BUILDING_SPECS[card.building!].hp);
    } else {
      this.spawnSquad(side, card.squad ?? [], col, row);
    }
  }

  /**
   * 花 5 金重抽全部 4 张手牌，**保底一张民居**。
   *
   * 为什么要保底：民居是塔/兵营能否开工的唯一名额来源，纯随机重抽可能抽到一手
   * 没有民居的牌 —— 那这 5 金就白花了，玩家会更不敢点刷新。
   * `draw()` 自己的「缺后勤保底」只在场上缺民居时触发，所以这里再补一道硬保底。
   */
  reroll(side: Side): PlayResult {
    if (this.outcome !== 'playing') return { ok: false, reason: '这一局已经结束' };
    if (this.gold[side] < REROLL.cost) return { ok: false, reason: `金币不够（刷新要 ${REROLL.cost}）` };

    // 先清空，让 draw() 的去重从零开始，保证 4 张互不重复
    this.hands[side] = [null, null, null, null];
    const fresh: ArenaCard[] = [];
    for (let i = 0; i < HAND.size; i++) {
      const card = this.draw(side, fresh.at(-1)?.id);
      fresh.push(card);
      this.hands[side][i] = card;
    }
    /**
     * 保底改成「缺什么给什么」（2026-11-06 实测纠错）。
     *
     * 上一版**永远只保 house**，于是 seed 20261027 的红方陷进死循环：
     * 面包 3/3 满、兵营缺磨坊 → 刷新 → 保底 house 把刚补到的 mill 换掉 →
     * 磨坊永远盖不出来 → 面包继续满 → 再刷。180 秒刷 11 次、白烧 55 金、0 兵。
     *
     * 现在：`missingLogistics()` 说缺磨坊就保 mill，**同时仍保一张房屋**
     * （用户原话「刷新默认会给一张房屋」，这条不破）。都不缺时只保房屋。
     */
    // 没空位时**不塞** house/mill 保底（否则刷新完又是一张盖不下去的楼）
    if (this.buildingRoom(side)) {
      const needs = this.missingLogisticsAll(side);
      const wanted: string[] = needs.length > 0 ? [...needs] : ['house'];
      // 用户原话「刷新默认会给一张房屋」：即使只缺磨坊，房屋也照保
      if (!wanted.includes('house')) wanted.push('house');
      let slot = HAND.size - 1;
      for (const id of wanted) {
        if (this.hands[side].some((c) => c?.id === id)) continue;
        this.hands[side][slot--] = cardById(id);
      }
    }

    // 牌全换了，冷却与「刚打出去那张」的记录一起清掉
    this.handCooldowns[side].fill(0);
    this.lastPlayed[side].fill(null);
    this.spend(side, REROLL.cost);
    return { ok: true };
  }

  /** 场地没空位时，把手牌里的建筑卡换成军队卡（槽位/冷却不动，只换卡面）。 */
  private purgeBuildingsIfNoRoom(side: Side): void {
    if (this.buildingRoom(side)) return;
    for (let i = 0; i < HAND.size; i++) {
      const card = this.hands[side][i];
      if (card?.kind === 'building') this.hands[side][i] = this.draw(side, card.id);
    }
  }

  /** 立刻补一张牌到那一格（补的是**手上还没有的**牌，也不补刚打出去那张）。 */
  private drawInto(side: Side, slot: number): void {
    const exclude = this.lastPlayed[side][slot] ?? undefined;
    this.lastPlayed[side][slot] = null;
    this.hands[side][slot] = this.draw(side, exclude);
  }

  private spend(side: Side, amount: number): void {
    this.gold[side] = Math.max(0, this.gold[side] - amount);
  }

  private spawnSquad(
    side: Side,
    squad: { unitId: string; count: number }[],
    col: number,
    row: number,
    /** true = 兵营自动出的兵：不占人口（用户 2026-11-06），面包照吃 */
    fromBarracks = false,
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
        });
        i++;
      }
    }
  }

  // ---------------------------------------------------------------- 每帧

  update(dt: number): void {
    if (this.outcome !== 'playing') return;
    this.elapsed += dt;

    // 金：每 ECONOMY.tickSeconds 跳 +perTick，到上限就不涨。
    // 用"攒够一格再加"而不是 perSecond*dt，是为了大 dt（快进/掉帧）时也按整格补，
    // 不会出现 12.7333 这种读数。
    for (const side of ['blue', 'red'] as Side[]) {
      this.goldTick[side] += dt;
      while (this.goldTick[side] >= ECONOMY.tickSeconds) {
        this.goldTick[side] -= ECONOMY.tickSeconds;
        this.gold[side] = Math.min(ECONOMY.cap, this.gold[side] + ECONOMY.perTick);
      }
    }

    // 手牌冷却：两边各自补（红方现在也有手牌了）
    for (const side of ['blue', 'red'] as Side[]) {
      const cool = this.handCooldowns[side];
      for (let i = 0; i < cool.length; i++) {
        if (cool[i]! <= 0) continue;
        cool[i] = Math.max(0, cool[i]! - dt);
        if (cool[i] === 0) this.drawInto(side, i);
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
    this.tickUnits(dt);
    this.separateUnits();
    this.tickAi(dt);
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
      u.x = Math.min(FIELD.cols - 0.4, Math.max(0.4, u.x));
      u.z = Math.min(FIELD.rows - 0.4, Math.max(0.4, u.z));
    }
  }

  /**
   * 大本营的水晶**魔法攻击**（2026-11-06 用户："主城顶上的水晶可以魔法攻击"）。
   *
   * 与塔的三点不同（口径都写在 config.CORE.attack 注释里）：
   * - **只打兵**：敌建筑让移动火炮去白嫖，水晶是最后防线不是主炮台；
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
      if (u.side === b.side || u.hp <= 0) continue;
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
      if (b.kind === 'mill') {
        b.timer += dt;
        if (b.timer < ECONOMY.millInterval) continue;
        b.timer = 0;
        this.gold[b.side] = Math.min(ECONOMY.cap, this.gold[b.side] + ECONOMY.millBonus);
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
          if (Math.hypot(u.x - target.x, u.z - target.z) <= spec.splash) this.hurtUnit(u, dmg);
        }
      } else if (target.unit) {
        this.hurtUnit(target.unit, dmg);
      } else if (target.building) {
        // 箭塔打出来的是箭（墙正常掉一块），炮塔打出来的是炮弹（墙炸散）
        this.hurtBuilding(target.building, dmg, b.kind === 'arrowTower' ? 'arrow' : 'cannon');
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
        if (e.side === u.side || e.hp <= 0 || this.bomberOf(e.defId)) continue;
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
          if (Math.hypot(e.x - target.x, e.z - target.z) <= BOMBER.splash) this.hurtUnit(e, BOMBER.damage);
        }
      }
    }
    if (u.x < -BOMBER.exitMargin || u.x > FIELD.cols + BOMBER.exitMargin) {
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
        u.healIn = (u.healIn ?? spec.every) - dt;
        if (u.healIn <= 0) {
          u.healIn = spec.every;
          const radius = spec.radius ?? 3;
          const amount = spec.amount ?? 6;
          let healed = 0;
          for (const ally of this.units) {
            if (ally.side !== u.side || ally.hp <= 0 || ally.hp >= ally.maxHp) continue;
            if (Math.hypot(ally.x - u.x, ally.z - u.z) > radius) continue;
            ally.hp = Math.min(ally.maxHp, ally.hp + amount);
            healed += 1;
          }
          if (healed > 0) this.heals.push({ id: this.nextId++, x: u.x, z: u.z, ttl: 0.6 });
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
          this.hurtBuilding(foe.building, st.damage, hit);
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
      const gx = goal ? goal.col + goal.cols / 2 : FIELD.cols / 2;
      const gz = goal ? goal.row + goal.rows / 2 : FIELD.rows / 2;
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
    // buildingsOnly 现在对移动火炮是 false（它要能打兵）；字段留着给以后"纯攻城"的兵种
    for (const other of buildingsOnly ? [] : this.units) {
      if (other.side === u.side || other.hp <= 0) continue;
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
    for (const u of this.units) {
      if (u.side === tower.side || u.hp <= 0) continue;
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
  private blockedBy(x: number, z: number): boolean {
    const col = Math.floor(x);
    const row = Math.floor(z);
    for (const b of this.buildings.values()) {
      if (col >= b.col && col < b.col + b.cols && row >= b.row && row < b.row + b.rows) return true;
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
    u.hp -= damageOf(attack, statsOf(u.defId).defense);
    if (u.hp < 0) u.hp = 0;
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
      .filter((b) => b.kind === 'barracks' || b.kind === 'arrowTower' || b.kind === 'cannonTower')
      .sort((a, b) => {
        // **兵营优先**（它要两样，是产兵的主路径），同档内才按楼号先盖先得。
        // 纯按楼号排过一次，结果民居被先盖的塔抢走、兵营一直冷着（实测 seed 11 红方 0 兵）。
        const rank = (kind: string) => (kind === 'barracks' ? 0 : 1);
        return rank(a.kind) - rank(b.kind) || a.id - b.id;
      });

    const out = new Set<number>();
    for (const b of consumers) {
      const needMill = b.kind === 'barracks' ? LOGISTICS.barracksMill : 0;
      const needHouse = b.kind === 'barracks' ? LOGISTICS.barracksHouse : LOGISTICS.towerHouse;
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
      if (b.side === side && (b.kind === 'barracks' || b.kind === 'arrowTower' || b.kind === 'cannonTower')) n++;
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
   */
  isStaffed(id: number): boolean {
    const b = this.buildings.get(id);
    if (!b) return true;
    if (b.kind !== 'barracks' && b.kind !== 'arrowTower' && b.kind !== 'cannonTower') return true;
    return this.staffedIds(b.side).has(id);
  }

  private hurtBuilding(b: ArenaBuilding, attack: number, kind: HitKind = 'blade'): void {
    b.hp -= damageOf(attack, 0);
    b.lastHit = kind;
    if (b.hp < 0) b.hp = 0;
    if (b.hp > 0) return;
    this.buildings.delete(b.id);
    // "拖他的建筑"的账本：记的永远是**谁被拆了**，判胜时反过来看（我拆掉对方多少）
    this.destroyed[b.side] += 1;
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

  // ---------------------------------------------------------------- AI

  /**
   * 托管方的节拍：**两边各一份倒计时**，谁开着谁就想。
   *
   * 原来只有一个 `aiIn` 且只喂红方 —— 蓝方托管后如果共用同一个计时器，
   * 两边会抢同一份倒计时（一边想完就清零，另一边这轮直接跳过），
   * 表现出来就是"红方一直在动、蓝方偶尔才动一下"。
   */
  private tickAi(dt: number): void {
    for (const side of ['blue', 'red'] as Side[]) {
      if (!this.auto[side]) continue;
      this.aiRerollIn[side] = Math.max(0, this.aiRerollIn[side] - dt);
      this.aiIn[side] -= dt;
      if (this.aiIn[side] > 0) continue;
      this.aiIn[side] = AI.thinkSeconds;
      this.think(side);
    }
  }

  /** 打开/关掉某一边的托管。红方不允许关（它没有手牌，关了就再也不动了）。 */
  setAuto(side: Side, on: boolean): void {
    this.auto[side] = side === 'red' ? true : on;
    if (on) this.aiIn[side] = 0; // 开了就立刻想一次，别让玩家等 2.5 秒
  }

  /**
   * ③ 执行层：把局面打包给 `ai.decide()`（纯函数），只按它返回的 action 动手。
   *
   * 这一层**不做任何判断** —— 「要不要刷新、该出第几张」全在 `ai.ts`，
   * 所以改动策略时不用碰世界状态，给一份 `AiView` 就能单测。
   */
  private think(side: Side): void {
    const mine = [...this.buildings.values()].filter((b) => b.side === side && b.kind !== 'core');
    const view: AiView = {
      hand: this.hands[side],
      gold: this.gold[side],
      count: (kind) => mine.filter((b) => b.kind === kind).length,
      // 容器读数直接复用 `supplyOf()`：AI 和 HUD 读同一份，不会算出两套账
      supply: this.supplyOf(side),
      rerollIn: this.aiRerollIn[side],
    };
    const action = decide(view);
    if (action.kind === 'reroll') {
      // 刷新保底一张民居；成功后上冷却，避免每 2.5 秒把钱刷光
      if (this.reroll(side).ok) this.aiRerollIn[side] = AI.rerollCooldown;
      return;
    }
    if (action.kind === 'wait') return;
    const card = this.hands[side][action.slot];
    if (card) this.play(side, action.slot, card);
  }

  /** 把第 slot 张牌落到半场里一个随机空位。 */
  private play(side: Side, slot: number, card: ArenaCard): void {
    if (slot < 0) return;
    const cell = this.randomSpot(side, card);
    if (!cell) return;
    this.playCard(side, slot, cell.col, cell.row);
  }

  /** AI 的落点：自己半场、不压楼。 */
  private randomSpot(side: Side, card: ArenaCard): { col: number; row: number } | null {
    const spec = card.kind === 'building' ? BUILDING_SPECS[card.building!] : { cols: 1, rows: 1 };
    for (let tries = 0; tries < 24; tries++) {
      // 横版：红方落在右半边，蓝方（备用）落在左半边
      // 禁建带要整段避开，而且**再多留一格**：建筑模型比占地宽（兵营 3.6 格 vs 占地 3 格），
      // 贴着黄线盖会看起来"楼压进了黄区"（用户 2026-11-02 就是这么以为的，其实格子没压）
      const margin = NO_BUILD.halfWidth + 2;
      const lo = side === 'red' ? FIELD.midCol + margin : 1;
      const hi = side === 'red' ? FIELD.cols - spec.cols - 1 : FIELD.midCol - margin - spec.cols - 1;
      if (hi < lo) return null;
      const col = this.rng.int(lo, hi + 1);
      const row = this.rng.int(1, FIELD.rows - spec.rows - 1);
      if (col + spec.cols > FIELD.cols || row + spec.rows > FIELD.rows) continue;
      if (!this.cellIsFree(col, row, spec.cols, spec.rows)) continue;
      return { col, row };
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
    const blueCore = this.coreOf('blue');
    const redCore = this.coreOf('red');

    if (!blueCore && !redCore) return this.finish('draw', 'core');
    if (!redCore) return this.finish('win', 'core');
    if (!blueCore) return this.finish('lose', 'core');

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
      return this.finish(blueAlive > redAlive ? 'win' : 'lose', 'overtime');
    }
    // 浮点比较：大本营血量是整数减伤后的整数，但归一化会带误差，留一道细缝
    if (Math.abs(blueFrac - redFrac) > 1e-9) {
      return this.finish(blueFrac > redFrac ? 'win' : 'lose', 'overtime');
    }
    const blueLost = this.destroyed.blue;
    const redLost = this.destroyed.red;
    if (blueLost !== redLost) return this.finish(redLost > blueLost ? 'win' : 'lose', 'overtime');
    this.finish('draw', 'draw');
  }

  private finish(outcome: Outcome, reason: OutcomeReason): void {
    this.outcome = outcome;
    this.outcomeReason = reason;
  }

  /** 场上还立着的非大本营建筑数（HUD 读数用）。 */
  private countBuildings(side: Side): number {
    let n = 0;
    for (const b of this.buildings.values()) if (b.side === side && b.kind !== 'core' && b.hp > 0) n++;
    return n;
  }

  /** 给 HUD 的一行读数：金、手牌、双方大本营血量、倒计时。 */
  /**
   * 这一侧的人口 / 面包读数（**容器**，不是随时间涨的库存）。
   *
   * 人口 = 基础 6 + 民居×2；占用 = 建筑（民居 0、其余 2）+ 每个兵 1。
   * 面包 = 基础 4 + 磨坊×2；占用 = 每个兵 1。
   *
   * 施工中的楼**算占用**（人手已经派出去了），否则会出现"先把地盘占满再慢慢盖"的漏洞。
   *
   * 2026-11-06 用户："兵营里面出的兵不占人口。" ⇒ `fromBarracks` 的兵
   * **不算人口占用**（卡牌出的兵照算），面包照吃 —— 两边分开数。
   */
  supplyOf(side: Side): { pop: number; popMax: number; bread: number; breadMax: number } {
    let popMax = SUPPLY.basePop;
    let breadMax = SUPPLY.baseBread;
    let pop = 0;

    for (const b of this.buildings.values()) {
      if (b.side !== side) continue;
      if (b.kind === 'core') continue;
      if (b.kind === 'house') {
        popMax += SUPPLY.housePop;
        pop += SUPPLY.housePopCost;
      } else if (b.kind === 'mill') {
        pop += SUPPLY.buildingPop;
        breadMax += SUPPLY.millBread;
      } else {
        pop += SUPPLY.buildingPop;
      }
    }

    let popEaters = 0;
    let eaters = 0;
    for (const u of this.units) {
      if (u.side !== side || u.hp <= 0) continue;
      eaters++;
      if (!u.fromBarracks) popEaters++;
    }
    pop += popEaters * SUPPLY.unitPop;
    const bread = eaters * SUPPLY.unitBread;

    return { pop, popMax, bread, breadMax };
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
   */
  supplyBlocked(side: Side, card: ArenaCard): string | null {
    const s = this.supplyOf(side);
    if (card.kind === 'building') {
      const isHouse = card.building === 'house';
      const cost = isHouse ? SUPPLY.housePopCost : SUPPLY.buildingPop;
      const maxAfter = s.popMax + (isHouse ? SUPPLY.housePop : 0);
      // 民居看的是加容器之后的真上限；其它建筑还要给军队留出保留槽
      const budget = maxAfter - (isHouse ? 0 : SUPPLY.armyReserve);
      if (s.pop + cost > budget) {
        return isHouse
          ? `人口不够（${s.pop}/${s.popMax}，先盖民居）`
          : `人口不够（${s.pop}/${s.popMax}，建筑最多占 ${s.popMax - SUPPLY.armyReserve}，给军队留 ${SUPPLY.armyReserve} 格）`;
      }
      return null;
    }
    const n = (card.squad ?? []).reduce((sum, g) => sum + g.count, 0);
    if (s.pop + n * SUPPLY.unitPop > s.popMax) {
      return `人口不够（${s.pop}/${s.popMax}，先盖民居）`;
    }
    if (s.bread + n * SUPPLY.unitBread > s.breadMax) {
      return `面包不够（${s.bread}/${s.breadMax}，先盖磨坊）`;
    }
    return null;
  }

  summary() {
    return {
      gold: Math.floor(this.gold.blue),
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
      /** 人口 / 面包（容器）：HUD 左上角那两个读数 */
      supply: { blue: this.supplyOf('blue'), red: this.supplyOf('red') },
    };
  }
}
