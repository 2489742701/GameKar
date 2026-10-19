/**
 * 世界状态 —— 一局的"账本"：地块、建筑、资源、人口、许可、抽卡记录。
 *
 * 这里不 import three，也不 import DOM：所以它能被单测直接 new 出来跑一百抽。
 * 渲染和 UI 都是它外侧的订阅者。
 */

import { EventBus } from '@engine/core/EventBus';
import type { FlatSize, GridPos } from '@engine/math/Grid';
import { footprintRect, inBounds } from '@engine/math/Grid';
import { ECONOMY, TERRAIN, type ResourceId } from '@game/config';
import { TERRAIN_BONUS, buildingDef, type BuildingDef } from '@game/data/buildings';
import { CARDS, type CardDef } from '@game/data/cards';
import type { Purchase, PullOutcome } from '@game/gacha/GachaService';
import type { TileMap } from './TileMap';

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

  populationCap = ECONOMY.basePopulationCap;
  selection: Selection = null;
  time = 0;

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

  /** 单座建筑的每秒产出，已含"盖在晶脉上翻倍"这类地形加成。 */
  yieldOf(b: Building): Partial<Record<ResourceId, number>> {
    if (!b.built || !b.def.yields) return {};
    const bonus = this.terrainBonus(b);
    const out: Partial<Record<ResourceId, number>> = {};
    for (const [res, rate] of Object.entries(b.def.yields)) {
      out[res as ResourceId] = (rate ?? 0) * bonus;
    }
    return out;
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

  private terrainBonus(b: Building): number {
    let best = 1;
    for (const cell of footprintRect({ origin: b.origin, cols: b.cols, rows: b.rows })) {
      const t = this.map.terrainAt(cell);
      if (t && TERRAIN_BONUS[t]) best = Math.max(best, TERRAIN_BONUS[t]!);
    }
    return best;
  }

  // ---------------------------------------------------------------- 落位判定

  /** 只做几何与规则判定，副作用为零，放置预览每帧都能安全调用。 */
  inspectPlacement(def: BuildingDef, origin: GridPos): BuildBlock | null {
    const cells = footprintRect({ origin, cols: def.footprint.cols, rows: def.footprint.rows });
    if (!cells.every((c) => inBounds(c, this.map.size))) return 'out-of-bounds';

    if (def.requiresTerrain) {
      const onRequired = cells.some((c) => this.map.terrainAt(c) === def.requiresTerrain);
      if (!onRequired) return 'terrain';
    }
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
    this.populationCap = Math.max(0, this.populationCap + amount);
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
  build(buildingId: string, origin: GridPos): Building | null {
    const def = buildingDef(buildingId);
    const block = this.inspectPlacement(def, origin);
    if (block) {
      this.bus.emit('toast', { text: `盖不了：${BLOCK_TEXT[block]}`, tone: 'warn' });
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
