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
import { DEFAULT_DIFFICULTY, DIFFICULTY, ROUNDS, isStandable, type Difficulty, type RaidProfile } from '@game/config';
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
  /** 这一局按哪一档来敌。不给就是正常档。 */
  difficulty?: Difficulty;
  on?: <K extends keyof CombatEvents>(type: K, handler: (payload: CombatEvents[K]) => void) => void;
}

/** 一回合的敌人构成：波次大小、什么时候混进远程与石怪，全读档位表。 */
function raidComposition(profile: RaidProfile, round: number): string[] {
  const want = Math.round(profile.waveBase + profile.waveGrowth * (round - 1));
  const total = Math.min(profile.capOnField, ROUNDS.maxRaidUnits, Math.max(0, want));
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    // 混兵按表里从前往后第一条命中的；everyN 那只进这种兵（与改动前的 i % 6 === 5 同形状）
    const mix = profile.mix.find((m) => round >= m.fromRound && i % m.everyN === m.everyN - 1);
    out.push(mix ? mix.unitId : 'raider');
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
  /** 档位：出兵量与怪物 AI 的唯一来源。换档只改"接下来怎么来敌"，不动已在场上的兵。 */
  difficulty: Difficulty;
  profile: RaidProfile;
  /** 流场按目标楼分槽：一波里几栋楼被盯上就各算一次，不再互相顶掉 */
  private readonly fields = new Map<string, FlowField>();
  /** 本局的来点（每局固定、按 seed 现量选出来的边缘可站格，最多 4 处） */
  private spawnPointsCache: GridPos[] | null = null;
  /** 还没进场的那几涌：at = 还有几秒进 */
  private pendingBursts: { ids: string[]; at: number; point: GridPos }[] = [];
  /** 打散用节拍：只按序推，不用随机，保证同 seed 同结果 */
  private spawnSeq = 0;
  defeated = false;

  capped = 0;
  /** 累计开火数：弹丸在天上活不到 0.2 秒，靠采样数"看见过几发"是数不准的 */
  fired = 0;

  constructor(private readonly opts: CombatOptions) {
    this.maxUnits = opts.maxUnits ?? ROUNDS.maxRaidUnits;
    this.difficulty = opts.difficulty ?? DEFAULT_DIFFICULTY;
    this.profile = DIFFICULTY[this.difficulty];
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

  /** 本局第 k 处来点：地图四条边里挑能站人的格子，按 seed 固定（k=0 就是原来那一处）。 */
  private edgePoint(seed: number, k: number): GridPos {
    const size = this.opts.world.map.size;
    const side = (((seed % 4) + 4) % 4 + k) % 4;
    const span = Math.max(1, (side % 2 === 0 ? size.cols : size.rows) - 8);
    const along = 4 + (((seed >> 2) + k * 9) % span);
    const cell =
      side === 0
        ? pos(along, 0)
        : side === 1
          ? pos(along, size.rows - 1)
          : side === 2
            ? pos(0, along)
            : pos(size.cols - 1, along);
    return this.nearestStandable(cell);
  }

  /** 来点清单（最多 4 处，四条边各一处）。同一局同一 seed 永远同一份。 */
  private allSpawnPoints(seed: number): GridPos[] {
    if (!this.spawnPointsCache) this.spawnPointsCache = [0, 1, 2, 3].map((k) => this.edgePoint(seed, k));
    return this.spawnPointsCache;
  }

  /** 第一处来点：给"这一波从哪边来"的读数与视图用，口径与改动前一致。 */
  spawnAt(seed: number): GridPos {
    return this.allSpawnPoints(seed)[0]!;
  }

  /** 这一波实际会用到的几处来点（简单档"从三面来"就体现在这里）。 */
  spawnPointsOf(seed: number, n = this.profile.spawnPoints): GridPos[] {
    return this.allSpawnPoints(seed).slice(0, Math.max(1, Math.min(n, 4)));
  }

  /** 换档：正在打的这一波不重排，下一波起按新档来敌。 */
  setDifficulty(d: Difficulty): void {
    if (this.difficulty === d) return;
    this.difficulty = d;
    this.profile = DIFFICULTY[d];
    this.fields.clear();
  }

  /** 这一档要打这一波，计划表上是谁：给测试与"来犯预告"读，不含进场时机。 */
  raidPlan(round: number): string[] {
    return raidComposition(this.profile, round);
  }

  /** 还有没进场的涌：回合的"打完没打完"必须算上它，不然两涌之间会被判成清场。 */
  burstsPending(): number {
    return this.pendingBursts.reduce((n, b) => n + b.ids.length, 0);
  }

  /** 这一回合还在不在打：场上有敌人，或还有后续涌没进。 */
  engaged(): boolean {
    return this.enemiesAlive() > 0 || this.pendingBursts.length > 0;
  }

  /** 一回合开打时调用：这一波按档拆成几涌，第一涌立刻进场，其余按间隔陆续进。 */
  spawnWave(seed: number, round: number): void {
    const ids = this.raidPlan(round);
    const points = this.spawnPointsOf(seed);
    // 新的一波：旧目标楼的流场不再有意义（楼可能被拆了，占地也变了）
    this.fields.clear();
    this.pendingBursts = [];
    if (ids.length === 0) {
      this.emit('wave', { round, count: 0, at: points[0]! });
      return;
    }
    const size = Math.max(1, this.profile.burstSize);
    const groups: string[][] = [];
    for (let i = 0; i < ids.length; i += size) groups.push(ids.slice(i, i + size));
    groups.forEach((g, gi) => {
      // 多处来点轮转分派：简单档"从三面来"就是这么来的
      const point = points[gi % points.length]!;
      if (gi === 0) this.emitBurst(g, point);
      else this.pendingBursts.push({ ids: g, at: gi * this.profile.burstGapSeconds, point });
    });
    this.emit('wave', { round, count: ids.length, at: points[0]! });
  }

  /** 一涌真进场：按档位的散开半径把这一组铺开，同一格不许叠成一坨。 */
  private emitBurst(ids: string[], at: GridPos): void {
    for (const unitId of ids) {
      if (this.size >= this.maxUnits) {
        this.capped++;
        continue;
      }
      const def = unitDef(unitId);
      // 黄金角铺开：序号决定位置，不用随机，所以同 seed 同摆法结果一定
      const k = this.spawnSeq++;
      const angle = k * 2.399963229728653;
      const radius = this.profile.scatterTiles * Math.sqrt(((k % 12) + 1) / 12);
      const w = cellToWorld(at);
      const cell = this.nearestStandable(worldToCell(w.x + Math.cos(angle) * radius, w.z + Math.sin(angle) * radius));
      const here = cellToWorld(cell);
      this.units.push({
        id: this.nextId++,
        def,
        hp: def.hp,
        x: here.x,
        z: here.z,
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

    this.drainBursts(dt);
    this.runBarracks(dt, world);
    this.runTowers(dt, world);
    this.runShots(dt, world);
    this.runUnits(dt, world);

    this.units = this.units.filter((u) => !u.dead || u.deadFor < 1.2);
  }

  /** 后续几涌按各自的间隔陆续进场（"慢慢出"落到这一条上）。 */
  private drainBursts(dt: number): void {
    if (this.pendingBursts.length === 0) return;
    for (const b of this.pendingBursts) b.at -= dt;
    const due = this.pendingBursts.filter((b) => b.at <= 0);
    if (due.length === 0) return;
    this.pendingBursts = this.pendingBursts.filter((b) => b.at > 0);
    for (const b of due) this.emitBurst(b.ids, b.point);
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
        damage: this.towerDamage(b),
        splash: spec.splashTiles ?? 0,
        targetUnit: target.kind === 'unit' ? target.unit.id : null,
        targetBuilding: null,
      });
    }
  }

  /** 空仓装填、弹夹与等级 —— 头顶条与信息卡共用这一份。 */
  towerState(b: Building): TowerState {
    let s = this.towers.get(b.id);
    if (!s) {
      s = { magazine: b.def.tower!.magazine, reloading: 0, cooldown: 0, level: 1 };
      this.towers.set(b.id, s);
    }
    return s;
  }

  /**
   * 这一发现在多痛（等级缩放之后）。开火与读数都走这一处：
   * 信息卡上写 8、实际打 10 这种事，只可能发生在两处各算一遍的时候。
   */
  towerDamage(b: Building): number {
    const spec = b.def.tower;
    if (!spec) return 0;
    return Math.round(spec.damage * levelScale(this.towerState(b).level).damage);
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

  /** 敌人：沿着流场往它挑中的楼走，够近了拆楼。 */
  private runEnemy(u: Unit, dt: number, world: GameWorld): void {
    // 困难档：远程敌人会转头射你的兵，先挑奶妈与弓箭手（那句"它会先射你的牧师"归位成真判据）
    if (this.profile.engageTroops && u.def.range > 1.5) {
      const prey = this.nearestPrey(u);
      if (prey) {
        const d = Math.hypot(prey.x - u.x, prey.z - u.z);
        if (d <= u.def.range) {
          if (u.cooldown <= 0) {
            u.cooldown = u.def.cooldown + this.profile.strikePauseSeconds;
            this.hurtUnit(prey, u.def.attack);
            this.emit('impact', { x: prey.x, z: prey.z, y: 0.5, ammo: u.def.attackAnim === 'bowShort' ? 'arrow' : 'magic', splash: 0 });
          }
          return;
        }
        this.stepToward(u, prey.x, prey.z, dt, world);
        return;
      }
    }
    const own = [...world.buildings.values()].filter((b) => b.built);
    if (own.length === 0) return;
    const objective = this.objective(u, own);
    const anchor = cellToWorld(world.rallyOf(objective));
    const dist = Math.hypot(anchor.x - u.x, anchor.z - u.z);
    const reach = Math.max(u.def.range, 1.2);
    if (dist <= reach + Math.max(objective.cols, objective.rows) * 0.5) {
      if (u.cooldown <= 0) {
        // 简单档的"不急"就落在这里：兵种自己的攻击间隔没动，动的是它打完一下之后的停顿
        u.cooldown = u.def.cooldown + this.profile.strikePauseSeconds;
        this.hurtBuilding(objective, u.def.attack, world);
      }
      return;
    }
    this.followField(u, objective, dt, world);
  }

  /** 这一档眼里"值先打"的兵：奶妈折 2 格、远程折 1 格，其余按距离；索敌半径用兵种自己的 sight。 */
  private nearestPrey(u: Unit): Unit | null {
    let best: Unit | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const v of this.units) {
      if (v.dead || v.def.faction !== 'own') continue;
      const d = Math.hypot(v.x - u.x, v.z - u.z);
      if (d > u.def.sight) continue;
      const fold = v.def.role === 'healer' ? 2 : v.def.role === 'ranged' ? 1 : 0;
      const score = d - fold;
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  private objective(u: Unit, own: Building[]): Building {
    let best = own[0]!;
    let bestD = Number.POSITIVE_INFINITY;
    for (const b of own) {
      const c = cellToWorld(this.opts.world.rallyOf(b));
      // 主城偏置来自档位表：0 = 谁近拆谁，越大越直奔心脏
      const d = Math.hypot(c.x - u.x, c.z - u.z) + (b.def.id === 'hall' ? -this.profile.hallBias : 0);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /** 流场：目标楼四周往外 BFS 一次，谁的距离小就往谁走。同一栋楼复用，换波时整批清。 */
  private followField(u: Unit, target: Building, dt: number, world: GameWorld): void {
    const key = `${target.id}:${target.origin.col},${target.origin.row}`;
    let field = this.fields.get(key);
    if (!field) {
      field = new FlowField(world.map.size, (c) => this.walkable(c, world), this.fieldSeeds(target, world));
      this.fields.set(key, field);
    }
    const here = worldToCell(u.x, u.z);
    const step = field.stepToward(here);
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
