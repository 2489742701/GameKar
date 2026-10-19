/**
 * 几何正确性 —— 在没有截图的环境里也能把"面朝向"这件事钉死。
 *
 * 判据：凸体的每个三角面，由绕序推出的法线必须背离自身形心。
 * 绕序反了的面会被正面剔除，在画面上的表现是"屋顶凭空少一块"，
 * 而那正是手写了顶点数组的 prism / plinth 最容易犯的错。
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildingModels } from '@game/models/buildings';
import { propModels } from '@game/models/props';
import { geometryFor, mergeGeometry, type Part } from '@game/models/kit';

const PARTS: Part[] = [
  { kind: 'box', size: [1, 1, 1] },
  { kind: 'prism', size: [1.5, 0.6, 1.2] },
  { kind: 'plinth', size: [1.8, 0.2, 1.8] },
  { kind: 'cyl', rTop: 0.3, rBottom: 0.4, height: 1.2, seg: 8 },
  { kind: 'cone', radius: 0.4, height: 0.6, seg: 8 },
  { kind: 'sphere', radius: 0.3, seg: 1 },
  { kind: 'crystal', radius: 0.2, height: 0.7 },
];

function outward(geo: THREE.BufferGeometry): number {
  const pos = geo.getAttribute('position');
  const center = new THREE.Vector3();
  geo.computeBoundingBox();
  geo.boundingBox!.getCenter(center);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const faceCenter = new THREE.Vector3();
  let inward = 0;

  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    normal.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (normal.lengthSq() < 1e-12) continue;
    faceCenter.addVectors(a, b).add(c).multiplyScalar(1 / 3);
    if (normal.dot(faceCenter.sub(center)) <= 0) inward++;
  }
  return inward;
}

describe('基本体绕序', () => {
  it.each(PARTS.map((p) => [p.kind, p] as const))('%s 的每个面都朝外', (_kind, part) => {
    const src = geometryFor(part);
    // 内建基本体是 indexed 的，按三连顶点直读会读出错位的"面"
    const geo = src.index ? src.toNonIndexed() : src;
    expect(geo.getAttribute('position').count % 3).toBe(0);
    expect(outward(geo)).toBe(0);
  });
});

describe('合批几何', () => {
  const models = { ...buildingModels, ...propModels };

  it.each(Object.keys(models))('%s 合批后三种顶点属性等长', (name) => {
    const geo = mergeGeometry(`lock:${name}`, models[name]!);
    const position = geo.getAttribute('position');
    const normal = geo.getAttribute('normal');
    const color = geo.getAttribute('color');

    expect(position.count).toBeGreaterThan(0);
    expect(normal.count).toBe(position.count);
    expect(color.count).toBe(position.count);
    expect(position.count % 3).toBe(0);
  });

  it('同一个 key 二次合批拿回的是同一份缓存，不会重复造顶点', () => {
    const spec = propModels.broadleaf!;
    expect(mergeGeometry('cache:shared', spec)).toBe(mergeGeometry('cache:shared', spec));
  });

  it('合批不污染原始几何：缓存里的 box 变换前后坐标逐位相同', () => {
    const boxGeo = geometryFor({ kind: 'box', size: [1, 1, 1] });
    const before = Float32Array.from(boxGeo.getAttribute('position').array as Float32Array);
    mergeGeometry('cache:pollution-check', propModels.rubble!);
    expect(boxGeo.getAttribute('position').array).toEqual(before);
  });
});
