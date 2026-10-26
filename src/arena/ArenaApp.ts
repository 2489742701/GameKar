/**
 * 对战模式的 three 组装层 —— 只做"把 ArenaWorld 的状态画出来 + 把点击变成出牌"。
 *
 * 复用老项目的引擎与素材（相机、渲染、光照、模型库、像素小人图集），
 * 但**不引用**老模式的 GameWorld / Combat / 回合系统：两套玩法互不牵连。
 *
 * 阵营靠衣服色带区分：蓝方取蓝带、红方取红带（素材调色板里现成的颜色），
 * 头顶水晶同色 —— 用户要的"一方蓝一方红"就是这一条。
 */

import * as THREE from 'three';
import { GameLoop, type FrameInfo } from '@engine/core/GameLoop';
import { PointerInput } from '@engine/input/PointerInput';
import { cellToWorld, inBounds, pos, worldToCell, type GridPos } from '@engine/math/Grid';
import { hashString, Random } from '@engine/math/Random';
import { CameraRig } from '@engine/render/CameraRig';
import { LightingRig } from '@engine/render/Lighting';
import { Renderer, pickQuality } from '@engine/render/Renderer';
import { Viewport } from '@engine/viewport/Viewport';
import { CAMERA, DUDE } from '@game/config';
import { DEFAULT_APPEARANCE, DudeGallery, DudeSprite } from '@game/dudes/DudeView';
import { loadPack, type DudePack } from '@game/dudes/pack';
import { faceCandidates, headCandidates, isBlue } from '@game/dudes/roster';
import { randomStyle, type DudeStyle } from '@game/dudes/style';
import { unitDef } from '@game/data/units';
import { ModelLibrary } from '@game/models/registry';
import { GroundView } from '@game/world/GroundView';
import { TileMap } from '@game/world/TileMap';
import { ArenaWorld, type ArenaBuilding, type ArenaUnit, type Side } from './ArenaWorld';
import { CARD_MODEL, CORE_COLOR, sideColor } from './theme';

export interface ArenaAppOptions {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  seed?: number;
  dudesUrl?: string;
  /** UI 回调：金/血变了、出牌失败要说话 */
  onToast?: (text: string, tone?: 'ok' | 'warn') => void;
  onState?: () => void;
}

interface UnitSprite {
  /** 场景里的那个东西：有素材包时是像素小人，没有时是一枚阵营色的小锥体 */
  obj: THREE.Object3D;
  dude: DudeSprite | null;
  x: number;
  z: number;
  cooldown: number;
  attackLeft: number;
}

export class ArenaApp {
  readonly scene = new THREE.Scene();
  readonly world: ArenaWorld;
  readonly rig: CameraRig;
  readonly seed: number;

  /** 当前选中的手牌槽；-1 = 没选 */
  selectedSlot = -1;
  /** 选中的自家建筑（用于挪出兵旗） */
  selectedBuilding: number | null = null;

  private readonly renderer: Renderer;
  private readonly lighting: LightingRig;
  private readonly viewport: Viewport;
  private readonly input: PointerInput;
  private readonly loop: GameLoop;
  private readonly library = new ModelLibrary();
  private readonly ground: GroundView;
  private readonly map: TileMap;
  private readonly pack: DudePack | null;
  private readonly gallery: DudeGallery | null;
  private readonly opts: ArenaAppOptions;

  private readonly buildingMeshes = new Map<number, THREE.Group>();
  private readonly unitSprites = new Map<number, UnitSprite>();
  private readonly flagMarks = new Map<number, THREE.Group>();
  private readonly styles = new Map<string, DudeStyle>();
  private lastFrame: FrameInfo = { delta: 0, time: 0, fps: 60 };

  private constructor(opts: ArenaAppOptions, pack: DudePack | null) {
    this.opts = opts;
    this.seed = opts.seed ?? 20261027;
    this.pack = pack;
    this.world = new ArenaWorld({ seed: this.seed });

    this.map = new TileMap({ cols: this.world.fieldSize.cols, rows: this.world.fieldSize.rows });
    this.ground = new GroundView(this.map);
    this.renderer = new Renderer(opts.canvas);
    this.viewport = new Viewport(opts.container);
    this.rig = new CameraRig({
      pitchDeg: CAMERA.pitchDeg,
      yawDeg: CAMERA.yawDeg,
      tilesAcross: CAMERA.tilesAcross,
      minTilesAcross: CAMERA.minTilesAcross,
      maxTilesAcross: CAMERA.maxTilesAcross,
    });
    this.rig.setBounds({ minX: 0, maxX: this.map.size.cols, minZ: 0, maxZ: this.map.size.rows });
    this.lighting = new LightingRig(this.scene, { shadowMapSize: 1024 });

    this.scene.add(this.ground.group);
    this.gallery = pack ? new DudeGallery(pack) : null;

    this.loop = new GameLoop({
      hz: 20,
      onSimStep: (dt) => {
        this.world.update(dt);
        this.opts.onState?.();
      },
      onFrame: (info) => this.draw(info),
    });

    this.input = new PointerInput(opts.canvas, {
      onPan: (dx, dy) => this.rig.panByPixels(dx, dy),
      onZoom: (factor, x, y) => this.rig.zoomBy(factor, x, y),
      onRotate: (deg) => this.rig.rotateBy(deg),
      onTap: (x, y) => this.handleTap(x, y),
      onLongPress: (x, y) => this.handleLongPress(x, y),
      onHover: () => {},
    });

    const mid = cellToWorld(pos(this.map.size.cols / 2, this.map.size.rows / 2));
    this.rig.centerOnWorld(mid.x, mid.z, true);
  }

  static async boot(opts: ArenaAppOptions): Promise<ArenaApp> {
    let pack: DudePack | null = null;
    try {
      pack = await loadPack(opts.dudesUrl ?? '/assets/dudes');
    } catch (err) {
      console.warn('[ArenaApp] 小人素材包没加载上，兵只跑数字：', err);
    }
    const app = new ArenaApp(opts, pack);
    app.syncBuildings();
    app.start();
    return app;
  }

  start(): void {
    this.viewport.attach();
    this.input.attach();
    this.viewport.observe((v) => {
      const quality = pickQuality(v.cssWidth * v.cssHeight, v.dpr);
      this.renderer.resize(v.cssWidth, v.cssHeight, v.dpr, quality);
      this.rig.resize(v.cssWidth, v.cssHeight);
      this.lighting.follow(this.rig);
    });
    const s = this.viewport.snapshot;
    this.renderer.resize(s.cssWidth, s.cssHeight, s.dpr, pickQuality(s.cssWidth * s.cssHeight, s.dpr));
    this.rig.resize(s.cssWidth, s.cssHeight);
    this.lighting.follow(this.rig);
    this.loop.start();
  }

  // ---------------------------------------------------------------- 出牌

  /** HUD 点手牌：选中/取消。返回是否真的选中。 */
  selectCard(slot: number): boolean {
    const card = this.world.hand[slot];
    if (!card || this.world.handCooldown[slot]! > 0) {
      this.opts.onToast?.('这张还在冷却', 'warn');
      return false;
    }
    this.selectedSlot = this.selectedSlot === slot ? -1 : slot;
    this.selectedBuilding = null;
    return this.selectedSlot === slot;
  }

  private handleTap(cssX: number, cssY: number): void {
    const hit = this.rig.screenToGround(cssX, cssY);
    if (!hit) return;
    const cell = worldToCell(hit.x, hit.z);
    if (!inBounds(cell, this.map.size)) return;

    // 选中了建筑（兵营）→ 这一下是挪旗
    if (this.selectedBuilding !== null) {
      if (this.world.setFlag(this.selectedBuilding, cell.col, cell.row)) {
        this.opts.onToast?.('出兵点挪好了');
        this.syncFlags();
      } else {
        this.opts.onToast?.('那一格放不了旗', 'warn');
      }
      this.selectedBuilding = null;
      return;
    }

    const building = this.buildingAtCell(cell);
    if (this.selectedSlot < 0) {
      // 没选手牌：点自家兵营 = 准备挪旗；点空地什么都不做
      if (building && building.side === 'blue' && building.kind === 'barracks') {
        this.selectedBuilding = building.id;
        this.opts.onToast?.('再点一处地面，把出兵旗放过去');
      }
      return;
    }

    const res = this.world.playCard('blue', this.selectedSlot, cell.col, cell.row);
    if (!res.ok) {
      this.opts.onToast?.(res.reason ?? '放不下', 'warn');
      return;
    }
    this.selectedSlot = -1;
    this.syncBuildings();
    this.opts.onState?.();
  }

  private handleLongPress(cssX: number, cssY: number): void {
    const hit = this.rig.screenToGround(cssX, cssY);
    if (!hit) return;
    const cell = worldToCell(hit.x, hit.z);
    const b = this.buildingAtCell(cell);
    if (!b) return;
    const hp = `${Math.round(b.hp)}/${b.maxHp}`;
    this.opts.onToast?.(`${labelOf(b)} · ${hp}`);
  }

  private buildingAtCell(cell: GridPos): ArenaBuilding | null {
    for (const b of this.world.buildings.values()) {
      if (cell.col >= b.col && cell.col < b.col + b.cols && cell.row >= b.row && cell.row < b.row + b.rows) return b;
    }
    return null;
  }

  // ---------------------------------------------------------------- 画

  private draw(info: FrameInfo): void {
    this.lastFrame = info;
    this.rig.update(info.delta);
    this.lighting.follow(this.rig);
    this.ground.update(info.time);
    this.syncBuildings();
    this.syncUnits(info.time, info.delta);
    this.syncFlags();
    this.renderer.render(this.scene, this.rig.camera);
  }

  /** 建筑：新增/删掉都在这补齐；核心头顶挂一颗蓝/红水晶。 */
  private syncBuildings(): void {
    for (const b of this.world.buildings.values()) {
      if (this.buildingMeshes.has(b.id)) continue;
      const model = b.kind === 'core' ? 'hall' : CARD_MODEL[b.kind];
      const group = this.library.create(model);
      const center = cellToWorld(pos(b.col + b.cols / 2 - 0.5, b.row + b.rows / 2 - 0.5));
      group.position.set(center.x, 0, center.z);
      this.scene.add(group);
      if (b.kind === 'core') {
        const orb = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.34, 0),
          new THREE.MeshStandardMaterial({
            color: CORE_COLOR[b.side],
            emissive: CORE_COLOR[b.side],
            emissiveIntensity: 0.9,
            roughness: 0.25,
            flatShading: true,
          }),
        );
        orb.position.y = 2.85;
        group.add(orb);
        const bar = makeHpBar(b.hp / b.maxHp, sideColor(b.side));
        bar.position.y = 3.5;
        group.add(bar);
        group.userData['hpBar'] = bar;
      }
      this.buildingMeshes.set(b.id, group);
      group.userData['side'] = b.side;
    }
    for (const [id, group] of this.buildingMeshes) {
      const b = this.world.buildings.get(id);
      if (b) {
        const bar = group.userData['hpBar'] as THREE.Mesh | undefined;
        if (bar) updateHpBar(bar, b.hp / b.maxHp);
        continue;
      }
      this.scene.remove(group);
      this.buildingMeshes.delete(id);
    }
  }

  private syncUnits(time: number, dt: number): void {
    const alive = new Set<number>();
    for (const u of this.world.units) {
      alive.add(u.id);
      let entry = this.unitSprites.get(u.id);
      if (!entry) {
        entry = this.makeSprite(u);
        this.unitSprites.set(u.id, entry);
      }
      const moved = Math.hypot(u.x - entry.x, u.z - entry.z);
      const justFired = u.cooldown > entry.cooldown;
      entry.x = u.x;
      entry.z = u.z;
      entry.cooldown = u.cooldown;
      if (justFired) entry.attackLeft = 0.5;
      else entry.attackLeft = Math.max(0, entry.attackLeft - dt);

      const def = unitDef(u.defId);
      const anim = entry.attackLeft > 0 ? def.attackAnim : moved > 0.004 ? 'run' : def.idleAnim;
      if (entry.dude) {
        entry.dude.moveTo(u.x, u.z);
        entry.dude.faceCamera(this.rig.yaw);
        entry.dude.play(anim, time);
      } else {
        // 没有素材包：锥体直接跟着走，玩法读数照常
        entry.obj.position.set(u.x, DUDE.heightTiles / 2, u.z);
      }
    }
    for (const [id, entry] of this.unitSprites) {
      if (alive.has(id)) continue;
      entry.dude?.dispose();
      entry.obj.removeFromParent();
      this.unitSprites.delete(id);
    }
  }

  private makeSprite(u: ArenaUnit): UnitSprite {
    // 没有素材包就退成一枚阵营色锥体：玩法照常，只是看不到像素小人
    if (!this.pack || !this.gallery) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, DUDE.heightTiles, 6),
        new THREE.MeshStandardMaterial({ color: sideColor(u.side), flatShading: true, roughness: 0.7 }),
      );
      cone.position.set(u.x, DUDE.heightTiles / 2, u.z);
      this.scene.add(cone);
      return { obj: cone, dude: null, x: u.x, z: u.z, cooldown: u.cooldown, attackLeft: 0 };
    }
    const def = unitDef(u.defId);
    const style = this.styleOf(u.side, def.id, def);
    const { atlas, texture } = this.gallery.acquire(style, def.anims);
    const dude = new DudeSprite(this.pack, atlas, texture, { ...DEFAULT_APPEARANCE, height: DUDE.heightTiles });
    this.scene.add(dude.mesh);
    return { obj: dude.mesh, dude, x: u.x, z: u.z, cooldown: u.cooldown, attackLeft: 0 };
  }

  /** 阵营色带：蓝方取蓝、红方取红，头脸从兵种自己的区间里挑。 */
  private styleOf(side: Side, unitId: string, def: ReturnType<typeof unitDef>): DudeStyle {
    const key = `${side}:${unitId}`;
    const hit = this.styles.get(key);
    if (hit) return hit;
    if (!this.pack) throw new Error('没有素材包');
    const rng = new Random(hashString(`${this.seed}:arena:${key}`));
    const base = randomStyle(rng, this.pack);
    const suits = this.pack.palettes.suit.filter((h) => (side === 'blue' ? isBlue(h) : isRed(h)));
    const style: DudeStyle = {
      ...base,
      head: rng.pick(headCandidates(def, this.pack)),
      face: rng.pick(faceCandidates(def, this.pack)),
      hex: { ...base.hex, suit: suits.length > 0 ? rng.pick(suits) : base.hex.suit },
    };
    this.styles.set(key, style);
    return style;
  }

  /** 兵营的出兵旗：地上一个小旗杆，蓝/红各一色。 */
  private syncFlags(): void {
    const want = new Map<number, ArenaBuilding>();
    for (const b of this.world.buildings.values()) if (b.kind === 'barracks') want.set(b.id, b);

    for (const [id, group] of this.flagMarks) {
      if (want.has(id)) continue;
      this.scene.remove(group);
      this.flagMarks.delete(id);
    }
    for (const [id, b] of want) {
      let group = this.flagMarks.get(id);
      if (!group) {
        group = makeFlag(b.side, this.selectedBuilding === id);
        this.scene.add(group);
        this.flagMarks.set(id, group);
      }
      const at = this.world.spawnCellOf(b);
      const c = cellToWorld(at);
      group.position.set(c.x, 0, c.z);
    }
  }

  get telemetry() {
    return {
      fps: Math.round(this.lastFrame.fps),
      ...this.world.summary(),
      sprites: this.unitSprites.size,
      buildings: this.buildingMeshes.size,
      dudesReady: this.pack !== null,
    };
  }
}

// ---------------------------------------------------------------- 小件

const isRed = (hex: string): boolean => {
  const v = hex.replace('#', '');
  const n = Number.parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return r > g + 30 && r > b + 30;
};

function labelOf(b: ArenaBuilding): string {
  return b.kind === 'core' ? '核心' : b.kind === 'barracks' ? '兵营' : b.kind === 'mill' ? '磨坊' : '防御塔';
}

function makeHpBar(frac: number, color: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1.6, 0.14);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
  const bar = new THREE.Mesh(geo, mat);
  bar.renderOrder = 10;
  bar.scale.x = Math.max(0.02, frac);
  bar.userData['frac'] = frac;
  bar.userData['base'] = color;
  return bar;
}

function updateHpBar(bar: THREE.Mesh, frac: number): void {
  const clamped = Math.max(0, Math.min(1, frac));
  const prev = bar.userData['frac'] as number;
  if (Math.abs(prev - clamped) < 0.005) return;
  bar.userData['frac'] = clamped;
  bar.scale.x = Math.max(0.02, clamped);
  const base = bar.userData['base'] as number;
  (bar.material as THREE.MeshBasicMaterial).color.setHex(clamped < 0.3 ? 0xff6b6b : base);
}

function makeFlag(side: Side, selected: boolean): THREE.Group {
  const g = new THREE.Group();
  const color = sideColor(side);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.04, 1.1, 6),
    new THREE.MeshStandardMaterial({ color: 0x6b4526, roughness: 0.9, flatShading: true }),
  );
  pole.position.y = 0.55;
  const cloth = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 0.34, 4),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: selected ? 0.9 : 0.35,
      roughness: 0.5,
      flatShading: true,
    }),
  );
  cloth.position.set(0, 1.05, 0);
  g.add(pole, cloth);
  return g;
}
