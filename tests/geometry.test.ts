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
import { buildModel, geometryFor, keepBaseOffset, mergeGeometry, type Node, type Part } from '@game/models/kit';
import { BUILDINGS, buildingDef } from '@game/data/buildings';
import { ModelLibrary } from '@game/models/registry';
import { BuildingView } from '@game/world/BuildingView';
import type { Building } from '@game/world/GameWorld';
import { pos } from '@engine/math/Grid';

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

/**
 * 脚底与悬空 —— 截图断掉时唯一能量到的一类错。
 *
 * 两条判据都来自"楼放在占地内最高那块的表面上"这一条落位规矩
 * （`TileMap.footprintSurfaceY` 取 max，故意不让楼陷进地里）：
 * ① 既然取 max，占地内最矮的那几格上面就有一条缝 —— 现量真图最大落差 0.100，
 *    所以多格楼的模型底面必须至少探到 -0.10，不然那条缝会漏光，看着就是"悬空"。
 * ② 一份模型里每一件都必须有东西托着：贴地，或者压到另一件。
 *    工地的横梁原来浮在立柱头顶 0.31 处，画面上正是"脚手架立在半空"。
 */
describe('脚底与悬空', () => {
  const FOOT_GAP = 0.1;
  /** 落位规矩决定的缝：占地内最矮那块比楼底最多低这么多 */
  const EPS = 0.02;
  /** 一件要有东西托：贴地，或离最近的件不超过 0.05（约一格宽的 5%，肉眼看不出来） */
  const SUPPORT_GAP = 0.05;

  const partBox = (node: Node): THREE.Box3 => new THREE.Box3().setFromObject(buildModel([node]));

  it('多格楼的脚底裙够深：盖在落差最大的那处也不露缝', () => {
    const offenders: string[] = [];
    for (const def of Object.values(BUILDINGS)) {
      // 1×1 的楼只在自己那格上，不存在内部落差
      if (def.footprint.cols * def.footprint.rows <= 1) continue;
      const spec = buildingModels[def.model];
      expect(spec, `${def.id} 用的模型 "${def.model}" 不在模型表里`).toBeTruthy();
      const min = new THREE.Box3().setFromObject(buildModel(spec!)).min.y;
      if (min > -FOOT_GAP) offenders.push(`${def.name}(${def.model}) min.y=${min.toFixed(3)}`);
    }
    expect(offenders.join(' '), '脚底裙不够深的多格楼').toBe('');
  });

  it('每件模型都在锚点之下起步（min.y ≤ 0）', () => {
    for (const [name, spec] of Object.entries(buildingModels)) {
      const min = new THREE.Box3().setFromObject(buildModel(spec)).min.y;
      expect(min, `${name} 的底面高于锚点，整栋楼浮着`).toBeLessThanOrEqual(EPS);
    }
  });

  it('模型里没有悬空的件：每件要么贴地，要么压到别的件上', () => {
    const floaters: string[] = [];
    for (const [name, spec] of Object.entries(buildingModels)) {
      const boxes = spec.map(partBox);
      boxes.forEach((box, i) => {
        if (box.min.y <= EPS) return; // 落地的（地基、墙、柱脚）
        const probe = box.clone().expandByScalar(SUPPORT_GAP);
        const supported = boxes.some((other, j) => j !== i && other.intersectsBox(probe));
        if (!supported) {
          floaters.push(`${name}#${i} ${spec[i]!.part.kind} y:${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}`);
        }
      });
    }
    expect(floaters.join(' | '), '谁也托不住的件').toBe('');
  });
});

/**
 * 建造进度是"沿 Y 缩放"，而缩放会把模型最低点一起抬起来。
 * 各楼底面实测在 -0.54..0 之间（不是一句"底面都在 0"能盖过去的），
 * 所以 BuildingView 每档进度都要补一笔下移；这条锁的是那个补偿本身。
 */
describe('缩放时底面钉住', () => {
  it('缩放后的底面 = 原底面（从 15% 长到 100% 全程不抬离地面）', () => {
    for (const minY of [-0.54, -0.26, -0.16, -0.005, 0]) {
      for (const s of [0.15, 0.4, 0.7, 1]) {
        const bottom = minY * s + keepBaseOffset(minY, s);
        expect(bottom, `minY=${minY} scale=${s}`).toBeCloseTo(minY, 10);
      }
    }
  });
});

/**
 * 建造进度用沿 Y 缩放实现，缩放会把最低点一起抬起来 —— 这条锁的是"接上了补偿"这件事，
 * 而不是只锁公式：三档进度量同一个 body 的世界最低点，必须一样高。
 */
describe('工地长出来时底面不抬', () => {
  it('进度 0 / 0.5 / 1 三档，模型最低点都在同一高度', () => {
    const view = new BuildingView(new ModelLibrary());
    const def = buildingDef('magicTower'); // 底面 -0.485，是各楼里最容易看出抬起的一栋
    const b = {
      id: 1,
      def,
      origin: pos(4, 4),
      cols: def.footprint.cols,
      rows: def.footprint.rows,
      progress: 0,
      built: false,
      surfaceY: 0.5,
      placedAt: 0,
      rally: null,
      hp: def.hp,
    } as Building;
    view.add(b);
    const body = view.group.children[0]!.children[0]!;
    const bottoms = [0, 0.5, 1].map((p) => {
      b.progress = p;
      view.applyProgress(b);
      // 世界矩阵要连着父节点一起更新，否则量到的是相对父节点的数（root 的 surfaceY 会被吞掉）
      view.group.updateMatrixWorld(true);
      return new THREE.Box3().setFromObject(body).min.y;
    });
    expect(bottoms[1]).toBeCloseTo(bottoms[2], 6);
    expect(bottoms[0]).toBeCloseTo(bottoms[2], 6);
    // 而且真的钉在锚点上：surfaceY(0.5) + 模型原底面
    const original = new THREE.Box3().setFromObject(buildModel(buildingModels[def.model]!)).min.y;
    expect(bottoms[2]).toBeCloseTo(0.5 + original, 6);
  });
});
