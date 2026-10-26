/**
 * 建筑视图 —— 世界里的 Building 记录 ↔ 场景里的 Group，一一对应。
 *
 * 工地骨架和实体模型同时挂在同一个根节点上：
 * 实体按建造进度沿 Y 从 0.15 长到 1.0，骨架在封顶那一刻撤走。
 * 缩放会把模型最低点一起抬起来（各楼的底面实测在 -0.54..0 之间，不是"都在 0"），
 * 所以每一档进度都要按 `keepBaseOffset` 补一笔下移，底面才钉在同一处地面上。
 */

import * as THREE from 'three';
import { footprintCenter } from '@engine/math/Grid';
import { keepBaseOffset, spinnersOf, TURRET, type Spinner } from '@game/models/kit';
import type { ModelLibrary } from '@game/models/registry';
import type { Building } from './GameWorld';

const GROWN = 1;
const GROUNDED = 0.15;

interface Entry {
  root: THREE.Group;
  body: THREE.Group;
  site: THREE.Group;
  /** 会自转的件（风车帆…）；静物楼是空数组 */
  spinners: Spinner[];
  /** 可转炮台（炮塔才有）；瞄准时转它 */
  turret: THREE.Group | null;
  /** 炮台当前朝向（弧度，绕 Y） */
  yaw: number;
  /** 选中框要用的实际高度（含屋顶） */
  height: number;
  /** 未缩放时的最低点，缩放补偿按它算 */
  baseY: number;
  /** 脚手架倒塌进度 0=未塌 1=塌完；封顶那一刻从 0 开始推进 */
  collapse: number;
  /** 受损档 0=完好 1=轻损 2=重损；按 hp/def.hp 分档，变了才重算碎件 */
  damageLevel: number;
  /** 封顶那一刻还没报过（雾爆只放一次，靠它去重） */
  settled: boolean;
}

/**
 * 接地阴影：一张软化的黑圆，压在地面上。
 *
 * 方向光给的投影是"太阳打的"，只有俯角够低才看得见；俯角 50° 时楼根一圈是飘的。
 * 这张贴地阴影补的就是"楼和地面接在一起"这件事 —— 便宜、无光照、不参与排序。
 */
let contactTexture: THREE.CanvasTexture | null = null;
let contactMaterial: THREE.MeshBasicMaterial | null = null;
let contactGeometry: THREE.PlaneGeometry | null = null;

function contactShadowAssets(): {
  geometry: THREE.PlaneGeometry;
  mat: THREE.MeshBasicMaterial;
} | null {
  // 单测（node 环境）里没有 document：没有贴图就不画这张阴影，别让测试为了它去装 jsdom
  if (typeof document === 'undefined') return null;
  if (!contactTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    // 楼会盖住圆心那一块，真正露在外面的只有 0.5~1.0 半径这一圈，
    // 所以渐变的重心要往外压：正中给太黑等于白画（肉眼看就是"没有阴影"）
    const g = ctx.createRadialGradient(32, 32, 3, 32, 32, 31);
    g.addColorStop(0, 'rgba(0,0,0,0.5)');
    g.addColorStop(0.42, 'rgba(0,0,0,0.42)');
    g.addColorStop(0.72, 'rgba(0,0,0,0.2)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    contactTexture = new THREE.CanvasTexture(c);
  }
  if (!contactMaterial) {
    contactMaterial = new THREE.MeshBasicMaterial({
      map: contactTexture,
      // 贴图是"白 + alpha 渐变"，颜色必须显式压黑：材质默认白，
      // 忘了这一笔它就不是阴影而是一圈白光（A/B 实测：加进去之后地面平均亮了 1.4 级）
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
  }
  if (!contactGeometry) contactGeometry = new THREE.PlaneGeometry(1, 1);
  return { geometry: contactGeometry, mat: contactMaterial };
}

export class BuildingView {
  readonly group = new THREE.Group();
  private readonly entries = new Map<number, Entry>();
  private readonly box = new THREE.Box3();
  /** 封顶待报的 id（GameApp 每帧取走做一次雾爆） */
  private readonly justSettled: number[] = [];

  constructor(private readonly library: ModelLibrary) {
    this.group.name = 'buildings';
  }

  add(building: Building): void {
    const { origin, cols, rows, def } = building;
    const center = footprintCenter({ origin, cols, rows });

    const root = new THREE.Group();
    root.position.set(center.x, building.surfaceY, center.z);
    root.userData.buildingId = building.id;

    const body = this.library.create(def.model);
    const site = this.library.create('scaffold');
    // 骨架按 2x2 画的，小建筑按比例缩
    site.scale.set(cols / 2, 1, rows / 2);

    root.add(body, site);

    // 接地阴影：贴地一张软圆，楼根不再是"悬着的一块"。放最后加，
    // 因为外面按 children[0] 取 body（进度与测试都靠这个次序）
    const shadow = contactShadowAssets();
    if (shadow) {
      const decal = new THREE.Mesh(shadow.geometry, shadow.mat);
      decal.rotation.x = -Math.PI / 2;
      decal.position.y = 0.015;
      decal.scale.set(cols * 2.0, rows * 2.0, 1);
      decal.renderOrder = -1;
      root.add(decal);
    }

    this.group.add(root);

    this.box.setFromObject(body);
    const height = Math.max(0.4, this.box.max.y - this.box.min.y);
    const baseY = this.box.min.y;

    this.entries.set(building.id, {
      root,
      body,
      site,
      spinners: spinnersOf(body),
      turret: (body.userData[TURRET] as THREE.Group | undefined) ?? null,
      yaw: 0,
      height,
      baseY,
      collapse: 0,
      damageLevel: 0,
      settled: false,
    });
    this.applyProgress(building, 0);
  }

  remove(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.root.removeFromParent();
    // Group 里的 Mesh 共享缓存几何与材质，removeFromParent 就是全部要做的事
    this.entries.delete(id);
  }

  heightOf(id: number): number {
    return this.entries.get(id)?.height ?? 1;
  }

  /**
   * 把炮塔转向某个世界坐标。
   *
   * 炮管在模型里朝 +Z，所以目标方位角就是 `atan2(dx, dz)`。
   * 转的时候限速（默认 3.2 弧度/秒）并且走**最短弧**，不然从 +170° 转到 -170°
   * 会绕一整圈 —— 屏幕上就是炮台突然原地转一圈，很蠢。
   */
  aimAt(id: number, x: number, z: number, dt: number, speed = 3.2): void {
    const entry = this.entries.get(id);
    if (!entry?.turret) return;
    const from = entry.root.position;
    const want = Math.atan2(x - from.x, z - from.z);
    let diff = want - entry.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const step = Math.sign(diff) * Math.min(Math.abs(diff), speed * Math.max(0, dt));
    entry.yaw += step;
    entry.turret.rotation.y = entry.yaw;
  }

  /** 炮口的世界坐标（开火火光的落点）；没有炮台就返回 null。 */
  turretTip(id: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const entry = this.entries.get(id);
    if (!entry?.turret) return null;
    // 炮管朝 +Z、略上扬，所以炮口在 (0, 0.30, 0.86) 这个局部点上
    entry.turret.updateWorldMatrix(true, false);
    return out.set(0, 0.3, 0.86).applyMatrix4(entry.turret.matrixWorld);
  }

  /**
   * 取走"这一帧刚封顶"的楼 id（取完就清空）。
   * 雾爆要发生在封顶那一瞬，而冒雾那一路是 0.28 秒节流的 —— 只靠节流会漏掉这一刻。
   */
  takeSettled(): number[] {
    if (this.justSettled.length === 0) return [];
    const ids = this.justSettled.slice();
    this.justSettled.length = 0;
    return ids;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 逐帧同步进度与脚手架倒塌；只写缩放与一处下移，不做几何重建。 */
  applyProgress(building: Building, dt: number): void {
    const entry = this.entries.get(building.id);
    if (!entry) return;
    const p = building.progress;
    const s = GROUNDED + (GROWN - GROUNDED) * p;
    entry.body.scale.y = s;
    // 补回被缩放抬起来的那一段，底面才一直钉在地面上
    entry.body.position.y = keepBaseOffset(entry.baseY, s);

    // 帆板只在封顶之后转：半截塔上飞转的帆看着像穿模
    if (building.built && dt > 0) {
      for (const spin of entry.spinners) spin.group.rotation.z += spin.speed * dt;
    }

    if (building.built && !entry.settled) {
      entry.settled = true;
      this.justSettled.push(building.id);
    }

    if (!building.built) {
      entry.site.visible = true;
      entry.site.scale.y = 1;
      entry.site.rotation.z = 0;
      entry.collapse = 0;
      return;
    }
    // 封顶：脚手架倒塌 0.4 秒（压扁 + 倾斜），塌完才隐藏
    if (entry.collapse < 1) {
      entry.collapse = Math.min(1, entry.collapse + dt / 0.4);
      const k = entry.collapse;
      entry.site.visible = true;
      entry.site.scale.y = 1 - k * 0.85;
      entry.site.rotation.z = k * 0.5;
    } else {
      entry.site.visible = false;
    }

    const frac = building.hp / building.def.hp;
    const newLevel = frac > 0.66 ? 0 : frac > 0.33 ? 1 : 2;
    if (newLevel !== entry.damageLevel) {
      entry.damageLevel = newLevel;
      this.applyDamage(entry, building.id);
    }
  }

  /** 按 building.id 定序随机隐藏几个件，模拟"碎裂小部分"。跳过 index 0（地基）。 */
  private applyDamage(entry: Entry, id: number): void {
    const parts = entry.body.children;
    const count = parts.length;
    const breakCount = entry.damageLevel === 0 ? 0 : entry.damageLevel === 1 ? Math.min(2, count - 1) : Math.min(4, count - 1);
    const broken = new Set<number>();
    const span = Math.max(1, count - 1);
    let seed = 1 + (((id * 2654435761) >>> 0) % span);
    for (let i = 0; i < breakCount; i++) {
      seed = 1 + (((seed * 1103515245 + 12345) >>> 0) % span);
      broken.add(seed);
    }
    parts.forEach((child, i) => {
      child.visible = !broken.has(i);
    });
  }

  syncAll(buildings: Iterable<Building>, dt: number): void {
    for (const b of buildings) this.applyProgress(b, dt);
  }
}
