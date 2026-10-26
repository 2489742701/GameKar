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
import { DEFAULT_APPEARANCE, DudeGallery, DudeSprite, facingFlip } from '@game/dudes/DudeView';
import { loadPack, type DudePack } from '@game/dudes/pack';
import { faceCandidates, headCandidates, isBlue } from '@game/dudes/roster';
import { randomStyle, type DudeStyle } from '@game/dudes/style';
import { unitDef } from '@game/data/units';
import { BattleFx } from '@game/fx/BattleFx';
import { buildModel, spinnersOf, TURRET } from '@game/models/kit';
import { GroundView } from '@game/world/GroundView';
import { TileMap } from '@game/world/TileMap';
import { ArenaWorld, statsOf, type ArenaBuilding, type ArenaUnit, type Side } from './ArenaWorld';
import { AmbientDust } from './ambient';
import { ArenaDirector } from './Camera';
import { ARENA_CAMERA, BUILDING_SCALE, FIELD, NO_BUILD, RUIN, UNIT_HEIGHT } from './config';
import { DamageFx } from './damage';
import { ARENA_FLAGS, ARENA_MODELS, type ArenaModelName } from './models';
import { WallShell } from './shell';
import { makeBanner, type Banner } from './props';
import { fracture } from './ruins';
import { sideColor } from './theme';

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
  /** 场景里的那个东西：普通兵是像素小人，移动火炮是"推车 + 两个小人" */
  obj: THREE.Object3D;
  dude: DudeSprite | null;
  /** 推车后面那两个人（只有移动火炮有） */
  pushers: DudeSprite[];
  siege: boolean;
  /** 车头朝向（弧度，绕 y），只给移动火炮用 */
  face: number;
  x: number;
  z: number;
  cooldown: number;
  attackLeft: number;
  /** 下一团脚底扬尘的倒计时（秒） */
  dustIn: number;
  /**
   * "还在走"的保留时间（秒）。
   *
   * 逻辑是 20Hz、渲染是 60Hz：直接拿"这一帧挪了多少"判跑步，三次渲染里两次挪了 0，
   * 动画就在 run / idle 之间每帧切一次 —— 屏幕上就是一闪一闪。
   * 给 0.18 秒迟滞：这期间动过就一直算走（老模式的 UnitView 同一条规矩）。
   */
  runHold: number;
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
  private readonly ground: GroundView;
  private readonly map: TileMap;
  /** 受伤的渐进碎裂：面片崩落 + 骨架 */
  private readonly damage: DamageFx;
  /** 开火/命中的烟雾、火光、火星（和老模式同一套 BattleFx，不另写一份） */
  private readonly fx: BattleFx;
  /** 战场浮尘：几十个点的一次 draw call，用来给静止画面一点"空气" */
  private readonly dustLayer: AmbientDust;
  private readonly pack: DudePack | null;
  private readonly gallery: DudeGallery | null;
  private readonly opts: ArenaAppOptions;

  private readonly buildingMeshes = new Map<number, THREE.Group>();
  private readonly unitSprites = new Map<number, UnitSprite>();
  private readonly flagMarks = new Map<number, THREE.Group>();
  private readonly styles = new Map<string, DudeStyle>();
  /** 会动的零件：磨坊的风车、炮塔的头、塔口的火光 */
  private readonly ruinMeshes = new Map<number, THREE.Group>();
  private readonly parts = new Map<
    number,
    { sails?: { group: THREE.Object3D; speed: number }[]; turret?: THREE.Object3D; banner?: Banner }
  >();
  /** 在飞的弹丸（视觉件，按 world.shots 同步） */
  private readonly shotMeshes = new Map<number, THREE.Object3D>();
  /** 已经放过治疗圈的 id（world.heals 是逐帧还在的事件，别重复放） */
  private readonly seenHeals = new Set<number>();
  readonly director = new ArenaDirector();
  private fitZoom = ARENA_CAMERA.tilesAcross;
  /** 当前这一笔拖动是从场地上开始的吗（真=平移，假=转视角） */
  private gestureFromField = true;
  private lastFrame: FrameInfo = { delta: 0, time: 0, fps: 60 };

  private constructor(opts: ArenaAppOptions, pack: DudePack | null) {
    this.opts = opts;
    this.seed = opts.seed ?? 20261027;
    this.pack = pack;
    this.world = new ArenaWorld({ seed: this.seed });

    this.map = new TileMap({ cols: this.world.fieldSize.cols, rows: this.world.fieldSize.rows });
    this.ground = new GroundView(this.map);
    this.damage = new DamageFx(this.scene);
    this.fx = new BattleFx();
    this.scene.add(this.fx.group);
    this.dustLayer = new AmbientDust(this.map.size.cols, this.map.size.rows);
    this.scene.add(this.dustLayer.points);
    // 外墙崩开时溅火星；碎块落地时扬一小团土
    this.damage.onBreach = (x, z, y, dirX, dirZ) => this.fx.spark(x, z, y, dirX, dirZ, 14);
    this.damage.onLand = (x, z, y) => this.fx.dust(x, z, y);
    this.renderer = new Renderer(opts.canvas);
    this.viewport = new Viewport(opts.container);
    this.rig = new CameraRig({
      pitchDeg: ARENA_CAMERA.pitchDeg,
      yawDeg: ARENA_CAMERA.yawDeg,
      tilesAcross: ARENA_CAMERA.tilesAcross,
      minTilesAcross: ARENA_CAMERA.minTilesAcross,
      maxTilesAcross: ARENA_CAMERA.maxTilesAcross,
    });
    this.rig.setBounds({ minX: 0, maxX: this.map.size.cols, minZ: 0, maxZ: this.map.size.rows });
    this.lighting = new LightingRig(this.scene, { shadowMapSize: 1024 });

    // 场地底盘：不然 16×26 之外全是黑洞，看着像地图没加载完
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(this.map.size.cols + 14, this.map.size.rows + 14),
      new THREE.MeshStandardMaterial({ color: 0x1b2a1b, roughness: 1, flatShading: true }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(this.map.size.cols / 2, -0.06, this.map.size.rows / 2);
    apron.receiveShadow = true;

    // 中场禁建带：**地块本身**染成黄沙（不再盖一层半透明贴纸），两侧各一道亮边。
    const bandCells: { col: number; row: number }[] = [];
    for (let col = FIELD.midCol - NO_BUILD.halfWidth; col <= FIELD.midCol + NO_BUILD.halfWidth; col++) {
      for (let row = 0; row < this.map.size.rows; row++) bandCells.push({ col, row });
    }
    this.ground.tintCells(bandCells, NO_BUILD.color);
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0xf0d08a,
      emissive: 0xc8a24c,
      emissiveIntensity: 0.5,
      roughness: 0.6,
    });
    const edgeL = new THREE.Mesh(new THREE.PlaneGeometry(0.12, this.map.size.rows), edgeMat);
    edgeL.rotation.x = -Math.PI / 2;
    edgeL.position.set(FIELD.midCol - NO_BUILD.halfWidth - 0.5, 0.53, this.map.size.rows / 2);
    const edgeR = edgeL.clone();
    edgeR.position.x = FIELD.midCol + NO_BUILD.halfWidth + 0.5;
    this.scene.add(apron, edgeL, edgeR, this.ground.group);
    this.gallery = pack ? new DudeGallery(pack) : null;

    this.loop = new GameLoop({
      hz: 20,
      onSimStep: (dt) => {
        this.world.update(dt);
        this.opts.onState?.();
      },
      onFrame: (info) => this.draw(info),
    });

    // 手势起点在场地里还是黑区里：决定这次拖动是"平移"还是"转视角"
    opts.canvas.addEventListener('pointerdown', (e) => {
      const rect = opts.canvas.getBoundingClientRect();
      const hit = this.rig.screenToGround(e.clientX - rect.left, e.clientY - rect.top);
      // 光有"打到地面平面"不够：那条射线在场地外也照样命中（无穷大平面），
      // 所以还要判格子是否在地图里 —— 否则黑区拖动也会被当成"在田里平移"。
      const cell = hit ? worldToCell(hit.x, hit.z) : null;
      this.gestureFromField = cell !== null && inBounds(cell, this.map.size);
    });

    this.input = new PointerInput(opts.canvas, {
      onPan: (dx, dy) => {
        this.director.userTouched();
        if (this.gestureFromField) {
          this.rig.panByPixels(dx, dy);
        } else {
          // 黑色区域（场地之外）：拖动 = 上下左右转视角。
          // 默认**正向**：往右拖视线往右、往下拖视线往下（两个轴一起翻，不是只翻一个）。
          // invertOrbit 留给以后的设置开关，拨一下就整体回到旧方向。
          const dir = this.director.invertOrbit ? -1 : 1;
          this.rig.rotateBy(-dx * 0.22 * dir);
          this.rig.setPitch(Math.min(78, Math.max(24, this.rig.pitch + dy * 0.18 * dir)));
        }
      },
      onZoom: (factor, x, y) => {
        this.director.userTouched();
        this.rig.zoomBy(factor, x, y);
      },
      onRotate: (deg) => {
        this.director.userTouched();
        this.rig.rotateBy(deg);
      },
      onTap: (x, y) => this.handleTap(x, y),
      onLongPress: (x, y) => this.handleLongPress(x, y),
      onHover: () => {},
    });

    const mid = cellToWorld(pos(this.map.size.cols / 2, this.map.size.rows / 2 - 1.4));
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
      this.fitCamera(v.cssWidth, v.cssHeight);
      this.lighting.follow(this.rig);
    });
    const s = this.viewport.snapshot;
    this.renderer.resize(s.cssWidth, s.cssHeight, s.dpr, pickQuality(s.cssWidth * s.cssHeight, s.dpr));
    this.rig.resize(s.cssWidth, s.cssHeight);
    this.fitCamera(s.cssWidth, s.cssHeight);
    this.lighting.follow(this.rig);
    this.loop.start();
  }

  /**
   * 让整幅场地进画面。相机按短边看几格来定视野，所以换朝向要重算：
   * 横屏短边是高、竖屏短边是宽 —— 两个方向分别求至少要看多少格，取大者。
   * 竖直方向多留 4 格，底下那几格是给手牌让位的（不然蓝方核心被卡牌压住）。
   */
  private fitCamera(cssWidth: number, cssHeight: number): void {
    const a = cssWidth / Math.max(1, cssHeight);
    const wantRows = this.map.size.rows + 4;
    const wantCols = this.map.size.cols + 2;
    const fit = a >= 1 ? Math.max(wantRows, wantCols / a) : Math.max(wantCols, wantRows * a);
    this.fitZoom = fit;
    // 自动模式下由导演每帧把缩放拉回机位；手动模式直接吃这个值
    if (this.director.locked) this.rig.zoom = fit * this.director.current.zoomFactor;
  }

  // ---------------------------------------------------------------- 出牌

  /**
   * HUD 点手牌。返回三态而不是布尔：
   * "没选中"和"被取消"是两件事，布尔会把"再点一次取消"误报成"选不了"。
   */
  selectCard(slot: number): 'selected' | 'deselected' | 'empty' | 'cooldown' | 'poor' {
    const card = this.world.hand[slot];
    if (!card) return 'empty';
    if (this.world.handCooldown[slot]! > 0) return 'cooldown';
    if (this.world.gold.blue < card.cost) return 'poor';
    this.selectedSlot = this.selectedSlot === slot ? -1 : slot;
    this.selectedBuilding = null;
    return this.selectedSlot === slot ? 'selected' : 'deselected';
  }

  /** 换下一个机位（HUD 按钮/键盘 V 都走这里）。 */
  nextView(): string {
    return this.director.next().name;
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
      // 没选手牌：点自家兵营 = 准备挪旗
      if (building && building.side === 'blue' && building.kind === 'barracks') {
        this.selectedBuilding = building.id;
        this.opts.onToast?.('再点一处地面，把出兵旗放过去');
        return;
      }
      // 点空地 = 指挥己方所有兵往那儿走（再点一次对面也不管用，它们路上遇敌照打）
      const n = this.world.command('blue', cell.col, cell.row);
      this.opts.onToast?.(n > 0 ? `全军向 (${cell.col}, ${cell.row}) 推进` : '场上还没有你的兵', n > 0 ? 'ok' : 'warn');
      return;
    }

    const card = this.world.hand[this.selectedSlot];
    const readyBefore = this.world.supportedBarracks('blue');
    const res = this.world.playCard('blue', this.selectedSlot, cell.col, cell.row);
    if (!res.ok) {
      this.opts.onToast?.(res.reason ?? '放不下', 'warn');
      return;
    }
    this.selectedSlot = -1;
    this.syncBuildings();
    // 后勤提示：兵营要 1 磨坊 + 1 民居；放对了后勤就说"开工了"
    const placed = this.buildingAtCell(cell);
    if (placed && placed.kind === 'barracks' && !this.world.isBarracksSupported(placed.id)) {
      this.opts.onToast?.('兵营要先配 1 磨坊 + 1 民居才会出兵', 'warn');
    } else if (card?.building === 'mill' || card?.building === 'house') {
      if (this.world.supportedBarracks('blue') > readyBefore) this.opts.onToast?.('兵营开工了');
    }
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
    this.syncShots(info.time);
    this.syncHeals();
    this.syncRuins();
    this.syncParts(info.time);
    this.damage.update(info.delta);
    this.fx.step(info.delta);
    this.dustLayer.update(info.delta);
    this.director.update(info.delta, this.rig, this.fitZoom, this.fieldCenter());
    this.renderer.render(this.scene, this.rig.camera);
  }

  /** 建筑：新增/删掉都在这补齐。模型来自 `models.ts`，五栋楼一套设计语言。 */
  private syncBuildings(): void {
    for (const b of this.world.buildings.values()) {
      if (this.buildingMeshes.has(b.id)) continue;
      const name = b.kind as ArenaModelName;
      // 阵营色只落在小件上：核心水晶、炮塔四角、磨坊顶盖
      const accent = name === 'core' || name === 'cannonTower' || name === 'mill' ? sideColor(b.side) : 0;
      const model = ARENA_MODELS[name](accent);
      const group = buildModel(model.static);
      // 外墙是一张单独的面片网格：受伤时从这里整块摘（见 shell.ts）
      const shell = new WallShell(model.shell);
      group.add(shell.mesh);
      // 磨坊的帆是六块各自带 pivot 的件 ⇒ 套件建了六个转轴 Group。
      // 只转第一个的话，就是"一块帆在转、其余五块钉死"（用户："有的地方转，有的地方不转"）。
      const sails = spinnersOf(group).map((s) => ({ group: s.group, speed: s.speed }));
      const turret = group.userData[TURRET] as THREE.Object3D | undefined;
      this.parts.set(b.id, { sails: sails.length > 0 ? sails : undefined, turret });
      const center = cellToWorld(pos(b.col + b.cols / 2 - 0.5, b.row + b.rows / 2 - 0.5));
      // 模型说明书写的是"局部原点在占地中心、底面 y=0"，所以要抬到**地块表面**，
      // 不能放在 y=0 —— 草地表面在 0.5，放 0 就是整栋楼埋掉半截。
      group.position.set(center.x, this.map.footprintSurfaceY(pos(b.col, b.row), b.cols, b.rows), center.z);
      group.scale.setScalar(BUILDING_SCALE);
      // 量一次模型自身的高度（格）：血条挂多高就按它算，不再按建筑种类写死。
      // 相对组自身量：组已经抬到了地块表面，直接用世界坐标会把那 0.5 格算进去。
      group.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(group);
      const modelTop = bounds.max.y - group.position.y;
      this.scene.add(group);
      // 血条要挂在**抵消缩放**的子组里：直接挂在 group 上会跟着放大，位置被抬到半空
      const ui = new THREE.Group();
      ui.scale.setScalar(1 / BUILDING_SCALE);
      group.add(ui);
      // 旗：放进反向缩放的 ui 组，所以尺寸直接用"格"（落点表在 models.ts 的 ARENA_FLAGS）
      const spot = ARENA_FLAGS[name];
      const banner = makeBanner(b.side, spot.pole);
      banner.group.position.set(spot.x, spot.base, spot.z);
      ui.add(banner.group);
      this.parts.set(b.id, { ...(this.parts.get(b.id) ?? {}), banner });
      const bar = makeHpBar(b.hp / b.maxHp, sideColor(b.side), 2.6);
      bar.position.y = modelTop + 0.25;
      ui.add(bar);
      group.userData['hpBar'] = bar;
      if (b.kind === 'barracks') {
        const need = makeNeedLabel();
        need.position.y = modelTop + 0.9;
        ui.add(need);
        group.userData['need'] = need;
      }
      // 受伤碎裂：注册时把实测尺寸交给它，之后每帧只喂血量分数
      this.damage.register(
        b.id,
        { center, groundY: group.position.y, scale: BUILDING_SCALE, seed: b.id * 7919 + 17 },
        shell,
      );

      // 核心的水晶是**模型自带的**（嵌在屋顶里、按阵营上色），不再往头顶飘一颗。
      // 用户 2026-10-27："整个建筑的模型本身里面就嵌了一个水晶，为什么还要再画一个水晶"。
      this.buildingMeshes.set(b.id, group);
      group.userData['side'] = b.side;
    }
    for (const [id, group] of this.buildingMeshes) {
      const b = this.world.buildings.get(id);
      if (b) {
        const frac = b.hp / b.maxHp;
        const need = group.userData['need'] as THREE.Sprite | undefined;
        if (need) need.visible = !this.world.isBarracksSupported(id);
        const bar = group.userData['hpBar'] as THREE.Mesh | undefined;
        if (bar) {
          // 满血不挂条；掉血才出现，这样一眼能看出哪栋在挨打
          bar.visible = frac < 0.999;
          updateHpBar(bar, frac);
        }
        this.damage.sync(id, frac);
        continue;
      }
      this.scene.remove(group);
      this.damage.forget(id);
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
      // 位移必须在更新缓存坐标**之前**算：老代码先写了 entry.z = u.z 再算 dz，
      // 于是 dz 恒为 0，推车的朝向永远不变（这次顺手修掉）。
      const dx = u.x - entry.x;
      const dz = u.z - entry.z;
      const moved = Math.hypot(dx, dz);
      const justFired = u.cooldown > entry.cooldown;
      entry.x = u.x;
      entry.z = u.z;
      entry.cooldown = u.cooldown;
      if (justFired) entry.attackLeft = 0.5;
      else entry.attackLeft = Math.max(0, entry.attackLeft - dt);
      // 迟滞：这一帧动过就续 0.18 秒，否则慢慢放掉 —— 不然 run/idle 每帧切换，屏幕上一闪一闪
      entry.runHold = moved > 0.004 ? 0.18 : Math.max(0, entry.runHold - dt);
      const moving = entry.runHold > 0;
      // 行军扬尘：每 0.4–0.65 秒在脚下放一小团（不是每帧，别把烟池吃满）
      entry.dustIn = Math.max(0, entry.dustIn - dt);
      if (moving && entry.dustIn <= 0) {
        entry.dustIn = 0.4 + Math.random() * 0.25;
        this.fx.dust(u.x, u.z, this.groundY(u.x, u.z) + 0.12);
      }

      if (entry.siege) {
        // 车头朝着"这一步往哪走"；停下来就保持最后朝向
        if (moved > 0.004) entry.face = -Math.atan2(dz, dx);
        entry.obj.position.set(u.x, this.groundY(u.x, u.z), u.z);
        entry.obj.rotation.y = entry.face;
        for (const p of entry.pushers) {
          // 推车是**转过的父组**：贴在它底下的小人要正对镜头，就得把父级转角减掉，
          // 否则车往左走时小人跟着转 180°，等于背对镜头且左右反了。
          p.faceCamera(this.rig.yaw - (entry.face * 180) / Math.PI);
          p.setFlipX(facingFlip(dx, dz, this.rig.yaw, p.flipped));
          p.play(moving ? 'run' : 'idle', time);
        }
        continue;
      }
      const def = unitDef(u.defId);
      const bodyH = def.heightTiles ?? UNIT_HEIGHT;
      const anim = entry.attackLeft > 0 ? def.attackAnim : moving ? 'run' : def.idleAnim;
      if (entry.dude) {
        entry.dude.moveTo(u.x, u.z);
        // 脚必须踩在**地块表面**上：草地表面在 y=0.5，而 DudeSprite 自带的身高偏移是从 y=0 起算的。
        // 老模式的 UnitView 一直有这一句，我这一版漏了 —— 表现就是整个小人埋掉半个身子。
        entry.obj.position.y = this.groundY(u.x, u.z) + bodyH / 2;
        entry.dude.faceCamera(this.rig.yaw);
        // 左右朝向看**屏幕**：把世界位移投到相机的右向量上，镜头转到哪边都不会反着走
        entry.dude.setFlipX(facingFlip(dx, dz, this.rig.yaw, entry.dude.flipped));
        entry.dude.play(anim, time);
      } else {
        // 没有素材包：锥体直接跟着走，玩法读数照常
        entry.obj.position.set(u.x, this.groundY(u.x, u.z) + bodyH / 2, u.z);
      }
    }
    for (const [id, entry] of this.unitSprites) {
      if (alive.has(id)) continue;
      // 倒下的位置留几团烟 + 火星（用最后缓存的位置）
      this.fx.death(entry.x, entry.z, this.groundY(entry.x, entry.z) + 0.5);
      entry.dude?.dispose();
      entry.obj.removeFromParent();
      this.unitSprites.delete(id);
    }
  }

  private makeSprite(u: ArenaUnit): UnitSprite {
    // 没有素材包就退成一枚阵营色锥体：玩法照常，只是看不到像素小人
    if (!this.pack || !this.gallery) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.24, UNIT_HEIGHT, 6),
        new THREE.MeshStandardMaterial({ color: sideColor(u.side), flatShading: true, roughness: 0.7 }),
      );
      cone.position.set(u.x, this.groundY(u.x, u.z) + UNIT_HEIGHT / 2, u.z);
      this.scene.add(cone);
      return { obj: cone, dude: null, pushers: [], siege: false, face: 0, x: u.x, z: u.z, cooldown: u.cooldown, attackLeft: 0, runHold: 0, dustIn: 0 };
    }
    if (statsOf(u.defId).siege) return u.defId === 'ballista' ? this.makeBallista(u) : this.makeSiege(u);
    const def = unitDef(u.defId);
    const style = this.styleOf(u.side, def.id, def);
    const { atlas, texture } = this.gallery.acquire(style, def.anims);
    const bodyH = def.heightTiles ?? UNIT_HEIGHT;
    const dude = new DudeSprite(this.pack, atlas, texture, { ...DEFAULT_APPEARANCE, height: bodyH });
    dude.mesh.position.y = this.groundY(u.x, u.z) + bodyH / 2;
    this.scene.add(dude.mesh);
    return { obj: dude.mesh, dude, pushers: [], siege: false, face: 0, x: u.x, z: u.z, cooldown: u.cooldown, attackLeft: 0, runHold: 0, dustIn: 0 };
  }

  /**
   * 移动火炮：一辆木车 + 车上那门 3D 炮 + 车尾两个推车的小人。
   * 两个小人用素材包里的普通杂役（`worker`），脚步跟着"有没有在动"切 run/idle。
   */
  private makeSiege(u: ArenaUnit): UnitSprite {
    const group = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4526, flatShading: true, roughness: 0.9 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x3b4250, flatShading: true, roughness: 0.55, metalness: 0.35 });

    // 第三次放大（用户 2026-10-27："移动火炮好小呀，可以稍微大一点；后面推的两个小人也小"）。
    // 车架整体 ~1.25 倍；推车小人 1.6 格（比普通兵略高一点，推车才看得见）
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.2, 1.0), wood);
    bed.position.y = 0.52;
    bed.castShadow = true;
    group.add(bed);
    for (const sx of [-0.5, 0.5]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.14, 10), iron);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(sx, 0.32, 0);
      wheel.castShadow = true;
      group.add(wheel);
    }
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.1, 8), iron);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.set(0.15, 0.86, 0);
    barrel.castShadow = true;
    const muzzleRing = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 8), iron);
    muzzleRing.rotation.z = -Math.PI / 2;
    muzzleRing.position.set(0.72, 0.86, 0);
    muzzleRing.castShadow = true;
    const breech = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.36, 0.42), iron);
    breech.position.set(-0.5, 0.84, 0);
    group.add(barrel, muzzleRing, breech);
    // 阵营色小旗插在车尾：一眼分敌我
    const mark = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.26, 0.1),
      new THREE.MeshStandardMaterial({
        color: sideColor(u.side),
        emissive: sideColor(u.side),
        emissiveIntensity: 0.5,
        flatShading: true,
      }),
    );
    mark.position.set(-0.82, 1.0, 0);
    group.add(mark);

    // 两个推车的小人：站在车尾两侧
    const pushers: DudeSprite[] = [];
    const pusherDef = unitDef('worker');
    const style = this.styleOf(u.side, pusherDef.id, pusherDef);
    const { atlas, texture } = this.gallery!.acquire(style, pusherDef.anims);
    for (const dz of [-0.44, 0.44]) {
      const dude = new DudeSprite(this.pack!, atlas, texture, { ...DEFAULT_APPEARANCE, height: 1.6 });
      dude.mesh.position.set(-1.24, 0.8, dz);
      group.add(dude.mesh);
      pushers.push(dude);
    }

    group.position.set(u.x, this.groundY(u.x, u.z), u.z);
    this.scene.add(group);
    return {
      obj: group,
      dude: null,
      pushers,
      siege: true,
      face: u.side === 'blue' ? 0 : Math.PI,
      x: u.x,
      z: u.z,
      cooldown: u.cooldown,
      attackLeft: 0,
      runHold: 0,
      dustIn: 0,
    };
  }

  /**
   * 移动弩箭：一辆轻车 + 一张横着的大弩 + 一个推车的人。
   * 剪影要和移动火炮分开：火炮是粗管子朝前，弩是**两片斜着的弩臂 + 一根细弩箭**。
   */
  private makeBallista(u: ArenaUnit): UnitSprite {
    const group = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4526, flatShading: true, roughness: 0.9 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x3b4250, flatShading: true, roughness: 0.55, metalness: 0.35 });
    const cord = new THREE.MeshStandardMaterial({ color: 0xd9cbb0, flatShading: true, roughness: 0.8 });

    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.16, 0.7), wood);
    bed.position.y = 0.4;
    bed.castShadow = true;
    group.add(bed);
    for (const sx of [-0.36, 0.36]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.12, 10), iron);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(sx, 0.24, 0);
      wheel.castShadow = true;
      group.add(wheel);
    }
    // 弩身（沿 +x 指向前方）
    const stock = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 0.13), wood);
    stock.position.set(0.1, 0.64, 0);
    stock.castShadow = true;
    group.add(stock);
    // 两片弩臂：从弩头往两侧斜后方张开
    for (const sz of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.07), wood);
      arm.position.set(0.32, 0.66, sz * 0.24);
      arm.rotation.y = sz * 0.7;
      arm.castShadow = true;
      group.add(arm);
    }
    // 弦 + 待发的弩箭
    const string = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.62), cord);
    string.position.set(0.05, 0.66, 0);
    const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.03, 0.03), iron);
    bolt.position.set(0.3, 0.7, 0);
    group.add(string, bolt);
    // 阵营色小旗
    const mark = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.26, 0.1),
      new THREE.MeshStandardMaterial({
        color: sideColor(u.side),
        emissive: sideColor(u.side),
        emissiveIntensity: 0.5,
        flatShading: true,
      }),
    );
    mark.position.set(-0.55, 0.78, 0);
    group.add(mark);

    // 一个推车的人（弩车比火炮轻）
    const pushers: DudeSprite[] = [];
    const pusherDef = unitDef('worker');
    const style = this.styleOf(u.side, pusherDef.id, pusherDef);
    const { atlas, texture } = this.gallery!.acquire(style, pusherDef.anims);
    const dude = new DudeSprite(this.pack!, atlas, texture, { ...DEFAULT_APPEARANCE, height: 1.5 });
    dude.mesh.position.set(-0.92, 0.75, 0);
    group.add(dude.mesh);
    pushers.push(dude);

    group.position.set(u.x, this.groundY(u.x, u.z), u.z);
    this.scene.add(group);
    return {
      obj: group,
      dude: null,
      pushers,
      siege: true,
      face: u.side === 'blue' ? 0 : Math.PI,
      x: u.x,
      z: u.z,
      cooldown: u.cooldown,
      attackLeft: 0,
      runHold: 0,
      dustIn: 0,
    };
  }

  /** 当前视口的"整幅场地入画"缩放（调试面板用它换算 zoom 倍率）。 */
  get fitZoomNow(): number {
    return this.fitZoom;
  }

  /** 调试面板/机位码用它一次把相机摆到位。 */
  setCameraShot(shot: { yaw: number; pitch: number; zoom: number }): void {
    this.director.userTouched();
    this.rig.zoom = this.fitZoom * shot.zoom;
    this.rig.setPitch(shot.pitch);
    const delta = ((((shot.yaw - this.rig.yaw + 180) % 360) + 360) % 360) - 180;
    this.rig.rotateBy(delta);
  }

  /** 这一点脚下的地表高度（草地 0.5）。所有贴地的件都读它，别各写各的。 */
  private groundY(x: number, z: number): number {
    return this.map.surfaceY(worldToCell(x, z));
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
    // 机器巨人换成灰铁色：别的兵种靠阵营色，它靠"一看就是铁疙瘩"
    if (unitId === 'mech') {
      // 机壳、装甲、蓝眼：连"皮肤"一起换，不然还是一个穿了铁甲的橘色小人
      style.hex.body = '#bfb8b4';
      style.hex.suit = '#918d8d';
      style.hex.eyes = '#74e0ff';
      style.hex.item = '#604b3d';
      style.hex.more = '#918d8d';
    }
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

  /** 会动的零件：风车一直转；炮塔头朝目标；刚开火的塔口闪一下。 */
  private syncParts(time: number): void {
    for (const [id, part] of this.parts) {
      const b = this.world.buildings.get(id);
      if (!b) continue;
      for (const sail of part.sails ?? []) sail.group.rotation.z = -time * sail.speed;
      if (part.turret) {
        // 炮口常驻对准 aim：aim 平时就是"冲着对面"的默认值，只有开火时才被改成目标方向。
        // 所以它不会自己到处扫视（用户说过"不是全自动转向"），但一眼就能看出朝哪边。
        const want = -b.aim;
        const cur = part.turret.rotation.y;
        const delta = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        if (Math.abs(delta) > 0.002) part.turret.rotation.y = cur + delta * Math.min(1, 0.25);
      }
      part.banner?.update(time);
    }
    void time;
  }

  /**
   * 在飞的弹丸：从**炮口高度**出发（箭塔顶 / 炮塔台 / 移动火炮车头），命中时炸一团烟。
   * 途中不再是平着贴地飞：起点高、落点低，炮弹再加一点抛物线。
   */
  private syncShots(time: number): void {
    const live = new Set<number>();
    for (const s of this.world.shots) {
      live.add(s.id);
      let mesh = this.shotMeshes.get(s.id);
      if (!mesh) {
        mesh =
          s.ammo === 'cannon'
            ? makeBall(0.16)
            : s.ammo === 'magic'
              ? makeBall(0.11, 0x74e0ff, 0x74e0ff)
              : makeArrow();
        this.scene.add(mesh);
        this.shotMeshes.set(s.id, mesh);
        const ground = this.map.surfaceY(worldToCell(s.fromX, s.fromZ));
        const fromY = ground + MUZZLE_Y[s.source];
        const targetGround = this.map.surfaceY(worldToCell(s.toX, s.toZ));
        mesh.userData['fromY'] = fromY;
        mesh.userData['toY'] = targetGround + 0.7;
        mesh.userData['hit'] = { x: s.toX, z: s.toZ, ground: targetGround, ammo: s.ammo };
        // 开火那一下：火光 + 烟（BattleFx 和老模式同一套）。
        // 炮塔的炮管有 1.9 格长、还会转，所以顺着开火方向把烟挪到**炮口**，别落在塔心
        const dx = s.toX - s.fromX;
        const dz = s.toZ - s.fromZ;
        const len = Math.hypot(dx, dz) || 1;
        const ux = dx / len;
        const uz = dz / len;
        const ahead =
          s.source === 'cannonTower'
            ? 1.0
            : s.source === 'siege'
              ? 0.55
              : s.source === 'ballista'
                ? 0.5
                : s.source === 'unit'
                  ? 0.15
                  : 0;
        this.fx.muzzle(s.fromX + ux * ahead, s.fromZ + uz * ahead, fromY, s.ammo, ux, uz);
      }
      const k = s.t;
      const x = s.fromX + (s.toX - s.fromX) * k;
      const z = s.fromZ + (s.toZ - s.fromZ) * k;
      const fromY = mesh.userData['fromY'] as number;
      const toY = mesh.userData['toY'] as number;
      // 抛物线：炮弹飞得高一点，法术弹居中，箭基本走直线
      const arc = Math.sin(k * Math.PI) * (s.ammo === 'cannon' ? 0.9 : s.ammo === 'magic' ? 0.35 : 0.12);
      mesh.position.set(x, fromY + (toY - fromY) * k + arc, z);
      if (s.ammo === 'arrow') {
        // 箭头模型沿 +Z 造：转到"从哪来 → 往哪去"
        mesh.rotation.y = Math.atan2(s.toX - s.fromX, s.toZ - s.fromZ);
        mesh.scale.setScalar(s.source === 'ballista' ? 2.2 : 1.6);
      } else {
        mesh.rotation.y = -Math.atan2(s.toZ - s.fromZ, s.toX - s.fromX);
        mesh.scale.setScalar(1);
      }
    }
    for (const [id, mesh] of this.shotMeshes) {
      if (live.has(id)) continue;
      const hit = mesh.userData['hit'] as
        | { x: number; z: number; ground: number; ammo: 'arrow' | 'cannon' | 'magic' }
        | undefined;
      if (hit) {
        this.fx.impact(hit.x, hit.z, hit.ground, hit.ammo, hit.ammo === 'cannon' ? 1.3 : 0);
        // 炮弹落地再溅一把火星（烟之外的第二层）
        if (hit.ammo === 'cannon') this.fx.spark(hit.x, hit.z, hit.ground + 0.4, 0, 1, 8);
      }
      this.scene.remove(mesh);
      // 箭的几何体/材质是全场共用的（ARROW_GEO/ARROW_MAT），不能 dispose；
      // 炮弹和法术弹是每次新建的，要释放。
      if (hit?.ammo !== 'arrow') {
        mesh.traverse((o) => {
          const part = o as THREE.Mesh;
          if (part.geometry) part.geometry.dispose();
        });
      }
      this.shotMeshes.delete(id);
    }
    void time;
  }

  /** 牧师回血：世界只报"谁在哪回了血"，这里放一圈绿环。 */
  private syncHeals(): void {
    const live = new Set<number>();
    for (const h of this.world.heals) {
      live.add(h.id);
      if (this.seenHeals.has(h.id)) continue;
      this.seenHeals.add(h.id);
      const y = this.map.surfaceY(worldToCell(h.x, h.z)) + 0.9;
      this.fx.healPulse(h.x, h.z, y);
    }
    for (const id of this.seenHeals) if (!live.has(id)) this.seenHeals.delete(id);
  }

  /** 废墟：被拆掉的楼在原地留一堆碎石，RUIN.seconds 之后自己塌平（最后几秒淡出）。 */
  private syncRuins(): void {
    const live = new Set<number>();
    for (const r of this.world.ruins) {
      live.add(r.id);
      let group = this.ruinMeshes.get(r.id);
      if (!group) {
        // 种子取楼号 + 阵营：同一栋楼拆两次长得一样，不同楼一定不一样
        const seed = r.id * 7919 + (r.side === 'blue' ? 11 : 29);
        group = makeRuin(r.cols, r.rows, seed, ruinStyleOf(r.kind));
        const center = cellToWorld(pos(r.col + r.cols / 2 - 0.5, r.row + r.rows / 2 - 0.5));
        group.position.set(center.x, this.groundY(center.x, center.z), center.z);
        group.userData['age'] = 0;
        this.scene.add(group);
        this.ruinMeshes.set(r.id, group);
      }
      // 炸开动画：按"已经活了多久"推进（ruin.total 减去剩余）
      group.userData['age'] = (group.userData['age'] as number) + 1 / 60;
      settleRuin(group, group.userData['age'] as number);
      const fade = r.ttl < RUIN.fadeSeconds ? Math.max(0, r.ttl / RUIN.fadeSeconds) : 1;
      group.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && 'opacity' in m) m.opacity = fade;
      });
    }
    for (const [id, group] of this.ruinMeshes) {
      if (live.has(id)) continue;
      this.scene.remove(group);
      this.ruinMeshes.delete(id);
    }
  }

  /** 场地中心（导演的"回中"目标）。 */
  private fieldCenter(): { x: number; z: number } {
    return { x: FIELD.cols / 2, z: FIELD.rows / 2 };
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
  return b.kind === 'core'
    ? '核心'
    : b.kind === 'barracks'
      ? '兵营'
      : b.kind === 'mill'
        ? '磨坊'
        : b.kind === 'house'
          ? '民居'
          : '防御塔';
}

function makeHpBar(frac: number, color: number, width = 1.6): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(width, 0.2);
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

/** 兵营缺后勤时头顶的提示牌（缺磨坊/民居）。 */
function makeNeedLabel(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(28,20,14,0.88)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = '#c8a24c';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 252, 60);
    ctx.fillStyle = '#f0d08a';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('缺 磨坊 + 民居', 128, 34);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(2.6, 0.65, 1);
  sprite.visible = false;
  return sprite;
}

/** 炮口离地高度（格）：和模型对得上（×BUILDING_SCALE 之后的塔顶 / 台面 / 车头）。 */
const MUZZLE_Y = { arrowTower: 5.6, cannonTower: 2.55, siege: 0.95, ballista: 1.15, unit: 1.1 } as const;

/**
 * 一支箭：杆 + 三角箭头 + 两片尾羽，沿 +Z 指向前方。
 * 几何体和材质**全场共用**：射手一多，每帧都在造箭，逐个 dispose 会反复重建几何体。
 */
const ARROW_GEO = {
  shaft: new THREE.BoxGeometry(0.035, 0.035, 0.5),
  head: new THREE.ConeGeometry(0.06, 0.14, 4),
  tail: new THREE.BoxGeometry(0.12, 0.02, 0.14),
};
const ARROW_MAT = {
  wood: new THREE.MeshStandardMaterial({ color: 0x8a5f2c, flatShading: true, roughness: 0.9 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xd9d9e3, flatShading: true, roughness: 0.4 }),
  fletch: new THREE.MeshStandardMaterial({ color: 0xe6d8b4, flatShading: true, roughness: 0.9 }),
};

function makeArrow(): THREE.Group {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(ARROW_GEO.shaft, ARROW_MAT.wood);
  const head = new THREE.Mesh(ARROW_GEO.head, ARROW_MAT.steel);
  head.rotation.x = Math.PI / 2;
  head.position.z = 0.31;
  const tail = new THREE.Mesh(ARROW_GEO.tail, ARROW_MAT.fletch);
  tail.position.z = -0.22;
  group.add(shaft, head, tail);
  return group;
}

function makeBall(radius: number, color = 0x1a1d24, emissive = 0x000000): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 6, 4),
    new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity: emissive ? 1.4 : 0,
      flatShading: true,
      roughness: 0.6,
    }),
  );
  mesh.castShadow = emissive === 0;
  return mesh;
}

/**
 * 废墟：用 `fracture()` 把这栋楼的占地**递归切碎**，每块按来源（屋瓦/墙体/木梁）
 * 换颜色、随机转向与高度。结果是 (楼号) 决定的 —— 同一堆废墟刷新前后长得一样，
 * 不同楼一定不一样（用户 2026-10-27："废墟长得不一样啊随机"）。
 *
 * 传进来的 group 里每块都带出始速度的方向，`settle()` 用前 0.5 秒把它从中心炸开再落定。
 */
function makeRuin(cols: number, rows: number, seed: number, style: 'core' | 'tower' | 'wood' | 'stone'): THREE.Group {
  const group = new THREE.Group();
  const parts = fracture(cols, rows, seed, 9);
  const palette = {
    roof: 0x7a3a30,
    wall: 0x8a8175,
    wood: 0x5a4326,
  } as const;
  const tintBase = style === 'core' ? 0x8a7a55 : style === 'wood' ? 0x6b5638 : 0x807a70;

  parts.forEach((p, i) => {
    const base = p.part === 'roof' ? palette.roof : p.part === 'wall' ? palette.wall : palette.wood;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(base).lerp(new THREE.Color(tintBase), 0.25).multiplyScalar(0.6 + p.tone * 0.6).getHex(),
      roughness: 0.98,
      flatShading: true,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), mat);
    mesh.rotation.y = p.spin;
    mesh.castShadow = true;
    mesh.userData['home'] = { x: p.x, z: p.z, y: p.h / 2 };
    mesh.userData['burst'] = { x: p.x * 0.45, z: p.z * 0.45, i };
    group.add(mesh);
  });

  group.userData['age'] = 0;
  return group;
}

/** 前 0.5 秒：从中心炸开、抬高，然后落到地面。之后不再动。 */
function settleRuin(group: THREE.Group, age: number): void {
  const k = Math.min(1, age / 0.5);
  const ease = 1 - (1 - k) * (1 - k);
  for (const child of group.children) {
    const home = child.userData['home'] as { x: number; z: number; y: number } | undefined;
    const burst = child.userData['burst'] as { x: number; z: number; i: number } | undefined;
    if (!home || !burst) continue;
    child.position.set(home.x + burst.x * (1 - ease), home.y + (1 - ease) * (0.7 + (burst.i % 3) * 0.2), home.z + burst.z * (1 - ease));
  }
}

/** 建筑种类 → 废墟的颜色族。 */
function ruinStyleOf(kind: string): 'core' | 'tower' | 'wood' | 'stone' {
  if (kind === 'core') return 'core';
  if (kind === 'arrowTower' || kind === 'cannonTower') return 'tower';
  if (kind === 'mill' || kind === 'barracks' || kind === 'house') return 'wood';
  return 'stone';
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
