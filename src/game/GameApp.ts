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
import { cellToWorld, footprintCenter, footprintRect, inBounds, pos, samePos, worldToCell } from '@engine/math/Grid';
import { hashString, Random } from '@engine/math/Random';
import { CameraRig } from '@engine/render/CameraRig';
import { LightingRig } from '@engine/render/Lighting';
import { Renderer, pickQuality } from '@engine/render/Renderer';
import { PointerInput } from '@engine/input/PointerInput';
import { Viewport, type OrientationMode } from '@engine/viewport/Viewport';
import { CAMERA, DIFFICULTY, DUDE, ROUNDS, SIM_HZ, WORLD, difficultyOf, type Difficulty } from '@game/config';
import { buildingName } from '@game/data/buildings';
import { STARTER_POOL } from '@game/data/cards';
import { GachaService, type Purchase } from '@game/gacha/GachaService';
import { Prefs } from '@game/prefs';
import { updateFlagTime } from '@game/models/kit';
import { ModelLibrary } from '@game/models/registry';
import { BuildingView } from '@game/world/BuildingView';
import { GroundView } from '@game/world/GroundView';
import { GameWorld, type Building } from '@game/world/GameWorld';
import { MarkerLayer } from '@game/world/Markers';
import { PropScatter } from '@game/world/PropScatter';
import { findNearestClearSpot, generateTerrain } from '@game/world/TerrainGenerator';
import { PlacementController } from '@game/systems/Placement';
import { FlagPocket } from '@game/systems/FlagPocket';
import { Combat } from '@game/systems/Combat';
import { applySave, parseSave, snapshot } from '@game/world/save';
import { BattleFx } from '@game/fx/BattleFx';
import { loadPack, type DudePack } from '@game/dudes/pack';
import { randomStyle, type DudeStyle } from '@game/dudes/style';
import { DudeGallery, DEFAULT_APPEARANCE } from '@game/dudes/DudeView';
import { MiningCrew } from '@game/dudes/Miners';
import { Roster } from '@game/dudes/roster';
import { UnitView } from '@game/dudes/UnitView';

export interface GameAppOptions {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  /** 换 seed 就换一张图；同一个 seed 永远同一张图，连抽卡序列和小人长相也一样 */
  seed?: number;
  /** 难度档。给了就压过存档与偏好里的记录（`?difficulty=` 走这一条）。 */
  difficulty?: Difficulty;
  orientation?: OrientationMode;
  /** 小人素材包位置；默认 /assets/dudes */
  dudesUrl?: string;
}

export interface Telemetry {
  fps: number;
  drawCalls: number;
  triangles: number;
  buildings: number;
  tiles: number;
  orientation: OrientationMode;
  /** 在场小人数量 */
  runners: number;
  /** 已烘的小人风格数（一个风格一张纹理） */
  dudeStyles: number;
  /** 因为人数上限没派出去的任务数 */
  capped: number;
  /** 寻路失败、退回直线（会穿墙）的小人数；非零就该看见 */
  noPath: number;
  /** 在场士兵 + 敌人 */
  units: number;
  /** 在飞的弹丸 */
  shots: number;
  fx: { arrows: number; cannons: number; magics: number; puffs: number; dropped: number };
  /** 排不到人手、正在摸鱼的楼 */
  understaffed: number;
  round: number;
  phase: 'prep' | 'raid';
  phaseSecondsLeft: number;
  /** 素材包是否加载成功；false = 小人视觉关闭，玩法照常 */
  dudesReady: boolean;
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
  /** 手里握着的集合旗（一次一面） */
  readonly flags = new FlagPocket();
  readonly seed: number;
  /** 素材包为 null 时整套小人视觉静默关闭，玩法不受影响 */
  private readonly pack: DudePack | null;
  private readonly gallery: DudeGallery | null;
  private readonly crew: MiningCrew | null;
  private readonly roster: Roster | null;
  private readonly unitView: UnitView | null;
  readonly fx = new BattleFx();
  readonly combat: Combat;
  /** 议事厅归零之后停掉一切生产，等玩家重开 */
  defeated = false;
  private readonly seenShots = new Set<number>();
  private smokeAccum = 0;
  /** 一栋楼一张脸，算过一次就记住：随机数只在第一次动 */
  private readonly styles = new Map<number, DudeStyle>();

  private hoverCell: GridPos | null = null;
  private lastFrame: FrameInfo = { delta: 0, time: 0, fps: 60 };
  /** 等玩家回话的那一次落位：按下时压着晶脉，必须先确认才能盖 */
  private awaiting: { cell: GridPos } | null = null;

  readonly prefs = new Prefs();

  /** 开局显式指定的档：它压过存档与偏好里的记录 */
  private readonly forced: Difficulty | undefined;
  /** 玩家刚点下的档：正在打的这一波照旧，下一波起才换 */
  private pendingDifficulty: Difficulty | null = null;

  private constructor(options: GameAppOptions, pack: DudePack | null) {
    this.seed = options.seed ?? WORLD.seed;
    this.pack = pack;
    const rng = new Random(this.seed);

    // ---------------------------------------------------------------- 世界
    const map = generateTerrain({
      size: { cols: WORLD.cols, rows: WORLD.rows },
      seed: this.seed,
      veins: VEIN_COUNT,
      clearingRadius: 4,
    });
    this.world = new GameWorld(map, { seed: this.seed });

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

    // ---------------------------------------------------------------- 战斗
    // 战斗内核不依赖素材包：没有小人贴图也照样打，只是地上看不到人
    // 档位优先级：显式给的 > 偏好记的 > 默认正常。存档再往上一层，读到档时才盖过来。
    this.forced = options.difficulty;
    this.combat = new Combat({
      world: this.world,
      maxUnits: ROUNDS.maxRaidUnits,
      difficulty: options.difficulty ?? difficultyOf(this.prefs.difficulty),
    });
    this.combat.on('impact', (e) => {
      this.fx.impact(e.x, e.z, this.world.map.surfaceY(worldToCell(e.x, e.z)) + e.y, e.ammo, e.splash);
    });
    this.combat.on('defeat', () => {
      this.defeated = true;
      this.bus.emit('toast', { text: '议事厅被打掉了，这一局到此', tone: 'warn' });
      // 'game:over' 不在这里发：判负事件是在楼被拆掉**之前**发的，
      // 那时候"还剩几栋楼"会把议事厅自己也算进去。等它真从账上消失再说。
    });
    // 回合的"还在不在打"由战斗内核回答：场上有人 **或还有后续几涌没进**，都算还在打
    this.world.raidActive = () => this.combat.engaged();

    // ---------------------------------------------------------------- 小人
    // 素材包没加载成功时这三个就是 null，玩法与画面其余部分照常工作
    if (pack) {
      this.gallery = new DudeGallery(pack);
      this.crew = new MiningCrew({
        world: this.world,
        gallery: this.gallery,
        styleFor: (b) => this.styleOf(b),
        appearance: { ...DEFAULT_APPEARANCE, height: DUDE.heightTiles },
        maxRunners: DUDE.maxRunners,
        combat: this.combat,
      });
      this.roster = new Roster(pack, rng.fork('dude-style'));
      this.unitView = new UnitView(this.combat, pack, this.gallery, this.roster, DUDE.heightTiles, (x, z) => this.world.map.surfaceY(worldToCell(x, z)));
      this.scene.add(this.crew.group, this.unitView.group, this.fx.group);
    } else {
      this.gallery = null;
      this.crew = null;
      this.roster = null;
      this.unitView = null;
    }


    // ---------------------------------------------------------------- 抽卡
    this.gacha = new GachaService(STARTER_POOL, rng.fork('gacha'));

    // ---------------------------------------------------------------- 循环与输入
    this.loop = new GameLoop({
      hz: SIM_HZ,
      onSimStep: (dt) => {
        if (this.defeated) return;
        this.world.tick(dt);
        this.combat.update(dt);
      },
      onFrame: (info) => this.draw(info),
    });

    this.input = new PointerInput(options.canvas, {
      onPan: (dx, dy) => this.rig.panByPixels(dx, dy),
      onZoom: (factor, x, y) => this.rig.zoomBy(factor, x, y),
      onRotate: (deg) => this.rig.rotateBy(deg),
      onTap: (x, y) => this.handleTap(x, y),
      onLongPress: (x, y) => this.handleLongPress(x, y),
      onHover: (x, y) => this.handleHover(x, y),
    });

    this.wireEvents();
    // 有档就读档，没档才走开局（bootstrap 会白送一座议事厅，读档时不能再送一次）
    this.restored = this.tryRestore();
    // 有档就读档，没档才走开局；但坏档（主城被拆过）读回来没主城，也要补盖一座
    if (!this.restored || !this.world.hallAlive) this.bootstrap();
  }

  /** 读档期间不许回写存档：adopt 会发 building:placed，那是读不是写。 */
  private restored = false;
  /** 判负只广播一次（议事厅那栋楼真从账上消失的那一刻）。 */
  private overSent = false;

  /**
   * 起机器：素材包要异步加载（4 张图 + 一份 json），所以这里是 async。
   * 加载失败不拦着游戏：控制台留一行原因，小人视觉自动关闭。
   */
  static async boot(options: GameAppOptions): Promise<GameApp> {
    let pack: DudePack | null = null;
    try {
      pack = await loadPack(options.dudesUrl ?? '/assets/dudes');
    } catch (err) {
      console.warn('[GameApp] 小人素材包没加载上，运输队视觉关闭：', err);
    }
    const app = new GameApp(options, pack);
    app.start();
    return app;
  }

  /**
   * 一栋楼一张脸：由 (地图 seed + 楼号) 派生，所以同局同楼永远同一张脸，
   * 而且不用存盘。楼拆了再盖会换脸——那是新的一次建造，读起来也讲得通。
   */
  private styleOf(building: Building): DudeStyle {
    const cached = this.styles.get(building.id);
    if (cached) return cached;
    const style = randomStyle(new Random(hashString(`${this.seed}:dude:${building.id}`)), this.pack!);
    this.styles.set(building.id, style);
    return style;
  }

  /** 这栋楼派出去几个小人；素材没加载时是 0。 */
  runnersOf(buildingId: number): number {
    return this.crew?.countFor(buildingId) ?? 0;
  }

  // ---------------------------------------------------------------- 接线

  /**
   * 视图只订阅世界事件，不被任何人直接调用。
   * 这样"脚本落位""点击落位""开局落位"三条路走的是同一套同步逻辑。
   */
  /** 存档点：盖楼、拆楼、回合结算。战场上的兵与弹不存 —— 刷新就是回到上一次结算。 */
  private autosave(): void {
    if (this.restoring) return; // 读档时 adopt 也会发 building:placed，那是读不是写
    this.prefs.setSave(JSON.stringify(snapshot(this.world, this.combat)));
  }

  private restoring = false;

  private tryRestore(): boolean {
    const saved = parseSave(this.prefs.save);
    if (!saved) return false;
    // seed 不符就整份丢掉：楼是按格子记的，换张图去盖它们等于凭空造 bug
    if (saved.seed !== this.seed) {
      console.warn(`[GameApp] 存档是 seed ${saved.seed} 的，当前 ${this.seed}，不读`);
      return false;
    }
    this.restoring = true;
    const skipped = applySave(this.world, this.combat, saved);
    // 档里记的档位由 applySave 应用；显式指定的（`?difficulty=`）压过它
    if (this.forced) this.combat.setDifficulty(this.forced);
    this.restoring = false;
    if (skipped > 0) console.warn(`[GameApp] 存档里有 ${skipped} 栋楼没摆回去（格子被占或越界）`);
    return true;
  }

  /** 这一局现在按哪一档打（含"已点但还没生效"的那一个）。 */
  get difficulty(): Difficulty {
    return this.pendingDifficulty ?? this.combat.difficulty;
  }

  /** 还没生效的那一档：UI 要把"下一波才换"这件事摆到明面上。 */
  get pendingDiff(): Difficulty | null {
    return this.pendingDifficulty;
  }

  /**
   * 选难度档：立刻记进偏好，但**下一波才换节奏**。
   * 正在打的这波不许中途变，否则"半波敌人突然变聪明"这种没法解释的事会发生。
   */
  setDifficulty(d: Difficulty): void {
    this.prefs.setDifficulty(d);
    this.pendingDifficulty = d;
  }

  /** 重开：先清档，否则读档会把"已经输了的那局"再端回来。跳转由 UI 层做。 */
  restart(): void {
    this.prefs.clearSave();
  }

  private wireEvents(): void {
    this.bus.on('building:placed', (b) => {
      this.buildingView.add(b);
      this.ground.markOccupied(b.origin, b.cols, b.rows, true);
      this.props.setHidden(footprintRect({ origin: b.origin, cols: b.cols, rows: b.rows }), true);
      this.autosave();
    });

    this.bus.on('building:removed', (b) => {
      this.buildingView.remove(b.id);
      this.ground.markOccupied(b.origin, b.cols, b.rows, false);
      this.props.setHidden(footprintRect({ origin: b.origin, cols: b.cols, rows: b.rows }), false);
      // 楼没了，手里那面旗不能继续指向一个空号
      this.flags.forget(b.id);
      this.emitFlag();
      this.autosave();
      if (this.defeated && !this.overSent) {
        this.overSent = true;
        this.bus.emit('game:over', { round: this.world.roundIndex });
      }
    });

    // 晶脉被压掉：地块重涂成裸土，矿簇永久撤走（拆楼也不会回来）
    this.bus.on('vein:destroyed', (cells) => {
      this.ground.recolor(cells);
      this.props.ruin(cells);
    });

    // 分配一变就重排运输队。挂在这条线上而不是自己轮询：
    // 那是分配唯一成型的地方，别的时候读到的都是旧账
    this.bus.on('vein:replanned', () => this.crew?.sync());

    this.bus.on('selection:changed', () => this.syncSelection());

    // 回合结算是唯一的"落盘时刻"：账、许可、塔等级、人口快照都在这一刻定型
    this.bus.on('round:settled', () => this.autosave());

    // 回合进入接敌 = 这一波敌人进场。准备阶段什么都不发生，正是用户要的"不涨钱"
    this.bus.on('round:changed', ({ phase, index }) => {
      if (phase !== 'raid' || this.defeated) return;
      // 换档只在这一刻生效：正在打的这波不许中途变节奏
      if (this.pendingDifficulty && this.pendingDifficulty !== this.combat.difficulty) {
        this.combat.setDifficulty(this.pendingDifficulty);
        this.bus.emit('toast', { text: `从这一波起改走「${DIFFICULTY[this.combat.difficulty].label}」`, tone: 'ok' });
      }
      this.pendingDifficulty = null;
      this.combat.spawnWave(this.seed, index);
    });

    // 放置模式的变化只有一个源头：控制器自己广播，
    // 这样"许可用完那一刻的自动取消"和"玩家按取消"走的是同一条线
    this.placement.onActiveChange = (id) => this.bus.emit('placing:changed', id);
  }

  /** 起手：镜头回城 + 送一座议事厅。它是全场唯一不靠抽卡得到的建筑，因为它是抽卡的发动机。 */
  private bootstrap(): void {
    const home = pos(Math.floor(this.world.size.cols / 2), Math.floor(this.world.size.rows / 2));
    const spot = findNearestClearSpot(this.world.map, home, 2, 2);
    if (spot) {
      this.world.addPermits('hall', 1);
      // 兵营许可开局就给：成军是核心路径，不该压在抽卡运气上
      // （实测 600 抽里兵营卡只出 16 张，玩家一局都摸不到军队）
      this.world.addPermits('barracks', 1);
      const hall = this.world.build('hall', spot);
      if (hall) {
        /**
         * 开局视野锁**大本营自己**，不是地图中心格。
         *
         * `findNearestClearSpot` 找的空地未必就是中心：中心被树/水占着时会挪出去好几格，
         * 而镜头原来固定落在中心格上 —— 玩家开局先看到一片野地，得自己拖回家。
         * 直接按楼的占地中心算，锁死。
         */
        const center = footprintCenter(hall);
        this.rig.centerOnWorld(center.x, center.z, true);
        return;
      }
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
    this.lighting.update(info.time);
    this.lighting.follow(this.rig);
    this.ground.update(info.time);
    this.markers.update(info.time);
    // 旗面是顶点动画：每帧喂一次时间，布才会飘（树/屋不飘，只更新一个 uniform）
    updateFlagTime(info.time);
    this.buildingView.syncAll(this.world.buildings.values(), info.delta);
    // 小人每帧按时间重算位置：用 time%trip，所以快进与回放都对得上
    this.crew?.update(info.time, this.rig.yaw, info.delta);
    this.unitView?.sync(info.time, info.delta, this.rig.yaw);
    this.aimTurrets(info.delta);
    this.fx.sync(this.combat, info.delta);
    this.muzzleFlashes();
    this.buildSmoke(info.delta);
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

  /** 点击：放置模式里是"确认落位"，否则是"选中/取消选中"。 */
  private handleTap(cssX: number, cssY: number): void {
    const cell = this.cellAt(cssX, cssY) ?? this.hoverCell;
    if (!cell) return;

    /** 点旗子袋之后，下一次点地面是"放旗"，不是"选格子"，也不许顺手盖楼 */
    if (this.flags.state === 'placing') {
      this.dropFlag(cell);
      return;
    }

    if (this.placement.isActive) {
      const state = this.placement.stateOf(cell);

      // 压着晶脉又不肯直接放行：先问一次。勾了"不再提示"就跳过这一问
      if (state === 'warn' && !this.prefs.neverAskDestroyVein) {
        this.awaiting = { cell };
        this.bus.emit('confirm:vein', {
          cells: this.placement.veinsAtRisk(cell),
          buildingName: buildingName(this.placement.activeBuildingId!),
        });
        return;
      }

      const placed = this.placement.commit(cell, state === 'warn');
      if (placed) this.world.select({ kind: 'building', building: placed });
      else this.markers.showHover(cell, this.world.map.surfaceY(cell));
      return;
    }

    const buildingId = this.world.map.buildingAt(cell);
    const building = buildingId !== null ? this.world.buildings.get(buildingId) : undefined;
    const sel = this.world.selection;

    // 再点一次已经选中的东西就是取消：竖屏上没有"点空白"这种便宜目标，
    // 自己就是最容易按到的那个取消键
    if (building && sel?.kind === 'building' && sel.building.id === building.id) {
      this.world.select(null);
      return;
    }
    if (!building && sel?.kind === 'tile' && samePos(sel.pos, cell)) {
      this.world.select(null);
      return;
    }

    this.world.select(building ? { kind: 'building', building } : { kind: 'tile', pos: cell });
  }

  /** 长按 = 查详情。气泡由 UI 挂在建筑头顶，跟"点一下选中"是两条独立的路。 */
  private handleLongPress(cssX: number, cssY: number): void {
    const cell = this.cellAt(cssX, cssY);
    if (!cell) {
      this.bus.emit('inspect:target', null);
      return;
    }
    const id = this.world.map.buildingAt(cell);
    const building = id !== null ? (this.world.buildings.get(id) ?? null) : null;
    this.bus.emit('inspect:target', building);
  }

  /**
   * 新开的一发弹丸 → 在塔口打一下火光。
   * 内核没有"开火"事件（它只维护弹丸表），所以这里用"第一次见到的 shot id"当开火时刻 ——
   * 比给内核加一条事件更省事，也不会漏。
   */
  private muzzleFlashes(): void {
    for (const shot of this.combat.liveShots()) {
      if (this.seenShots.has(shot.id)) continue;
      this.seenShots.add(shot.id);
      // 炮口火光落在**炮口**上，不是塔心：炮台会转，火光必须跟着转
      const tip = shot.fromBuilding !== null ? this.buildingView.turretTip(shot.fromBuilding) : null;
      const x = tip ? tip.x : shot.fromX;
      const z = tip ? tip.z : shot.fromZ;
      const y = tip ? tip.y : shot.y + 1.0;
      const dx = shot.toX - x;
      const dz = shot.toZ - z;
      const len = Math.hypot(dx, dz) || 1;
      this.fx.muzzle(x, z, y, shot.ammo, dx / len, dz / len);
    }
    if (this.seenShots.size > 512) this.seenShots.clear();
  }

  /**
   * 炮台转向：每帧把有炮台的塔转向 `combat.aimOf()` 给的点。
   *
   * 没目标就**不转**（停在最后朝向）—— 回正会让人以为它在待机，其实只是没看见人。
   */
  private aimTurrets(dt: number): void {
    for (const b of this.world.buildings.values()) {
      if (!b.built || !b.def.tower) continue;
      const aim = this.combat.aimOf(b.id);
      if (aim) this.buildingView.aimAt(b.id, aim.x, aim.z, dt);
    }
  }

  /**
   * 工地雾霭：没封顶的楼每 0.28 秒从地面往上涌一层软雾，楼身半遮半露。
   *
   * 雾的高度跟着建造进度抬（不是钉在楼顶）：楼在长，尘也在往上翻，
   * 这样"长高"和"扬尘"是同一件事，而不是两条各演各的动画。
   */
  private buildSmoke(dt: number): void {
    // 封顶那一记雾爆不受节流管：它只发生一次，错过就没了
    for (const id of this.buildingView.takeSettled()) {
      const b = this.world.buildings.get(id);
      if (!b) continue;
      const c = footprintCenter({ origin: b.origin, cols: b.cols, rows: b.rows });
      this.fx.buildHaze(c.x, c.z, b.surfaceY + 0.1, Math.max(b.cols, b.rows) * 0.85, 1.7, b.id);
    }

    this.smokeAccum += dt;
    if (this.smokeAccum < 0.24) return;
    this.smokeAccum = 0;
    for (const b of this.world.buildings.values()) {
      if (b.built) continue;
      const c = footprintCenter({ origin: b.origin, cols: b.cols, rows: b.rows });
      const radius = Math.max(b.cols, b.rows) * 0.55;
      const top = this.buildingView.heightOf(b.id) * b.progress;
      this.fx.buildHaze(c.x, c.z, b.surfaceY + 0.12 + top * 0.45, radius, 0.75, b.id);
    }
  }

  /** 升级一座塔：只花钱与水晶，不碰许可。返回 false = 不是塔 / 已满级 / 钱不够。 */
  upgrade(buildingId: number): boolean {
    const b = this.world.buildings.get(buildingId);
    return b ? this.combat.upgrade(b) : false;
  }

  /** 塔的射击状态（弹夹、装填、等级）—— 给头顶菜单与信息卡读。 */
  towerState(buildingId: number) {
    const b = this.world.buildings.get(buildingId);
    return b?.def.tower ? this.combat.towerState(b) : null;
  }

  /** 兵营三态：在场 / 储备 / 读条。 */
  barracksState(buildingId: number) {
    const b = this.world.buildings.get(buildingId);
    return b?.def.squad ? this.combat.barracksState(b) : null;
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
    if (!ok) {
      this.bus.emit('toast', { text: '手上没有这张建造许可', tone: 'warn' });
      return false;
    }
    // 拿起一张建造卡，就不该同时在等一次"放旗"的落点
    if (this.flags.state === 'placing') this.cancelFlag();
    return true;
  }

  cancelBuild(): void {
    this.awaiting = null;
    this.placement.cancel();
  }

  // ---------------------------------------------------------------- 集合旗
  /*
   * 取旗**只有一条路**：旗子袋 → 旗架（旗子卡）→ 点卡 → 点地面。
   *
   * 原来还有 `stowFlag`（点头顶那面旗收进袋）和 `armFlag`（点旗子袋直接进落旗），
   * 三条路各维护一半状态，玩家看到的就是"几个界面串在一起、到底先点哪个"。
   * 那两个方法已经删掉：少一条路，就少一处能对不上的状态。
   */

  /**
   * 旗架上点一张卡：把这面旗拿到手上，**并直接进入落旗**。
   *
   * 以前要三步（点楼上的旗 → 点旗子袋 → 点地面），旗架把前两步合成一步；
   * 手还是只握一面（`FlagPocket` 的规则没变，收第二面时第一面自动回位）。
   */
  pickFlag(buildingId: number): boolean {
    const b = this.world.buildings.get(buildingId);
    if (!b) return false;
    this.flags.take(buildingId);
    if (!this.flags.arm()) return false;
    this.placement.cancel();
    this.emitFlag();
    this.bus.emit('toast', { text: `拿了${b.def.name}的旗 —— 点一处地面放下` });
    return true;
  }

  /** 落旗。地形不许时旗子留在手里，可以再点一次 —— 不许出现"点一下就没了一面旗"。 */
  dropFlag(cell: GridPos): boolean {
    const held = this.flags.held;
    if (held === null) return false;
    if (!this.world.setRally(held, cell)) return false;
    this.flags.release();
    this.emitFlag();
    return true;
  }

  /** Esc：正在等落点就先退出等落点；只是握着，就把旗子放回原位。 */
  cancelFlag(): void {
    if (this.flags.state === 'placing') this.flags.disarm();
    else if (this.flags.state === 'held') this.flags.release();
    else return;
    this.emitFlag();
  }

  private emitFlag(): void {
    this.bus.emit('flag:changed', { state: this.flags.state, buildingId: this.flags.held });
  }

  /**
   * 确认框的回话。agree=false 就什么都不做——一格都不动，许可也不扣。
   * neverAsk=true 时把"不再提示"记下来，此后压矿脉直接放行（破坏照样发生）。
   */
  resolveConfirm(agree: boolean, neverAsk = false): Building | null {
    const pending = this.awaiting;
    this.awaiting = null;
    if (neverAsk) this.prefs.setNeverAskDestroyVein(true);
    if (!agree || !pending || !this.placement.isActive) return null;

    const placed = this.placement.commit(pending.cell, true);
    if (placed) this.world.select({ kind: 'building', building: placed });
    return placed;
  }

  /** 跳过交互直接落位：给脚本、回放和单测用。 */
  place(buildingId: string, where: GridPos, allowDestroy = false): Building | null {
    if (this.world.permitCount(buildingId) <= 0) this.world.addPermits(buildingId, 1);
    const building = this.world.build(buildingId, where, allowDestroy);
    if (building) this.world.select({ kind: 'building', building });
    return building;
  }

  /** 拆除模式：进"拆"状态后，选一栋楼、再按一次那一格才真的拆。 */
  demolishMode = false;

  /** 拆除模式下选中的楼（给操作坞显示"拆除 · 民居"用）；议事厅不算。 */
  get demolishTargetName(): string | null {
    const sel = this.world.selection;
    if (!this.demolishMode || sel?.kind !== 'building') return null;
    return sel.building.def.unique ? null : sel.building.def.name;
  }

  /**
   * 操作坞"建造/拆除"那一格。
   *
   * 和放建筑同构：第一次按**进入**拆除模式，选好楼之后再按一次**执行**。
   * 没有选中可拆的楼时再按一次，就是退出 —— 不然会卡在一个不知道自己在干什么的状态里。
   */
  onDemolishSlot(): void {
    const sel = this.world.selection;
    const target = sel?.kind === 'building' ? sel.building : null;
    if (!this.demolishMode) {
      this.demolishMode = true;
      this.cancelBuild(); // 手上还握着建造卡就先放下，两种模式不并存
      return;
    }
    if (target && !target.def.unique) {
      this.demolish(target.id);
      this.world.select(null);
      return;
    }
    this.demolishMode = false;
  }

  demolish(id: number): void {
    this.world.demolish(id, true);
  }

  focusHome(): void {
    // 回城要回**实际那座议事厅**，不是地图中心（中心被占的时候楼会挪出去）
    const homeHall = [...this.world.buildings.values()].find((b) => b.def.unique);
    const fallback = cellToWorld(pos(Math.floor(this.world.size.cols / 2), Math.floor(this.world.size.rows / 2)));
    const center = homeHall ? footprintCenter(homeHall) : fallback;
    this.rig.centerOnWorld(center.x, center.z);
  }

  /**
   * 世界坐标 -> 以画布左上角为原点的 CSS 像素。
   * UI 要把气泡钉在建筑头顶时用它，这样 three 的投影公式只留在一处。
   */
  screenOfWorld(x: number, y: number, z: number): { x: number; y: number; inFront: boolean } {
    const v = new THREE.Vector3(x, y, z).project(this.rig.camera);
    const { cssWidth, cssHeight } = this.viewport.snapshot;
    return {
      x: (v.x * 0.5 + 0.5) * cssWidth,
      y: (-v.y * 0.5 + 0.5) * cssHeight,
      // 正交相机下 z 出界意味着这点跑到相机背后，投影出来的位置是假的
      inFront: v.z <= 1,
    };
  }

  /** 钉在楼顶上方一点，别压住屋顶。 */
  screenOfBuilding(building: Building): { x: number; y: number; inFront: boolean } {
    const center = footprintCenter({
      origin: building.origin,
      cols: building.cols,
      rows: building.rows,
    });
    const top = building.surfaceY + this.buildingView.heightOf(building.id) + 0.35;
    return this.screenOfWorld(center.x, top, center.z);
  }

  /** 集合旗钉在"集合点那一格"的地面上方，而不是楼顶：旗子指的是地，不是楼。 */
  screenOfRally(building: Building): { x: number; y: number; inFront: boolean } {
    const cell = this.world.rallyOf(building);
    const world = cellToWorld(cell);
    return this.screenOfWorld(world.x, this.world.map.surfaceY(cell) + 0.9, world.z);
  }

  /** 任意一格地面的屏幕位置（来犯预告旗标用它）。 */
  screenOfCell(cell: GridPos): { x: number; y: number; inFront: boolean } {
    const world = cellToWorld(cell);
    return this.screenOfWorld(world.x, this.world.map.surfaceY(cell) + 0.7, world.z);
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
      runners: this.crew?.count ?? 0,
      dudeStyles: this.gallery?.styleCount ?? 0,
      capped: (this.crew?.capped ?? 0) + this.combat.capped,
      noPath: this.crew?.noPath ?? 0,
      dudesReady: this.pack !== null,
      units: this.combat.size,
      shots: this.combat.liveShots().length,
      fx: this.fx.readout,
      understaffed: this.world.understaffed().size,
      round: this.world.roundIndex,
      phase: this.world.phase,
      phaseSecondsLeft: this.world.phaseSecondsLeft,
    };
  }

  /** 素材包读出来的规模，用来确认"头/脸/体型是不是我以为的那个数"。 */
  get dudeInfo(): { headMax: number; faceMax: number; baseMax: number; frameCols: number } | null {
    if (!this.pack) return null;
    return {
      headMax: this.pack.maxima.head,
      faceMax: this.pack.maxima.face,
      baseMax: this.pack.maxima.base,
      frameCols: this.pack.frameCols,
    };
  }
}
