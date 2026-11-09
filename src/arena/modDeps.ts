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
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
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
import { cellToWorld } from '@engine/math/Grid';
import { ARENA_MODELS } from './models';
import { buildModel } from '@game/models/kit';

/** 注入给模组的 three 子集（不是完整命名空间，别改回 `import('three')`）。 */
export const modThree = {
  WebGLRenderer,
  Scene,
  Group,
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

/** 只借引擎，不借玩法：没有 ArenaWorld / config / ArenaApp。 */
export const modEngine = {
  GameLoop,
  Random,
  cellToWorld,
};

/**
 * 主游戏的**视觉资产工厂**（2026-11-09）：模组用它生成和 1v1 完全相同的建筑模型。
 * 依然是注入，不是让模组去 import 主程序 —— 隔离锁一条没松。
 */
export const modAssets = {
  ARENA_MODELS,
  buildModel,
};
