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
import { buildModel, geometryFor, keepBaseOffset, mergeGeometry, spinnersOf, type Node, type Part } from '@game/models/kit';
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

  it('模型里没有悬空的件：每件要么贴地，要么从下方被别的件托住', () => {
    const floaters: string[] = [];
    for (const [name, spec] of Object.entries(buildingModels)) {
      const boxes = spec.map(partBox);
      boxes.forEach((box, i) => {
        if (box.min.y <= EPS) return; // 落地的（地基、墙、柱脚）
        const supported = boxes.some((other, j) => {
          if (j === i) return false;
          // 托件必须从下方够到件底：托件起点在件底以下，托件顶够得到件底附近
          return other.min.y < box.min.y && other.max.y >= box.min.y - SUPPORT_GAP;
        });
        if (!supported) {
          floaters.push(`${name}#${i} ${spec[i]!.part.kind} y:${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}`);
        }
      });
    }
    expect(floaters.join(' | '), '下方有缝、谁也托不住的件').toBe('');
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
      view.applyProgress(b, 0);
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

/**
 * 会转的件（风车帆）。
 *
 * 锁三件事：① 四叶的轴心必须是同一个点 —— 各转各的，轮子会散架；
 * ② 没封顶不许转（半截塔上飞转的帆看着像穿模）；
 * ③ 封顶后每帧真的在转，转速就是模型里写的那个数。
 */
describe('风车帆', () => {
  it('四片帆绕同一个轮毂，封顶之后才转起来', () => {
    const spec = buildingModels.mill!;
    const sails = spec.filter((node) => node.spin);
    expect(sails.length).toBe(24); // 4 叶 × (帆杆 + 梢 + 帆布 + 3 横肋)

    const pivots = new Set(sails.map((node) => node.pivot!.join(',')));
    expect(pivots.size, '四叶的轴心必须同一个点').toBe(1);
    const speed = sails[0]!.spin!;
    expect(speed).toBeGreaterThan(0);

    const view = new BuildingView(new ModelLibrary());
    const def = buildingDef('mill');
    const b = {
      id: 7,
      def,
      origin: pos(6, 6),
      cols: def.footprint.cols,
      rows: def.footprint.rows,
      progress: 0.5,
      built: false,
      surfaceY: 0.5,
      placedAt: 0,
      rally: null,
      hp: def.hp,
    } as Building;
    view.add(b);

    const body = view.group.children[0]!.children[0]!;
    const spinners = spinnersOf(body);
    expect(spinners.length).toBe(24);
    const angleOf = () => spinners[0]!.group.rotation.z;

    // 盖到一半：一动不动
    view.applyProgress(b, 1);
    expect(angleOf()).toBe(0);

    // 封顶：一秒转 speed 弧度
    b.built = true;
    b.progress = 1;
    view.applyProgress(b, 1);
    expect(angleOf()).toBeCloseTo(speed, 6);
    view.applyProgress(b, 0.5);
    expect(angleOf()).toBeCloseTo(speed * 1.5, 6);
  });
});

/**
 * 屋顶浮空 —— 这条是"截图看出来的"，不是"算出来的"。
 *
 * 原来那条"没有悬空的件"只看 Y：一根细柱子能从 0.1 顶到 0.9，于是浮在 0.63 的屋顶
 * 也算"被柱子托住"。实测画面里就是四栋楼**屋顶整片浮在墙上方**（兵营 / 弓手营 /
 * 精炼厂 / 神龛）。根因是同一个：prism、cone、plinth 的 at 是**底面**，
 * 而 box、cyl、cone(sphere) 的 at 是**中心** —— 墙按中心锚点写在 0.1~0.2，
 * 其实整面墙陷进地里，屋顶的底面就悬在墙顶上方 0.14~0.39。
 *
 * 判据换成"谁真的托着它"：
 *   ① 在所有"水平上压着它"的件里，挑**重叠面积最大**的那一个（细柱子自动出局）；
 *   ② 那个件的顶面必须够到件的底面（容差 0.06）；或者
 *   ③ 件心落在托件的体积里（嵌进去的靶心、套在炮管上的铁环、挂在墙上的轮毂）。
 * 自转件（风车帆）挂在轴上，不参与。
 */
describe('屋顶不许浮在墙上', () => {
  const TOL = 0.09;

  it('每个件都得有托件够到它的底面，而且压得住', () => {
    const floaters: string[] = [];
    for (const [name, spec] of Object.entries(buildingModels)) {
      const boxes = spec.map((node) => new THREE.Box3().setFromObject(buildModel([node])));
      boxes.forEach((box, i) => {
        if (box.min.y <= 0.02) return; // 落地的
        if (spec[i]!.float) return; // 设计上就悬空的（魔法塔的磁浮晶核）
        // 挂在杆上的布：靠上沿用同一高度挂住，不是被托在下面。
        // 这条不能变成"有 hang 就放行" —— 必须真的找到一个顶边和它齐平、且水平压着的件
        if (spec[i]!.hang) {
          const hung = boxes.some((o, j) => {
            if (j === i) return false;
            const ox = Math.min(box.max.x, o.max.x) - Math.max(box.min.x, o.min.x);
            const oz = Math.min(box.max.z, o.max.z) - Math.max(box.min.z, o.min.z);
            // 旗面是平面，Box3 厚度正好 0 —— 用 oz > 0 永远不成立，这里允许"贴住"
            return ox > 1e-4 && oz >= -1e-4 && Math.abs(o.max.y - box.max.y) <= 0.1;
          });
          if (hung) return;
        }
        // 自转件要挂在轴上才算数：轴心必须插在别的件里。
        // 只按"有 spin 就跳过"是不够的 —— 魔法塔的晶核也带 spin，
        // 于是"悬空"这件事被"自转"这条豁免顺手吃掉了（反证时才发现锁根本没红）。
        if (spec[i]!.spin && spec[i]!.pivot) {
          const p = spec[i]!.pivot!;
          const mounted = boxes.some(
            (o, j) =>
              j !== i &&
              p[0] >= o.min.x - 0.1 &&
              p[0] <= o.max.x + 0.1 &&
              p[1] >= o.min.y - 0.1 &&
              p[1] <= o.max.y + 0.1 &&
              p[2] >= o.min.z - 0.1 &&
              p[2] <= o.max.z + 0.1,
          );
          if (mounted) return;
        }
        const center = box.getCenter(new THREE.Vector3());
        const area = (box.max.x - box.min.x) * (box.max.z - box.min.z);

        let touching = 0; // 顶面正好托在件底（±0.09）的件数
        let bestCover = 0; // 其中单个件覆盖了件底多少面积
        let held = false;
        for (let j = 0; j < boxes.length && !held; j++) {
          if (j === i) continue;
          const other = boxes[j]!;
          const ox = Math.min(box.max.x, other.max.x) - Math.max(box.min.x, other.min.x);
          const oz = Math.min(box.max.z, other.max.z) - Math.max(box.min.z, other.min.z);
          if (ox <= 0 || oz <= 0) continue;
          const cover = area > 0 ? (ox * oz) / area : 0;
          const centered =
            center.x >= other.min.x && center.x <= other.max.x &&
            center.z >= other.min.z && center.z <= other.max.z;
          // ① 托件顶正好托在件底
          if (Math.abs(other.max.y - box.min.y) <= TOL) {
            touching++;
            bestCover = Math.max(bestCover, cover);
            // 单件压得住（墙托屋顶），或者件心正对着它（杆子托伞盖）
            if (cover >= 0.25 || centered) held = true;
          }
          // ② 件整根在托件的高度范围里（横管插进烟囱）
          if (other.min.y <= box.min.y + 0.02 && other.max.y >= box.max.y - 0.02) held = true;
          // ③ 件底插进托件里且压得住（烟囱穿过屋面）
          if (box.min.y >= other.min.y - 0.02 && box.min.y <= other.max.y && cover >= 0.3) held = true;
          // ④ 件心落在托件体积里（轮毂挂在墙上、铁环套在炮管上）
          if (centered && other.min.y <= center.y && center.y <= other.max.y) held = true;
        }
        // ⑤ 三根以上的角柱撑起一片屋顶：单根只盖几个百分点，合起来才是这个屋顶的腿
        if (!held && touching >= 3) held = true;

        if (!held) {
          floaters.push(
            `${name}#${i} ${spec[i]!.part.kind} 底 ${box.min.y.toFixed(2)}｜托到它底面的件 ${touching} 个，最多覆盖 ${(bestCover * 100).toFixed(0)}%`,
          );
        }
      });
    }
    expect(floaters.join(' | '), '水平上没人托住的件（屋顶浮空就是从这来的）').toBe('');
  });
});

/**
 * 旗子的风向 —— 这条是用户看出来的："为什么他们的风向不一样啊？"
 *
 * 当时左旗用 `rot: [0, π, 0]` 翻面：旋转会把局部 +Z 翻到世界 -Z，
 * 两面旗的抖动相位正好相反，屏幕上就是两股对着吹的风。
 * 正确做法是镜像几何（`part.dir = -1`），风向仍是同一阵。
 */
describe('旗子的风向', () => {
  it('同一栋楼的旗子不靠旋转翻面，而且朝同一侧飘', () => {
    for (const [name, spec] of Object.entries(buildingModels)) {
      const dirs = new Set<number>();
      for (const node of spec) {
        if (node.part.kind !== 'flag') continue;
        const ry = node.rot?.[1] ?? 0;
        expect(
          Math.abs(Math.sin(ry)),
          `${name} 的旗面被绕 Y 转过：局部 +Z 会翻到世界 -Z，风向就反了（要用 dir: -1 镜像）`,
        ).toBeLessThan(1e-6);
        dirs.add(node.part.dir ?? 1);
      }
      if (dirs.size > 0) expect(dirs.size, `${name} 的几面旗朝向不一致`).toBe(1);
    }
  });
});

/**
 * 炮台转向的锁。
 *
 * 炮塔"能转"这件事有三层，缺一层就白做：装配（件在转台里）→ 被调用（每帧转）→
 * **转得对**（方位角对、限速、走最短弧）。这里钉第三层。
 */
describe('炮塔转向', () => {
  const make = () => {
    const view = new BuildingView(new ModelLibrary());
    const def = buildingDef('cannonTower');
    const b = {
      id: 11,
      def,
      origin: pos(6, 6),
      cols: def.footprint.cols,
      rows: def.footprint.rows,
      progress: 1,
      built: true,
      surfaceY: 0.5,
      placedAt: 0,
      rally: null,
      hp: def.hp,
    } as Building;
    view.add(b);
    const body = view.group.children[0]!.children[0]!;
    const turret = body.userData.turret as THREE.Group | undefined;
    return { view, b, turret };
  };

  it('炮管四件真的被收进了一个转台', () => {
    const { turret } = make();
    expect(turret, '炮塔必须有一个可转的转台').toBeTruthy();
    expect(turret!.children.length).toBe(4); // 炮盘 / 炮车 / 炮管 / 炮口箍
    expect(turret!.position.y).toBeCloseTo(1.22, 6);
  });

  it('朝 +X 的敌人转成 +90°，而且每帧限速不瞬移', () => {
    const { view, b, turret } = make();
    // 目标在正 +X：atan2(dx, dz) = atan2(+, 0) = +90°
    view.aimAt(b.id, 20, 6.5, 1);
    expect(turret!.rotation.y).toBeCloseTo(Math.PI / 2, 6);
    // 转回去，一帧只走 speed*dt
    const before = turret!.rotation.y;
    view.aimAt(b.id, 6.5, -20, 0.016);
    const moved = Math.abs(turret!.rotation.y - before);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(3.2 * 0.016 + 1e-9);
  });
});
