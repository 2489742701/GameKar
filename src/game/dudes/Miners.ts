/**
 * 采矿运输队 —— 把"谁在采哪条矿"画成真的在小路上走的人。
 *
 * 一条硬要求：**这一层不许自己发明速度**。
 * 来回几秒 = `max(overhead, 2×格数) ÷ 脚程`，和经济结算同一条公式，
 * 于是"看见的忙碌程度"和"账上的产量"必然同步，不会出现人跑得飞快而产量没变。
 */

import * as THREE from 'three';
import type { GridPos } from '@engine/math/Grid';
import { cellToWorld, footprintCenter, footprintRect, pos, worldToCell } from '@engine/math/Grid';
import { VEIN_WORK, isStandable } from '@game/config';
import type { Combat } from '@game/systems/Combat';
import type { Building, GameWorld } from '@game/world/GameWorld';
import type { AnimName } from '@game/dudes/anims';
import { facingFlip, type DudeAppearance, type DudeGallery, type DudeSprite } from './DudeView';
import type { DudeStyle } from './style';
import { findPath, pathLength, pointAt } from './walk';

/**
 * 一段行程里走路占的比例；剩下的时间停在矿点/楼门口。
 *
 * 0.55 试过：停顿很足，但走路被压缩成 1.8 倍速（实测 5.5 格/秒），看着还是"蹭蹭蹭"。
 * 0.65 是"停得出来、又不赶路"的折中 —— 经济周期不变，只是走路没那么夸张。
 */
const WALK_SHARE = 0.65;

/** 矿工只要这四条：站着没必要，跑/待命/挨打/倒下才有意义。 */
export const MINER_ANIMS: AnimName[] = ['idle', 'run', 'sword', 'hurt', 'die'];

/** 一次来回几秒。tiles = 占地边缘到矿点的格数。 */
export function tripSeconds(tiles: number, speed: number): number {
  return Math.max(VEIN_WORK.overheadTiles, 2 * tiles) / Math.max(0.01, speed);
}

interface Runner {
  buildingId: number;
  /** 地面锚点：只把"站在哪"写在这里，卡片自身的半身高由 DudeSprite 内部管 */
  anchor: THREE.Group;
  sprite: DudeSprite;
  /** 走位折线（世界坐标，含首尾）；寻路失败时退化成一条直线 */
  route: { x: number; z: number }[];
  /** 折线总长：走位按弧长插值，拐角才不会被拽着抄近道 */
  routeLength: number;
  /** 每个小人的横向错位，别都踩同一条线（下面那个"碰撞点"就是这个） */
  offset: { x: number; z: number };
  trip: number;
  /** 步调错开量，不然一队人齐步走像复制粘贴 */
  phase: number;
  /** 下次能出手的剩余秒数（自卫挥镐） */
  strike: number;
}

export interface CrewDeps {
  world: GameWorld;
  gallery: DudeGallery;
  /** 一栋楼的长相由外部给：同 seed 同楼永远同一张脸，不用存盘 */
  styleFor: (building: Building) => DudeStyle;
  appearance?: DudeAppearance;
  /** 敌人从矿区边上过时，矿工会停下来挥镐 —— 不给就纯运输 */
  combat?: Combat;
  /** 全局上限：一个小人一次 draw call，别让矿脉一多就把批次顶爆 */
  maxRunners?: number;
}

export class MiningCrew {
  readonly group = new THREE.Group();
  private readonly runners = new Map<string, Runner>();
  private readonly maxRunners: number;
  private skipped = 0;
  /** 没找到路的条数（会直着穿墙走）。非零要在读数里看得见，不能悄悄兜底。 */
  private unrouted = 0;

  constructor(private readonly deps: CrewDeps) {
    this.maxRunners = deps.maxRunners ?? 48;
    this.group.name = 'crew';
  }

  get count(): number {
    return this.runners.size;
  }

  /** 因为上限而没派出去的任务数。非零就要在读数里看得见，不能悄悄丢。 */
  get capped(): number {
    return this.skipped;
  }

  /** 寻路失败、退回直线的小人数。 */
  get noPath(): number {
    return this.unrouted;
  }

  countFor(buildingId: number): number {
    let n = 0;
    for (const r of this.runners.values()) if (r.buildingId === buildingId) n++;
    return n;
  }

  /**
   * 按世界当前的分配增删小人。
   * 只挂在 'vein:replanned' 上：那是分配唯一成型的地方，别处调用只会读到旧账。
   */
  sync(): void {
    const wanted = new Map<string, { building: Building; vein: GridPos; trip: number }>();

    for (const b of this.deps.world.buildings.values()) {
      if (!b.def.veinWork) continue;
      for (const claim of this.deps.world.claimsOf(b)) {
        const key = runnerKey(b.id, claim.vein);
        if (wanted.has(key)) continue;
        wanted.set(key, { building: b, vein: claim.vein, trip: tripSeconds(claim.tiles, b.def.veinWork.speed) });
      }
    }

    this.skipped = 0;
    const keep = new Map<string, { building: Building; vein: GridPos; trip: number }>();
    for (const [key, spec] of wanted) {
      // 已经在场的优先保留：不然每次重算都会因为"名额"把小人来回拆装
      if (this.runners.has(key) || keep.size < this.maxRunners) keep.set(key, spec);
      else this.skipped++;
    }

    for (const [key, runner] of [...this.runners]) {
      if (keep.has(key)) continue;
      runner.sprite.dispose();
      runner.anchor.removeFromParent();
      this.runners.delete(key);
    }

    this.unrouted = 0;
    for (const [key, spec] of keep) {
      if (this.runners.has(key)) continue;
      const runner = this.spawn(key, spec.building, spec.vein, spec.trip);
      runner.routeLength = Math.max(0.001, pathLength(runner.route));
      this.runners.set(key, runner);
    }
  }

  private spawn(key: string, building: Building, vein: GridPos, trip: number): Runner {
    const mineCenter = footprintCenter({ origin: building.origin, cols: building.cols, rows: building.rows });
    const sprite = this.deps.gallery.createSprite(this.deps.styleFor(building), MINER_ANIMS, this.deps.appearance);

    const anchor = new THREE.Group();
    anchor.add(sprite.mesh);
    anchor.position.set(mineCenter.x, building.surfaceY, mineCenter.z);
    this.group.add(anchor);

    // 由 key 派生两个固定量：相位（齐步走）与横向错位（踩同一条线）
    const hash = [...key].reduce((a, c) => a + c.charCodeAt(0), 0);
    const angle = (hash % 97) / 97 * Math.PI * 2;
    const radius = 0.14 + ((hash >> 3) % 3) * 0.07;

    return {
      buildingId: building.id,
      anchor,
      sprite,
      route: this.routeFor(building, vein),
      routeLength: 0,
      offset: { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius },
      trip,
      phase: (hash % 7) / 7,
      strike: 0,
    };
  }

  /**
   * 从楼门口走到矿点的折线。
   *
   * 起点不能在占地里（那里被楼占着、A* 会判成死路），所以先沿占地外圈找一格能站的；
   * 走不通就退回直线，并把这条记进 `noPath` —— 宁可屏幕上看见"他穿墙了"，
   * 也不要悄悄把这一趟吞掉。
   */
  private routeFor(building: Building, vein: GridPos): { x: number; z: number }[] {
    const world = this.deps.world;
    const map = world.map;
    const blocked = (c: GridPos): boolean => {
      const t = map.terrainAt(c);
      return !t || !isStandable(t) || map.buildingAt(c) !== null;
    };
    const start = this.doorstep(building, blocked) ?? building.origin;
    const path = findPath(map.size, start, vein, blocked);

    const cells = path ? [pos(building.origin.col, building.origin.row), ...path] : null;
    if (!cells) {
      this.unrouted++;
      const c = footprintCenter({ origin: building.origin, cols: building.cols, rows: building.rows });
      const v = cellToWorld(vein);
      return [
        { x: c.x, z: c.z },
        { x: v.x, z: v.z },
      ];
    }
    const points = cells.map((cell) => {
      const w = cellToWorld(cell);
      return { x: w.x, z: w.z };
    });
    points[0] = points[0]!; // 起点仍是楼心，第一段直接从楼里走出来
    return points;
  }

  /** 占地外圈里第一格能站的地方（就是"门口"）。 */
  private doorstep(building: Building, blocked: (c: GridPos) => boolean): GridPos | null {
    const out: GridPos[] = [];
    const c0 = building.origin.col;
    const r0 = building.origin.row;
    for (const cell of footprintRect({
      origin: pos(c0 - 1, r0 - 1),
      cols: building.cols + 2,
      rows: building.rows + 2,
    })) {
      const inside =
        cell.col >= c0 && cell.col < c0 + building.cols && cell.row >= r0 && cell.row < r0 + building.rows;
      if (!inside) out.push(cell);
    }
    // 优先正前方（+z 那一边），读起来像"从门口出来"
    out.sort((a, b) => Math.abs(a.row - (r0 + building.rows)) + Math.abs(a.col - c0) - (Math.abs(b.row - (r0 + building.rows)) + Math.abs(b.col - c0)));
    for (const cell of out) if (!blocked(cell)) return cell;
    return null;
  }

  /**
   * 走位：一个来回分两段，前半去程、后半回程。
   * 用 `time % trip` 而不是累计位移，所以重建、快进、回放都不会让小人飘走。
   */
  update(time: number, yawDeg: number, dt: number): void {
    for (const r of this.runners.values()) {
      const local = time + r.phase * r.trip;
      const u = (local % r.trip) / r.trip;
      /**
       * 一段行程分两半：**走一段、停一段**。
       *
       * 原来是一条三角波，人从头走到尾不停 —— 屏幕上就是"矿工在矿区里来回抽"。
       * 现在每段前 55% 走路、后 45% 停在原地（矿点边上、楼门口各停一次）。
       * 关键是**总周期不变**：`trip` 还是经济公式算出来的那个数，
       * 所以"看见的忙碌程度"和"账上的产量"仍然同步，只是把走路压缩进前 55%。
       */
      // 当前这一段走了多少（0 = 起点，1 = 终点）。去程从楼出发、回程从矿点出发，
      // 所以回程要 `(u - 0.5) * 2`，不是 `(1 - u) * 2`。
      // 上一版写成了后者再配合 `1 - legT`，等于**在 u=0.5 处把 s 从 1 直接翻成 0** ——
      // 屏幕上就是矿工在矿点原地瞬移回楼门口。
      const leg = u < 0.5 ? u * 2 : (u - 0.5) * 2;
      const walking = leg < WALK_SHARE;
      const legT = walking ? leg / WALK_SHARE : 1;
      const s = u < 0.5 ? legT : 1 - legT; // 去程 0→1，回程 1→0

      const p = pointAt(r.route, s * r.routeLength);
      const here = this.deps.world.map.surfaceY(worldToCell(p.x, p.z));
      const nx = p.x + r.offset.x;
      const nz = p.z + r.offset.z;

      /**
       * 自卫：1.5 格内有敌人就**停下挥镐**，冷却 1.4 秒。
       * 伤害走 `combat.strike()`，跟塔/兵同一个公式 —— 不是视图自己算的。
       */
      r.strike = Math.max(0, r.strike - dt);
      const foe = this.deps.combat?.nearestEnemyTo(nx, nz, 1.5) ?? null;
      if (foe) {
        r.anchor.position.set(nx, here, nz);
        r.sprite.faceCamera(yawDeg);
        r.sprite.play('sword', local);
        if (r.strike <= 0) {
          r.strike = 1.4;
          this.deps.combat!.strike(foe.id, 3);
        }
        continue;
      }
      // 位移要在**摆位置之前**取：拿上一帧的锚点当参考，才能知道这一帧往哪边走
      const dx = nx - r.anchor.position.x;
      const dz = nz - r.anchor.position.z;
      r.anchor.position.set(nx, here, nz);
      r.sprite.faceCamera(yawDeg);
      if (walking) r.sprite.setFlipX(facingFlip(dx, dz, yawDeg, r.sprite.flipped));
      // 停下的时候播待命，不然人是站着但腿在跑
      r.sprite.play(walking ? 'run' : 'idle', local);
    }
    this.separate();
  }

  /**
   * 互相挤开。
   *
   * 小人脚下是个**半径 0.13 的小碰撞点**（不是整格）：两个人走近了才推，走开了就不管。
   * 不推的话，同一对"楼+矿"的错位量是固定的，多个小人叠加时会在同一点上重合，
   * 屏幕上就是"一格站了一堆人"。
   */
  private separate(): void {
    const list = [...this.runners.values()];
    const min = 0.26;
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        const dx = b.anchor.position.x - a.anchor.position.x;
        const dz = b.anchor.position.z - a.anchor.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > min * min || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.5;
        const ux = dx / d;
        const uz = dz / d;
        a.anchor.position.x -= ux * push;
        a.anchor.position.z -= uz * push;
        b.anchor.position.x += ux * push;
        b.anchor.position.z += uz * push;
      }
    }
  }

  dispose(): void {
    for (const r of this.runners.values()) {
      r.sprite.dispose();
      r.anchor.removeFromParent();
    }
    this.runners.clear();
  }
}

export const runnerKey = (buildingId: number, vein: GridPos): string => `${buildingId}@${vein.col},${vein.row}`;
