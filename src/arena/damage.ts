/**
 * 建筑受伤的**渐进碎裂** —— 血量每跨过一档，外墙就崩掉一片：
 * 面片从 `WallShell` 上整块摘下来（洞是连成一片的），然后走简单弹道掉到地上。
 *
 * 落下去的就是**原来那块墙板**（尺寸、颜色、朝向都从模型里来），
 * 所以破洞的轮廓和地上的碎块是同一块东西 —— 不需要另画"破洞贴纸"。
 *
 * 物理只有重力 + 落地弹一下 —— P-096 起连这段也和废墟共用
 * `visuals/rigidFall.ts` 的 `stepRigid()`：角动量、摩擦、反弹只有一套常量，
 * 落地**不再瞬间把板子摆平**（那才是用户说的"斜躺着掉落却直直往下"）。
 * 生成顺序只由（楼号 + 第几档）决定，同一栋楼每次碎在同一个地方。
 *
 * **P-097（2026-11-12）破损第一次有了反向播放**：自动修复把血补回去时，
 * `sync()` 会把该档崩掉的面片**原数拼回**墙上，墙片顺手染成木色（`WallShell.restore`），
 * 再由 `visuals/repairPlanks.ts` 生成一块带木纹和钉头的木板飞回原位钉上。
 * 于是"血补回去了"在画面上就是"破口一块块补了木板"，不是墙凭空复原。
 * ⚠️ 拼回是**施工**（解析插值），不套用掉落的刚体物理 —— 目标位明确、到位就停。
 */

import * as THREE from 'three';
import { Random } from '@engine/math/Random';
import type { HitKind } from './ArenaWorld';
import type { ShellPanel } from './models';
import type { WallShell } from './shell';
import { stepRigid, type RigidState } from './visuals/rigidFall';
import {
  PLANK,
  makePlankGeometry,
  plankColor,
  plankPoseAt,
  plankSeed,
  type PlankFlight,
} from './visuals/repairPlanks';

/** 血量分数降到这些值时各崩一次（从高到低）。 */
export const HIT_THRESHOLDS = [0.8, 0.62, 0.45, 0.29, 0.15] as const;

/** 这个血量应该已经崩过几次（纯函数，给锁用）。 */
export function hitsFor(frac: number): number {
  let n = 0;
  for (const t of HIT_THRESHOLDS) if (frac <= t) n += 1;
  return n;
}

/**
 * 视觉破损的**滞后带**（P-097）。血量恰好卡在阈值上时，若没有这层，
 * 一帧回血一帧挨打就会在同一档反复"崩一片 / 拼一片"，火星和木屑一起刷屏。
 *
 * - 往下掉血：要 `frac + margin <= t` 才崩（即 frac 掉到 t − margin 以下）；
 * - 往上涨血：要 `frac − margin > t` 才拼回（即 frac 涨到 t + margin 以上）；
 * - 中间这段保持当前档数不动。
 *
 * 只作用于**视觉**（这一层没有任何血量写入），逻辑层的 HP / 修复判据一个字没改。
 */
export const BREAK_HYSTERESIS = 0.02;

/** 给定血量分数与当前档数，算这一帧该停在第几档（纯函数，锁用）。 */
export function targetHits(frac: number, current: number): number {
  // ⚠️ 必须先把 ±margin 的结果收敛到 6 位小数：0.27 + 0.02 在 IEEE754 里是
  // 0.29000000000000004，恰好比阈值 0.29 大一丁点，`hitsFor()` 就会少算一档，
  // 滞后带的边界变成看浮点脸色。这条是 p097 测试逼出来的，别删。
  const round = (v: number): number => Math.round(v * 1e6) / 1e6;
  const mustBreak = hitsFor(Math.min(1, round(frac + BREAK_HYSTERESIS)));
  const mayRestore = hitsFor(Math.max(0, round(frac - BREAK_HYSTERESIS)));
  return Math.min(mayRestore, Math.max(mustBreak, current));
}

export interface DamageInfo {
  /** 楼心（世界坐标） */
  center: { x: number; z: number };
  /** 地面高度（世界坐标 y） */
  groundY: number;
  /** 模型单位的缩放（BUILDING_SCALE） */
  scale: number;
  seed: number;
}

interface Chunk {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  /** 躺平后的中心高度（也是刚体的地面） */
  restY: number;
  rest: boolean;
  /** 落地之后活了多久（用来"过一会儿慢慢消失"，见 DEBRIS_LIFE） */
  age: number;
}

interface Damaged extends DamageInfo {
  id: number;
  hits: number;
  shell: WallShell;
  /**
   * P-097：每一档**实际**崩掉了几块。回血倒放时必须按原数拼回：
   * `breakOnce()` 里的 12% 是按当时的 `shell.count` 算的，墙少了之后重算会偏小，
   * 攒几轮就永远拼不回原样。
   */
  broken: number[];
}

/** 一块正飞回墙上的木板（短生命周期，到位即摘、并露出墙上那块补片）。 */
interface FlyingPlank {
  id: number;
  mesh: THREE.Mesh;
  flight: PlankFlight;
  /** 到位后要 `WallShell.reveal()` 的那一块补片 */
  panel: ShellPanel;
  age: number;
}

/** 场上最多留多少块碎块：再多就回收最老的（每栋楼最多 5 档 × 6 块 = 30） */
const MAX_DEBRIS = 70;
/** 同时在飞的木板上限：一档最多 6 块 × 一场同时修几栋，60 足够，超了回收最老的 */
const MAX_PLANKS = 60;
/**
 * 碎块落地后活多久（秒）以及最后几秒怎么消失。
 *
 * 用户 2026-11-05："废墟砖块掉到哪里都不影响，只要最后过一段时间后自动消失，慢慢消失就可以了。"
 * 上一版碎块**永远不会消失**，只在超过 `MAX_DEBRIS` 时回收最老的 ——
 * 一局打到 3 分钟，塔脚底下会积一圈永远躺着的板子。
 *
 * 消失方式用**缩小 + 下沉**，不用淡出：碎块的材质按颜色共享（`matOf`），
 * 改 opacity 会把场上所有同色碎块一起变透明。
 */
const DEBRIS_LIFE = 12;
const DEBRIS_FADE = 2.2;

export class DamageFx {
  /** 外壳崩开时的回调：让视图在破口处溅一把火星 */
  onBreach?: (x: number, z: number, y: number, dirX: number, dirZ: number) => void;
  /** 碎块落地时的回调：让视图在墙脚扬一小团土 */
  onLand?: (x: number, z: number, y: number) => void;
  /** P-097：一档木板拼完的回调：让视图在补片处扬一小团木屑/尘 */
  onRestore?: (x: number, z: number, y: number) => void;
  private readonly states = new Map<number, Damaged>();
  private readonly debris: Chunk[] = [];
  /** 正飞回墙上的木板；和 debris 分开管，它不用物理、也不会躺 12 秒 */
  private readonly planks: FlyingPlank[] = [];
  private readonly mats = new Map<number, THREE.MeshStandardMaterial>();
  /** 所有木板共用一张顶点色材质：颜色都烘在几何里，一次 draw call / 块 */
  private readonly plankMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.88,
  });

  constructor(private readonly scene: THREE.Scene) {}

  register(id: number, info: DamageInfo, shell: WallShell): void {
    if (this.states.has(id)) return;
    this.states.set(id, { ...info, id, hits: 0, shell, broken: [] });
  }

  /**
   * 每帧喂血量分数（P-097 起双向）：
   * - 掉血跨过一档 → `breakOnce()` 崩一片（一次掉很多血会连崩多档）；
   * - 回血跨回一档 → `restoreOnce()` **按原数**把那档的木板拼回来。
   *
   * `targetHits()` 带 0.02 滞后带，血量在阈值附近抖动不会反复崩/拼。
   */
  sync(id: number, frac: number, kind: HitKind = 'blade'): void {
    const st = this.states.get(id);
    if (!st) return;
    const want = targetHits(frac, st.hits);
    while (st.hits < want) {
      this.breakOnce(st, st.hits, kind);
      st.hits += 1;
    }
    while (st.hits > want) {
      st.hits -= 1;
      this.restoreOnce(st, st.hits);
    }
  }

  /**
   * 整栋塌了：**剩下没崩的面片一块不剩地全掉到地上**（用户 2026-11-06）。
   *
   * 之前 `sync()` 只按血量档位崩（最多 5 档、每档 12% 左右），楼一没就
   * `forget()` 把整张外墙网格 dispose 掉 —— 墙上还立着的板子凭空消失。
   * 现在拆楼统一走这里：一次 `breach(count)` 摘光，逐块变成落体。
   * 返回掉了几块，方便视图 / 探针核实。
   */
  collapseAll(id: number, kind: HitKind = 'cannon'): number {
    const st = this.states.get(id);
    if (!st) return 0;
    const rnd = new Random(st.seed + 91129);
    // 等着的补片先回墙：不然它们不会进 breach()，塌楼时会凭空少几块
    st.shell.revealAll();
    const removed = st.shell.breach(st.shell.count, rnd);
    for (const panel of removed) this.dropPanel(st, panel, rnd, kind);
    // 楼都塌了，还在飞回来的木板不该钉到一面不存在的墙上
    this.dropPlanksFor(id);
    st.shell.dispose(); // 网格已经空了；调用方负责把它从场景里摘掉
    this.states.delete(id);
    return removed.length;
  }

  /** 楼没了：外墙网格跟着释放，地上已经躺下的碎块留着。 */
  forget(id: number): void {
    const st = this.states.get(id);
    if (!st) return;
    this.dropPlanksFor(id);
    st.shell.dispose();
    this.states.delete(id);
  }

  /** 碎块弹道：重力 + 落地弹一下，速度耗尽了就躺平；躺够 12 秒缩小下沉消失。 */
  update(dt: number): void {
    // 倒序：落地满 12 秒的要在这一趟里摘掉，正序删会跳元素
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const c = this.debris[i]!;
      if (c.rest) {
        c.age += dt;
        const left = DEBRIS_LIFE - c.age;
        if (left <= 0) {
          this.dropDebris(i);
          continue;
        }
        if (left < DEBRIS_FADE) {
          // 最后 2.2 秒：缩到 2% 并往下沉 0.4 格 —— 看起来是"陷进土里"
          const k = left / DEBRIS_FADE;
          c.mesh.scale.setScalar(Math.max(0.02, k));
          c.mesh.position.y = c.restY - (1 - k) * 0.4;
        }
        continue;
      }
      /**
       * P-096：逐帧刚体积分交给 `stepRigid()`，和废墟的 `rigidPoseAt()` 共用
       * 同一套重力/反弹/摩擦/角阻尼常量。位移与姿态一起推进，不再"位置在落、
       * 旋转却从出生起就定死"。
       */
      const p = c.mesh.position;
      const s: RigidState = {
        x: p.x, y: p.y, z: p.z,
        vx: c.vx, vy: c.vy, vz: c.vz,
        rx: c.mesh.rotation.x, ry: c.mesh.rotation.y, rz: c.mesh.rotation.z,
        wx: c.wx, wy: c.wy, wz: c.wz,
        floor: c.restY,
      };
      const r = stepRigid(s, dt);
      p.set(s.x, s.y, s.z);
      c.mesh.rotation.set(s.rx, s.ry, s.rz);
      c.vx = s.vx; c.vy = s.vy; c.vz = s.vz;
      c.wx = s.wx; c.wy = s.wy; c.wz = s.wz;
      if (r.rest) {
        /**
         * 静止：**姿态保持物理积分的结果**。
         * 旧版在这里 `rotation.set(-π/2 + tilt, ...)` 把板子瞬间摆平，
         * 于是翻滚了半天最后"啪"一下归位 —— 位置和旋转各说各话。
         * 现在每块歪成什么样由初速与角动量决定，落地就那样。
         */
        c.rest = true;
        c.age = 0;
        this.onLand?.(p.x, p.z, c.restY);
      }
    }

    // P-097 拼回的木板：解析姿态，倒序删（到位即摘）
    // 同一帧到位的补片攒成一批，一栋楼只 rebuild 一次墙面网格
    const arrived = new Map<number, ShellPanel[]>();
    for (let i = this.planks.length - 1; i >= 0; i--) {
      const p = this.planks[i]!;
      p.age += dt;
      const pose = plankPoseAt(p.flight, p.age);
      p.mesh.visible = pose.visible;
      if (pose.visible) {
        p.mesh.position.set(pose.x, pose.y, pose.z);
        p.mesh.rotation.set(pose.rx, pose.ry, pose.rz);
        p.mesh.scale.setScalar(pose.scale);
      }
      if (pose.done) {
        const batch = arrived.get(p.id);
        if (batch) batch.push(p.panel);
        else arrived.set(p.id, [p.panel]);
        this.dropPlank(i);
      }
    }
    for (const [id, panels] of arrived) {
      this.states.get(id)?.shell.reveal(panels);
    }
  }

  /** 摘掉一块碎块并释放它的几何（材质按颜色共享，不能 dispose）。 */
  private dropDebris(index: number): void {
    const c = this.debris[index]!;
    this.scene.remove(c.mesh);
    c.mesh.geometry.dispose();
    this.debris.splice(index, 1);
  }

  get debrisCount(): number {
    return this.debris.length;
  }

  /** 现在有几栋楼记着伤（调试/锁用）。 */
  get damagedCount(): number {
    return this.states.size;
  }

  /** P-097：此刻有几块木板正飞回墙上（调试/锁用）。 */
  get plankCount(): number {
    return this.planks.length;
  }

  private breakOnce(st: Damaged, index: number, kind: HitKind): void {
    const rnd = new Random(st.seed + index * 977 + 73);
    // 每档崩掉约 12% 的墙板（48 块 → 6 块；12 块 → 2 块），至少 2 块
    const n = Math.min(6, Math.max(2, Math.round(st.shell.count * 0.12)));
    const removed = st.shell.breach(n, rnd);
    // P-097：记下这一档到底掉了几块，回血倒放时原数拼回
    st.broken[index] = removed.length;
    for (const panel of removed) this.dropPanel(st, panel, rnd, kind);
    // 破口中心 + 外法线：火星从这里往外溅
    if (removed.length > 0 && this.onBreach) {
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (const p of removed) {
        ax += p.x;
        ay += p.y;
        az += p.z;
      }
      ax /= removed.length;
      ay /= removed.length;
      az /= removed.length;
      const face = removed[0]!;
      this.onBreach(
        st.center.x + ax * st.scale,
        st.center.z + az * st.scale,
        st.groundY + ay * st.scale,
        Math.sin(face.yaw),
        Math.cos(face.yaw),
      );
    }
  }

  /**
   * **倒放一档**（P-097）：把第 `index` 档崩掉的面片原数拼回墙上。
   *
   * 两件同源的事在这里一次做完，别拆到别处：
   * 1. 结构上 `WallShell.restore()` 把面片放回网格，并染成木板色；
   * 2. 画面上给每块补片造一块同色木板，从墙外飞回来钉上。
   *
   * `plankColor(rnd)` 是**唯一**的木色来源：墙上补片和飞行木板读同一个返回值，
   * 所以到位摘掉飞行 mesh 时颜色是连续的。
   */
  private restoreOnce(st: Damaged, index: number): void {
    const rnd = new Random(st.seed + index * 977 + 73 + 4441);
    const n = st.broken[index] ?? 0;
    st.broken.length = index;
    if (n <= 0) return;

    const restored = st.shell.restore(n, rnd, (_panel, r) => plankColor(r));
    // 结构上已经拼回、画面上先留着破口：木板飞到位才逐块合上
    st.shell.hideRestored(restored.map((r) => r.panel));
    for (let i = 0; i < restored.length; i++) {
      const { panel, color } = restored[i]!;
      this.flyPlank(st, panel, color, rnd, i);
    }

    // 一档只扬一次木屑，别每块板都喷
    if (restored.length > 0 && this.onRestore) {
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (const { panel } of restored) {
        ax += panel.x;
        ay += panel.y;
        az += panel.z;
      }
      const k = restored.length;
      this.onRestore(
        st.center.x + (ax / k) * st.scale,
        st.center.z + (az / k) * st.scale,
        st.groundY + (ay / k) * st.scale,
      );
    }
    while (this.planks.length > MAX_PLANKS) this.dropPlank(0);
  }

  /** 造一块木板并排进飞行队列：起点在墙外、略高、斜着拿，终点就是原墙片的位置。 */
  private flyPlank(
    st: Damaged,
    panel: ShellPanel,
    color: number,
    rnd: Random,
    order: number,
  ): void {
    const s = st.scale;
    // 木纹 seed 与墙上补片同源 ⇒ 到位时木纹/钉头不会跳一下；
    // 飞行起点的抖动继续用本档的 rnd，不影响木纹
    const wood = makePlankGeometry(panel, s, color, new Random(plankSeed(panel, color)));
    const mesh = new THREE.Mesh(wood, this.plankMat);
    mesh.castShadow = true;
    mesh.visible = false;
    mesh.name = 'repair-plank';

    const to = {
      x: st.center.x + panel.x * s,
      y: st.groundY + panel.y * s,
      z: st.center.z + panel.z * s,
    };
    // 外法线 = (sin yaw, 0, cos yaw)；沿法线退开，再带一点切向错位
    const nx = Math.sin(panel.yaw);
    const nz = Math.cos(panel.yaw);
    const back = PLANK.outward * s;
    const jitter = (rnd.next() - 0.5) * 0.7 * s;
    const flight: PlankFlight = {
      from: {
        x: to.x + nx * back - nz * jitter,
        y: to.y + PLANK.lift * s + rnd.next() * 0.3 * s,
        z: to.z + nz * back + nx * jitter,
      },
      to,
      yaw: panel.yaw,
      tiltX: (rnd.next() - 0.5) * 1.0,
      tiltZ: (rnd.next() - 0.5) * 0.9,
      arc: PLANK.arc * s,
      delay: order * PLANK.stagger,
      seconds: PLANK.flySeconds,
    };
    this.scene.add(mesh);
    this.planks.push({ id: st.id, mesh, flight, panel, age: 0 });
  }

  /** 摘掉一块飞行木板（材质全局共享，只 dispose 几何）。 */
  private dropPlank(index: number): void {
    const p = this.planks[index];
    if (!p) return;
    this.scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    this.planks.splice(index, 1);
  }

  /** 楼塌了 / 忘了：把还在飞回这栋楼的木板一并收掉。 */
  private dropPlanksFor(id: number): void {
    for (let i = this.planks.length - 1; i >= 0; i--) {
      if (this.planks[i]!.id === id) this.dropPlank(i);
    }
  }

  /** 把一块墙板变成落体：位置/尺寸/颜色都从模型来。 */
  private dropPanel(st: Damaged, panel: ShellPanel, rnd: Random, kind: HitKind): void {
    const s = st.scale;
    const w = panel.w * s;
    const h = panel.h * s;
    const t = panel.t * s;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), this.matOf(panel.color));
    mesh.castShadow = true;
    mesh.position.set(
      st.center.x + panel.x * s,
      st.groundY + panel.y * s,
      st.center.z + panel.z * s,
    );
    mesh.rotation.set(rnd.next() * 0.5 - 0.25, panel.yaw, rnd.next() * 0.5 - 0.25);
    this.scene.add(mesh);

    // 外法线 = (sin yaw, 0, cos yaw)：板子从墙上往外崩，再带一点切向抖动
    const nx = Math.sin(panel.yaw);
    const nz = Math.cos(panel.yaw);
    /**
     * 炮弹炸散 vs 刀砍/箭射正常掉：
     * - 炮弹：**全方向**（不认墙面朝外那一条），速度 1.6–4.0 格/秒，转得更野；
     * - 刀箭：顺着墙面法线往外崩 0.5–1.4，慢一点，落地就躺下。
     */
    const blast = kind === 'cannon';
    const dir = rnd.next() * Math.PI * 2;
    const blastSpeed = 1.6 + rnd.next() * 2.4;
    this.debris.push({
      mesh,
      vx: blast ? Math.cos(dir) * blastSpeed : nx * (0.5 + rnd.next() * 0.9) + nz * (rnd.next() - 0.5) * 0.8,
      vy: blast ? 1.8 + rnd.next() * 1.8 : 0.9 + rnd.next() * 1.3,
      vz: blast ? Math.sin(dir) * blastSpeed : nz * (0.5 + rnd.next() * 0.9) - nx * (rnd.next() - 0.5) * 0.8,
      /**
       * 绕 x 的角速度带一个**朝躺倒方向的偏置**：薄墙板从竖着脱落，
       * 纯粹随机角速度会有一半概率落地时仍立着（旧版注释里的"砖头直插在地上"）。
       * 这是给定初速的**初始条件**，不是落地后硬摆姿态 —— 姿态仍由积分决定。
       */
      wx: (rnd.next() - 0.5) * (blast ? 18 : 8) - (blast ? 2.5 : 3.5),
      wy: (rnd.next() - 0.5) * (blast ? 16 : 8),
      wz: (rnd.next() - 0.5) * (blast ? 18 : 8),
      restY: st.groundY + t / 2 + 0.01,
      rest: false,
      age: 0,
    });

    while (this.debris.length > MAX_DEBRIS) this.dropDebris(0);
  }

  private matOf(color: number): THREE.MeshStandardMaterial {
    const hit = this.mats.get(color);
    if (hit) return hit;
    const mat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95 });
    this.mats.set(color, mat);
    return mat;
  }
}
