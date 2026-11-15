/**
 * 模组依赖的**具名**出口（2026-11-08）。
 *
 * 这里存在的唯一理由是包体积：如果在 `modHost` 里直接 `await import('three')`
 * 拿到整个命名空间对象，Rollup 就没法 tree-shake —— 实测 three 共享 chunk
 * 从 496 KB 涨到 **690 KB**（+39%），等于模组还没写，主程序首包先胖了一圈。
 * 改成在这里具名列出模组用得到的类，只保留这些导出，chunk 就回到原量级。
 *
 * 代价是契约收紧：模组只能用 `host.three` 里列出的类。要加新类就在这个文件里
 * **加一行**（仍然是注入，不是让模组去 import 主程序/three）。
 * 这也正是架构文档 §6 说的"host 注入面"—— 第一版按最小面给。
 */

import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  InstancedMesh,
  Object3D,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GameLoop } from '@engine/core/GameLoop';
import { Random } from '@engine/math/Random';
import { cellToWorld, pos } from '@engine/math/Grid';
import { Renderer } from '@engine/render/Renderer';
import { CameraRig } from '@engine/render/CameraRig';
import { LightingRig } from '@engine/render/Lighting';
import { TileMap } from '@game/world/TileMap';
import { GroundView } from '@game/world/GroundView';
import { TERRAIN, TERRAIN_ORDER } from '@game/config';
// 战斗口径：纯函数 + 纯数据，模组复用原版那一套（不是 Combat 类，那个要 GameWorld）
import { UNITS, damageOf, unitDef } from '@game/data/units';
import { levelScale } from '@game/systems/Combat';
import { ARENA_MODELS } from './models';
import { buildStand } from './stand';
import { AmbientDust } from './ambient';
import { installArenaBackdrop } from './visuals/backdrop';
import { TILT_SHIFT_SHADER } from './visuals/tiltShift';
import { ARENA_CAMERA, NO_BUILD, FIELD, BUILDING_SCALE } from './config';
import { MOD_API_VERSION, CARDS, ECONOMY, HAND, iconOf, createModHand, createModBank } from './modApi';
import { buildModel } from '@game/models/kit';
// P-087 续：「点击地面集结军队」要出主程序同款像素小人，这几个依然只作注入出口
import { DudeGallery, DudeSprite, DEFAULT_APPEARANCE } from '@game/dudes/DudeView';
import { loadPack } from '@game/dudes/pack';
import { randomStyle } from '@game/dudes/style';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/** 注入给模组的 three 子集（不是完整命名空间，别改回 `import('three')`）。 */
export const modThree = {
  WebGLRenderer,
  Scene,
  Group,
  InstancedMesh,
  Object3D,
  OrthographicCamera,
  Vector2,
  Vector3,
  Color,
  Line,
  LineSegments,
  BufferGeometry,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  Raycaster,
  AmbientLight,
  DirectionalLight,
  BoxGeometry,
  CircleGeometry,
  PlaneGeometry,
  SphereGeometry,
  BackSide,
  DoubleSide,
};

/**
 * 开放给模组的稳定 API（P-087）：卡池、卡面图标、手牌工厂。
 * 主程序玩法文件一行不动，只新增 `modApi.ts` 这个出口。
 */
export const modApi = {
  version: MOD_API_VERSION,
  CARDS,
  ECONOMY,
  HAND,
  iconOf,
  createModHand,
  createModBank,
};

/**
 * 只借引擎，不借玩法：没有 ArenaWorld / config / ArenaApp。
 *
 * **2026-11-15 补：战斗口径也在这里**。用户：「单位战斗原版中就有了」——
 * 意思是别在模组里重写一套攻防血，直接借原版那张表。所以这里放进来的是
 * **纯函数 + 纯数据**（`damageOf` / `unitDef` / `UNITS` / `levelScale`），
 * 不是 `Combat` 类 —— 后者构造时要一个 `GameWorld`（老模式的账本），
 * 模组拿不到也不该拿，那是"借玩法"，越线了。
 */
export const modEngine = {
  GameLoop,
  Random,
  cellToWorld,
  // ===== 战斗口径（纯函数 / 纯数据，原版唯一来源）=====
  /** 伤害 = max(1, 攻 − 防)。锁在 tests/combat.test.ts。 */
  damageOf,
  /** 兵种表查询，未知 id 会抛（别静默返回 undefined）。 */
  unitDef,
  /** 全部 19 个兵种，只读。 */
  UNITS,
  /** 升级缩放（攻/射程/装填），老模式三塔共用同一条。 */
  levelScale,
};

/**
 * 主游戏的**视觉资产工厂**（2026-11-09）：模组用它生成和 1v1 完全相同的建筑模型。
 * 依然是注入，不是让模组去 import 主程序 —— 隔离锁一条没松。
 */
export const modAssets = {
  // 3D 模型
  ARENA_MODELS,
  buildModel,
  // 地图与地形：和 1v1 同一套 TileMap / GroundView / 看台围墙 / 浮尘
  TileMap,
  GroundView,
  TERRAIN,
  TERRAIN_ORDER,
  buildStand,
  AmbientDust,
  // 相机 / 光照 / 渲染 / 色彩管理 / 后期链
  CameraRig,
  LightingRig,
  Renderer,
  installArenaBackdrop,
  EffectComposer,
  RenderPass,
  OutputPass,
  ShaderPass,
  TILT_SHIFT_SHADER,
  // 坐标与常量
  cellToWorld,
  pos,
  ARENA_CAMERA,
  NO_BUILD,
  FIELD,
  BUILDING_SCALE,
  // 像素小人（集结军队用）：模组自己 loadPack，不碰主程序玩法
  loadPack,
  DudeGallery,
  DudeSprite,
  DEFAULT_APPEARANCE,
  randomStyle,
};
