/**
 * 模型库 —— 名字进，Group 出。
 *
 * 每次 `create()` 都新建一层 Group，但几何体与材质走全局缓存：
 * 三百栋房子是三百个变换矩阵，不是三百份顶点数据。
 */

import * as THREE from 'three';
import { buildModel, type ModelSpec } from './kit';
import { buildingModels } from './buildings';
import { propModels } from './props';

const ghostCache = new Map<number, THREE.MeshStandardMaterial>();

/** 幽灵材质按颜色缓存；换颜色只是换个引用，不会多出新的着色器程序。 */
export function ghostMaterialFor(tint: number): THREE.MeshStandardMaterial {
  const cached = ghostCache.get(tint);
  if (cached) return cached;
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    flatShading: true,
    roughness: 0.6,
  });
  ghostCache.set(tint, mat);
  return mat;
}

export class ModelLibrary {
  private readonly specs = new Map<string, ModelSpec>();

  constructor() {
    this.registerAll(buildingModels);
    this.registerAll(propModels);
  }

  register(name: string, spec: ModelSpec): void {
    this.specs.set(name, spec);
  }

  registerAll(table: Record<string, ModelSpec>): void {
    for (const [name, spec] of Object.entries(table)) this.specs.set(name, spec);
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  get names(): string[] {
    return [...this.specs.keys()];
  }

  /** 未知名字不抛异常——一个空 Group 让地图少一个崩点，问题交给控制台那行 warn。 */
  create(name: string): THREE.Group {
    const spec = this.specs.get(name);
    if (!spec) {
      console.warn(`[ModelLibrary] 没有名为 "${name}" 的模型`);
      return new THREE.Group();
    }
    return buildModel(spec);
  }
}
