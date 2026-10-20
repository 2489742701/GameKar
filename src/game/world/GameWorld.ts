/**
 * 世界状态 —— 一局的"账本"：地块、建筑、资源、人口、许可、抽卡记录。
 *
 * 这里不 import three，也不 import DOM：所以它能被单测直接 new 出来跑一百抽。
 * 渲染和 UI 都是它外侧的订阅者。
 */

import { EventBus } from '@engine/core/EventBus';
import type { FlatSize, GridPos } from '@engine/math/Grid';
import { footprintRect, inBounds, toKey } from '@engine/math/Grid';
import { ECONOMY, TERRAIN, VEIN_WORK, type ResourceId } from '@game/config';
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
}

export type Selection = { kind: 'tile'; pos: GridPos } | { kind: 'building'; building: Building } | null;

export type BuildBlock = 'out-of-bounds' | 'terrain' | 'occupied' | 'cost' | 'population' | 'unique' | 'no-permit';

export const BLOCK_TEXT: Record<BuildBlock, string> = {
  'out-of-bounds': '超出地图',
  terrain: '地形不允许',
  occupied: '这块地已被占用',
  cost: '资源不够',
  population: '人口不足',
  unique: '这种建筑全场只能有一座',
  'no-permit': '没有建造许可，先去抽卡',
};

/**
 * 全局广播表。抽卡与放置模式严格说不算"世界状态"，
 * 但它们的后果最终都落到世界上（许可、幽灵），所以共用一条总线，UI 只订阅一处。
 */
export interface WorldEvents {
  'building:placed': Building;
  'building:built': Building;
  'building:removed': Building;
  'vein:destroyed': GridPos[];
  /** 玩家想盖的这一格压着晶脉，需要一次明确同意 */
  'confirm:vein': { cells: GridPos[]; buildingName: string };
  /** 长按某个建筑 = 查详情；null 表示收起 */
  'inspect:target': Building | null;
  'permit:changed': { buildingId: string; count: number };
  'population:changed': { cap: number; used: number };
  'pull:done': Purchase;
  'placing:changed': string | null;
  'selection:changed': Selection;
  toast: { text: string; tone?: 'ok' | 'warn' };
}

const zeroWallet = (): Record<ResourceId, number> => ({ gold: 0, crystal: 0 });

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
    return this.populationCap - this.populationUsed();
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

    if (def.unique && [...this.buildings.values()].some((b) => b.def.id === def.id)) return 'unique';
    if (this.permitCount(def.id) <= 0) return 'no-permit';
    if (!this.canAfford(def.cost)) return 'cost';
    if (def.population > this.populationFree()) return 'population';

    return null;
  }

  // ---------------------------------------------------------------- 变更

  addPermits(buildingId: string, count: number): void {
    const next = this.permitCount(buildingId) + count;
    this.permits.set(buildingId, Math.max(0, next));
    this.bus.emit('permit:changed', { buildingId, count: next });
  }

  grant(resource: ResourceId, amount: number): void {
    this.resources[resource] = Math.max(0, this.resources[resource] + amount);
  }

  addPopulationCap(amount: number): void {
    this.bonusPopulationCap += amount;
    this.bus.emit('population:changed', { cap: this.populationCap, used: this.populationUsed() });
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
      this.bus.emit('toast', { text: `盖不了：${BLOCK_TEXT[block]}`, tone: 'warn' });
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
    };

    this.map.claim(origin, building.cols, building.rows, building.id);
    this.buildings.set(building.id, building);
    if (atRisk.length > 0) this.destroyVeins(atRisk);
    this.invalidateVeinPlan();
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

  select(selection: Selection): void {
    this.selection = selection;
    this.bus.emit('selection:changed', selection);
  }

  // ---------------------------------------------------------------- 每帧

  /** 固定步长调用：推进工地、结算进账。 */
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

    const rates = this.incomeRates();
    for (const res of Object.keys(rates) as ResourceId[]) {
      const gain = (rates[res] ?? 0) * dt;
      if (gain !== 0) this.grant(res, gain);
    }
  }
}
