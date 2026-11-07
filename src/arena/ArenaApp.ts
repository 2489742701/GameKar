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
import { faceCandidates, headCandidates } from '@game/dudes/roster';
import { randomStyle, type DudeStyle } from '@game/dudes/style';
import { unitDef } from '@game/data/units';
import { BattleFx } from '@game/fx/BattleFx';
import { buildModel, spinnersOf, TURRET } from '@game/models/kit';
import { GroundView } from '@game/world/GroundView';
import { TileMap } from '@game/world/TileMap';
import { ArenaWorld, statsOf, type ArenaBuilding, type ArenaUnit, type PlayResult, type Side } from './ArenaWorld';
import { AmbientDust } from './ambient';
import { ArenaDirector, PVE_VIEW_PRESETS, type ViewPreset } from './Camera';
import { loadControls, panDelta, pitchDelta, rotateDelta, zoomDelta } from './controls';
import { AutoPilot, type AutoPilotState } from './autoPilot';
import { ARENA_CAMERA, BUILDING_SPECS, BUILDING_SCALE, NO_BUILD, RUIN, UNIT_HEIGHT } from './config';
import { DamageFx } from './damage';
import { ARENA_FLAGS, ARENA_MODELS, type ArenaModelName } from './models';
import { Confetti } from './visuals/confetti';
import { makeShadow } from './visuals/shadow';
import { FLYER_STYLE, flyerYaw, makeAirscrew, makeBalloon, makeBomber } from './visuals/flyers';
import { buildingSpinKey, spinOf } from './visuals/spin';
import { WallShell } from './shell';
import { makeBanner, type Banner } from './props';
import { sideBanner, sideColor } from './theme';
// 视觉小件按"职责"分在 visuals/ 下：都是给参数就出 Object3D 的纯函数，不碰 App 的状态
import { labelOf, makeFlag, makeHpBar, makeNeedLabel, needsStaffing, updateHpBar } from './visuals/labels';
import { makeRuin, ruinStyleOf, settleRuin } from './visuals/ruinView';
import { disposeTree, makeScaffold } from './visuals/scaffold';
import { MUZZLE_Y, makeArrow, makeBall } from './visuals/shots';
import { makeCoreBar, updateCoreBar, type CoreBar } from './visuals/coreBar';
import { Sfx } from '@audio/sfx';
import { buildStand, type ArenaStand } from './stand';

export interface ArenaAppOptions {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  seed?: number;
  /** 玩法模式（2026-11-07）：`pve` = 守波次，场地与判据都换一套；默认对战 */
  mode?: 'arena' | 'pve';
  /** PVE 关卡 id（不给就用第一关） */
  level?: string;
  /** PVE 玩家人数（1 或 2，两人都在 blue 一侧） */
  players?: number;
  dudesUrl?: string;
  /** UI 回调：金/血变了、出牌失败要说话 */
  onToast?: (text: string, tone?: 'ok' | 'warn') => void;
  onState?: () => void;
  /**
   * 长按**空地**要设置面板（2026-11-07 用户："游戏栏目不需要设置，右键可以"）。
   *
   * 为什么走回调而不是让 App 直接拿 HUD：App 是 three 那一层，不该认识设置面板；
   * 长按落在**建筑**上仍然是原来的"看血量"提示，只有落在空地才是叫设置。
   */
  onRequestSettings?: () => void;
  /** 托管状态变了（HUD 用来提示"已自动托管，点屏幕拿回控制权"） */
  onAutoPilot?: (state: AutoPilotState) => void;
}

interface Corpse {
  obj: THREE.Object3D;
  kind: 'corpse' | 'wreck';
  life: number;
  x: number;
  z: number;
  dude?: DudeSprite | null;
  /** 解体碎块（局部坐标里各自飞散） */
  pieces?: { mesh: THREE.Object3D; vx: number; vy: number; vz: number; spin: number }[];
  fireIn: number;
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
  /** 贴地黑影（2026-11-06 用户："给他们一个影子"）；siege 车的影子在 group 里跟着转 */
  shadow?: THREE.Mesh;
  /** 飞行单位：转子 / 翼 / 闪白材质（3D 模型，不用像素小人那套） */
  flying?: boolean;
  rotor?: THREE.Object3D;
  rotorAxis?: 'y' | 'z';
  wings?: THREE.Object3D[];
  flyMats?: { mat: THREE.MeshStandardMaterial; color: THREE.Color }[];
  /** 受击闪白剩余时间（秒）；0 = 正常 */
  flashLeft: number;
  /** 上一次消费的受击标记（unitFlash 的时间戳；变了就重新触发闪白） */
  lastFlashSeen?: number;
  /** 锥体兜底（无素材包）的材质与本色：闪白往白 lerp，回落 copy 本色 */
  flashMat?: THREE.MeshStandardMaterial;
  flashBase?: THREE.Color;
}

/** 整栋塌下去要多久（秒）：前 2.6 秒一直扬尘，把下沉过程糊住 */
const SINK_SECONDS = 3.4;
const SINK_DUST_SECONDS = 2.6;
/** 受击泛白/闪白的目标色（往这个白 lerp，别直接设——原色才恢复得回来） */
const FLASH_WHITE = new THREE.Color(1, 1, 1);
/** 飞行器离地高度搬到 visuals/flyers.ts 的 FLYER_STYLE，与体型倍率同表 */
const CORPSE_SECONDS = 2.6;
const FLYER_IDS = new Set(['balloon', 'airscrew', 'bomber']);
/** 触屏拖放：影子落在手指前方（屏幕上方）这么多 CSS 像素，免得手指盖住预览 */
const DRAG_FINGER_OFFSET = 56;

/**
 * 一次拖放的全部 3D 资源。打包成一个对象是为了**按玩家**各留一份 ——
 * 双人同屏时两个人在同一块屏上各拖一张牌，影子不能共用一个。
 */
interface DragState {
  slot: number;
  ghost: THREE.Group;
  fill: THREE.MeshBasicMaterial;
  edge: THREE.LineBasicMaterial;
  modelMat: THREE.MeshStandardMaterial;
}

export class ArenaApp {
  readonly scene = new THREE.Scene();
  readonly world: ArenaWorld;
  readonly rig: CameraRig;
  readonly seed: number;

  /** 当前选中的手牌槽；-1 = 没选 */
  selectedSlot = -1;
  /**
   * 这个槽属于哪个玩家（0 起）。1v1 / PVE 单人恒 0，双人同屏时 0 或 1。
   * `selectedSlot` 单独一个数字不够用了 —— 两个玩家各有一套手牌，槽号会撞。
   */
  selectedPlayer = 0;
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
  /** 画布：拖放时要把客户端坐标减掉画布偏移再投到地面 */
  private readonly canvas: HTMLCanvasElement;

  private readonly buildingMeshes = new Map<number, THREE.Group>();
  private readonly unitSprites = new Map<number, UnitSprite>();
  /** 倒地不动的小人 / 解体冒火的车与飞机（视图自己的残骸池，逻辑层不碰） */
  private readonly corpses: Corpse[] = [];
  private readonly flagMarks = new Map<number, THREE.Group>();
  private readonly styles = new Map<string, DudeStyle>();
  /** 会动的零件：磨坊的风车、炮塔的头、塔口的火光 */
  private readonly ruinMeshes = new Map<number, THREE.Group>();
  private readonly parts = new Map<
    number,
    {
      sails?: { group: THREE.Object3D; speed: number }[];
      turret?: THREE.Object3D;
      /** 楼体朝向（弧度）：炮口目标角要减掉它才不指偏 */
      spin?: number;
      banner?: Banner;
      /** 外墙：施工时按进度露出，受伤时崩掉 */
      shell?: WallShell;
      /** 楼体材质（受击泛白用）：无贴图的标准材质 + 原色副本 */
      mats?: { mat: THREE.MeshStandardMaterial; color: THREE.Color }[];
      /** 施工脚手架（完工后拆掉，不在 group 里 —— 它不该跟着楼一起升起） */
      scaffold?: THREE.Group;
      /** 模型缩放（工厂 1.18 倍）；施工缩放要用同一个值 */
      scale?: number;
      /** 楼的静止高度（世界 y），施工时 group 从这个高度下面往上冒 */
      baseY?: number;
      /** 模型自身高度（世界单位），决定施工要"长"多高 */
      modelTop?: number;
      /** 是不是已经完工过（用来只在完工那一帧做一次收尾） */
      built?: boolean;
    }
  >();
  /** 在飞的弹丸（视觉件，按 world.shots 同步） */
  private readonly shotMeshes = new Map<number, THREE.Object3D>();
  /** 单位受击标记（unitId → 视图时间戳）：近战命中与弹丸命中帧写入，syncUnits 消费后闪白 */
  private readonly unitFlash = new Map<number, number>();
  /** 进加时赛的两侧彩带（HUD 触发 burst，draw 每帧 update）；HUD 也要触发，开 readonly */
  readonly confetti: Confetti;
  /** 竞技场围墙与看台：三段看台要按相机方位整段显隐，所以持有引用 */
  private readonly stand: ArenaStand;
  /** 建筑上一次掉血的时刻（视图时间）：血条只在挨打后短暂出现，不是一直挂着 */
  private readonly lastHitAt = new Map<number, number>();
  private readonly lastHpFrac = new Map<number, number>();
  /**
   * 正在往地里沉的楼体残骸（用户 2026-11-06）：拆楼不立刻删模型，
   * 让它整体下沉 + 尘雾遮挡，最后没入地面。
   */
  private readonly sinking: {
    group: THREE.Group;
    baseY: number;
    depth: number;
    x: number;
    z: number;
    life: number;
    dustIn: number;
  }[] = [];
  /** 两座大本营的世界空间悬浮血条：满血不显示，挨打才浮出来 */
  private readonly coreBars = new Map<number, CoreBar>();
  /** 已经放过治疗圈的 id（world.heals 是逐帧还在的事件，别重复放） */
  private readonly seenHeals = new Set<number>();
  /** 已经放过粒子效果的近战命中 id（world.hits 是逐帧还在的事件，别重复放） */
  private readonly seenHits = new Set<number>();
  readonly director = new ArenaDirector();
  /**
   * 操作方向偏好（2026-11-07）：从 localStorage 读，**四个手势回调每帧直接读它**。
   * 设置面板改的是同一个对象并立刻 `saveControls()`，所以不用重载、不用事件总线：
   * 下一次指针事件就是新方向，下次进游戏也还是这个方向。
   */
  readonly controls = loadControls();
  /**
   * 我方托管状态机。构造体里 `world` 一落地就建（不能用字段初始化器 ——
   * 那时 `this.world` 还没赋值）。20Hz 的 `onSimStep` 每帧喂 dt，
   * window 上的 pointerdown/keydown 喂 `activity()`。
   */
  readonly autoPilot: AutoPilot;
  /** 所有声音都从这里发：合成音，不加载素材（见 `@audio/sfx`） */
  readonly sfx = new Sfx();
  /** window 捕获阶段统一的「玩家还在操作」信号 */
  private readonly markActivity = (): void => this.autoPilot.activity();
  /** 上一帧的结算状态：用来抓「这局结束了」这个瞬间（coin 已撤，2026-11-06） */
  private lastOutcome = 'playing';
  private fitZoom = ARENA_CAMERA.tilesAcross;
  private lastFrame: FrameInfo = { delta: 0, time: 0, fps: 60 };

  private constructor(opts: ArenaAppOptions, pack: DudePack | null) {
    this.opts = opts;
    this.seed = opts.seed ?? 20261027;
    this.canvas = opts.canvas;
    this.pack = pack;
    this.world = new ArenaWorld({
      seed: this.seed,
      mode: opts.mode,
      level: opts.level,
      players: opts.players,
    });
    this.autoPilot = new AutoPilot(this.world, this.controls, opts.onAutoPilot);
    /**
     * 「玩家还在这儿」的判定只有一条：**任何指针按下 / 键盘按键**。
     * 在 window 捕获阶段收，画布手势、卡牌点击、刷新、拖放、菜单按钮全都覆盖；
     * 不用给每个交互点单独接一次，也不会漏掉 HUD 上的操作。
     * 刻意不收 `pointermove`/`hover` —— 鼠标悬着不动不该算"人在操作"。
     */
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.markActivity, { capture: true });
      window.addEventListener('keydown', this.markActivity);
    }

    this.map = new TileMap({ cols: this.world.fieldSize.cols, rows: this.world.fieldSize.rows });
    this.ground = new GroundView(this.map);
    this.damage = new DamageFx(this.scene);
    this.fx = new BattleFx();
    this.scene.add(this.fx.group);
    this.confetti = new Confetti(this.map.size.cols, this.map.size.rows);
    this.scene.add(this.confetti.group);
    // 竞技场：几何一次建好，但每帧要按相机 yaw 把"离镜头最近的一整段看台"藏掉
    this.stand = buildStand({
      cols: this.map.size.cols,
      rows: this.map.size.rows,
      baseY: this.map.surfaceY(pos(0, 0)),
      blue: sideColor('blue'),
      red: sideColor('red'),
    });
    this.scene.add(this.stand.group);
    this.dustLayer = new AmbientDust(this.map.size.cols, this.map.size.rows);
    this.scene.add(this.dustLayer.points);
    // 外墙崩开时溅火星；碎块落地时扬一小团土
    this.damage.onBreach = (x, z, y, dirX, dirZ) => this.fx.spark(x, z, y, dirX, dirZ, 14);
    this.damage.onLand = (x, z, y) => this.fx.dust(x, z, y);
    this.renderer = new Renderer(opts.canvas);
    this.viewport = new Viewport(opts.container);
    /**
     * PVE 的相机初值（2026-11-07）。
     *
     * **yaw 270° 是关键**：格子的 `col` 轴映射世界 x（水平），而 PVE 的场地是
     * 60 col × 32 row 的长条 —— 不转过来，竖屏上看到的是"横向 60 格"，
     * 水平只能装下 30 格、上下空一大片（实测截图：大本营被挤在左边缘外）。
     * 转过来之后 col 变成屏幕的上下轴，"蓝在下、怪从上往下"的塔防读图才成立。
     *
     * 俯角 44°（= 机位表的 46° + `pitchBias` −2）：俯角越大纵深越扁，
     * 44° 时 60 格投影约 42 格，正好铺满竖屏上下沿。
     *
     * 这两个值和 `PVE_VIEW_PRESETS[0]`（正对）是同一组数字 —— 初值直接对齐机位表，
     * 开局就不会出现"先转 180° 再定住"的甩镜头。
     */
    const pve = this.world.mode === 'pve';
    if (pve) {
      this.director.usePresets(PVE_VIEW_PRESETS, 0);
      this.director.pitchBias = -2;
    }
    this.rig = new CameraRig({
      pitchDeg: pve ? 44 : ARENA_CAMERA.pitchDeg,
      yawDeg: pve ? 270 : ARENA_CAMERA.yawDeg,
      tilesAcross: ARENA_CAMERA.tilesAcross,
      minTilesAcross: ARENA_CAMERA.minTilesAcross,
      // PVE 的场地宽 32 格、长 60 格：不把上限放开，竖屏只能看到半条防线
      maxTilesAcross: pve ? 60 : ARENA_CAMERA.maxTilesAcross,
    });
    /**
     * 平移边界 2026-11-06 改**随视野动态**（用户："往左边往自己家里移动会被限位"、
     * "放大的时候好像会卡"——实测 60fps 满帧，卡的就是撞在写死的
     * `0.3c~0.7c` 边界上的顿挫）。放大时中心可以贴到自家门口看细节；
     * 缩小时边界自动收回，不会拖出一屏黑。规则见 CameraRig.CameraBounds.field。
     */
    const c = this.map.size.cols;
    const r = this.map.size.rows;
    this.rig.setBounds({ field: { cols: c, rows: r } });
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
    for (let col = this.world.field.midCol - NO_BUILD.halfWidth; col <= this.world.field.midCol + NO_BUILD.halfWidth; col++) {
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
    edgeL.position.set(this.world.field.midCol - NO_BUILD.halfWidth - 0.5, 0.53, this.map.size.rows / 2);
    const edgeR = edgeL.clone();
    edgeR.position.x = this.world.field.midCol + NO_BUILD.halfWidth + 0.5;
    this.scene.add(apron, edgeL, edgeR, this.ground.group);
    this.gallery = pack ? new DudeGallery(pack) : null;

    this.loop = new GameLoop({
      hz: 20,
      onSimStep: (dt) => {
        // 先推进托管计时，再更新世界：状态一变这一帧就生效，不用多等一轮
        this.autoPilot.step(dt);
        this.world.update(dt);
        this.opts.onState?.();
      },
      onFrame: (info) => this.draw(info),
    });

    // 2026-11-07：原来这里在 pointerdown 时打一条射线，判断手指落在场地内还是黑区，
    // 决定"这次拖动是平移还是转视角"。现在单指一律平移、转视角交给双指，
    // 这个判断没有读者了，删掉（顺带省掉每个 pointerdown 一次射线求交）。
    this.input = new PointerInput(opts.canvas, {
      /**
       * 单指拖动 = **平移**，不管手指落在战场上还是黑区里（2026-11-07 用户：
       * "手机端点击任何地方都是移动"）。
       *
       * 上一版黑区拖动是"转视角"，结果玩家在手机上想挪一下地图，
       * 稍微拖出场地边界镜头就开始转，很容易把视角甩歪 —— 而且他要转视角
       * 本来就有双指手势，单指不该兼职两件事。
       */
      onPan: (dx, dy) => {
        this.director.userTouched();
        const [px, py] = panDelta(dx, dy, this.controls);
        this.rig.panByPixels(px, py);
      },
      onZoom: (factor, x, y) => {
        this.director.userTouched();
        this.rig.zoomBy(zoomDelta(factor, this.controls), x, y);
      },
      onRotate: (deg) => {
        this.director.userTouched();
        this.rig.rotateBy(rotateDelta(deg, this.controls));
      },
      /**
       * 双指整体上下推 = 调俯仰角（2026-11-07 用户："还有上下转……最大可以转到平行"，
       * 下午又追加"向上滑和向下滑反转一下"）。
       *
       * **默认方向按用户偏好改过**：往下滑 = 更俯视（看得见全场），
       * 往上滑 = 更平（贴近地面看兵线）。上一版是反的（`pitch - dy·k`），
       * 现在把符号搬进 `controls.ts` 的 `pitchDelta()`，设置里勾「反转」才回到旧方向。
       *
       * 上下限在 `CameraRig`：6°（几乎与地面平行）~ 88°（几乎正上方）。
       */
      onTilt: (dy) => {
        this.director.userTouched();
        this.rig.setPitch(this.rig.pitch + pitchDelta(dy, this.controls));
      },
      onTap: (x, y) => this.handleTap(x, y),
      onLongPress: (x, y) => this.handleLongPress(x, y),
      onHover: () => {},
    });

    /**
     * 相机中心往远端（-z）再偏一点：俯角从 52 降到 44 之后地面在竖直方向被压短，
     * 原来这个偏移会让画面下方留一大块黑地。往 -z 偏 = 场地下移，把那块黑吃掉一部分。
     */
    /**
     * 开局机位：1v1 压在中场（两边都看得见）；
     * PVE 压在**自家防区**（col 小的那一侧）—— 玩家一上来要布防，
     * 镜头对着一片空走廊没有意义，怪涌下来的时候再自己往外拖。
     */
    const centerCol = this.world.mode === 'pve' ? this.map.size.cols * 0.3 : this.map.size.cols / 2;
    const mid = cellToWorld(pos(centerCol, this.map.size.rows / 2 - 2.0));
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
    app.syncBuildings(0);
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
   * 暂停 / 恢复**逻辑**（开始菜单用）：画面照常渲染，时间不走。
   *
   * 不做这件事的后果很具体：玩家在菜单里读 30 秒说明，对面 AI 已经推到大本营门口了。
   */
  pause(): void {
    this.loop.pause();
  }

  resume(): void {
    this.loop.resume();
  }

  get paused(): boolean {
    return this.loop.isPaused;
  }

  /** 手牌刷新（5 金，保底民居）。`player` 是玩家槽下标（双人同屏各刷各的）。 */
  rerollHand(player = 0): PlayResult {
    const p = this.playerAt(player);
    const res = this.world.rerollOf(p);
    if (res.ok) {
      this.selectedSlot = -1;
      this.sfx.play('place');
      this.syncBuildings(0);
    }
    return res;
  }

  /**
   * 取玩家槽。下标越界一律回落到 0 —— 单人局里 UI 偶尔带着 `player: 1` 的残留
   * 不该炸，也不该"操作了第二个不存在的玩家"，回落到 0 是最不容易误解的行为。
   */
  playerAt(index: number) {
    return this.world.players[index] ?? this.world.players[0]!;
  }

  /**
   * 让整幅场地进画面。相机按短边看几格来定视野，所以换朝向要重算：
   * 横屏短边是高、竖屏短边是宽 —— 两个方向分别求至少要看多少格，取大者。
   * 竖直方向多留 4 格，底下那几格是给手牌让位的（不然蓝方大本营被卡牌压住）。
   */
  private fitCamera(cssWidth: number, cssHeight: number): void {
    const a = cssWidth / Math.max(1, cssHeight);
    /**
     * 四周留的余量：2026-11-06 加了围墙与看台之后从（+2,+4）放大到（+9,+9）。
     * 原来那点余量正好把看台裁在画面外 —— 墙看得见、台阶看不见，像是地上一圈石边。
    加高看台 + 帆布之后再放到（+12,+11）：棚布在俯视角下会往上偏移约 3 格，不留够就只剩半截。
     */
    const wantRows = this.map.size.rows + 11;
    const wantCols = this.map.size.cols + 10;
    const fit = a >= 1 ? Math.max(wantRows, wantCols / a) : Math.max(wantCols, wantRows * a);

    /**
     * **PVE 竖屏的构图**（2026-11-07 实测纠错）。
     *
     * 1v1 的算法是"场地整幅入画"，对 44×20 的小场地没问题；
     * 但 PVE 是 60×32 的长条，按 `wantCols`（70）算出来的视角在竖屏上
     * 只能让战场占画面 **42%**（上下各一大片空底盘）——
     * 因为竖屏的短边是**宽**，按"宽度装下 32 格"就必然在纵深留下 80 格的高度。
     *
     * 所以 PVE 竖屏改成**贴着宽度铺满**：短边显示 `rows × 0.95` 格，
     * 两边各裁掉半格边（看台挡着，看不出来），纵深靠俯视投影自然铺到画面上下沿。
     * 横屏仍然用整幅入画的算法（横屏本来就看得见全貌）。
     */
    const pvePortrait = this.world.mode === 'pve' && a < 1;
    /**
     * 双人同屏时屏幕**上下各压着一套手牌**（2026-11-07），战场可视高度少掉约 130px。
     * 所以竖屏再退一点（+10%）：不然自家最下面那排楼正好被手牌盖住 ——
     * 那是玩家最需要盯着看的地方（大本营就在那儿）。
     *
     * 判据必须是 `seatCount`（玩家阵营有几个人），**不能是 `players.length`** ——
     * 1v1 里 `players` 也长度 2（含红方 AI），那样 1v1 的视角会被白白缩小 10%。
     */
    const seatCrowd = this.world.seatCount > 1 ? 1.1 : 1;
    /**
     * PVE 竖屏的基准缩放 = `rows × 1.02`，**与当前档位无关**。
     *
     * 上一版除以了机位的 `zoomFactor` 去抵消导演那一乘，结果 `fitZoom` 变成
     * "当时那一档"的函数：玩家切到「斜视」再转屏，重算出来的基准就偏了，
     * 换回「正对」时大小不对。现在基准固定，机位的 zoomFactor 相对它算。
     */
    this.fitZoom = (pvePortrait ? this.map.size.rows * 1.02 : fit) * seatCrowd;
    // 竖屏告诉导演：拉近 + 构图偏自家（2026-11-07 设计文档 D 节）。
    // PVE 已经按宽度贴满了，再乘 0.58 会近到只看得到半个防区。
    this.director.portrait = a < 1 && !pvePortrait;
    // 自动模式下由导演每帧把缩放拉回机位；手动模式直接吃这个值
    if (this.director.locked) this.rig.zoom = fit * this.director.current.zoomFactor;
  }

  // ---------------------------------------------------------------- 出牌

  /**
   * HUD 点手牌。返回三态而不是布尔：
   * "没选中"和"被取消"是两件事，布尔会把"再点一次取消"误报成"选不了"。
   */
  selectCard(slot: number, player = 0): 'selected' | 'deselected' | 'empty' | 'cooldown' | 'poor' {
    const p = this.playerAt(player);
    const card = p.hand[slot];
    if (!card) return 'empty';
    if ((p.cooldowns[slot] ?? 0) > 0) return 'cooldown';
    if (p.gold < card.cost) return 'poor';
    // 两个玩家各有一套选中状态：玩家 1 选牌不该把玩家 0 的选中清掉
    const same = this.selectedSlot === slot && this.selectedPlayer === p.id;
    this.selectedSlot = same ? -1 : slot;
    this.selectedPlayer = p.id;
    this.selectedBuilding = null;
    return this.selectedSlot === slot ? 'selected' : 'deselected';
  }

  /** 换下一个机位（键盘 V 走这里）。 */
  nextView(): string {
    return this.director.next().name;
  }

  /**
   * 直接跳到第 i 档机位（HUD 的视角菜单，2026-11-07 用户："给一个斜着的，
   * 还有一个正视角、斜视角，这些都可以设置"）。
   *
   * 清单本身来自导演（`director.presets`，PVE 与 1v1 不同），这里只做转发 ——
   * UI 不该自己维护一份机位名，那样加一档要改两处。
   */
  pickView(index: number): string {
    return this.director.select(index).name;
  }

  /** 当前模式可选的全部机位（视角菜单按它生成按钮）。 */
  get viewPresets(): readonly ViewPreset[] {
    return this.director.presets;
  }

  /** 当前档位下标（菜单高亮用）。 */
  get viewIndex(): number {
    return this.director.index;
  }

  /** 画布本体：HUD 要往它上面挂"右键开设置"（2026-11-07 用户："应该右键可以"）。 */
  get stage(): HTMLCanvasElement {
    return this.canvas;
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
      /**
       * 2026-11-07 用户："点击移动军队这个功能给关掉，军队是棋子，落下之后
       * 就不归我们管了，他会自己走。" 点空地一律静默 —— 不再改任何单位的 order。
       * （兵营挪旗是建筑配置，仍然保留；world.command 留作 PVE 波次脚本的内部 API。）
       */
      return;
    }

    const res = this.playAt(this.selectedSlot, cell, this.selectedPlayer);
    if (res) this.selectedSlot = -1;
  }

  /** 真正落一张牌：点击放置和拖拽放置走同一条路（判据在 world.playCardOf）。 */
  private playAt(slot: number, cell: GridPos, player = 0): boolean {
    const p = this.playerAt(player);
    const staffedBefore = this.world.staffedCount(p.side);
    const res = this.world.playCardOf(p, slot, cell.col, cell.row);
    if (!res.ok) {
      this.opts.onToast?.(res.reason ?? '放不下', 'warn');
      return false;
    }
    this.sfx.play('place');
    this.syncBuildings(0);
    // 后勤提示：兵营要 1 磨坊 + 1 民居；塔要 1 座民居（2026-10-31 起防御建筑也占民居）。
    // 缺什么直接点名 —— 玩家看到"塔不开火"时不该自己去猜为什么。
    const placed = this.buildingAtCell(cell);
    if (placed && needsStaffing(placed.kind) && !this.world.isStaffed(placed.id)) {
      this.opts.onToast?.(
        placed.kind === 'barracks' ? '兵营要 1 磨坊 + 1 民居才会出兵' : '这座塔要 1 座民居才开火',
        'warn',
      );
    } else if (this.world.staffedCount(p.side) > staffedBefore) {
      this.opts.onToast?.('后勤配齐了，开工');
    }
    this.opts.onState?.();
    return true;
  }

  // ---------------------------------------------------------------- 拖放（2026-11-06）

  /**
   * 用户："单位和建筑玩家可以直接点击放置，也可以拖住它拖到地图上，会显示一个
   * 影子看看放在哪里，然后可以拖回卡牌。"
   *
   * HUD 负责手势（跨元素的 pointermove/up 在 window 上收），这里只管影子与落牌：
   * 影子是一块贴地的半透明占位（建筑 3×3 / 军队 1×1），绿=可放、红=不可放，
   * 判据和落牌共用 `world.canPlaceAt()`（与 playCard 同一份校验）。
   */
  private readonly drags: (DragState | null)[] = [];
  private dragState(player: number): DragState | null {
    return this.drags[player] ?? null;
  }

  /** 客户端坐标 → 地面格子（画布外 / 场地外 = null）。 */
  private clientToCell(clientX: number, clientY: number): GridPos | null {
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.rig.screenToGround(clientX - rect.left, clientY - rect.top);
    if (!hit) return null;
    const cell = worldToCell(hit.x, hit.z);
    return inBounds(cell, this.map.size) ? cell : null;
  }

  /** 拖放专用：触屏把落点抬到手指前方，桌面不变；影子与落牌共用。 */
  private dragCell(clientX: number, clientY: number, pointerType: string): GridPos | null {
    const lift = pointerType === 'touch' ? DRAG_FINGER_OFFSET : 0;
    return this.clientToCell(clientX, clientY - lift);
  }

  beginCardDrag(slot: number, player = 0): void {
    const p = this.playerAt(player);
    const card = p.hand[slot];
    if (!card) return;
    this.cancelCardDrag(p.id);
    const spec = card.kind === 'building' ? BUILDING_SPECS[card.building!] : { cols: 1, rows: 1 };
    const cols = spec.cols, rows = spec.rows;
    const g = new THREE.Group();
    // 底下仍留一层**很淡**的占地框（按真实尺寸：齿轮工厂是 4×3 长方形），主角换成模型影子
    const fillMat = new THREE.MeshBasicMaterial({ color: 0x7fe09a, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x7fe09a, transparent: true, opacity: 0.5, depthTest: false });
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(cols, rows), fillMat);
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = card.kind === 'building' ? 0.05 : 0;
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(cols, 0.04, rows)), edgeMat);
    edge.renderOrder = 28;
    edge.position.y = card.kind === 'building' ? 0.03 : 0;
    g.add(fill, edge);
    /**
     * **模型影子**（2026-11-06 用户："我想的是建筑影子一个可以看见的建筑的影子，
     * 而不是占地面积"）：建筑卡用**真模型**（ARENA_MODELS 同一套建模）半透明渲染，
     * 摆放公式与真楼一致（footprintSurfaceY + BUILDING_SCALE），松手前就能看清
     * "这栋楼长什么样、挡多大"。军队卡给一个小人剪影锥。
     */
    const modelMat = new THREE.MeshStandardMaterial({ color: 0x7fe09a, transparent: true, opacity: 0.45, depthWrite: false, roughness: 0.9, side: THREE.DoubleSide });
    if (card.kind === 'building') {
      // 影子模型仍按蓝方配色：双人同屏两人都在蓝方，阵营色本来就一样
      const model = ARENA_MODELS[card.building as ArenaModelName](sideColor(p.side));
      const body = buildModel(model.static);
      body.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.material = modelMat;
      });
      // 所有楼统一一个缩放（2026-11-07 返工）：工厂原先额外乘 1.18，
      // 加上模型本身就宽，台基直接盖出 4×3 占地 —— 影子也得跟着改回 2.2，
      // 否则"预览一个尺寸、落下去是另一个尺寸"。
      body.scale.setScalar(BUILDING_SCALE);
      g.add(body);
      g.userData['body'] = body;
    } else {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.3, 6), modelMat);
      cone.position.y = 0.65;
      g.add(cone);
    }
    g.visible = false;
    this.scene.add(g);
    this.drags[p.id] = { slot, ghost: g, fill: fillMat, edge: edgeMat, modelMat };
  }

  /** 影子跟随指针：贴着格子中心，合法绿 / 非法红（判据 canPlaceAt）。 */
  moveCardDrag(clientX: number, clientY: number, pointerType = 'mouse', player = 0): void {
    const p = this.playerAt(player);
    const drag = this.dragState(p.id);
    if (!drag) return;
    // 触屏：影子在手指前方（上方），手指不挡预览；桌面鼠标偏移 0
    const cell = this.dragCell(clientX, clientY, pointerType);
    drag.ghost.visible = cell !== null;
    if (!cell) return;
    const card = p.hand[drag.slot];
    const isBuilding = card?.kind === 'building';
    const spec = isBuilding ? BUILDING_SPECS[card!.building!] : { cols: 1, rows: 1 };
    const c = cellToWorld(pos(cell.col + spec.cols / 2, cell.row + spec.rows / 2));
    // 模型影子的摆放公式与真楼一致；占地平面只差一层 0.05 的贴地防 z-fight
    const baseY = isBuilding
      ? this.map.footprintSurfaceY(pos(cell.col, cell.row), spec.cols, spec.rows)
      : this.map.surfaceY(cell) + 0.06;
    drag.ghost.position.set(c.x, baseY, c.z);
    // 模型影子的朝向与落成一致（同一个 落点+类型 key）
    const ghostBody = drag.ghost.userData['body'] as THREE.Object3D | undefined;
    const bId = card?.building;
    if (ghostBody && bId) ghostBody.rotation.y = spinOf(buildingSpinKey(cell.col, cell.row, bId));
    const ok = this.world.canPlaceAtOf(p, drag.slot, cell.col, cell.row).ok;
    const color = ok ? 0x7fe09a : 0xe2503f;
    drag.fill.color.setHex(color);
    drag.edge.color.setHex(color);
    drag.modelMat.color.setHex(color);
  }

  /** 松手在地图上 = 落牌；松手回到手牌区由 HUD 直接调 cancelCardDrag（拖回取消）。 */
  dropCardDrag(clientX: number, clientY: number, pointerType = 'mouse', player = 0): void {
    const p = this.playerAt(player);
    const drag = this.dragState(p.id);
    if (!drag) return;
    // 落牌与影子必须用同一个函数，杜绝"看着放这、落到那"
    const cell = this.dragCell(clientX, clientY, pointerType);
    if (cell) this.playAt(drag.slot, cell, p.id);
    this.cancelCardDrag(p.id);
  }

  /**
   * 拆掉影子。`player` 省略 = 全部拆掉（系统级取消：指针丢失、切窗、重开）。
   * 一个人拖到一半点了别处时，只拆他自己的 —— 别把另一个人的影子也清了。
   */
  cancelCardDrag(player?: number): void {
    for (let i = 0; i < this.drags.length; i++) {
      if (player !== undefined && i !== player) continue;
      const drag = this.drags[i];
      if (!drag) continue;
      this.scene.remove(drag.ghost);
      drag.ghost.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      drag.fill.dispose();
      drag.edge.dispose();
      drag.modelMat.dispose();
      this.drags[i] = null;
    }
  }

  /**
   * 长按：落在**建筑**上是"看这栋楼的血量"（原有行为）；
   * 落在**空地**上叫设置面板（2026-11-07 用户："游戏栏目不需要设置，右键可以"——
   * 手机上没有右键，长按就是它的等价物）。
   *
   * 两个出口靠"按到没按到楼"分流，不做二次确认，因为两种意图完全不重叠：
   * 想挪镜头的人不会按住不动 380ms。
   */
  private handleLongPress(cssX: number, cssY: number): void {
    const hit = this.rig.screenToGround(cssX, cssY);
    if (!hit) return;
    const cell = worldToCell(hit.x, hit.z);
    const b = this.buildingAtCell(cell);
    if (!b) {
      this.opts.onRequestSettings?.();
      return;
    }
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
    // 镜头转到哪一侧，那一侧的整段看台就整段消失（台阶 + 座位 + 帆布 + 撑杆）
    this.stand.update(this.rig.yaw);
    this.audioCues();
    this.rig.update(info.delta);
    this.lighting.follow(this.rig);
    this.ground.update(info.time);
    this.syncBuildings(info.delta);
    this.syncUnits(info.time, info.delta);
    this.syncFlags();
    this.syncShots(info.time);
    this.syncHeals();
    this.syncHits();
    this.syncRuins();
    this.syncParts(info.time);
    this.damage.update(info.delta);
    this.confetti.update(info.delta);
    this.stepSinking(info.delta);
    this.stepCorpses(info.delta);
    this.fx.step(info.delta);
    this.dustLayer.update(info.delta);
    this.director.update(info.delta, this.rig, this.fitZoom, this.fieldCenter());
    this.renderer.render(this.scene, this.rig.camera);
  }

  /**
   * 建筑：新增/删掉都在这补齐。模型来自 `models.ts`，五栋楼一套设计语言。
   *
   * 2026-11-02 起这里还管**施工**：`b.build < 1` 的楼正在垒 ——
   * 外墙按进度从下往上露（`WallShell.setBuild`）、楼体从地里往上升、外面围一圈脚手架。
   */
  private syncBuildings(dt: number): void {
    for (const b of this.world.buildings.values()) {
      if (this.buildingMeshes.has(b.id)) continue;
      const name = b.kind as ArenaModelName;
      // 阵营色现在**每栋楼都发**：屋顶瓦、屋脊、顶珠、磨坊的帆。
      // 以前只有大本营/炮塔/磨坊三栋拿到 accent，其余三栋双方长得一模一样 ——
      // 隔着战场只看旗子和血条才分得出敌我，那是用户 2026-10-27 点名要改的。
      const accent = sideColor(b.side);
      const model = ARENA_MODELS[name](accent);
      /**
       * 朝向随机（2026-11-07 设计文档 B 节）：外层 group 不转（位置/缩放/血条/旗/
       * 脚手架照旧），楼体装进 body 子组按 `落点+类型` 的稳定 hash 转 0/90/180/270°
       * ±4° 小抖动。占地仍是 3×3，横竖摆都行；同 seed 同摆法朝向一致。
       * 拖拽影子用同一 key，预览朝向 = 落成朝向。
       */
      const group = new THREE.Group();
      const body = buildModel(model.static);
      const spin = spinOf(buildingSpinKey(b.col, b.row, b.kind));
      body.rotation.y = spin;
      group.add(body);
      // 外墙是一张单独的面片网格：受伤时从这里整块摘（见 shell.ts）
      const shell = new WallShell(model.shell);
      body.add(shell.mesh);
      // 收集楼体材质（受击泛白用）：无贴图的标准材质 + 原色副本；旗布（带 map）与后加的血条不收
      const mats: { mat: THREE.MeshStandardMaterial; color: THREE.Color }[] = [];
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const m = mesh.material as THREE.MeshStandardMaterial | undefined;
        if (m && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !m.map) {
          mats.push({ mat: m, color: m.color.clone() });
        }
      });
      // 磨坊的帆是六块各自带 pivot 的件 ⇒ 套件建了六个转轴 Group。
      // 只转第一个的话，就是"一块帆在转、其余五块钉死"（用户："有的地方转，有的地方不转"）。
      // 自转件在 body 子组里（P-054 建筑朝向拆组后），必须读 body 而不是外层 group
      const sails = spinnersOf(body).map((s) => ({ group: s.group, speed: s.speed }));
      const turret = body.userData[TURRET] as THREE.Object3D | undefined;
      this.parts.set(b.id, { sails: sails.length > 0 ? sails : undefined, turret, spin });
      const center = cellToWorld(pos(b.col + b.cols / 2 - 0.5, b.row + b.rows / 2 - 0.5));
      // 模型说明书写的是"局部原点在占地中心、底面 y=0"，所以要抬到**地块表面**，
      // 不能放在 y=0 —— 草地表面在 0.5，放 0 就是整栋楼埋掉半截。
      group.position.set(center.x, this.map.footprintSurfaceY(pos(b.col, b.row), b.cols, b.rows), center.z);
      // 4×3 的"大一圈"是**占地**给的，模型本身按占地倒推，不再额外放大
      // （2026-11-07 返工：原来额外乘 1.18，台基盖出 5.97 格、屋顶穿到隔壁格子）
      const bScale = BUILDING_SCALE;
      group.scale.setScalar(bScale);
      // 量一次模型自身的高度（格）：血条挂多高就按它算，不再按建筑种类写死。
      // 相对组自身量：组已经抬到了地块表面，直接用世界坐标会把那 0.5 格算进去。
      group.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(group);
      const modelTop = bounds.max.y - group.position.y;
      this.scene.add(group);
      // 血条要挂在**抵消缩放**的子组里：直接挂在 group 上会跟着放大，位置被抬到半空
      const ui = new THREE.Group();
      ui.scale.setScalar(1 / bScale);
      group.add(ui);
      group.userData['ui'] = ui;
      // 旗：放进反向缩放的 ui 组，所以尺寸直接用"格"（落点表在 models.ts 的 ARENA_FLAGS）
      const spot = ARENA_FLAGS[name];
      const banner = makeBanner(b.side, spot.pole);
      banner.group.position.set(spot.x, spot.base, spot.z);
      ui.add(banner.group);
      this.parts.set(b.id, { ...(this.parts.get(b.id) ?? {}), banner });
      // 施工要用的三样：外墙（按进度露出）、静止高度、模型高度
      this.parts.set(b.id, {
        ...(this.parts.get(b.id) ?? {}),
        shell,
        baseY: group.position.y,
        modelTop,
        scale: bScale,
        built: b.build >= 1,
        mats,
      });
      /**
       * 大本营**不要**这块原生小血条（用户 2026-11-06：「它居然有两个血条」）。
       * 它已经有 `visuals/coreBar` 那根永远正对镜头的世界空间悬浮条；
       * 两个一起显示会一条挂在楼顶、一条浮在半空，读数重复还互相挡。
       */
      if (b.kind !== 'core') {
        const bar = makeHpBar(b.hp / b.maxHp, sideColor(b.side), 2.6);
        bar.position.y = modelTop + 0.25;
        ui.add(bar);
        group.userData['hpBar'] = bar;
      }
      if (needsStaffing(b.kind)) {
        // SVG 图标替掉文字横条：缺民居 = 房屋 + 红叉；兵营再多一个小风车
        const need = makeNeedLabel(b.kind === 'barracks' ? 'millHouse' : 'house');
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

      // 大本营的水晶是**模型自带的**（嵌在屋顶里、按阵营上色），不再往头顶飘一颗。
      // 用户 2026-10-27："整个建筑的模型本身里面就嵌了一个水晶，为什么还要再画一个水晶"。
      this.buildingMeshes.set(b.id, group);
      group.userData['side'] = b.side;

      // 大本营的血条不进 HUD：挂在楼顶上方 1.5 格，满血不显示、掉血才浮出来
      if (b.kind === 'core') {
        const bar = makeCoreBar(sideColor(b.side));
        bar.group.position.set(center.x, group.position.y + modelTop + 1.5, center.z);
        this.scene.add(bar.group);
        this.coreBars.set(b.id, bar);
      }

      if (b.build < 1) {
        /**
         * 施工中：楼体在 y 方向从 12% 长到 100%（**原点在底面**，所以是"往上长"），
         * 外墙按进度从下往上逐块露出，外面围一圈跟着长高的脚手架。
         *
         * 为什么用 scale.y 而不是"从地下升起来"：位移露出的是**屋顶**（先看到顶，
         * 墙反而藏在土里），读起来像"楼掉坑里了"；压扁是"矮墙在长高"，才是垒墙。
         */
        shell.setBuild(b.build);
        const sc = this.parts.get(b.id)?.scale ?? BUILDING_SCALE;
        group.scale.set(sc, sc * Math.max(0.12, b.build), sc);
        const info = this.parts.get(b.id)!;
        if (info.banner) info.banner.group.visible = false;
        const scaffold = makeScaffold(b.cols, b.rows, modelTop);
        scaffold.position.set(center.x, info.baseY!, center.z);
        scaffold.scale.y = 0.32 + 0.68 * b.build;
        this.scene.add(scaffold);
        info.scaffold = scaffold;
      }
    }
    for (const [id, group] of this.buildingMeshes) {
      const b = this.world.buildings.get(id);
      if (b) {
        const frac = b.hp / b.maxHp;
        /**
         * 血条「受击才显示」：比较上一帧血量，掉了就记时刻；2.5 秒后淡出。
         * 用户 2026-11-06：「建筑只有被攻击的时候会显示血条，没攻击时默认消失。」
         * 之前是 `frac < 0.999` 一直挂着 —— 一局打完半场全是残血条。
         */
        const prev = this.lastHpFrac.get(id) ?? frac;
        if (frac < prev - 0.0005) this.lastHitAt.set(id, this.lastFrame.time);
        this.lastHpFrac.set(id, frac);
        const since = this.lastFrame.time - (this.lastHitAt.get(id) ?? -999);
        const show = since < 2.5;
        const alpha = since < 1.8 ? 1 : Math.max(0, 1 - (since - 1.8) / 0.7);

        /**
         * **受击泛白**（2026-11-06 用户："建筑物轻微泛一个白光，相当于有一个
         * 透明的遮罩轻微白一点"）：挨打后 0.35 秒内把楼体材质的 color 往白 lerp，
         * 峰值 0.45——是"遮罩感"不是闪光弹。mats 是新建楼时收集的无贴图
         * 标准材质（带原色副本），glow=0 时逐帧 copy 回原色，无需恢复逻辑。
         * 旗布（带 map）和血条不参与。
         */
        const mats = this.parts.get(id)?.mats;
        if (mats) {
          const glow = Math.max(0, 1 - since / 0.35);
          if (glow > 0) {
            for (const m of mats) m.mat.color.copy(m.color).lerp(FLASH_WHITE, glow * 0.45);
          } else if (mats.some((m) => !m.mat.color.equals(m.color))) {
            for (const m of mats) m.mat.color.copy(m.color);
          }
        }

        const cb = this.coreBars.get(id);
        if (cb) {
          cb.group.visible = show;
          updateCoreBar(cb, frac, alpha);
          // billboard：正交相机转视角时血条始终正对屏幕
          cb.group.quaternion.copy(this.rig.camera.quaternion);
        }
        const need = group.userData['need'] as THREE.Sprite | undefined;
        // 施工中不提示缺后勤：楼还没长起来，那块牌子会被父级的 y 缩放压扁，字都糊了
        if (need) need.visible = b.build >= 1 && !this.world.isStaffed(id);
        const bar = group.userData['hpBar'] as THREE.Mesh | undefined;
        if (bar) {
          // 挨打后 2.5 秒可见，之后淡出 —— 不是「残血就一直挂条」
          bar.visible = show;
          (bar.material as THREE.MeshBasicMaterial).opacity = 0.95 * alpha;
          updateHpBar(bar, frac);
        }
        this.damage.sync(id, frac, b.lastHit);
        this.syncBuild(group, b, this.parts.get(id), dt);
        continue;
      }
      /**
       * 整栋塌了（用户 2026-11-06）：
       * ① 墙上还立着的面片**一块不剩**全变成落体掉到地上；
       * ② 楼体不立刻删，留下来慢慢沉进地里；
       * ③ 同时地面扬起一大片尘，把下沉那几秒糊住。
       */
      const info = this.parts.get(id);
      const baseY = info?.baseY ?? group.position.y;
      const modelTop = info?.modelTop ?? 2.2;
      this.damage.collapseAll(id, 'cannon');
      // 外墙网格已经空了、几何也释放了，从残骸里摘掉（留着会渲染一张空网格）
      const shellMesh = group.getObjectByName('wall-shell');
      if (shellMesh) group.remove(shellMesh);
      // 血条 / 「缺 民居」牌子 / 旗子不跟着沉，否则会有一串字浮在土里
      const ui = group.userData['ui'] as THREE.Group | undefined;
      if (ui) ui.visible = false;

      this.sinking.push({
        group,
        baseY,
        depth: modelTop + 1.6,
        x: group.position.x,
        z: group.position.z,
        life: 0,
        dustIn: 0,
      });
      // 占地按 BUILDING_SPECS（齿轮工厂 4×3），删除分支里 b 已经是 undefined，别去读它
      this.fx.collapseDust(group.position.x, group.position.z, baseY, 1.9);
      this.buildingMeshes.delete(id);
      this.damage.forget(id); // collapseAll 已经删了状态，这里只是兜底
      this.lastHitAt.delete(id);
      this.lastHpFrac.delete(id);
      const cb = this.coreBars.get(id);
      if (cb) {
        this.scene.remove(cb.group);
        for (const child of cb.group.children) {
          const mesh = child as THREE.Mesh;
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        this.coreBars.delete(id);
      }
      // 塌的是楼：最重的一声 + 一次明显的震屏（0.55，差不多是"整栋倒下"的量）
      this.sfx.play('collapse', { pitch: 0.92 + Math.random() * 0.16 });
      this.rig.shake(0.55);
    }
  }

  /**
   * 施工的每帧表现。三件事挂在**同一个进度** `b.build` 上：
   *
   * 1. 外墙按进度从下往上露出（`WallShell.setBuild` 用 drawRange 截断，零重建）；
   * 2. 楼体从地下升起，完工那一下正好回到 `baseY`；
   * 3. 脚手架完工后 0.25 秒缩没（不是"啪"地消失）。
   */
  private syncBuild(
    group: THREE.Object3D,
    b: ArenaBuilding,
    info:
      | {
          shell?: WallShell;
          scaffold?: THREE.Group;
          banner?: Banner;
          baseY?: number;
          modelTop?: number;
          built?: boolean;
        }
      | undefined,
    dt: number,
  ): void {
    if (!info) return;
    const baseY = info.baseY ?? group.position.y;

    if (b.build < 1) {
      info.shell?.setBuild(b.build);
      // 楼往上长（原点在底面）+ 脚手架跟着长：一个通到顶的空架子立在矮墙上，像楼掉坑里了
      const sc = this.parts.get(b.id)?.scale ?? BUILDING_SCALE;
        group.scale.set(sc, sc * Math.max(0.12, b.build), sc);
      if (info.banner) info.banner.group.visible = false;
      if (info.scaffold) info.scaffold.scale.y = 0.32 + 0.68 * b.build;
      return;
    }

    if (!info.built) {
      // 完工那一帧：墙体补齐、楼体长到原比例、旗子挂上、脚手架开始收
      info.built = true;
      /**
       * 资源/建造类音效**只给玩家自己听**（用户 2026-11-06：「对方获得一个金币的音效，
       * 我也能听到」）。实测一局里红方磨坊每次产金都在涨，而 `build` 之前是全场播 ——
       * 红方立好一栋楼也响一串木材敲击，听起来就像"对面拿了一笔钱"。
       *
       * 战斗音（开火 / 命中 / 阵亡 / 倒塌）仍双方都播：它们发生在玩家视野里，
       * 静音反而会让战场变哑。规则见 docs/工作笔记/AI决策架构_20261106.md 的音效分层表。
       */
      if (group.userData['side'] === 'blue') {
        this.sfx.play('build');
        this.rig.shake(0.16);
      }
      info.shell?.setBuild(1);
      group.scale.setScalar(BUILDING_SCALE);
      if (info.banner) info.banner.group.visible = true;
      if (info.scaffold) info.scaffold.userData['fold'] = 0.25;
    }

    const sc = info.scaffold;
    if (!sc) return;
    const fold = (sc.userData['fold'] as number | undefined) ?? 0.25;
    if (fold <= 0) return;
    const next = fold - dt;
    sc.userData['fold'] = next;
    sc.scale.y = Math.max(0.02, next / 0.25);
    sc.position.y = baseY;
    if (next <= 0) {
      this.scene.remove(sc);
      disposeTree(sc);
      info.scaffold = undefined;
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
      // 贴地影子：只跟位置（siege 车的影子是 group 子件，跟着车走，不用管）
      if (entry.shadow && !entry.siege) {
        entry.shadow.position.set(u.x, this.groundY(u.x, u.z) + 0.02, u.z);
      }
      /**
       * 受击闪白：unitFlash 里的时间戳和 entry 记的对上了就不重放；
       * 0.16 秒线性衰减，像素小人染 color（超白），锥体兜底往白 lerp 本色。
       */
      const mark = this.unitFlash.get(u.id);
      if (mark !== undefined && mark !== entry.lastFlashSeen) {
        entry.lastFlashSeen = mark;
        entry.flashLeft = 0.16;
      }
      if (entry.flashLeft > 0) {
        entry.flashLeft = Math.max(0, entry.flashLeft - dt);
        const k = entry.flashLeft / 0.16;
        if (entry.dude) entry.dude.setFlash(k);
        if (entry.flashMat && entry.flashBase) entry.flashMat.color.copy(entry.flashBase).lerp(FLASH_WHITE, k);
        for (const m of entry.flyMats ?? []) m.mat.color.copy(m.color).lerp(FLASH_WHITE, k * 0.8);
      }
      // 行军扬尘：每 0.4–0.65 秒在脚下放一小团（不是每帧，别把烟池吃满）
      entry.dustIn = Math.max(0, entry.dustIn - dt);
      if (moving && entry.dustIn <= 0) {
        entry.dustIn = 0.4 + Math.random() * 0.25;
        this.fx.dust(u.x, u.z, this.groundY(u.x, u.z) + 0.12);
      }

      if (entry.flying) {
        // 悬浮 + 轻微起伏/侧晃；转子转、扑翼机机翼颤动；影子仍留在地上
        const t = this.lastFrame.time;
        entry.obj.position.set(u.x, this.groundY(u.x, u.z) + FLYER_STYLE.height + Math.sin(t * 1.5 + u.id) * 0.1, u.z);
        /**
         * 机头对准逻辑层的 aim（2026-11-07 用户："滑翔机甚至头没有对前，是歪过来滑的"）。
         * 旧版这一支**只设了 rotation.z（侧晃），从来没设 rotation.y** ⇒ 机体恒朝局部 +Z，
         * 而兵是往 +X 走的，看起来就是横着漂。公式见 flyers.ts 的 flyerYaw()。
         */
        const aim = u.aim ?? (u.side === 'blue' ? 0 : Math.PI);
        entry.obj.rotation.y = flyerYaw(aim);
        entry.obj.rotation.z = Math.sin(t * 1.2 + u.id) * 0.02;
        if (entry.rotor) {
          if (entry.rotorAxis === 'z') entry.rotor.rotation.z += dt * 5.5;
          else entry.rotor.rotation.y += dt * 0.8;
        }
        for (let i = 0; i < (entry.wings?.length ?? 0); i++) {
          entry.wings![i]!.rotation.z = (i === 0 ? 1 : -1) * Math.sin(t * 4) * 0.03;
        }
        continue;
      }
      if (entry.siege) {
        // 车头朝**逻辑层的 aim**：锁敌时对准目标（炮口/弩臂真的指过去），
        // 行军时朝行进方向。旧实现只在"这一步动了"时按位移改朝向，
        // 停下来开火就永远保持最后的行军角度（用户点名的"没把头对准敌人"）。
        const aim = u.aim ?? (u.side === 'blue' ? 0 : Math.PI);
        entry.face = -aim;
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
        // 左右朝向看**屏幕**：把当前的 aim（锁敌朝向 / 行军朝向）投到相机右向量上。
        // 旧实现用帧位移 dx,dz，站着开火时是 0 ⇒ 保持行军朝向 ⇒ 背对背开打。
        const aim = u.aim ?? (u.side === 'blue' ? 0 : Math.PI);
        entry.dude.setFlipX(facingFlip(Math.cos(aim), Math.sin(aim), this.rig.yaw, entry.dude.flipped));
        entry.dude.play(anim, time);
      } else {
        // 没有素材包：锥体直接跟着走，玩法读数照常
        entry.obj.position.set(u.x, this.groundY(u.x, u.z) + bodyH / 2, u.z);
      }
    }
    for (const [id, entry] of this.unitSprites) {
      if (alive.has(id)) continue;
      const x = entry.x, z = entry.z, ground = this.groundY(x, z);
      // 轰炸机飞出地图：直接消失，不播解体（用户："直到地图外面就是直接消失"）
      if (this.world.leftField.has(id)) {
        entry.dude?.dispose();
        entry.shadow?.removeFromParent();
        entry.obj.removeFromParent();
        this.unitSprites.delete(id);
        continue;
      }
      this.sfx.play('kill', { pitch: 0.85 + Math.random() * 0.3 });
      if (entry.siege || entry.flying) {
        // 车 / 飞机：解体碎在地上 + 冒火（用户第 2 条）
        const pieces = this.scatterPieces(entry.obj);
        this.fx.impact(x, z, ground, 'cannon', 1.3);
        this.fx.spark(x, z, ground + 0.4, 0, 0, 14);
        this.corpses.push({ obj: entry.obj, kind: 'wreck', life: CORPSE_SECONDS, x, z, pieces, fireIn: 0 });
      } else {
        // 小人：倒地不动（die 停在最后一帧）＋ 几团烟，过一会渐隐（用户第 1 条）
        entry.dude?.play('die', time, false);
        this.fx.death(x, z, ground + 0.5);
        this.corpses.push({ obj: entry.obj, kind: 'corpse', life: CORPSE_SECONDS, x, z, dude: entry.dude, fireIn: 0 });
      }
      entry.shadow?.removeFromParent();
      this.unitSprites.delete(id);
    }
  }

  /** 把车体/机体的第一层部件打散：各自给一点初速与自旋，落到地面就停。 */
  private scatterPieces(obj: THREE.Object3D): Corpse['pieces'] {
    const out: NonNullable<Corpse['pieces']> = [];
    for (const child of obj.children) {
      const a = Math.random() * Math.PI * 2;
      out.push({
        mesh: child,
        vx: Math.cos(a) * (0.4 + Math.random() * 0.8),
        vy: 0.6 + Math.random() * 0.9,
        vz: Math.sin(a) * (0.4 + Math.random() * 0.8),
        spin: (Math.random() - 0.5) * 4,
      });
    }
    return out;
  }

  /** 尸体/残骸每帧推进：碎块落地、火光持续 1.6 秒、最后 0.7 秒渐隐后移除。 */
  private stepCorpses(dt: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i]!;
      c.life -= dt;
      if (c.kind === 'wreck') {
        for (const p of c.pieces ?? []) {
          p.vy -= 3.2 * dt;
          p.mesh.position.x += p.vx * dt;
          p.mesh.position.y += p.vy * dt;
          p.mesh.position.z += p.vz * dt;
          p.mesh.rotation.z += p.spin * dt;
          if (p.mesh.position.y < -0.2) {
            p.mesh.position.y = -0.2;
            p.vy = 0;
            p.vx *= 0.8;
            p.vz *= 0.8;
          }
        }
        c.fireIn -= dt;
        if (c.fireIn <= 0 && c.life > CORPSE_SECONDS - 1.6) {
          c.fireIn = 0.26;
          const ground = this.groundY(c.x, c.z);
          this.fx.spark(c.x + (Math.random() - 0.5) * 0.6, c.z + (Math.random() - 0.5) * 0.6, ground + 0.35, 0, 0, 6);
          this.fx.dust(c.x, c.z, ground + 0.4);
        }
      }
      const fade = Math.min(1, Math.max(0, c.life / 0.7));
      c.obj.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) { m.transparent = true; m.opacity = fade; }
      });
      if (c.life <= 0) {
        c.dude?.dispose();
        c.obj.removeFromParent();
        if (c.kind === 'wreck') c.obj.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const m = mesh.material;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else if (m) m.dispose();
        });
        this.corpses.splice(i, 1);
      }
    }
  }

  /** 三架飞行器：按 defId 取对应模型，悬浮 + 贴地影子 + 闪白材质副本。 */
  private makeFlyerUnit(u: ArenaUnit): UnitSprite {
    const accent = sideColor(u.side);
    const model = u.defId === 'balloon' ? makeBalloon(accent)
      : u.defId === 'airscrew' ? makeAirscrew(accent)
        : makeBomber(accent);
    const g = model.group;
    // 开局就给对朝向，别等第一帧 syncUnits 才转过来（出兵那一瞬间会闪一下歪的）
    g.rotation.y = flyerYaw(u.aim ?? (u.side === 'blue' ? 0 : Math.PI));
    g.position.set(u.x, this.groundY(u.x, u.z) + FLYER_STYLE.height, u.z);
    this.scene.add(g);
    // 影子跟着体型放大：热气球最大，别还是原来那个小椭圆
    const shadowSize = FLYER_STYLE.shadow[u.defId as keyof typeof FLYER_STYLE.shadow] ?? 1.2;
    const shadow = makeShadow(shadowSize, shadowSize * 0.75);
    shadow.position.set(u.x, this.groundY(u.x, u.z) + 0.02, u.z);
    this.scene.add(shadow);
    return {
      obj: g, dude: null, pushers: [], siege: false, face: 0,
      x: u.x, z: u.z, cooldown: u.cooldown, attackLeft: 0, runHold: 0, dustIn: 0,
      shadow, flashLeft: 0, flying: true,
      rotor: model.rotor, rotorAxis: model.rotorAxis, wings: model.wings,
      flyMats: model.mats.map((m) => ({ mat: m, color: m.color.clone() })),
    };
  }

  private makeSprite(u: ArenaUnit): UnitSprite {
    // 三个飞行器是纯 3D 模型，不依赖像素小人素材包
    if (FLYER_IDS.has(u.defId)) return this.makeFlyerUnit(u);
    // 没有素材包就退成一枚阵营色锥体：玩法照常，只是看不到像素小人
    if (!this.pack || !this.gallery) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.24, UNIT_HEIGHT, 6),
        new THREE.MeshStandardMaterial({ color: sideColor(u.side), flatShading: true, roughness: 0.7 }),
      );
      cone.position.set(u.x, this.groundY(u.x, u.z) + UNIT_HEIGHT / 2, u.z);
      this.scene.add(cone);
      const shadow = makeShadow(0.5, 0.36);
      shadow.position.set(u.x, this.groundY(u.x, u.z) + 0.02, u.z);
      this.scene.add(shadow);
      return { obj: cone, dude: null, pushers: [], siege: false, face: 0, x: u.x, z: u.z, cooldown: u.cooldown, attackLeft: 0, runHold: 0, dustIn: 0, shadow, flashLeft: 0, flashMat: cone.material as THREE.MeshStandardMaterial, flashBase: (cone.material as THREE.MeshStandardMaterial).color.clone() };
    }
    if (statsOf(u.defId).siege) return u.defId === 'ballista' ? this.makeBallista(u) : this.makeSiege(u);
    const def = unitDef(u.defId);
    const style = this.styleOf(u.side, def.id, def);
    const { atlas, texture } = this.gallery.acquire(style, def.anims);
    const bodyH = def.heightTiles ?? UNIT_HEIGHT;
    const dude = new DudeSprite(this.pack, atlas, texture, { ...DEFAULT_APPEARANCE, height: bodyH });
    dude.mesh.position.y = this.groundY(u.x, u.z) + bodyH / 2;
    this.scene.add(dude.mesh);
    const shadow = makeShadow(0.55, 0.4);
    shadow.position.set(u.x, this.groundY(u.x, u.z) + 0.02, u.z);
    this.scene.add(shadow);
    return { obj: dude.mesh, dude, pushers: [], siege: false, face: 0, x: u.x, z: u.z, cooldown: u.cooldown, attackLeft: 0, runHold: 0, dustIn: 0, shadow, flashLeft: 0 };
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
    // 影子是 group 的子件：车转影子跟着转（攻城车的椭圆比小人一个大圈）
    group.add(makeShadow(1.9, 1.05));
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
      flashLeft: 0,
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
    // 影子是 group 的子件：车转影子跟着转（攻城车的椭圆比小人一个大圈）
    group.add(makeShadow(1.9, 1.05));
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
      flashLeft: 0,
    };
  }

  /** 当前视口的"整幅场地入画"缩放（调试面板用它换算 zoom 倍率）。 */
  get fitZoomNow(): number {
    return this.fitZoom;
  }

  /** 相机当前读数：调试面板打开时用它**同步滑杆**（而不是反过来把相机拽到滑杆值）。 */
  get cameraShotNow(): { yaw: number; pitch: number; zoom: number } {
    return {
      yaw: Math.round(this.rig.yaw),
      pitch: Math.round(this.rig.pitch),
      zoom: this.rig.zoom / Math.max(1e-6, this.fitZoom),
    };
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

  /** 阵营色带（2026-11-06 花色系统）：小人**严格按花色**穿——主色作衣、次色作镶边。
   *  旧做法是从素材包的蓝/红色带里挑一条，玩家没法自定义；现在直接写 hex，
   *  suit2 的阴影由烘图时自动加深，任意颜色都成立。头脸仍从兵种自己的区间里挑。 */
  private styleOf(side: Side, unitId: string, def: ReturnType<typeof unitDef>): DudeStyle {
    const key = `${side}:${unitId}`;
    const hit = this.styles.get(key);
    if (hit) return hit;
    if (!this.pack) throw new Error('没有素材包');
    const rng = new Random(hashString(`${this.seed}:arena:${key}`));
    const base = randomStyle(rng, this.pack);
    const banner = sideBanner(side);
    const style: DudeStyle = {
      ...base,
      head: rng.pick(headCandidates(def, this.pack)),
      face: rng.pick(faceCandidates(def, this.pack)),
      hex: { ...base.hex, suit: banner.primary, more: banner.secondary },
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
        // 楼体随机转了 spin，炮口要把这个角度补回来（否则一转就指偏）
        const want = -b.aim - (part.spin ?? 0);
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
            ? makeBall(0.16, 0x1a1d24, 0x000000, 'cannon')
            : s.ammo === 'magic'
              ? makeBall(0.11, 0x74e0ff, 0x74e0ff, 'magic')
              : makeArrow();
        this.scene.add(mesh);
        this.shotMeshes.set(s.id, mesh);
        const ground = this.map.surfaceY(worldToCell(s.fromX, s.fromZ));
        const fromY = ground + MUZZLE_Y[s.source];
        const targetGround = this.map.surfaceY(worldToCell(s.toX, s.toZ));
        mesh.userData['fromY'] = fromY;
        mesh.userData['toY'] = targetGround + 0.7;
        mesh.userData['hit'] = { x: s.toX, z: s.toZ, ground: targetGround, ammo: s.ammo, targetId: s.targetId };
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
        // 开火音：炮弹是"咚"，箭/法术是"嗖"（法术用稍高的音高区分）
        if (s.ammo === 'cannon') this.sfx.play('cannon');
        else if (s.ammo === 'arrow') this.sfx.play('arrow', { pitch: s.source === 'ballista' ? 1.15 : 1 });
        else this.sfx.play('arrow', { pitch: 1.5 });
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
        | { x: number; z: number; ground: number; ammo: 'arrow' | 'cannon' | 'magic'; targetId?: number }
        | undefined;
      if (hit) {
        // 火星现在由 impact 按弹种自己放（炮弹 10 颗 / 法术 5 / 箭 3），这里别再补一遍
        this.fx.impact(hit.x, hit.z, hit.ground, hit.ammo, hit.ammo === 'cannon' ? 1.3 : 0);
        this.sfx.play('impact', { pitch: hit.ammo === 'cannon' ? 0.72 : hit.ammo === 'magic' ? 1.3 : 1 });
        // 弹丸命中帧：被打的小人闪白（伤害早就结算了，这是纯渲染层的确认帧）
        if (hit.targetId !== undefined) this.unitFlash.set(hit.targetId, this.lastFrame.time);
      }
      this.scene.remove(mesh);
      // 箭的几何体/材质是全场共用的（ARROW_GEO/ARROW_MAT），不能 dispose；
      // 炮弹和法术弹是每次新建的，要释放。尾巴（TRAIL_*）同样是共用的，跳过。
      if (hit?.ammo !== 'arrow') {
        mesh.traverse((o) => {
          const part = o as THREE.Mesh;
          if (part.userData['trail']) return;
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

  /**
   * 一种"没有事件只有状态"的声音：这局结束。
   *
   * 其余音效都挂在具体动作的钩子上（开火、命中、完工、倒塌、阵亡），
   * 只有这个是"每帧比一下上一帧"——世界层不报这件事，它只报结果。
   *
   * （金币到账的 coin 原来也在这里，2026-11-06 用户嫌吵"把它关掉吧"——
   * 2 秒一格的节奏音 + 磨坊产金，声音比动作密得多，撤了。）
   */
  private audioCues(): void {
    const outcome = this.world.outcome;
    if (outcome !== this.lastOutcome) {
      if (outcome === 'win') this.sfx.play('win');
      else if (outcome === 'lose') this.sfx.play('lose');
      this.lastOutcome = outcome;
    }
  }

  /**
   * 近战命中：贴身的火星 + 一小团土（2026-11-05）。
   *
   * 远程不在这里 —— 它们的特效在弹丸飞到目标那一刻由 `impact` 放（按弹种分三种碎片），
   * 这里只管"没有飞行物的那一下"。
   */
  private syncHits(): void {
    const live = new Set<number>();
    for (const h of this.world.hits) {
      live.add(h.id);
      if (this.seenHits.has(h.id)) continue;
      this.seenHits.add(h.id);
      this.fx.melee(h.x, h.z, this.groundY(h.x, h.z) + h.y, h.dirX, h.dirZ, h.heavy);
      this.sfx.play('melee', { pitch: h.heavy ? 0.78 : 1 });
      // 近战命中帧：被打的小人闪白（远程的在 syncShots 命中帧）
      if (h.unitId !== undefined) this.unitFlash.set(h.unitId, this.lastFrame.time);
    }
    for (const id of this.seenHits) if (!live.has(id)) this.seenHits.delete(id);
  }

  /** 废墟：被拆掉的楼在原地留一堆碎石，RUIN.seconds 之后自己塌平（最后几秒淡出）。 */
  /**
   * 残骸下沉：smoothstep 缓入缓出，前 SINK_DUST_SECONDS 秒持续补尘。
   *
   * 地面是实体地块，深度测试会把沉下去的部分自然遮住 —— 不用做剖面或遮罩。
   * 销毁时**只 remove、不 dispose 几何**：模型里的 BoxGeometry / 血条 plane 是共享的，
   * dispose 会把场上其它楼一起弄没。
   */
  private stepSinking(dt: number): void {
    for (let i = this.sinking.length - 1; i >= 0; i--) {
      const s = this.sinking[i]!;
      s.life += dt;
      const k = Math.min(1, s.life / SINK_SECONDS);
      const ease = k * k * (3 - 2 * k);
      s.group.position.y = s.baseY - ease * s.depth;
      s.group.scale.setScalar(BUILDING_SCALE * (1 - 0.1 * ease));

      if (s.life < SINK_DUST_SECONDS) {
        s.dustIn -= dt;
        if (s.dustIn <= 0) {
          s.dustIn = 0.17;
          this.fx.collapsePuff(s.x, s.z, s.baseY);
        }
      }

      if (k >= 1) {
        this.scene.remove(s.group);
        this.sinking.splice(i, 1);
      }
    }
  }

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

  /**
   * 镜头该盯哪儿（导演每帧拿它做"回中"目标）。
   *
   * 1v1：场地正中 —— 两边都看得见；
   * PVE：**自家防区**（col 的 28% 处）。塔防 90% 的时间玩家在看自己的楼，
   * 盯着场地正中会把整条防线顶到画面下沿、被手牌挡住（实测截图就是这样）。
   */
  private fieldCenter(): { x: number; z: number } {
    const col = this.world.mode === 'pve' ? this.world.field.cols * 0.28 : this.world.field.cols / 2;
    return { x: col, z: this.world.field.rows / 2 };
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

