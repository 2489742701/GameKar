/**
 * 战斗内核 —— 兵、塔、弹丸、波次都在这一个状态机里，不 import three。
 *
 * 三条口径先写明白，免得后面到处各判各的：
 * 1. **伤害 = max(1, 攻 − 防)**（`damageOf`，下限保证"堆防堆不死人"这件事不发生）。
 * 2. **弹丸是有实体的**：塔开火只是把一发弹丸扔进 `projectiles`，伤害在**落地那一刻**才发生。
 *    所以"箭是 2D 的箭、炮弹是 3D 黑方块、砸过去会爆炸"是视图的事，
 *    "什么时候算打到"是这里的事，两边只通过 id 与位置对齐。
 * 3. **缺员的楼不开火、不产兵**：判据一律走 `world.isUnderstaffed()`，这里不自己数人口。
 */

import type { FlatSize, GridPos } from '@engine/math/Grid';
import { cellToWorld, pos, worldToCell } from '@engine/math/Grid';
import { ROUNDS, isStandable } from '@game/config';
import { UNITS, damageOf, unitDef, type UnitDef } from '@game/data/units';
import type { Building, GameWorld } from '@game/world/GameWorld';

/** 一枪打出去的弹丸：位置是世界坐标，ttl 走完就到点。 */
export interface Shot {
  id: number;
  ammo: 'arrow' | 'cannon' | 'magic';
  x: number;
  z: number;
  y: number;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  /** 0..1 飞行进度，视图按它插值 */
  t: number;
  seconds: number;
  damage: number;
  splash: number;
  /** 打谁：null = 打地面（炮塔预判落点） */
  targetUnit: number | null;
  targetBuilding: number | null;
}

export interface Unit {
  id: number;
  def: UnitDef;
  hp: number;
  x: number;
  z: number;
  /** 兵营的锚点：守家范围从这里算 */
  home: number | null;
  cooldown: number;
  /** 冲撞/回血的自身节拍 */
  specialIn: number;
  stun: number;
  dead: boolean;
  /** 死亡动画走完才从名单里摘掉 */
  deadFor: number;
  /** 被撞飞时的位移向量（世界单位/秒，会自然衰减） */
  knockX: number;
  knockZ: number;
}

export interface TowerState {
  /** 弹夹里还剩几发 */
  magazine: number;
  /** 空仓装填剩余（秒） */
  reloading: number;
  /** 两发之间的间隔剩余 */
  cooldown: number;
  /** 升级等级 1..3 */
  level: number;
}

export interface BarracksState {
  alive: number;
  stock: number;
  /** 生产读条 0..1；只有 alive < squad 时才走 */
  progress: number;
}

export interface CombatEvents {
  /** 一次命中：视图用来放烟雾/爆炸 */
  impact: { x: number; z: number; y: number; ammo: Shot['ammo']; splash: number };
  /** 楼挨了一下：血条与缺员徽章都要跟着动 */
  'building:hit': { id: number; damage: number };
  /** 一栋楼被打掉了 */
  'building:destroyed': Building;
  /** 波次生成了一批敌人 */
  wave: { round: number; count: number; at: GridPos };
  /** 议事厅没了 */
  defeat: void;
}

export interface CombatOptions {
  world: GameWorld;
  maxUnits?: number;
  on?: <K extends keyof CombatEvents>(type: K, handler: (payload: CombatEvents[K]) => void) => void;
}

/** 一回合的敌人构成：前期全是杂兵，后面混进石怪与暗影弓手。 */
function raidComposition(round: number): string[] {
  const total = Math.min(ROUNDS.maxRaidUnits, 3 + 2 * round);
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    if (round >= 4 && i % 6 === 5) out.push('golem');
    else if (round >= 2 && i % 4 === 3) out.push('shade');
    else out.push('raider');
  }
  return out;
}

export class Combat {
  units: Unit[] = [];
  shots: Shot[] = [];
  readonly towers = new Map<number, TowerState>();
  readonly barracks = new Map<number, BarracksState>();
  /** 被毁掉的楼 id，避免同一栋楼被反复结算 */
  private readonly gone = new Set<number>();
  private nextId = 1;
  private readonly listeners = new Map<string, Set<(payload: never) => void>>();
  private readonly maxUnits: number;
  private field: FlowField | null = null;
  private fieldKey = '';
  /** 本回合的来点（每局固定一处，按 seed 现量选出来的边缘可站格） */
  private spawnPoint: GridPos | null = null;
  defeated = false;

  capped = 0;
  /** 累计开火数：弹丸在天上活不到 0.2 秒，靠采样数"看见过几发"是数不准的 */
  fired = 0;

  constructor(private readonly opts: CombatOptions) {
    this.maxUnits = opts.maxUnits ?? ROUNDS.maxRaidUnits;
    // 判负只看一件事：**议事厅被打掉**。
    // 不能写成"场上没有议事厅"—— 开局前、以及不带主城的夹具里那都是"还没盖"，不是"输了"。
    opts.world.bus.on('building:destroyed', (b) => {
      if (b.def.id !== 'hall' || this.defeated) return;
      this.defeated = true;
      this.emit('defeat', undefined);
    });
  }

  on<K extends keyof CombatEvents>(type: K, handler: (payload: CombatEvents[K]) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler as (payload: never) => void);
    this.listeners.set(type, set);
  }

  private emit<K extends keyof CombatEvents>(type: K, payload: CombatEvents[K]): void {
    for (const handler of this.listeners.get(type) ?? []) (handler as (p: CombatEvents[K]) => void)(payload);
  }

  get size(): number {
    return this.units.filter((u) => !u.dead).length;
  }

  enemiesAlive(): number {
    return this.units.filter((u) => !u.dead && u.def.faction === 'enemy').length;
  }

  // ---------------------------------------------------------------- 兵营与波次

  /** 兵营的三态：在场几个 / 储备几个 / 读条走到哪。 */
  barracksState(b: Building): BarracksState {
    let s = this.barracks.get(b.id);
    if (!s) {
      const squad = b.def.squad ?? [];
      s = {
        alive: 0,
        stock: squad.reduce((n, m) => n + Math.min(2, unitDef(m.unitId).stockInitial), 0),
        progress: 0,
      };
      this.barracks.set(b.id, s);
    }
    return s;
  }

  /** 每栋营的编制总量。 */
  squadSize(b: Building): number {
    return (b.def.squad ?? []).reduce((n, m) => n + m.size, 0);
  }

  /** 来点：地图四条边里挑一处能站人的格子，按 seed 固定。 */
  spawnAt(seed: number): GridPos {
    if (this.spawnPoint) return this.spawnPoint;
    const size = this.opts.world.map.size;
    const side = seed % 4;
    const along = 4 + ((seed >> 2) % Math.max(1, (side % 2 === 0 ? size.cols : size.rows) - 8));
    const cell =
      side === 0
        ? pos(along, 0)
        : side === 1
          ? pos(along, size.rows - 1)
          : side === 2
            ? pos(0, along)
            : pos(size.cols - 1, along);
    this.spawnPoint = this.nearestStandable(cell);
    return this.spawnPoint;
  }

  private nearestStandable(cell: GridPos): GridPos {
    const map = this.opts.world.map;
    if (isStandable(map.terrainAt(cell) ?? 'rock')) return cell;
    for (let r = 1; r < 12; r++) {
      for (let dc = -r; dc <= r; dc++) {
        for (let dr = -r; dr <= r; dr++) {
          const c = pos(cell.col + dc, cell.row + dr);
          const t = map.terrainAt(c);
          if (t && isStandable(t)) return c;
        }
      }
    }
    return cell;
  }

  /** 一回合开打时调用：把这一波敌人放进场。 */
  spawnWave(seed: number, round: number): void {
    const ids = raidComposition(round);
    const at = this.spawnAt(seed);
    for (let i = 0; i < ids.length; i++) {
      if (this.size >= this.maxUnits) {
        this.capped += ids.length - i;
        break;
      }
      const def = unitDef(ids[i]!);
      // 同一格挤一挤：按序号在 3x3 的小块里散开，别让整波人叠成一个点
      const cell = this.nearestStandable(pos(at.col + (i % 3) - 1, at.row + Math.floor(i / 3) % 3));
      const w = cellToWorld(cell);
      this.units.push({
        id: this.nextId++,
        def,
        hp: def.hp,
        x: w.x + (i % 3) * 0.02,
        z: w.z + Math.floor(i / 3) * 0.02,
        home: null,
        cooldown: 0,
        specialIn: def.special?.every ?? 0,
        stun: 0,
        dead: false,
        deadFor: 0,
        knockX: 0,
        knockZ: 0,
      });
    }
    this.field = null;
    this.emit('wave', { round, count: ids.length, at });
  }

  /** 兵营把一个小人放进场（由 update 里的读条驱动）。 */
  private spawnOwn(b: Building, defId: string): void {
    if (this.size >= this.maxUnits) {
      this.capped++;
      return;
    }
    const def = UNITS[defId]!;
    const center = cellToWorld(
      this.opts.world.rallyOf(b),
    );
    this.units.push({
      id: this.nextId++,
      def,
      hp: def.hp,
      x: center.x,
      z: center.z,
      home: b.id,
      cooldown: 0,
      specialIn: def.special?.every ?? 0,
      stun: 0,
      dead: false,
      deadFor: 0,
      knockX: 0,
      knockZ: 0,
    });
  }

  // ---------------------------------------------------------------- 每帧

  update(dt: number): void {
    if (this.defeated) return;
    const world = this.opts.world;

    this.runBarracks(dt, world);
    this.runTowers(dt, world);
    this.runShots(dt, world);
    this.runUnits(dt, world);

    this.units = this.units.filter((u) => !u.dead || u.deadFor < 1.2);
  }

  /** 兵营：死一个先从储备补，储备空了才走读条。 */
  private runBarracks(dt: number, world: GameWorld): void {
    for (const b of world.buildings.values()) {
      const squad = b.def.squad;
      if (!squad || !b.built) continue;
      const state = this.barracksState(b);
      const alive = this.units.filter((u) => !u.dead && u.home === b.id).length;
      state.alive = alive;

      const total = this.squadSize(b);
      if (alive >= total) {
        state.progress = 0;
        continue;
      }
      if (state.stock > 0) {
        state.stock -= 1;
        this.spawnOwn(b, squad[0]!.unitId);
        continue;
      }
      const train = unitDef(squad[0]!.unitId).trainSeconds;
      state.progress = Math.min(1, state.progress + dt / Math.max(0.01, train));
      if (state.progress >= 1) {
        state.progress = 0;
        this.spawnOwn(b, squad[0]!.unitId);
      }
    }
  }

  /** 塔：索敌 → 开火（进弹丸表）→ 打空了装填。缺员直接跳过。 */
  private runTowers(dt: number, world: GameWorld): void {
    for (const b of world.buildings.values()) {
      const spec = b.def.tower;
      if (!spec || !b.built) continue;
      const st = this.towerState(b);
      const level = levelScale(st.level);
      st.cooldown = Math.max(0, st.cooldown - dt);
      if (st.magazine <= 0) {
        st.reloading = Math.max(0, st.reloading - dt);
        if (st.reloading <= 0) st.magazine = spec.magazine;
        continue;
      }
      if (world.isUnderstaffed(b)) continue;

      const from = this.buildingAnchor(b);
      const target = this.nearestEnemy(from.x, from.z, spec.rangeTiles * level.range);
      if (!target) {
        st.cooldown = Math.min(st.cooldown, spec.shotSeconds * 0.5);
        continue;
      }
      if (st.cooldown > 0) continue;

      st.magazine -= 1;
      this.fired += 1;
      if (st.magazine === 0) st.reloading = spec.reloadSeconds * level.reload;
      st.cooldown = spec.shotSeconds * level.shot;

      const flight = Math.max(0.08, Math.hypot(target.x - from.x, target.z - from.z) / ammoSpeed(spec.ammo));
      this.shots.push({
        id: this.nextId++,
        ammo: spec.ammo,
        x: from.x,
        z: from.z,
        y: from.y,
        fromX: from.x,
        fromZ: from.z,
        toX: target.x,
        toZ: target.z,
        t: 0,
        seconds: flight,
        damage: Math.round(spec.damage * level.damage),
        splash: spec.splashTiles ?? 0,
        targetUnit: target.kind === 'unit' ? target.unit.id : null,
        targetBuilding: null,
      });
    }
  }

  towerState(b: Building): TowerState {
    let s = this.towers.get(b.id);
    if (!s) {
      s = { magazine: b.def.tower!.magazine, reloading: 0, cooldown: 0, level: 1 };
      this.towers.set(b.id, s);
    }
    return s;
  }

  /** 读档用：把塔的等级摆回去（不花钱、不判许可）。 */
  setTowerLevel(buildingId: number, level: number): void {
    const b = this.opts.world.buildings.get(buildingId);
    const spec = b?.def.tower;
    if (!b || !spec) return;
    const st = this.towerState(b);
    st.level = Math.min(spec.upgrades.length + 1, Math.max(1, Math.round(level)));
    st.magazine = spec.magazine;
    st.reloading = 0;
  }

  /** 升级：只花钱与水晶，不碰许可。返回 false = 钱不够或已满级。 */
  upgrade(b: Building): boolean {
    const spec = b.def.tower;
    if (!spec) return false;
    const st = this.towerState(b);
    const price = spec.upgrades[st.level - 1];
    if (!price) return false;
    const world = this.opts.world;
    const cost = { gold: price.gold, crystal: price.crystal };
    if (!world.canAfford(cost)) {
      world.bus.emit('toast', { text: `升级${b.def.name}还差一点，看看缺什么`, tone: 'warn' });
      return false;
    }
    world.spend(cost);
    st.level += 1;
    st.magazine = spec.magazine;
    st.reloading = 0;
    world.bus.emit('toast', { text: `${b.def.name}升到 Lv${st.level}` });
    return true;
  }

  private runShots(dt: number, world: GameWorld): void {
    for (const shot of this.shots) {
      shot.t = Math.min(1, shot.t + dt / shot.seconds);
      // 目标还活着就跟着走一点，死了就按最后位置落地
      const unit = shot.targetUnit !== null ? this.units.find((u) => u.id === shot.targetUnit) : undefined;
      if (unit && !unit.dead) {
        shot.toX = unit.x;
        shot.toZ = unit.z;
      }
      const k = shot.t;
      shot.x = shot.fromX + (shot.toX - shot.fromX) * k;
      shot.z = shot.fromZ + (shot.toZ - shot.fromZ) * k;
      // 炮弹走一条抛物线，箭与魔弹基本平飞
      const arc = shot.ammo === 'cannon' ? Math.sin(k * Math.PI) * 1.1 : Math.sin(k * Math.PI) * 0.12;
      shot.y = arc;

      if (shot.t < 1) continue;
      this.impact(shot, world);
    }
    this.shots = this.shots.filter((s) => s.t < 1);
  }

  private impact(shot: Shot, world: GameWorld): void {
    const hits: Unit[] = [];
    if (shot.splash > 0) {
      for (const u of this.units) {
        if (u.dead || u.def.faction !== 'enemy') continue;
        if (Math.hypot(u.x - shot.toX, u.z - shot.toZ) <= shot.splash) hits.push(u);
      }
    } else if (shot.targetUnit !== null) {
      const u = this.units.find((x) => x.id === shot.targetUnit && !x.dead);
      if (u) hits.push(u);
    }
    for (const u of hits) this.hurtUnit(u, shot.damage);
    this.emit('impact', { x: shot.toX, z: shot.toZ, y: 0.1, ammo: shot.ammo, splash: shot.splash });
    void world;
  }

  private hurtUnit(u: Unit, damage: number): void {
    u.hp -= damageOf(damage, u.def.defense);
    if (u.hp <= 0 && !u.dead) {
      u.dead = true;
      u.deadFor = 0;
      u.hp = 0;
    }
  }

  private runUnits(dt: number, world: GameWorld): void {
    for (const u of this.units) {
      if (u.dead) {
        u.deadFor += dt;
        continue;
      }
      u.cooldown = Math.max(0, u.cooldown - dt);
      u.stun = Math.max(0, u.stun - dt);
      // 被撞飞的位移自己衰减，不等玩家操作
      if (u.knockX !== 0 || u.knockZ !== 0) {
        this.move(u, u.knockX * dt, u.knockZ * dt, world);
        u.knockX *= Math.max(0, 1 - dt * 6);
        u.knockZ *= Math.max(0, 1 - dt * 6);
        if (Math.abs(u.knockX) < 0.02 && Math.abs(u.knockZ) < 0.02) {
          u.knockX = 0;
          u.knockZ = 0;
        }
      }
      if (u.stun > 0) continue;

      if (u.def.faction === 'own') this.runOwn(u, dt, world);
      else this.runEnemy(u, dt, world);
    }
  }

  /** 自己人：守在自己的集合旗附近，敌人进视野就打。 */
  private runOwn(u: Unit, dt: number, world: GameWorld): void {
    const home = u.home !== null ? world.buildings.get(u.home) : undefined;
    if (!home) {
      u.home = null;
      return;
    }
    if (world.isUnderstaffed(home)) return; // 缺员的兵营：兵就地站着

    const anchor = cellToWorld(world.rallyOf(home));
    const foe = this.nearestEnemy(u.x, u.z, u.def.sight);
    if (!foe) {
      // 归位：离锚点超过 1.5 格就慢慢走回去
      const d = Math.hypot(anchor.x - u.x, anchor.z - u.z);
      if (d > 1.5) this.stepToward(u, anchor.x, anchor.z, dt, world);
      return;
    }
    const reach = u.def.range;
    const dist = Math.hypot(foe.x - u.x, foe.z - u.z);
    if (dist > reach) this.stepToward(u, foe.x, foe.z, dt, world);
    else if (u.cooldown <= 0) {
      u.cooldown = u.def.cooldown;
      this.fireSpecial(u, foe.kind === 'unit' ? foe.unit : null, world);
    }
  }

  private fireSpecial(u: Unit, foe: Unit | null, world: GameWorld): void {
    const def = u.def;
    if (def.special?.kind === 'heal') {
      const ally = this.weakestAlly(u, def.special.radius ?? 3);
      if (ally) {
        ally.hp = Math.min(ally.def.hp, ally.hp + (def.special.amount ?? 0));
        this.emit('impact', { x: ally.x, z: ally.z, y: 0.5, ammo: 'magic', splash: 0 });
        return;
      }
    }
    if (def.special?.kind === 'charge' && foe) {
      const spec = def.special;
      u.specialIn -= 1;
      if (u.specialIn <= 0) {
        u.specialIn = spec.every;
        // 先冲过去，再把人顶开并定身
        const dx = foe.x - u.x;
        const dz = foe.z - u.z;
        const len = Math.max(0.001, Math.hypot(dx, dz));
        const dash = Math.min(len, spec.dashTiles ?? 2);
        this.move(u, (dx / len) * dash, (dz / len) * dash, world);
        foe.knockX = (dx / len) * (spec.knockTiles ?? 1.5) * 4;
        foe.knockZ = (dz / len) * (spec.knockTiles ?? 1.5) * 4;
        foe.stun = spec.stunSeconds ?? 0.5;
      }
    }
    if (foe) this.hurtUnit(foe, def.attack);
    else {
      // 远程打建筑也算打到了：把伤害记在楼上
      const target = this.buildingAt(u.x, u.z, def.range);
      if (target) this.hurtBuilding(target, def.attack, world);
    }
  }

  /** 敌人：沿着流场往最近的自己的楼走，够近了拆楼。 */
  private runEnemy(u: Unit, dt: number, world: GameWorld): void {
    const own = [...world.buildings.values()].filter((b) => b.built);
    if (own.length === 0) return;
    const objective = this.objective(u, own);
    const anchor = cellToWorld(world.rallyOf(objective));
    const dist = Math.hypot(anchor.x - u.x, anchor.z - u.z);
    const reach = Math.max(u.def.range, 1.2);
    if (dist <= reach + Math.max(objective.cols, objective.rows) * 0.5) {
      if (u.cooldown <= 0) {
        u.cooldown = u.def.cooldown;
        this.hurtBuilding(objective, u.def.attack, world);
      }
      return;
    }
    this.followField(u, objective, dt, world);
  }

  private objective(u: Unit, own: Building[]): Building {
    let best = own[0]!;
    let bestD = Number.POSITIVE_INFINITY;
    for (const b of own) {
      const c = cellToWorld(this.opts.world.rallyOf(b));
      const d = Math.hypot(c.x - u.x, c.z - u.z) + (b.def.id === 'hall' ? -2 : 0);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /** 流场：目标楼四周往外 BFS 一次，谁的距离小就往谁走。目标换了才重算。 */
  private followField(u: Unit, target: Building, dt: number, world: GameWorld): void {
    const key = `${target.id}:${target.origin.col},${target.origin.row}`;
    if (!this.field || this.fieldKey !== key) {
      this.field = new FlowField(world.map.size, (c) => this.walkable(c, world), this.fieldSeeds(target, world));
      this.fieldKey = key;
    }
    const here = worldToCell(u.x, u.z);
    const step = this.field.stepToward(here);
    if (!step) {
      this.stepToward(u, ...this.targetPoint(target, world), dt, world);
      return;
    }
    const w = cellToWorld(step);
    this.stepToward(u, w.x, w.z, dt, world);
  }

  private targetPoint(b: Building, world: GameWorld): [number, number] {
    const c = cellToWorld(world.rallyOf(b));
    return [c.x, c.z];
  }

  private fieldSeeds(target: Building, world: GameWorld): GridPos[] {
    const seeds: GridPos[] = [];
    const size = world.map.size;
    for (let dc = -1; dc <= target.cols; dc++) {
      for (let dr = -1; dr <= target.rows; dr++) {
        const c = pos(target.origin.col + dc, target.origin.row + dr);
        if (c.col < 0 || c.row < 0 || c.col >= size.cols || c.row >= size.rows) continue;
        if (world.map.buildingAt(c) === null && this.walkable(c, world)) seeds.push(c);
      }
    }
    return seeds.length > 0 ? seeds : [target.origin];
  }

  private walkable(cell: GridPos, world: GameWorld): boolean {
    const t = world.map.terrainAt(cell);
    return t !== null && isStandable(t);
  }

  private buildingAt(x: number, z: number, reach: number): Building | null {
    const world = this.opts.world;
    const cell = worldToCell(x, z);
    for (let dc = -Math.ceil(reach); dc <= Math.ceil(reach); dc++) {
      for (let dr = -Math.ceil(reach); dr <= Math.ceil(reach); dr++) {
        const id = world.map.buildingAt(pos(cell.col + dc, cell.row + dr));
        if (id !== null) {
          const b = world.buildings.get(id);
          if (b) return b;
        }
      }
    }
    return null;
  }

  /** 打楼：伤害与"归零就没了"都交给世界层，这里只负责在楼消失后清掉自己的那部分状态。 */
  private hurtBuilding(b: Building, attack: number, world: GameWorld): void {
    if (this.gone.has(b.id)) return;
    const destroyed = world.damage(b.id, damageOf(attack, 0));
    if (!destroyed) return;
    this.gone.add(b.id);
    this.barracks.delete(b.id);
    this.towers.delete(b.id);
    for (const u of this.units) if (u.home === b.id) u.home = null;
  }

  private nearestEnemy(
    x: number,
    z: number,
    rangeTiles: number,
  ): { kind: 'unit'; unit: Unit; x: number; z: number } | null {
    let best: Unit | null = null;
    let bestD = rangeTiles;
    for (const u of this.units) {
      if (u.dead || u.def.faction !== 'enemy') continue;
      const d = Math.hypot(u.x - x, u.z - z);
      if (d <= bestD) {
        bestD = d;
        best = u;
      }
    }
    return best ? { kind: 'unit', unit: best, x: best.x, z: best.z } : null;
  }

  private weakestAlly(u: Unit, radius: number): Unit | null {
    let best: Unit | null = null;
    for (const a of this.units) {
      if (a.dead || a.def.faction !== 'own' || a === u) continue;
      if (a.hp >= a.def.hp) continue;
      if (Math.hypot(a.x - u.x, a.z - u.z) > radius) continue;
      if (!best || a.hp < best.hp) best = a;
    }
    return best;
  }

  private stepToward(u: Unit, tx: number, tz: number, dt: number, world: GameWorld): void {
    const dx = tx - u.x;
    const dz = tz - u.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return;
    const step = Math.min(len, u.def.speed * dt);
    this.move(u, (dx / len) * step, (dz / len) * step, world);
  }

  /** 一步移动：走不进水里，也走不进别人占的格子里。 */
  private move(u: Unit, dx: number, dz: number, world: GameWorld): void {
    const next = { x: u.x + dx, z: u.z + dz };
    const cell = worldToCell(next.x, next.z);
    if (!this.walkable(cell, world)) {
      // 沿轴试一步：能横着走就横着走，能竖着走就竖着走（水边不会卡死）
      const altX = worldToCell(u.x + dx, u.z);
      if (this.walkable(altX, world)) u.x += dx;
      const altZ = worldToCell(u.x, u.z + dz);
      if (this.walkable(altZ, world)) u.z += dz;
      return;
    }
    u.x = next.x;
    u.z = next.z;
  }

  private buildingAnchor(b: Building): { x: number; z: number; y: number } {
    const c = cellToWorld(this.opts.world.rallyOf(b));
    return { x: c.x, z: c.z, y: b.surfaceY + 1.1 };
  }

  /** 视图直接读这两个列表，不自己维护第二份名单。 */
  liveUnits(): Unit[] {
    return this.units;
  }

  liveShots(): Shot[] {
    return this.shots;
  }

}

/**
 * 一个目标集合的 BFS 距离场。
 * 8 向邻接与地图同一口径，所以斜着绕水也是合法走法。
 */
class FlowField {
  private readonly dist: Int32Array;
  private readonly cols: number;
  private readonly rows: number;
  private readonly walkable: (c: GridPos) => boolean;

  constructor(size: FlatSize, walkable: (c: GridPos) => boolean, seeds: GridPos[]) {
    this.cols = size.cols;
    this.rows = size.rows;
    this.walkable = walkable;
    this.dist = new Int32Array(size.cols * size.rows).fill(-1);
    const queue: GridPos[] = [];
    for (const s of seeds) {
      if (!this.inside(s)) continue;
      this.dist[s.row * this.cols + s.col] = 0;
      queue.push(s);
    }
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]!;
      const d = this.dist[cur.row * this.cols + cur.col]!;
      for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (dc === 0 && dr === 0) continue;
          const n = pos(cur.col + dc, cur.row + dr);
          if (!this.inside(n) || !this.walkable(n)) continue;
          const i = n.row * this.cols + n.col;
          if (this.dist[i] !== -1) continue;
          this.dist[i] = d + 1;
          queue.push(n);
        }
      }
    }
  }

  private inside(c: GridPos): boolean {
    return c.col >= 0 && c.row >= 0 && c.col < this.cols && c.row < this.rows;
  }

  private at(c: GridPos): number {
    return this.inside(c) ? this.dist[c.row * this.cols + c.col]! : -1;
  }

  /** 从 from 走一步到距离更小的邻居；已经在目标上或不可达就返回 null。 */
  stepToward(from: GridPos): GridPos | null {
    const here = this.at(from);
    if (here <= 0) return null;
    let best: GridPos | null = null;
    let bestD = here;
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        const n = pos(from.col + dc, from.row + dr);
        const d = this.at(n);
        if (d >= 0 && d < bestD) {
          bestD = d;
          best = n;
        }
      }
    }
    return best;
  }
}

/** 弹丸飞行速度（格/秒）：箭快、炮弹慢、魔弹最快。 */
function ammoSpeed(ammo: Shot['ammo']): number {
  return ammo === 'magic' ? 18 : ammo === 'arrow' ? 12 : 7;
}

/** 等级缩放：伤害 ×1.35、射程 +0.6、装填 −10%、射间隔 −8%（每级）。 */
export function levelScale(level: number): { damage: number; range: number; reload: number; shot: number } {
  const n = Math.max(0, level - 1);
  return {
    damage: Math.pow(1.35, n),
    range: 1 + (n * 0.6) / 5,
    reload: Math.pow(0.9, n),
    shot: Math.pow(0.92, n),
  };
}
