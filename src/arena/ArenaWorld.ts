/**
 * 对战模式的世界状态 —— **纯逻辑**，不 import three、不碰 DOM。
 *
 * 所以一局能在 node 里跑完（tests/arena.test.ts 就是这么验的）：
 * 金币、手牌、建筑节拍、兵的前进与互殴、AI、胜负，全在这里。
 *
 * 三条规则写死在这里，别处不许再判一遍：
 * 1. **建筑没有寿命**：不会自己掉血、不会定时消失，只有被打掉。
 * 2. **兵只能放在自己半场**；建筑同理（防止一开局就往对面脸上丢兵营）。
 * 3. **拆掉对方核心才算赢**，兵死光了不算输。
 */

import { Random } from '@engine/math/Random';
import { UNITS, damageOf, unitDef } from '@game/data/units';
import {
  AI,
  BARRACKS,
  BUILDING_SPECS,
  CARDS,
  CORE,
  ECONOMY,
  FIELD,
  HAND,
  TOWER,
  cardById,
  type ArenaCard,
  type BuildingKind,
  type Side,
} from './config';

export type { Side };

export interface ArenaBuilding {
  id: number;
  side: Side;
  /** 'core' = 主城 */
  kind: BuildingKind | 'core';
  col: number;
  row: number;
  cols: number;
  rows: number;
  hp: number;
  maxHp: number;
  /** 兵营/磨坊的节拍计时 */
  timer: number;
  /** 塔的下一发 */
  fireIn: number;
  /** 兵营的出兵点（旗）。null = 用默认位置 */
  flag: { col: number; row: number } | null;
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
}

export type Outcome = 'playing' | 'win' | 'lose';

export interface PlayResult {
  ok: boolean;
  /** 失败原因，直接给 HUD 显示 */
  reason?: string;
}

export interface ArenaOptions {
  seed?: number;
  /** 开局手牌（测试用；不给就按 seed 随机发 4 张） */
  hand?: string[];
}

export class ArenaWorld {
  readonly seed: number;
  readonly rng: Random;

  gold: Record<Side, number> = { blue: ECONOMY.start, red: ECONOMY.start };
  /** 只有蓝方有"手牌"；红方走 AI，直接按卡池挑 */
  readonly hand: (ArenaCard | null)[] = [null, null, null, null];
  readonly handCooldown: number[] = [0, 0, 0, 0];

  readonly buildings = new Map<number, ArenaBuilding>();
  units: ArenaUnit[] = [];

  outcome: Outcome = 'playing';
  elapsed = 0;

  private nextId = 1;
  private aiIn = AI.thinkSeconds;

  constructor(options: ArenaOptions = {}) {
    this.seed = options.seed ?? 1;
    this.rng = new Random(this.seed);

    this.place('blue', 'core', Math.floor((FIELD.cols - CORE.cols) / 2), FIELD.rows - CORE.rows - 1, CORE.hp);
    this.place('red', 'core', Math.floor((FIELD.cols - CORE.cols) / 2), 1, CORE.hp);

    const fixed = options.hand ?? [];
    for (let i = 0; i < HAND.size; i++) {
      this.hand[i] = fixed[i] ? cardById(fixed[i]!) : this.rng.pick(CARDS);
    }
  }

  // ---------------------------------------------------------------- 查询

  /** 场地尺寸（视图层建地面要它，别自己再去读一遍配置）。 */
  get fieldSize(): { cols: number; rows: number } {
    return { cols: FIELD.cols, rows: FIELD.rows };
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

  /** 己方半场：蓝在下方（row ≥ midRow），红在上方。 */
  inOwnHalf(side: Side, row: number): boolean {
    return side === 'blue' ? row >= FIELD.midRow : row < FIELD.midRow;
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
      timer: 0,
      fireIn: 0,
      flag: null,
    };
    this.buildings.set(b.id, b);
    return b;
  }

  /** 兵营的出兵点：没挪过就用"朝对手那一面"的第一格空地。 */
  spawnCellOf(b: ArenaBuilding): { col: number; row: number } {
    if (b.flag) return b.flag;
    // 蓝方朝上打，出兵点在自己上沿外侧；红方反过来
    const row = b.side === 'blue' ? b.row - 1 : b.row + b.rows;
    const col = b.col + Math.floor(b.cols / 2);
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
   * 打出手牌第 slot 张。
   * 失败原因会原样给 HUD 用：金不够 / 半场不对 / 这格被占 / 卡还在冷却。
   */
  playCard(side: Side, slot: number, col: number, row: number): PlayResult {
    if (this.outcome !== 'playing') return { ok: false, reason: '这一局已经结束' };
    const card = this.hand[slot];
    if (!card) return { ok: false, reason: '这格是空的' };
    if (this.handCooldown[slot]! > 0) return { ok: false, reason: '这张还在冷却' };
    if (this.gold[side] < card.cost) return { ok: false, reason: `金币不够（要 ${card.cost}）` };
    if (!this.inOwnHalf(side, row)) return { ok: false, reason: '只能放在自己半场' };

    if (card.kind === 'building') {
      const spec = BUILDING_SPECS[card.building!];
      if (col + spec.cols > FIELD.cols || row + spec.rows > FIELD.rows) return { ok: false, reason: '出界了' };
      if (!this.cellFree(col, row, spec.cols, spec.rows)) return { ok: false, reason: '这格被占了' };
    }

    this.execute(side, card, col, row);
    // 打出去就进冷却，冷却完补一张新的（配卡组以后再做）
    this.hand[slot] = null;
    this.handCooldown[slot] = HAND.refillSeconds;
    return { ok: true };
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

  /** 立刻把某张牌发给蓝方（AI 不走这里）。 */
  private drawInto(slot: number): void {
    this.hand[slot] = this.rng.pick(CARDS);
  }

  private spend(side: Side, amount: number): void {
    this.gold[side] = Math.max(0, this.gold[side] - amount);
  }

  private spawnSquad(side: Side, squad: { unitId: string; count: number }[], col: number, row: number): void {
    let i = 0;
    for (const part of squad) {
      for (let n = 0; n < part.count; n++) {
        const def = UNITS[part.unitId];
        if (!def) continue;
        // 以落点为中心散开：一格塞不下三个，错开成 3×3 的小方阵
        const dc = (i % 3) - 1;
        const dr = Math.floor(i / 3) - 1;
        this.units.push({
          id: this.nextId++,
          side,
          defId: part.unitId,
          x: col + 0.5 + dc * 0.32,
          z: row + 0.5 + dr * 0.32,
          hp: def.hp,
          maxHp: def.hp,
          cooldown: 0,
          stun: 0,
        });
        i++;
      }
    }
  }

  // ---------------------------------------------------------------- 每帧

  update(dt: number): void {
    if (this.outcome !== 'playing') return;
    this.elapsed += dt;

    // 金：到上限就不涨
    for (const side of ['blue', 'red'] as Side[]) {
      this.gold[side] = Math.min(ECONOMY.cap, this.gold[side] + ECONOMY.perSecond * dt);
    }

    // 手牌冷却
    for (let i = 0; i < this.handCooldown.length; i++) {
      if (this.handCooldown[i]! <= 0) continue;
      this.handCooldown[i] = Math.max(0, this.handCooldown[i]! - dt);
      if (this.handCooldown[i] === 0) this.drawInto(i);
    }

    this.tickBuildings(dt);
    this.tickUnits(dt);
    this.tickAi(dt);
    this.checkOutcome();
  }

  private tickBuildings(dt: number): void {
    for (const b of this.buildings.values()) {
      if (b.kind === 'core') continue;
      if (b.kind === 'barracks') {
        b.timer += dt;
        if (b.timer < BARRACKS.interval) continue;
        b.timer = 0;
        const mine = this.units.filter((u) => u.side === b.side).length;
        if (mine >= BARRACKS.cap) continue;
        const at = this.spawnCellOf(b);
        this.spawnSquad(b.side, [{ unitId: b.side === 'blue' ? 'knight' : 'orc', count: 1 }], at.col, at.row);
        continue;
      }
      if (b.kind === 'mill') {
        b.timer += dt;
        if (b.timer < ECONOMY.millInterval) continue;
        b.timer = 0;
        this.gold[b.side] = Math.min(ECONOMY.cap, this.gold[b.side] + ECONOMY.millBonus);
        continue;
      }
      // 塔：打最近的敌兵；没有敌兵就不打建筑（和皇室战争一样只守兵）
      b.fireIn = Math.max(0, b.fireIn - dt);
      if (b.fireIn > 0) continue;
      const spec = b.kind === 'arrowTower' ? TOWER.arrow : TOWER.cannon;
      const c = this.buildingCenter(b);
      const target = this.nearestEnemyUnit(b.side, c.x, c.z, spec.range);
      if (!target) continue;
      b.fireIn = spec.interval;
      const dmg = spec.damage;
      if ('splash' in spec && spec.splash) {
        for (const u of this.units) {
          if (u.side === b.side || u.hp <= 0) continue;
          if (Math.hypot(u.x - target.x, u.z - target.z) <= spec.splash) this.hurtUnit(u, dmg);
        }
      } else {
        this.hurtUnit(target, dmg);
      }
    }
    this.units = this.units.filter((u) => u.hp > 0);
  }

  private tickUnits(dt: number): void {
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const def = unitDef(u.defId);
      u.cooldown = Math.max(0, u.cooldown - dt);
      u.stun = Math.max(0, u.stun - dt);
      if (u.stun > 0) continue;

      const foe = this.nearestHostile(u, def.sight, def.range);
      if (foe && foe.dist <= def.range) {
        if (u.cooldown > 0) continue;
        u.cooldown = def.cooldown;
        if (foe.unit) this.hurtUnit(foe.unit, def.attack);
        else if (foe.building) this.hurtBuilding(foe.building, def.attack);
        continue;
      }

      // 没得打就朝对方核心走；路上被谁挡住就贴上去打（下面这一支）
      const goal = this.coreOf(u.side === 'blue' ? 'red' : 'blue');
      const gx = goal ? goal.col + goal.cols / 2 : FIELD.cols / 2;
      const gz = goal ? goal.row + goal.rows / 2 : FIELD.rows / 2;
      const tx = foe ? foe.x : gx;
      const tz = foe ? foe.z : gz;
      const dist = Math.hypot(tx - u.x, tz - u.z);
      if (dist < 0.001) continue;
      const step = Math.min(dist, def.speed * dt);
      u.x += ((tx - u.x) / dist) * step;
      u.z += ((tz - u.z) / dist) * step;
    }
    this.units = this.units.filter((u) => u.hp > 0);
  }

  /** 最近的敌对目标：先看兵，再看建筑。 */
  private nearestHostile(
    u: ArenaUnit,
    sight: number,
    _range: number,
  ): { dist: number; x: number; z: number; unit?: ArenaUnit; building?: ArenaBuilding } | null {
    let best: { dist: number; x: number; z: number; unit?: ArenaUnit; building?: ArenaBuilding } | null = null;
    for (const other of this.units) {
      if (other.side === u.side || other.hp <= 0) continue;
      const d = Math.hypot(other.x - u.x, other.z - u.z);
      if (d <= sight && (!best || d < best.dist)) best = { dist: d, x: other.x, z: other.z, unit: other };
    }
    if (best) return best;
    for (const b of this.buildings.values()) {
      if (b.side === u.side) continue;
      const c = this.buildingCenter(b);
      const d = Math.hypot(c.x - u.x, c.z - u.z);
      // 打建筑要看"贴到占地边缘"，不然大建筑永远够不着
      const edge = Math.max(0, d - Math.max(b.cols, b.rows) / 2);
      if (edge <= sight && (!best || edge < best.dist)) best = { dist: edge, x: c.x, z: c.z, building: b };
    }
    return best;
  }

  private nearestEnemyUnit(side: Side, x: number, z: number, range: number): ArenaUnit | null {
    let best: ArenaUnit | null = null;
    let bestD = range;
    for (const u of this.units) {
      if (u.side === side || u.hp <= 0) continue;
      const d = Math.hypot(u.x - x, u.z - z);
      if (d <= bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private hurtUnit(u: ArenaUnit, attack: number): void {
    const def = unitDef(u.defId);
    u.hp -= damageOf(attack, def.defense);
    if (u.hp < 0) u.hp = 0;
  }

  private hurtBuilding(b: ArenaBuilding, attack: number): void {
    b.hp -= damageOf(attack, 0);
    if (b.hp < 0) b.hp = 0;
    if (b.hp > 0) return;
    this.buildings.delete(b.id);
  }

  // ---------------------------------------------------------------- AI

  /**
   * 红方：**先建筑、后军队**（用户点的路线）。
   * 手上永远从整池里挑，不看手牌（它没有手牌，只有钱包）。
   */
  private tickAi(dt: number): void {
    this.aiIn -= dt;
    if (this.aiIn > 0) return;
    this.aiIn = AI.thinkSeconds;

    const kinds = [...this.buildings.values()].filter((b) => b.side === 'red' && b.kind !== 'core');
    const buildings = kinds.filter((b) => b.kind !== 'barracks').length;

    const affordable = CARDS.filter((c) => c.cost <= this.gold.red).sort((a, b) => b.cost - a.cost);
    if (affordable.length === 0) return;

    const wantsBuilding = buildings < AI.buildingsBeforeSquad;
    const card = affordable.find((c) => (wantsBuilding ? c.kind === 'building' : true)) ?? affordable[0]!;
    const cell = this.randomSpot('red', card);
    if (!cell) return;
    this.execute('red', card, cell.col, cell.row);
  }

  /** AI 的落点：自己半场、不压楼。 */
  private randomSpot(side: Side, card: ArenaCard): { col: number; row: number } | null {
    const spec = card.kind === 'building' ? BUILDING_SPECS[card.building!] : { cols: 1, rows: 1 };
    for (let tries = 0; tries < 24; tries++) {
      const row = side === 'red' ? this.rng.int(FIELD.midRow - 6, FIELD.midRow) : this.rng.int(FIELD.midRow, FIELD.rows - 2);
      const col = this.rng.int(0, FIELD.cols - spec.cols);
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

  private checkOutcome(): void {
    const blueCore = this.coreOf('blue');
    const redCore = this.coreOf('red');
    if (!redCore) this.outcome = 'win';
    else if (!blueCore) this.outcome = 'lose';
  }

  /** 给 HUD 的一行读数：金、手牌、双方核心血量。 */
  summary() {
    return {
      gold: Math.floor(this.gold.blue),
      goldCap: ECONOMY.cap,
      blueCore: Math.round(this.coreOf('blue')?.hp ?? 0),
      redCore: Math.round(this.coreOf('red')?.hp ?? 0),
      coreMax: CORE.hp,
      units: { blue: this.units.filter((u) => u.side === 'blue').length, red: this.units.filter((u) => u.side === 'red').length },
      outcome: this.outcome,
    };
  }
}
