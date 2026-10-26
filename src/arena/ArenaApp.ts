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
import { DEFAULT_APPEARANCE, DudeGallery, DudeSprite } from '@game/dudes/DudeView';
import { loadPack, type DudePack } from '@game/dudes/pack';
import { faceCandidates, headCandidates, isBlue } from '@game/dudes/roster';
import { randomStyle, type DudeStyle } from '@game/dudes/style';
import { unitDef } from '@game/data/units';
import { ModelLibrary } from '@game/models/registry';
import { GroundView } from '@game/world/GroundView';
import { TileMap } from '@game/world/TileMap';
import { ArenaWorld, statsOf, type ArenaBuilding, type ArenaUnit, type Side } from './ArenaWorld';
import { ArenaDirector } from './Camera';
import { ARENA_CAMERA, BUILDING_SCALE, FIELD, NO_BUILD, RUIN, UNIT_HEIGHT } from './config';
import { makeBanner, shade, bannerSpot, type Banner } from './props';
import { CARD_MODEL, sideColor } from './theme';

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
  /** 会动的零件：磨坊的风车、炮塔的头、塔口的火光 */
  private readonly ruinMeshes = new Map<number, THREE.Group>();
  private readonly parts = new Map<
    number,
    { sails?: THREE.Object3D; turret?: THREE.Object3D; flash?: THREE.Sprite; banner?: Banner }
  >();
  /** 在飞的弹丸（视觉件，按 world.shots 同步） */
  private readonly shotMeshes = new Map<number, THREE.Mesh>();
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

    // 中场黄区：一条**有宽度**的禁建带（3 列），不是一根线。
    // 抬 0.02 是为了不和地皮共面打架（z-fighting 会闪成锯齿）。
    const bandW = NO_BUILD.halfWidth * 2 + 1;
    const divider = new THREE.Mesh(
      new THREE.PlaneGeometry(bandW, this.map.size.rows),
      new THREE.MeshStandardMaterial({
        color: 0xd8b45c,
        emissive: 0xa9762c,
        emissiveIntensity: 0.22,
        roughness: 0.8,
        transparent: true,
        opacity: 0.62,
      }),
    );
    divider.rotation.x = -Math.PI / 2;
    divider.position.set(FIELD.midCol + 0.0, 0.52, this.map.size.rows / 2);
    // 两条边线：黄区两侧各一道亮边，边界一眼看得准
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
    this.scene.add(apron, divider, edgeL, edgeR, this.ground.group);
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
    this.syncShots(info.time);
    this.syncRuins();
    this.syncParts(info.time);
    this.director.update(info.delta, this.rig, this.fitZoom, this.fieldCenter());
    this.renderer.render(this.scene, this.rig.camera);
  }

  /** 建筑：新增/删掉都在这补齐；核心头顶挂一颗蓝/红水晶。 */
  private syncBuildings(): void {
    for (const b of this.world.buildings.values()) {
      if (this.buildingMeshes.has(b.id)) continue;
      // 磨坊与炮塔用自己的件：模型库里的那两件是静态合并的，帆和炮管转不起来
      const custom =
        b.kind === 'core'
          ? makeCore(b.side)
          : b.kind === 'mill'
            ? makeMill(b.side)
            : b.kind === 'cannonTower'
              ? makeCannon(b.side)
              : null;
      // 核心/磨坊/炮塔是自建件；剩下会走到这里的只有兵营和箭塔
      const group = custom
        ? custom.group
        : this.library.create(b.kind === 'barracks' ? CARD_MODEL.barracks : CARD_MODEL.arrowTower);
      if (custom) this.parts.set(b.id, { sails: custom.sails, turret: custom.turret });
      if (b.kind === 'arrowTower' || b.kind === 'cannonTower') {
        const flash = makeFlashSprite();
        flash.position.y = b.kind === 'arrowTower' ? 1.6 : 1.05;
        group.add(flash);
        this.parts.set(b.id, { ...(this.parts.get(b.id) ?? {}), flash });
      }
      const center = cellToWorld(pos(b.col + b.cols / 2 - 0.5, b.row + b.rows / 2 - 0.5));
      // 模型说明书写的是"局部原点在占地中心、底面 y=0"，所以要抬到**地块表面**，
      // 不能放在 y=0 —— 草地表面在 0.5，放 0 就是整栋楼埋掉半截。
      group.position.set(center.x, this.map.footprintSurfaceY(pos(b.col, b.row), b.cols, b.rows), center.z);
      this.scene.add(group);
      group.scale.setScalar(BUILDING_SCALE);
      // 血条要挂在**抵消缩放**的子组里：直接挂在 group 上会跟着放大 1.75 倍，
      // 位置被抬到半空、宽度也变成 4.5 格（截图里就是那两条悬空的横线）。
      const ui = new THREE.Group();
      ui.scale.setScalar(1 / BUILDING_SCALE);
      group.add(ui);
      // 旗：放进反向缩放的 ui 组，所以尺寸直接用"格"。
      // 石台整个拿掉了（用户：不要那个地基，在地皮上变颜色丑死了）——
      // 现在阵营色只出现在"建筑自己的零件"上：炮塔四角、磨坊顶盖、旗面。
      const spot = bannerSpot(b.kind, b.cols, b.rows);
      const banner = makeBanner(b.side, spot.pole);
      // 插在**屋顶上**（base 是屋顶高度），不再挂墙 —— 挂墙那份会穿进模型里
      banner.group.position.set(spot.x, spot.base, spot.z);
      ui.add(banner.group);
      this.parts.set(b.id, { ...(this.parts.get(b.id) ?? {}), banner });
      const bar = makeHpBar(b.hp / b.maxHp, sideColor(b.side), 2.6);
      bar.position.y = barHeightOf(b.kind);
      ui.add(bar);
      group.userData['hpBar'] = bar;
      const cracks = makeCracks(group);
      group.userData['cracks'] = cracks;
      for (const crack of cracks) crack.visible = false;

      // 核心的水晶是**模型自带的**（嵌在屋顶里、按阵营上色），不再往头顶飘一颗。
      // 用户 2026-10-27："整个建筑的模型本身里面就嵌了一个水晶，为什么还要再画一个水晶"。
      this.buildingMeshes.set(b.id, group);
      group.userData['side'] = b.side;
    }
    for (const [id, group] of this.buildingMeshes) {
      const b = this.world.buildings.get(id);
      if (b) {
        const frac = b.hp / b.maxHp;
        const bar = group.userData['hpBar'] as THREE.Mesh | undefined;
        if (bar) {
          // 满血不挂条；掉血才出现，这样一眼能看出哪栋在挨打
          bar.visible = frac < 0.999;
          updateHpBar(bar, frac);
        }
        const cracks = group.userData['cracks'] as THREE.Mesh[] | undefined;
        if (cracks) {
          cracks[0]!.visible = frac <= 0.66;
          cracks[1]!.visible = frac <= 0.4;
          cracks[2]!.visible = frac <= 0.2;
        }
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

      if (entry.siege) {
        // 车头朝着"这一步往哪走"；停下来就保持最后朝向
        if (moved > 0.004) entry.face = -Math.atan2(u.z - entry.z, u.x - entry.x);
        entry.obj.position.set(u.x, this.groundY(u.x, u.z), u.z);
        entry.obj.rotation.y = entry.face;
        for (const p of entry.pushers) {
          p.faceCamera(this.rig.yaw);
          p.play(moved > 0.004 ? 'run' : 'idle', time);
        }
        continue;
      }
      const def = unitDef(u.defId);
      const anim = entry.attackLeft > 0 ? def.attackAnim : moved > 0.004 ? 'run' : def.idleAnim;
      if (entry.dude) {
        entry.dude.moveTo(u.x, u.z);
        // 脚必须踩在**地块表面**上：草地表面在 y=0.5，而 DudeSprite 自带的身高偏移是从 y=0 起算的。
        // 老模式的 UnitView 一直有这一句，我这一版漏了 —— 表现就是整个小人埋掉半个身子。
        entry.obj.position.y = this.groundY(u.x, u.z) + UNIT_HEIGHT / 2;
        entry.dude.faceCamera(this.rig.yaw);
        entry.dude.play(anim, time);
      } else {
        // 没有素材包：锥体直接跟着走，玩法读数照常
        entry.obj.position.set(u.x, this.groundY(u.x, u.z) + UNIT_HEIGHT / 2, u.z);
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
        new THREE.ConeGeometry(0.24, UNIT_HEIGHT, 6),
        new THREE.MeshStandardMaterial({ color: sideColor(u.side), flatShading: true, roughness: 0.7 }),
      );
      cone.position.set(u.x, this.groundY(u.x, u.z) + UNIT_HEIGHT / 2, u.z);
      this.scene.add(cone);
      return { obj: cone, dude: null, pushers: [], siege: false, face: 0, x: u.x, z: u.z, cooldown: u.cooldown, attackLeft: 0 };
    }
    if (statsOf(u.defId).siege) return this.makeSiege(u);
    const def = unitDef(u.defId);
    const style = this.styleOf(u.side, def.id, def);
    const { atlas, texture } = this.gallery.acquire(style, def.anims);
    const dude = new DudeSprite(this.pack, atlas, texture, { ...DEFAULT_APPEARANCE, height: UNIT_HEIGHT });
    dude.mesh.position.y = this.groundY(u.x, u.z) + UNIT_HEIGHT / 2;
    this.scene.add(dude.mesh);
    return { obj: dude.mesh, dude, pushers: [], siege: false, face: 0, x: u.x, z: u.z, cooldown: u.cooldown, attackLeft: 0 };
  }

  /**
   * 移动火炮：一辆木车 + 车上那门 3D 炮 + 车尾两个推车的小人。
   * 两个小人用素材包里的普通杂役（`worker`），脚步跟着"有没有在动"切 run/idle。
   */
  private makeSiege(u: ArenaUnit): UnitSprite {
    const group = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4526, flatShading: true, roughness: 0.9 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x3b4250, flatShading: true, roughness: 0.55, metalness: 0.35 });

    const bed = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.14, 0.62), wood);
    bed.position.y = 0.34;
    bed.castShadow = true;
    group.add(bed);
    for (const sx of [-0.3, 0.3]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 10), iron);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(sx, 0.2, 0);
      wheel.castShadow = true;
      group.add(wheel);
    }
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.7, 8), iron);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.set(0.12, 0.52, 0);
    barrel.castShadow = true;
    const breech = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.24), iron);
    breech.position.set(-0.24, 0.5, 0);
    group.add(barrel, breech);
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
    mark.position.set(-0.42, 0.56, 0);
    group.add(mark);

    // 两个推车的小人：站在车尾两侧
    const pushers: DudeSprite[] = [];
    const pusherDef = unitDef('worker');
    const style = this.styleOf(u.side, pusherDef.id, pusherDef);
    const { atlas, texture } = this.gallery!.acquire(style, pusherDef.anims);
    for (const dz of [-0.26, 0.26]) {
      const dude = new DudeSprite(this.pack!, atlas, texture, { ...DEFAULT_APPEARANCE, height: UNIT_HEIGHT * 0.85 });
      dude.mesh.position.set(-0.62, UNIT_HEIGHT * 0.85 * 0.5, dz);
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
      if (part.sails) part.sails.rotation.z = -time * 1.7;
      if (part.turret) {
        // 炮口常驻对准 aim：aim 平时就是"冲着对面"的默认值，只有开火时才被改成目标方向。
        // 所以它不会自己到处扫视（用户说过"不是全自动转向"），但一眼就能看出朝哪边。
        const want = -b.aim;
        const cur = part.turret.rotation.y;
        const delta = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        if (Math.abs(delta) > 0.002) part.turret.rotation.y = cur + delta * Math.min(1, 0.25);
      }
      if (part.flash) part.flash.visible = b.shotsMuzzle > 0;
      part.banner?.update(time);
    }
    void time;
  }

  /** 在飞的弹丸：箭头是细长条，炮弹是小黑球，都朝目标摆正。 */
  private syncShots(time: number): void {
    const live = new Set<number>();
    for (const s of this.world.shots) {
      live.add(s.id);
      let mesh = this.shotMeshes.get(s.id);
      if (!mesh) {
        mesh = s.ammo === 'cannon' ? makeBall(0.16) : makeBall(0.09);
        this.scene.add(mesh);
        this.shotMeshes.set(s.id, mesh);
      }
      const k = s.t;
      const x = s.fromX + (s.toX - s.fromX) * k;
      const z = s.fromZ + (s.toZ - s.fromZ) * k;
      // 抛物线：炮弹飞得高一点，箭基本贴平
      const arc = s.ammo === 'cannon' ? Math.sin(k * Math.PI) * 0.9 : Math.sin(k * Math.PI) * 0.12;
      mesh.position.set(x, this.map.surfaceY(worldToCell(x, z)) + 1.05 + arc, z);
      mesh.rotation.y = -Math.atan2(s.toZ - s.fromZ, s.toX - s.fromX);
      mesh.scale.setScalar(s.ammo === 'cannon' ? 1 : 1.6);
    }
    for (const [id, mesh] of this.shotMeshes) {
      if (live.has(id)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.shotMeshes.delete(id);
    }
    void time;
  }

  /** 废墟：被拆掉的楼在原地留一堆碎石，RUIN.seconds 之后自己塌平（最后几秒淡出）。 */
  private syncRuins(): void {
    const live = new Set<number>();
    for (const r of this.world.ruins) {
      live.add(r.id);
      let group = this.ruinMeshes.get(r.id);
      if (!group) {
        group = makeRuin(r.cols, r.rows);
        const center = cellToWorld(pos(r.col + r.cols / 2 - 0.5, r.row + r.rows / 2 - 0.5));
        group.position.set(center.x, this.groundY(center.x, center.z), center.z);
        this.scene.add(group);
        this.ruinMeshes.set(r.id, group);
      }
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
  return b.kind === 'core' ? '核心' : b.kind === 'barracks' ? '兵营' : b.kind === 'mill' ? '磨坊' : '防御塔';
}

/** 血条挂多高：按建筑种类给，别让条埋进屋顶里。 */
function barHeightOf(kind: string): number {
  if (kind === 'core') return 3.9;
  if (kind === 'mill') return 2.5;
  if (kind === 'arrowTower') return 2.4;
  if (kind === 'cannonTower') return 1.9;
  return 2.2; // 兵营
}

/**
 * 破损：三道随机角度的深色裂纹，血越少露得越多。
 * 不用"给模型换材质变暗"那条路 —— 模型库的材质是共享缓存的，改一处会把全场都改暗。
 */
function makeCracks(parent: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const mat = new THREE.MeshBasicMaterial({ color: 0x1a1410, transparent: true, opacity: 0.85 });
  const spots: { x: number; y: number; z: number; rot: number; w: number }[] = [
    { x: -0.22, y: 0.62, z: 0.36, rot: 0.55, w: 0.26 },
    { x: 0.2, y: 0.9, z: 0.34, rot: -0.85, w: 0.34 },
    { x: -0.02, y: 1.12, z: 0.32, rot: 1.25, w: 0.22 },
  ];
  for (const s of spots) {
    const crack = new THREE.Mesh(new THREE.PlaneGeometry(s.w, 0.05), mat);
    crack.position.set(s.x, s.y, s.z);
    crack.rotation.z = s.rot;
    parent.add(crack);
    out.push(crack);
  }
  return out;
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

/**
 * 磨坊（会转的）：石塔 + 锥顶 + 四片帆。帆单独成组，绕 z 轴转。
 * 这里不走模型库 —— 库里那件是静态合并的，帆转不了（用户点名要风车转）。
 */
function makeMill(side: Side): { group: THREE.Group; sails?: THREE.Object3D; turret?: THREE.Object3D } {
  const group = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xd9cbb0, flatShading: true, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x5f6472, flatShading: true, roughness: 0.9 });
  const wood = new THREE.MeshStandardMaterial({ color: 0xa9762c, flatShading: true, roughness: 0.85 });

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.62, 1.25, 8), stone);
  base.position.y = 0.625;
  base.castShadow = true;
  // 顶盖按阵营上色（用户：风车顶盖上的颜色应该不同），中间再压一圈亮边
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(0.6, 0.5, 8),
    new THREE.MeshStandardMaterial({ color: shade(sideColor(side), 0.9), flatShading: true, roughness: 0.85 }),
  );
  roof.position.y = 1.5;
  roof.castShadow = true;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.3, 6), dark);
  hub.rotation.x = Math.PI / 2;
  hub.position.set(0, 1.45, 0.5);

  const sails = new THREE.Group();
  sails.position.set(0, 1.45, 0.62);
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.05, 0.05), wood);
    blade.position.y = 0.55;
    blade.castShadow = true;
    const arm = new THREE.Group();
    arm.rotation.z = (i * Math.PI) / 2;
    arm.add(blade);
    sails.add(arm);
  }
  group.add(base, roof, hub, sails);
  return { group, sails };
}

/**
 * 炮塔（会转的）：石座 + 可旋转的炮塔头 + 一根炮管。
 * 同样不用模型库那份静态件 —— 炮管必须跟着目标转。
 */
function makeCannon(side: Side): { group: THREE.Group; sails?: THREE.Object3D; turret?: THREE.Object3D } {
  const group = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x8e93a3, flatShading: true, roughness: 0.95 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x3b4250, flatShading: true, roughness: 0.55, metalness: 0.35 });

  const base = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.72, 0.86), stone);
  base.position.y = 0.36;
  base.castShadow = true;
  // 台面：阵营色（用户要求"模型上的台面上有颜色"，不是在地上贴一块）
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(0.96, 0.14, 0.96),
    new THREE.MeshStandardMaterial({ color: 0x5f6472, flatShading: true, roughness: 0.85 }),
  );
  deck.position.y = 0.79;

  // 四个**防撞角**：阵营色只落在这四个小方块上（用户："4 个角变颜色就行了"）。
  // 比给整个底座上色低调得多，但远远看过去仍然一眼能分出是谁的炮塔。
  const bumperMat = new THREE.MeshStandardMaterial({
    color: sideColor(side),
    emissive: sideColor(side),
    emissiveIntensity: 0.5,
    flatShading: true,
    roughness: 0.55,
  });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, 0.16), bumperMat);
      bumper.position.set(sx * 0.4, 0.86, sz * 0.4);
      bumper.castShadow = true;
      group.add(bumper);
    }
  }

  const turret = new THREE.Group();
  turret.position.y = 0.92;
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.34, 8), iron);
  head.castShadow = true;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.72, 8), iron);
  barrel.rotation.z = -Math.PI / 2; // 炮管朝 +x
  barrel.position.x = 0.42;
  barrel.castShadow = true;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.1, 8), stone);
  collar.rotation.z = -Math.PI / 2;
  collar.position.x = 0.74;
  turret.add(head, barrel, collar);

  group.add(base, deck, turret);
  return { group, turret };
}

/** 塔口火光：一张很小的贴图精灵，刚开火时亮 0.18 秒。 */
function makeFlashSprite(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#fff2c4';
    ctx.fillRect(6, 7, 4, 2);
    ctx.fillRect(7, 6, 2, 4);
    ctx.fillStyle = '#ffb545';
    ctx.fillRect(3, 7, 3, 2);
    ctx.fillRect(10, 7, 3, 2);
    ctx.fillRect(7, 2, 2, 4);
    ctx.fillRect(7, 10, 2, 4);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(0.7, 0.7, 1);
  sprite.visible = false;
  return sprite;
}

function makeBall(radius: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 6, 4),
    new THREE.MeshStandardMaterial({ color: 0x1a1d24, flatShading: true, roughness: 0.6 }),
  );
  mesh.castShadow = true;
  return mesh;
}

/** 废墟：几块歪斜的深色碎石 + 一根断梁，铺满原地块。 */
function makeRuin(cols: number, rows: number): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x4a443a,
    roughness: 0.98,
    flatShading: true,
    transparent: true,
    opacity: 1,
  });
  // 碎石比断梁更像"塌了"：四块大小不一的深石 + 一堆浅色碎渣 + 一根短梁
  const rubble: [number, number, number, number, number][] = [
    [0.75, 0.26, 0.6, 1.25, 0.12],
    [0.5, 0.36, 0.45, 4.1, -0.28],
    [0.38, 0.18, 0.34, 2.6, 0.34],
    [0.3, 0.14, 0.28, 5.4, -0.05],
  ];
  for (const [w, h, d, ang, dz] of rubble) {
    const block = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    block.position.set(Math.cos(ang) * cols * 0.18, h / 2, dz * rows * 0.2);
    block.rotation.y = ang;
    block.castShadow = true;
    group.add(block);
  }
  // 碎渣：一小堆浅色颗粒，压住"这是废墟"的读图
  const dust = new THREE.Mesh(
    new THREE.ConeGeometry(cols * 0.42, 0.16, 8),
    new THREE.MeshStandardMaterial({ color: 0x6b6255, roughness: 1, flatShading: true, transparent: true, opacity: 1 }),
  );
  dust.position.y = 0.08;
  group.add(dust);
  // 一根断梁，斜搭在碎堆上
  const beam = new THREE.Mesh(new THREE.BoxGeometry(cols * 0.5, 0.08, 0.12), mat);
  beam.position.set(-cols * 0.08, 0.22, rows * 0.16);
  beam.rotation.z = 0.22;
  group.add(beam);
  return group;
}

/**
 * 核心（主城）：基座 + 墙 + 四坡屋顶 + **嵌在屋顶里的水晶**（按阵营上色）。
 *
 * 为什么不用模型库里的 hall：那份模型的水晶是固定色的、材质还是全局缓存的，
 * 想按阵营染色会把场上所有实例一起改掉。自建一份最省事，也正好把"水晶是模型的一部分"落实了。
 */
function makeCore(side: Side): { group: THREE.Group; sails?: THREE.Object3D; turret?: THREE.Object3D } {
  const group = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x5f6472, flatShading: true, roughness: 0.95 });
  const wall = new THREE.MeshStandardMaterial({ color: 0xc9b795, flatShading: true, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xa8483c, flatShading: true, roughness: 0.9 });
  const tint = sideColor(side);

  const base = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.28, 2.3), stone);
  base.position.y = 0.14;
  base.receiveShadow = true;

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.85, 1.15, 1.85), wall);
  body.position.y = 0.86;
  body.castShadow = true;
  body.receiveShadow = true;

  // 一道深色墙裙 + 一扇门：不然从高处看，正面就是一整片浅色，像开了个洞
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.3, 1.92), stone);
  skirt.position.y = 0.44;
  skirt.receiveShadow = true;
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.62, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x6b4526, flatShading: true, roughness: 0.9 }),
  );
  door.position.set(0, 0.62, 0.94);
  group.add(skirt, door);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.28, 0.72, 4), roofMat);
  roof.position.y = 1.78;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;

  // 水晶：半嵌在屋顶顶端的凹槽里（不是飘在上面）
  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.42, 0),
    new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 0.95,
      roughness: 0.25,
      flatShading: true,
    }),
  );
  crystal.position.y = 2.2;
  crystal.scale.y = 1.35;
  crystal.castShadow = true;

  // 四角立柱，让"主城"看起来比兵营更厚重
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 1.5, 6), stone);
      post.position.set(sx * 0.95, 0.86, sz * 0.95);
      post.castShadow = true;
      group.add(post);
    }
  }

  group.add(base, body, roof, crystal);
  return { group };
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
