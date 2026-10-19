/**
 * GameApp —— 把引擎、世界、视图、输入接成一台的门面。
 *
 * 外部只需要这几个动词：
 *   game.pull(10)             抽十连（扣费 + 落地卡牌效果）
 *   game.build('farm')        进入某张建造许可的放置模式
 *   game.place('farm', cell)  跳过交互直接落位，给脚本/回放/单测用
 *   game.focusHome()          镜头回城
 *   game.setOrientation(..)   锁定横竖屏档位
 * 其余都是内部管线。
 */

import * as THREE from 'three';
import type { FrameInfo } from '@engine/core/GameLoop';
import { GameLoop } from '@engine/core/GameLoop';
import type { GridPos } from '@engine/math/Grid';
import { cellToWorld, footprintRect, inBounds, pos, worldToCell } from '@engine/math/Grid';
import { Random } from '@engine/math/Random';
import { CameraRig } from '@engine/render/CameraRig';
import { LightingRig } from '@engine/render/Lighting';
import { Renderer, pickQuality } from '@engine/render/Renderer';
import { PointerInput } from '@engine/input/PointerInput';
import { Viewport, type OrientationMode } from '@engine/viewport/Viewport';
import { CAMERA, SIM_HZ, WORLD } from '@game/config';
import { STARTER_POOL } from '@game/data/cards';
import { GachaService, type Purchase } from '@game/gacha/GachaService';
import { ModelLibrary } from '@game/models/registry';
import { BuildingView } from '@game/world/BuildingView';
import { GroundView } from '@game/world/GroundView';
import { GameWorld, type Building } from '@game/world/GameWorld';
import { MarkerLayer } from '@game/world/Markers';
import { PropScatter } from '@game/world/PropScatter';
import { findNearestClearSpot, generateTerrain } from '@game/world/TerrainGenerator';
import { PlacementController } from '@game/systems/Placement';

export interface GameAppOptions {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  /** 换 seed 就换一张图；同一个 seed 永远同一张图，连抽卡序列也一样 */
  seed?: number;
  orientation?: OrientationMode;
}

export interface Telemetry {
  fps: number;
  drawCalls: number;
  triangles: number;
  buildings: number;
  tiles: number;
  orientation: OrientationMode;
}

const VEIN_COUNT = 9;

export class GameApp {
  readonly scene = new THREE.Scene();
  readonly world: GameWorld;
  readonly gacha: GachaService;

  private readonly renderer: Renderer;
  private readonly rig: CameraRig;
  private readonly lighting: LightingRig;
  private readonly viewport: Viewport;
  private readonly input: PointerInput;
  private readonly loop: GameLoop;
  private readonly library = new ModelLibrary();
  private readonly ground: GroundView;
  private readonly props: PropScatter;
  private readonly markers = new MarkerLayer();
  private readonly buildingView: BuildingView;
  private readonly placement: PlacementController;
  private readonly seed: number;

  private hoverCell: GridPos | null = null;
  private lastFrame: FrameInfo = { delta: 0, time: 0, fps: 60 };

  private constructor(options: GameAppOptions) {
    this.seed = options.seed ?? WORLD.seed;
    const rng = new Random(this.seed);

    // ---------------------------------------------------------------- 世界
    const map = generateTerrain({
      size: { cols: WORLD.cols, rows: WORLD.rows },
      seed: this.seed,
      veins: VEIN_COUNT,
      clearingRadius: 4,
    });
    this.world = new GameWorld(map);

    // ---------------------------------------------------------------- 渲染管线
    this.renderer = new Renderer(options.canvas);
    this.viewport = new Viewport(options.container);
    this.rig = new CameraRig({
      pitchDeg: CAMERA.pitchDeg,
      yawDeg: CAMERA.yawDeg,
      tilesAcross: CAMERA.tilesAcross,
      minTilesAcross: CAMERA.minTilesAcross,
      maxTilesAcross: CAMERA.maxTilesAcross,
    });
    this.rig.setBounds({ minX: 0, maxX: map.size.cols, minZ: 0, maxZ: map.size.rows });
    this.lighting = new LightingRig(this.scene, { shadowMapSize: 2048 });

    this.ground = new GroundView(map);
    this.props = new PropScatter(map, this.seed);
    this.buildingView = new BuildingView(this.library);
    this.scene.add(this.ground.group, this.props.group, this.buildingView.group, this.markers.group);

    this.placement = new PlacementController(this.world, this.library, this.markers, this.scene);

    // ---------------------------------------------------------------- 抽卡
    this.gacha = new GachaService(STARTER_POOL, rng.fork('gacha'));

    // ---------------------------------------------------------------- 循环与输入
    this.loop = new GameLoop({
      hz: SIM_HZ,
      onSimStep: (dt) => this.world.tick(dt),
      onFrame: (info) => this.draw(info),
    });

    this.input = new PointerInput(options.canvas, {
      onPan: (dx, dy) => this.rig.panByPixels(dx, dy),
      onZoom: (factor, x, y) => this.rig.zoomBy(factor, x, y),
      onRotate: (deg) => this.rig.rotateBy(deg),
      onTap: (x, y) => this.handleTap(x, y),
      onHover: (x, y) => this.handleHover(x, y),
    });

    this.wireEvents();
    this.bootstrap();
  }

  static boot(options: GameAppOptions): GameApp {
    const app = new GameApp(options);
    app.start();
    return app;
  }

  // ---------------------------------------------------------------- 接线

  /**
   * 视图只订阅世界事件，不被任何人直接调用。
   * 这样"脚本落位""点击落位""开局落位"三条路走的是同一套同步逻辑。
   */
  private wireEvents(): void {
    this.bus.on('building:placed', (b) => {
      this.buildingView.add(b);
      this.ground.markOccupied(b.origin, b.cols, b.rows, true);
      this.props.setHidden(footprintRect({ origin: b.origin, cols: b.cols, rows: b.rows }), true);
      this.world.select({ kind: 'building', building: b });
    });

    this.bus.on('building:removed', (b) => {
      this.buildingView.remove(b.id);
      this.ground.markOccupied(b.origin, b.cols, b.rows, false);
      this.props.setHidden(footprintRect({ origin: b.origin, cols: b.cols, rows: b.rows }), false);
    });

    this.bus.on('selection:changed', () => this.syncSelection());
  }

  /** 起手：镜头回城 + 送一座议事厅。它是全场唯一不靠抽卡得到的建筑，因为它是抽卡的发动机。 */
  private bootstrap(): void {
    const home = pos(Math.floor(this.world.size.cols / 2), Math.floor(this.world.size.rows / 2));
    const spot = findNearestClearSpot(this.world.map, home, 2, 2);
    if (spot) {
      this.world.addPermits('hall', 1);
      this.world.build('hall', spot);
    }
    const center = cellToWorld(home);
    this.rig.centerOnWorld(center.x, center.z, true);
  }

  // ---------------------------------------------------------------- 生命周期

  start(): void {
    this.viewport.attach();
    this.input.attach();
    this.viewport.observe((snapshot) => this.applyViewport(snapshot));
    this.applyViewport(this.viewport.snapshot);
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
    this.input.dispose();
    this.viewport.dispose();
  }

  private applyViewport(v: { cssWidth: number; cssHeight: number; dpr: number }): void {
    const quality = pickQuality(v.cssWidth * v.cssHeight, v.dpr);
    this.renderer.resize(v.cssWidth, v.cssHeight, v.dpr, quality);
    this.rig.resize(v.cssWidth, v.cssHeight);
    this.lighting.follow(this.rig);
  }

  private draw(info: FrameInfo): void {
    this.lastFrame = info;
    this.rig.update(info.delta);
    this.lighting.follow(this.rig);
    this.ground.update(info.time);
    this.markers.update(info.time);
    this.buildingView.syncAll(this.world.buildings.values());
    this.renderer.render(this.scene, this.rig.camera);
  }

  // ---------------------------------------------------------------- 交互

  private cellAt(cssX: number, cssY: number): GridPos | null {
    const hit = this.rig.screenToGround(cssX, cssY);
    if (!hit) return null;
    const cell = worldToCell(hit.x, hit.z);
    return inBounds(cell, this.world.size) ? cell : null;
  }

  private handleHover(cssX: number, cssY: number): void {
    const cell = this.cellAt(cssX, cssY);
    this.hoverCell = cell;
    if (!cell) {
      this.markers.showHover(null, 0);
      return;
    }
    if (this.placement.isActive) this.placement.preview(cell);
    else this.markers.showHover(cell, this.world.map.surfaceY(cell));
  }

  /** 点击：放置模式里是"确认落位"，否则是"选中"。 */
  private handleTap(cssX: number, cssY: number): void {
    const cell = this.cellAt(cssX, cssY) ?? this.hoverCell;
    if (!cell) return;

    if (this.placement.isActive) {
      if (!this.placement.commit(cell)) {
        this.markers.showHover(cell, this.world.map.surfaceY(cell));
      }
      return;
    }

    const buildingId = this.world.map.buildingAt(cell);
    const building = buildingId !== null ? this.world.buildings.get(buildingId) : undefined;
    this.world.select(building ? { kind: 'building', building } : { kind: 'tile', pos: cell });
  }

  private syncSelection(): void {
    const sel = this.world.selection;
    if (sel?.kind !== 'building') {
      this.markers.select(null);
      return;
    }
    this.markers.select({
      origin: sel.building.origin,
      cols: sel.building.cols,
      rows: sel.building.rows,
      height: this.buildingView.heightOf(sel.building.id),
      surfaceY: sel.building.surfaceY,
    });
  }

  // ---------------------------------------------------------------- 对外动词

  /** 抽卡：报价 → 验账 → 掷卡 → 扣费 → 落地效果。钱不够返回 null 并吐一句提示。 */
  pull(count = 1): Purchase | null {
    const cost = this.gacha.priceFor(count);
    if (!this.world.canAfford(cost)) {
      this.bus.emit('toast', { text: '晶钻不够，先盖矿井或精炼厂', tone: 'warn' });
      return null;
    }
    const purchase: Purchase = { count, cost, outcomes: this.gacha.roll(count) };
    this.world.spend(cost);
    this.world.applyPurchase(purchase);
    this.bus.emit('pull:done', purchase);
    return purchase;
  }

  /** 进入放置模式。返回 false 表示这张卡手上没有许可。 */
  build(buildingId: string): boolean {
    const ok = this.placement.begin(buildingId);
    this.bus.emit('placing:changed', ok ? buildingId : null);
    if (!ok) this.bus.emit('toast', { text: '手上没有这张建造许可', tone: 'warn' });
    return ok;
  }

  cancelBuild(): void {
    this.placement.cancel();
    this.bus.emit('placing:changed', null);
  }

  /** 跳过交互直接落位：给脚本、回放和单测用。 */
  place(buildingId: string, where: GridPos): Building | null {
    if (this.world.permitCount(buildingId) <= 0) this.world.addPermits(buildingId, 1);
    const building = this.world.build(buildingId, where);
    if (building) this.world.select({ kind: 'building', building });
    return building;
  }

  demolish(id: number): void {
    this.world.demolish(id);
  }

  focusHome(): void {
    const home = pos(Math.floor(this.world.size.cols / 2), Math.floor(this.world.size.rows / 2));
    const center = cellToWorld(home);
    this.rig.centerOnWorld(center.x, center.z);
  }

  setOrientation(mode: OrientationMode): void {
    this.viewport.setOrientationMode(mode);
  }

  /** 视角高度：50° 是默认 2.5D，压到 25° 更接近红警的贴地感。 */
  setPitch(deg: number): void {
    this.rig.setPitch(deg);
  }

  // ---------------------------------------------------------------- 读数

  get bus() {
    return this.world.bus;
  }

  get camera(): CameraRig {
    return this.rig;
  }

  get telemetry(): Telemetry {
    return {
      fps: Math.round(this.lastFrame.fps),
      drawCalls: this.renderer.drawCalls,
      triangles: this.renderer.triangles,
      buildings: this.world.buildings.size,
      tiles: this.world.size.cols * this.world.size.rows,
      orientation: this.viewport.orientation,
    };
  }
}
