/**
 * 世界状态 —— 一局的"账本"：地块、建筑、资源、人口、许可、抽卡记录。
 *
 * 这里不 import three，也不 import DOM：所以它能被单测直接 new 出来跑一百抽。
 * 渲染和 UI 都是它外侧的订阅者。
 */

import { EventBus } from '@engine/core/EventBus';
import type { FlatSize, GridPos } from '@engine/math/Grid';
import { footprintRect, inBounds, pos, toKey } from '@engine/math/Grid';
import { BREAD, ECONOMY, RESOURCE_META, ROUNDS, TERRAIN, VEIN_WORK, isStandable, type ResourceId } from '@game/config';
import { buildingDef, type BuildingDef } from '@game/data/buildings';
import { CARDS, type CardDef } from '@game/data/cards';
import type { Purchase, PullOutcome } from '@game/gacha/GachaService';
import type { TileMap } from './TileMap';

/** 一条被包工的矿脉，以及它按脚程折算出来的每秒产出。 */
export interface VeinClaim {
  vein: GridPos;
  /** 占地边缘到矿点的格数 */
  tiles: number;
  resource: ResourceId;
  perSecond: number;
}

export interface Building {
  id: number;
  def: BuildingDef;
  origin: GridPos;
  cols: number;
  rows: number;
  /** 0..1，建造进度 */
  progress: number;
  built: boolean;
  /** 落位时的地表高度，视图层用它垫底 */
  surfaceY: number;
  placedAt: number;
  /**
   * 集合旗：兵出营之后往这儿走。null = 还没挪过，读的时候回落到占地中心那一格。
   * 只有产兵的楼用得上，别的楼一直是 null。
   */
  rally: GridPos | null;
  /** 当前血量，从 def.hp 起算；归零就走 demolish（议事厅归零 = 输） */
  hp: number;
}

export type Selection = { kind: 'tile'; pos: GridPos } | { kind: 'building'; building: Building } | null;

/** 回合两态：准备（什么都不涨）与接敌（照常运转，但账先攒着）。 */
export type RoundPhase = 'prep' | 'raid';

export type BuildBlock =
  | 'out-of-bounds'
  | 'terrain'
  | 'occupied'
  | 'cost'
  | 'unique'
  | 'no-permit'
  | 'no-adjacent';

export const BLOCK_TEXT: Record<BuildBlock, string> = {
  'out-of-bounds': '超出地图',
  terrain: '地形不允许',
  occupied: '这块地已被占用',
  cost: '资源不够',
  unique: '这种建筑全场只能有一座',
  'no-permit': '没有建造许可，先去抽卡',
  'no-adjacent': '这种楼必须贴着它要贴的那栋',
};

/**
 * 全局广播表。抽卡与放置模式严格说不算"世界状态"，
 * 但它们的后果最终都落到世界上（许可、幽灵），所以共用一条总线，UI 只订阅一处。
 */
export interface WorldEvents {
  'building:placed': Building;
  'building:built': Building;
  'building:removed': Building;
  /** 楼挨了一下：视图的血条与"被打掉"的动画都读这两条 */
  'building:hit': { building: Building; damage: number; hp: number };
  /** 血量归零，正在走 demolish 之前发出来（拆楼特效要拿到那栋楼本身） */
  'building:destroyed': Building;
  'vein:destroyed': GridPos[];
  /** 重新分配完"谁采哪条矿"之后广播：小人数量变了，视图要跟着增删 */
  'vein:replanned': void;
  /** 玩家想盖的这一格压着晶脉，需要一次明确同意 */
  'confirm:vein': { cells: GridPos[]; buildingName: string };
  /** 长按某个建筑 = 查详情；null 表示收起 */
  'inspect:target': Building | null;
  /** 集合旗挪了（或被收回默认位）：旗子视图与以后的兵都要跟着改道 */
  'rally:changed': Building;
  /**
   * 旗子袋换了状态。'empty' 袋里没旗 / 'held' 握着没落地 / 'placing' 正在等一次点地面。
   * 这是输入态不是世界账，但它和 'placing:changed' 同类，所以共用同一条总线，
   * UI 只订阅一处。联合类型写在联合表里，省得世界层反过来 import 系统层。
   */
  'flag:changed': { state: 'empty' | 'held' | 'placing'; buildingId: number | null };
  'permit:changed': { buildingId: string; count: number };
  'population:changed': { cap: number; used: number };
  /** 回合换了阶段：HUD 的倒计时与"准备中不涨钱"的提示都读这条 */
  'round:changed': { index: number; phase: RoundPhase; secondsLeft: number };
  /** 一次结算完成：进账明细 + 快照重算后的缺员名单 */
  'round:settled': { index: number; gains: Partial<Record<ResourceId, number>>; understaffed: number };
  'pull:done': Purchase;
  'placing:changed': string | null;
  'selection:changed': Selection;
  toast: { text: string; tone?: 'ok' | 'warn' };
}

const zeroWallet = (): Record<ResourceId, number> => ({ gold: 0, crystal: 0, bread: 0 });

export interface WorldOptions {
  bus?: EventBus<WorldEvents>;
}

export class GameWorld {
  readonly bus: EventBus<WorldEvents>;
  readonly buildings = new Map<number, Building>();
  readonly resources: Record<ResourceId, number> = zeroWallet();
  readonly cardYields: Record<ResourceId, number> = zeroWallet();

  /** 建造许可：建筑卡抽到几张，就能盖几座。 */
  readonly permits = new Map<string, number>();
  readonly seenCards = new Set<string>();
  readonly pullHistory: PullOutcome[] = [];

  /** 来自卡牌的永久人口上限增量；建筑提供的那部分走 populationCap getter 现算 */
  private bonusPopulationCap = 0;
  selection: Selection = null;
  time = 0;

  // ---------------------------------------------------------------- 回合与快照
  //
  // 人口与面包是**容积**：这一回合能用多少，是回合开始时冻下来的那份快照。
  // 所以战斗中房屋被拆光，本回合的兵营照常产兵；结算那一刻容量才掉下去，
  // 掉下去之后排不到岗位的楼就"缺员"（塔不开火、兵营不产兵），要再抽到民居才补得回来。

  roundIndex = 1;
  phase: RoundPhase = 'prep';
  /** 敌人还在场上时 raid 不许结束。波次系统没接之前恒为 false（raid 到最短时长就结算）。 */
  raidActive: () => boolean = () => false;

  private phaseLeft = ROUNDS.prepSeconds;
  private raidElapsed = 0;
  private approvedPopulation = 0;
  /** 本回合攒下来、等结算才进钱包的账 */
  private pending: Record<ResourceId, number> = zeroWallet();

  /** 采矿分配（谁在采哪条矿）。任何改变"谁在场"的动作都要把它挂脏。 */
  private readonly claims = new Map<number, VeinClaim[]>();
  private planValid = false;
  private plannedBuilt = -1;

  private nextId = 1;

  constructor(
    readonly map: TileMap,
    options: WorldOptions = {},
  ) {
    this.bus = options.bus ?? new EventBus<WorldEvents>();
    for (const res of Object.keys(this.resources) as ResourceId[]) {
      this.resources[res] = ECONOMY.starting[res] ?? 0;
    }
    // 开局没有"上一回合"，所以第一份快照就是当场算出来的容量
    this.approvedPopulation = this.populationCap;
  }

  get size(): FlatSize {
    return this.map.size;
  }

  // ---------------------------------------------------------------- 查询

  permitCount(buildingId: string): number {
    return this.permits.get(buildingId) ?? 0;
  }

  /**
   * 人口上限 = 底子上限 + 卡牌增量 + 在场建筑提供的上限。
   * 写成现算而不是一个可写字段：之前那种"谁来了就 += 一下"的记法，
   * 盖民居不会涨、拆民居不会掉，卡牌和建筑两条路迟早对不上账。
   */
  get populationCap(): number {
    let cap = ECONOMY.basePopulationCap + this.bonusPopulationCap;
    for (const b of this.buildings.values()) cap += b.def.populationCap ?? 0;
    return cap;
  }

  populationUsed(): number {
    let used = 0;
    for (const b of this.buildings.values()) used += b.def.population;
    return used;
  }

  populationFree(): number {
    return this.approvedPopulation - this.populationUsed();
  }

  /** 这一回合被批准使用的人口容量（回合开始时冻下来的快照）。 */
  get approved(): number {
    return this.approvedPopulation;
  }

  /**
   * 哪些楼排不到人手：按建造顺序（id 升序）依次发岗位，快照容量发完为止。
   * 与矿脉分配同一个口径 —— 同一局同一种摆法永远得到同一份缺员名单。
   */
  understaffed(): Set<number> {
    let left = this.approvedPopulation;
    const out = new Set<number>();
    const ordered = [...this.buildings.values()]
      .filter((b) => b.built)
      .sort((a, b) => a.id - b.id);
    for (const b of ordered) {
      const need = b.def.population;
      if (need <= 0) continue;
      if (need > left) out.add(b.id);
      left = Math.max(0, left - need);
    }
    return out;
  }

  isUnderstaffed(b: Building): boolean {
    return this.understaffed().has(b.id);
  }

  /** 还剩几秒进入下一阶段。 */
  get phaseSecondsLeft(): number {
    return this.phase === 'prep' ? Math.max(0, this.phaseLeft) : Math.max(0, ROUNDS.raidMaxSeconds - this.raidElapsed);
  }

  private startRaid(): void {
    this.phase = 'raid';
    this.raidElapsed = 0;
    this.bus.emit('round:changed', { index: this.roundIndex, phase: this.phase, secondsLeft: this.phaseSecondsLeft });
  }

  /**
   * 结算：把整回合攒下的账一次进钱包，然后重算人口快照。
   * "人口掉下去"这件事只在这里发生 —— 所以回合中途拆掉的房屋不影响本回合生产。
   */
  settle(): void {
    const gains: Partial<Record<ResourceId, number>> = {};
    const bread = this.breadPerRound();
    for (const res of Object.keys(this.pending) as ResourceId[]) {
      const amount = this.pending[res] + (res === 'bread' ? bread : 0);
      this.pending[res] = 0;
      if (amount <= 0) continue;
      const before = this.resources[res];
      this.grant(res, amount);
      gains[res] = this.resources[res] - before;
    }

    this.approvedPopulation = this.populationCap;
    this.roundIndex += 1;
    this.phase = 'prep';
    this.phaseLeft = ROUNDS.prepSeconds;
    this.raidElapsed = 0;
    this.bus.emit('round:settled', {
      index: this.roundIndex - 1,
      gains,
      understaffed: this.understaffed().size,
    });
    this.bus.emit('population:changed', { cap: this.populationCap, used: this.populationUsed() });
    this.bus.emit('round:changed', { index: this.roundIndex, phase: this.phase, secondsLeft: this.phaseSecondsLeft });
  }

  canAfford(cost: Partial<Record<ResourceId, number>>): boolean {
    return Object.entries(cost).every(([res, need]) => this.resources[res as ResourceId] >= (need ?? 0));
  }

  /**
   * 单座建筑的每秒产出 = 固定产出 + 各条矿脉按脚程算出来的产出。
   * 没晶脉可采的矿井就是 0，这不是惩罚，是把"选址"变成真决策。
   */
  yieldOf(b: Building): Partial<Record<ResourceId, number>> {
    if (!b.built) return {};
    this.ensureVeinPlan();
    const out: Partial<Record<ResourceId, number>> = {};
    for (const [res, rate] of Object.entries(b.def.yields ?? {})) {
      out[res as ResourceId] = (out[res as ResourceId] ?? 0) + (rate ?? 0);
    }
    for (const claim of this.claims.get(b.id) ?? []) {
      out[claim.resource] = (out[claim.resource] ?? 0) + claim.perSecond;
    }
    return out;
  }

  /** 这栋楼现在派人在采哪几条矿、分别多远、各贡献多少。给气泡和信息卡读。 */
  claimsOf(b: Building): VeinClaim[] {
    this.ensureVeinPlan();
    return this.claims.get(b.id) ?? [];
  }

  /** 全局每秒进账，UI 的 "+3.2/s" 和系统结算共用同一个口径。 */
  incomeRates(): Record<ResourceId, number> {
    const rates: Record<ResourceId, number> = { ...this.cardYields };
    for (const b of this.buildings.values()) {
      for (const [res, rate] of Object.entries(this.yieldOf(b))) {
        rates[res as ResourceId] = (rates[res as ResourceId] ?? 0) + (rate ?? 0);
      }
    }
    return rates;
  }

  // ---------------------------------------------------------------- 采矿分配

  /**
   * 谁去采哪条矿：按建造顺序处理，每栋楼从最近的未认领矿脉开始挑，挑满自己的包工上限。
   * 一条矿脉只归一栋楼 —— 否则两个矿井挤同一处矿点等于白送产量。
   */
  private planVeins(): void {
    this.claims.clear();
    const claimed = new Set<number>();

    const workers = [...this.buildings.values()]
      .filter((b) => b.built && b.def.veinWork)
      .sort((a, b) => a.id - b.id);

    for (const b of workers) {
      const spec = b.def.veinWork!;
      const candidates: { cell: GridPos; tiles: number }[] = [];
      for (const tile of this.map) {
        if (tile.terrain !== 'vein') continue;
        if (claimed.has(toKey(tile.pos))) continue;
        const tiles = this.tilesTo(b, tile.pos);
        if (tiles > VEIN_WORK.reach) continue;
        candidates.push({ cell: tile.pos, tiles });
      }
      // 近的优先；一样近时按格子顺序，保证同 seed 同布局得到同一个分配
      candidates.sort((x, y) => x.tiles - y.tiles || toKey(x.cell) - toKey(y.cell));

      const picks = candidates.slice(0, spec.capacity);
      for (const p of picks) claimed.add(toKey(p.cell));

      this.claims.set(
        b.id,
        picks.map((p) => ({
          vein: p.cell,
          tiles: p.tiles,
          resource: spec.resource,
          // 来回两趟路，所以除以 2×格数；下限用 overhead 兜住，避免零距离时产量爆表
          perSecond: (spec.speed / Math.max(VEIN_WORK.overheadTiles, 2 * p.tiles)) * spec.perTrip,
        })),
      );
    }
    this.planValid = true;
    this.plannedBuilt = this.builtCount();
    // 分配结果一定在这里成型，所以放牧视图挂在这条线上，而不是各自去猜时机
    this.bus.emit('vein:replanned');
  }

  /** 占地边缘到矿点的切比雪夫距离（斜着走也算一步，跟邻接口径一致）。 */
  private tilesTo(b: Building, v: GridPos): number {
    let best = Number.POSITIVE_INFINITY;
    for (let r = 0; r < b.rows; r++) {
      for (let c = 0; c < b.cols; c++) {
        best = Math.min(best, Math.max(Math.abs(v.col - (b.origin.col + c)), Math.abs(v.row - (b.origin.row + r))));
      }
    }
    return best;
  }

  private ensureVeinPlan(): void {
    // 除了显式挂脏，再自校一条：在建楼数一变就说明"谁在场"变了。
    // 少了这道保险，任何绕过 tick() 直接改 built 的写法（测试、回放快进、调试台）
    // 都会读到一份"这栋楼还没封顶"的旧分配，表现为明明有矿却说附近没矿。
    if (this.planValid && this.builtCount() === this.plannedBuilt) return;
    this.planVeins();
  }

  private builtCount(): number {
    let n = 0;
    for (const b of this.buildings.values()) if (b.built) n++;
    return n;
  }

  /** 任何会改变"谁在场"的事都要挂脏：盖楼、拆楼、封顶、矿脉被压掉。 */
  private invalidateVeinPlan(): void {
    this.planValid = false;
  }

  /** 这格占地上有哪些晶脉会被压掉，用来决定要不要弹确认框。 */
  veinsUnder(origin: GridPos, cols: number, rows: number): GridPos[] {
    return footprintRect({ origin, cols, rows }).filter((c) => this.map.terrainAt(c) === 'vein');
  }

  /** 压掉晶脉：地块变成开采过的裸土，从此再也采不出东西，是不可逆的。 */
  destroyVeins(cells: GridPos[]): void {
    if (cells.length === 0) return;
    for (const cell of cells) this.map.setTerrain(cell, VEIN_WORK.ruinedTerrain);
    this.invalidateVeinPlan();
    this.bus.emit('vein:destroyed', cells);
  }

  /**
   * 面包容积 = 底子 + 每座磨坊一份。磨坊同时兼任粮仓，
   * 所以"面包涨不上去"这件事有明确的可读原因：不是卡了数值，是没仓。
   */
  get breadCap(): number {
    let cap = BREAD.baseCap;
    for (const b of this.buildings.values()) {
      if (b.built && b.def.breadPerRound) cap += BREAD.capPerMill;
    }
    return cap;
  }

  /** 这栋楼四周（8 向）贴着几栋某种楼。田地给磨坊加产、以及"田地必须贴磨坊"都读这一处。 */
  adjacentOf(b: Building, defId: string): number {
    let n = 0;
    for (const other of this.buildings.values()) {
      if (other.id === b.id || !other.def.id.startsWith(defId)) continue;
      if (this.tilesBetween(b, other) === 0) n++;
    }
    return n;
  }

  /** 两块占地是否相接或重叠：切比雪夫距离按"占地边缘"算，0 就是贴上了。 */
  private tilesBetween(a: Building, b: Building): number {
    const gapCol = Math.max(a.origin.col - (b.origin.col + b.cols - 1), b.origin.col - (a.origin.col + a.cols - 1));
    const gapRow = Math.max(a.origin.row - (b.origin.row + b.rows - 1), b.origin.row - (a.origin.row + a.rows - 1));
    return Math.max(0, Math.max(gapCol, gapRow) - 1);
  }

  /** 这一回合能进账几个面包（结算时才写账，见 ROUNDS）。 */
  breadPerRound(): number {
    let n = 0;
    for (const b of this.buildings.values()) {
      if (!b.built) continue;
      const spec = b.def.breadPerRound;
      if (spec) {
        n += spec.base + spec.perAdjacentField * this.adjacentOf(b, 'field');
      } else if (b.def.unique) {
        // 主城白送面包："默认给你一些" —— 不占磨坊的仓，但照样受容积夹
        n += BREAD.perRoundFromHall;
      }
    }
    return n;
  }

  /** 缺哪些资源、各缺多少。给提示语用，让玩家知道去哪儿补。 */
  missingCost(cost: Partial<Record<ResourceId, number>>): string {
    const parts = (Object.keys(cost) as ResourceId[])
      .filter((res) => this.resources[res] < (cost[res] ?? 0))
      .map((res) => `${RESOURCE_META[res].label} ${Math.ceil((cost[res] ?? 0) - this.resources[res])}`);
    return parts.length > 0 ? `（缺 ${parts.join('、')}）` : '';
  }

  // ---------------------------------------------------------------- 落位判定

  /** 只做几何与规则判定，副作用为零，放置预览每帧都能安全调用。 */
  inspectPlacement(def: BuildingDef, origin: GridPos): BuildBlock | null {
    const cells = footprintRect({ origin, cols: def.footprint.cols, rows: def.footprint.rows });
    if (!cells.every((c) => inBounds(c, this.map.size))) return 'out-of-bounds';

    // 晶脉是"可以压但会毁资源"，不是"地形允许"：这里放行，
    // 要不要压由 veinsUnder + 确认框那一层决定
    if (!cells.every((c) => TERRAIN[this.map.terrainAt(c) ?? 'rock'].buildable)) return 'terrain';

    const holder = cells.map((c) => this.map.buildingAt(c)).find((id) => id !== null);
    if (holder !== undefined) return 'occupied';

    // 田地这类"必须贴着某栋楼"的：先按占地的外圈判，和 tilesBetween 同一口径
    if (def.requiresAdjacent) {
      const probe: Building = {
        id: -1,
        def,
        origin,
        cols: def.footprint.cols,
        rows: def.footprint.rows,
        progress: 1,
        built: true,
        surfaceY: 0,
        placedAt: 0,
        rally: null,
        hp: def.hp,
      };
      if (this.adjacentOf(probe, def.requiresAdjacent) === 0) return 'no-adjacent';
    }

    if (def.unique && [...this.buildings.values()].some((b) => b.def.id === def.id)) return 'unique';
    if (this.permitCount(def.id) <= 0) return 'no-permit';
    if (!this.canAfford(def.cost)) return 'cost';

    // 人口**不再**是建造闸门：缺人手也要让人把塔/兵营盖下去，
    // 代价是那栋楼缺员不干活（understaffed），而不是点不下去。
    return null;
  }

  // ---------------------------------------------------------------- 变更

  addPermits(buildingId: string, count: number): void {
    const next = this.permitCount(buildingId) + count;
    this.permits.set(buildingId, Math.max(0, next));
    this.bus.emit('permit:changed', { buildingId, count: next });
  }

  grant(resource: ResourceId, amount: number): void {
    const next = this.resources[resource] + amount;
    // 面包是容积：到顶就不再涨，多出来的那部分不是"消失"，是压根没进账
    const ceiling = resource === 'bread' ? this.breadCap : Number.POSITIVE_INFINITY;
    this.resources[resource] = Math.min(ceiling, Math.max(0, next));
  }

  addPopulationCap(amount: number): void {
    this.bonusPopulationCap += amount;
    this.raiseApproved();
    this.bus.emit('population:changed', { cap: this.populationCap, used: this.populationUsed() });
  }

  /**
   * 快照只往上走，不往下走：抽到民居当场就多 4 个人口（不然玩家会觉得没生效），
   * 而房屋被拆掉时容量**不许**当场掉 —— 那正是"本回合兵营照常产兵"的由来。
   * 往下掉只发生在 settle() 里。
   */
  private raiseApproved(): void {
    this.approvedPopulation = Math.max(this.approvedPopulation, this.populationCap);
  }

  addCardYield(resource: ResourceId, perSecond: number): void {
    this.cardYields[resource] = (this.cardYields[resource] ?? 0) + perSecond;
  }

  /** 把一次抽卡的结算落到世界上。 */
  applyOutcome(outcome: PullOutcome): void {
    this.pullHistory.push(outcome);
    this.seenCards.add(outcome.card.id);
    for (const effect of outcome.card.effects) {
      switch (effect.kind) {
        case 'permit':
          this.addPermits(effect.buildingId, effect.count);
          break;
        case 'grant':
          this.grant(effect.resource, effect.amount);
          break;
        case 'yield':
          this.addCardYield(effect.resource, effect.perSecond);
          break;
        case 'populationCap':
          this.addPopulationCap(effect.amount);
          break;
      }
    }
  }

  cardById(id: string): CardDef {
    return CARDS[id]!;
  }

  /** 一次购买的总账：逐张落地效果。广播 'pull:done' 由调用方（GameApp）负责。 */
  applyPurchase(purchase: Purchase): void {
    for (const outcome of purchase.outcomes) this.applyOutcome(outcome);
  }

  /** 付账。调用前必须已经 canAfford，否则会被 clamp 成少付。 */
  spend(cost: Partial<Record<ResourceId, number>>): void {
    for (const [res, amount] of Object.entries(cost)) {
      this.grant(res as ResourceId, -(amount ?? 0));
    }
  }

  /** 建造：全部判定通过才动账，任何一步失败都不留半个建筑。 */
  build(buildingId: string, origin: GridPos, allowDestroy = false): Building | null {
    const def = buildingDef(buildingId);
    const block = this.inspectPlacement(def, origin);
    if (block) {
      // 资源不够时要报出**缺哪一种**：面包盖不了房子，玩家得知道去修磨坊
      const detail = block === 'cost' ? this.missingCost(def.cost) : '';
      this.bus.emit('toast', { text: `盖不了：${BLOCK_TEXT[block]}${detail}`, tone: 'warn' });
      return null;
    }

    // 压晶脉是不可逆的，所以这一关放在世界层：交互、脚本、回放都绕不过去
    const atRisk = this.veinsUnder(origin, def.footprint.cols, def.footprint.rows);
    if (atRisk.length > 0 && !allowDestroy) {
      this.bus.emit('toast', { text: `这里压着 ${atRisk.length} 格晶脉，得先确认才会毁掉`, tone: 'warn' });
      return null;
    }

    for (const [res, amount] of Object.entries(def.cost)) {
      this.grant(res as ResourceId, -(amount ?? 0));
    }
    this.addPermits(def.id, -1);

    const building: Building = {
      id: this.nextId++,
      def,
      origin,
      cols: def.footprint.cols,
      rows: def.footprint.rows,
      progress: def.buildSeconds > 0 ? 0 : 1,
      built: def.buildSeconds <= 0,
      surfaceY: this.map.footprintSurfaceY(origin, def.footprint.cols, def.footprint.rows),
      placedAt: this.time,
      rally: null,
      hp: def.hp,
    };

    this.map.claim(origin, building.cols, building.rows, building.id);
    this.buildings.set(building.id, building);
    if (atRisk.length > 0) this.destroyVeins(atRisk);
    this.invalidateVeinPlan();
    this.raiseApproved();
    this.bus.emit('building:placed', building);
    this.bus.emit('population:changed', { cap: this.populationCap, used: this.populationUsed() });
    if (building.built) this.bus.emit('building:built', building);
    return building;
  }

  demolish(id: number): void {
    const b = this.buildings.get(id);
    if (!b) return;
    this.map.release(id);
    this.buildings.delete(id);
    this.invalidateVeinPlan();
    if (this.selection?.kind === 'building' && this.selection.building.id === id) this.select(null);
    this.bus.emit('building:removed', b);
    this.bus.emit('population:changed', { cap: this.populationCap, used: this.populationUsed() });
  }

  /**
   * 集合旗现在指哪一格。没挪过就回落到占地自己的一格 ——
   * 存 null 而不是存下初始格子：将来默认算法要改，不用把在场的楼一个个刷一遍。
   *
   * 2x2 取的是**靠镜头那一格**（东南角那格），不是左上角：
   * 相机 yaw 45° / pitch 50°，玩家看到的是楼的东南面，旗子钉在背面那格会"旗子楼身不同框"。
   */
  rallyOf(b: Building): GridPos {
    if (b.rally) return b.rally;
    return pos(b.origin.col + (b.cols >> 1), b.origin.row + (b.rows >> 1));
  }

  /**
   * 放下集合旗。返回 false 时这栋楼一个字没动，也不广播事件 ——
   * "水面上/岩脊上站不住人"和"越界"都从这里挡掉，UI 不用自己判地形。
   */
  setRally(buildingId: number, cell: GridPos): boolean {
    const b = this.buildings.get(buildingId);
    if (!b) return false;

    if (!inBounds(cell, this.map.size)) {
      this.bus.emit('toast', { text: '旗子得插在地图里', tone: 'warn' });
      return false;
    }
    const terrain = this.map.terrainAt(cell) ?? 'rock';
    if (!isStandable(terrain)) {
      this.bus.emit('toast', { text: `${TERRAIN[terrain].label}上站不住人`, tone: 'warn' });
      return false;
    }

    b.rally = pos(cell.col, cell.row);
    this.bus.emit('rally:changed', b);
    return true;
  }

  /**
   * 挨一下。归零就走已有的 demolish 那条路 —— 归还地块、回收读数、拆掉小人都有现成的锁覆盖，
   * 所以"被打掉"和"自己拆掉"在账上必须是同一件事，不然两套清理迟早对不上。
   * 返回 true = 这一栋从此不存在了。
   */
  damage(buildingId: number, amount: number): boolean {
    const b = this.buildings.get(buildingId);
    if (!b || amount <= 0) return false;
    b.hp = Math.max(0, b.hp - amount);
    this.bus.emit('building:hit', { building: b, damage: amount, hp: b.hp });
    if (b.hp > 0) return false;
    this.bus.emit('building:destroyed', b);
    this.demolish(buildingId);
    return true;
  }

  /** 议事厅还在不在。它归零就是输。 */
  get hallAlive(): boolean {
    for (const b of this.buildings.values()) if (b.def.id === 'hall') return true;
    return false;
  }

  select(selection: Selection): void {
    this.selection = selection;
    this.bus.emit('selection:changed', selection);
  }

  // ---------------------------------------------------------------- 每帧

  /** 固定步长调用：推进工地、跑回合节奏、把接敌期间的产出攒到结算。 */
  tick(dt: number): void {
    this.time += dt;

    for (const b of this.buildings.values()) {
      if (b.built) continue;
      b.progress = Math.min(1, b.progress + dt / Math.max(0.01, b.def.buildSeconds));
      if (b.progress >= 1) {
        b.built = true;
        this.invalidateVeinPlan();
        this.bus.emit('building:built', b);
      }
    }

    // 准备时间只有**水晶**不涨（用户原话点的是水晶）：金币照常在攒，
    // 但都压在 pending 里等结算那一刻才进钱包 —— 不然每回合十几块金币，塔根本补不起。
    const inRaid = this.phase === 'raid';
    if (inRaid) this.raidElapsed += dt;
    this.phaseLeft -= inRaid ? 0 : dt;

    const rates = this.incomeRates();
    for (const res of Object.keys(rates) as ResourceId[]) {
      if (!inRaid && res === 'crystal') continue;
      const gain = (rates[res] ?? 0) * dt;
      if (gain !== 0) this.pending[res] += gain;
    }

    if (!inRaid) {
      if (this.phaseLeft <= 0) this.startRaid();
      return;
    }

    const cleared = !this.raidActive() && this.raidElapsed >= ROUNDS.raidMinSeconds;
    if (cleared || this.raidElapsed >= ROUNDS.raidMaxSeconds) this.settle();
  }
}
