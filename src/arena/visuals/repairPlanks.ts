/**
 * **修复时拼回来的木板积木**（P-097，2026-11-12）。
 *
 * 用户原话：「修的时候，就像我们之前那个碎开来的东西一样，把碎掉的部分重新拼
 * 一些积木回去。但是这个积木有特点，重新拼上去的是木板的那种感觉和质感。
 * 血可以补回去，然后会拼回木板的感觉。」
 *
 * 和 `rigidFall.ts` 的分工要分清：
 * - 掉落是**物理**（重力 / 反弹 / 摩擦 / 角阻尼），姿态由积分决定；
 * - 拼回是**施工**：有明确目标位、有顺序、到位就钉住，不该用重力去"砸"回墙上。
 *   所以这里是解析插值（easeOutCubic + 抛物拱 + 到位一记轻拍），不是刚体。
 *
 * 木板质感全部来自几何本身，**一张 mesh、一次 draw call**：板身 + 上下端纹 +
 * 三道木纹 + 四角钉头，合成一张带顶点色的 BufferGeometry。没有贴图、没有 canvas，
 * 也不需要额外材质。`PLANK_WOOD` 的暖棕和 `ARENA_PAL.wood / woodLight` 同族。
 *
 * 关键口径：**飞回来的木板颜色 = `WallShell.restore()` 给墙片的补片颜色**。
 * 到位那一刻木板 mesh 被摘掉、墙上同一位置已经是同色木片 —— 不会"啪"一下
 * 从木头跳回米色石墙。`damage.ts` 把 `RestoredPanel.color` 原样传进来。
 */

import * as THREE from 'three';
import type { Random } from '@engine/math/Random';
import type { ShellPanel } from '../models';
import { shade } from '../models';

/** 拼木板的时间参数，只在这张表里调。 */
export const PLANK = {
  /** 一块木板从外侧飞到墙上要多久（秒） */
  flySeconds: 0.58,
  /** 同一档里相邻木板的起飞间隔（秒）：一块块拼，不是一起糊上去 */
  stagger: 0.075,
  /** 飞行拱高（模型单位，乘 scale 后生效） */
  arc: 0.55,
  /** 起点沿墙面外法线退开多远（模型单位 × scale） */
  outward: 1.25,
  /** 起点抬高多少（模型单位 × scale） */
  lift: 0.85,
} as const;

/** 木色一族：确定性从里面挑，同一栋楼每次修补出来同一批颜色。 */
export const PLANK_WOOD = [0xa97644, 0x9a6b3f, 0x8a5a30, 0xb4834d, 0x7c5228] as const;

export function plankColor(rnd: Random): number {
  return PLANK_WOOD[rnd.int(0, PLANK_WOOD.length)]!;
}

/**
 * 木板木纹的种子：只由面片位置 + 木色决定。
 * **飞行木板（`damage.ts`）与墙上补片（`shell.ts`）必须用同一个种子**，
 * 否则到位那一刻木纹长短 / 位置会轻微跳一下。和全局随机流无关，可复现。
 */
export function plankSeed(panel: ShellPanel, color: number): number {
  return Math.round(panel.x * 7919 + panel.y * 104729 + panel.z * 15485863) + color;
}

interface Buffers {
  position: number[];
  normal: number[];
  color: number[];
}

/** 往合成缓冲里追加一只盒子（局部坐标，整块木板随后由 mesh 统一旋转 yaw）。 */
function appendBox(
  buf: Buffers,
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  color: number,
): void {
  const src = new THREE.BoxGeometry(size[0], size[1], size[2]);
  src.translate(at[0], at[1], at[2]);
  // 同 shell.ts：BoxGeometry 是索引几何，必须展开，否则抄顶点会拼出白色大叉
  const geo = src.toNonIndexed();
  src.dispose();
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const tint = new THREE.Color(color);
  for (let i = 0; i < pos.count; i++) {
    buf.position.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    buf.normal.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    buf.color.push(tint.r, tint.g, tint.b);
  }
  geo.dispose();
}

/**
 * 造一块「钉上去的木板」：尺寸取自原来那块墙片，这样飞到位时严丝合缝。
 * `color` 必须与墙上补片一致（见文件头）。`rnd` 只让木纹长短/位置略有变化，
 * 不影响轮廓，也不影响拼回顺序。
 */
export function makePlankGeometry(
  panel: ShellPanel,
  scale: number,
  color: number,
  rnd: Random,
): THREE.BufferGeometry {
  const w = panel.w * scale;
  const h = panel.h * scale;
  // 比原墙片厚一点：读起来是"后钉上去的一块板"，不是原来那块石片
  const t = Math.max(panel.t * scale * 1.25, 0.055);
  const buf: Buffers = { position: [], normal: [], color: [] };

  appendBox(buf, [w * 0.96, h * 0.96, t], [0, 0, 0], color);

  const edge = shade(color, 0.8);
  const grain = shade(color, 0.66);
  const front = t / 2 + 0.008; // 比板面高出一点，避免 z-fighting

  // 上下端纹：两条深色收边，板子的"两端"就读出来了
  appendBox(buf, [w * 0.97, Math.max(h * 0.045, 0.014), t * 1.02], [0, h * 0.47, 0], edge);
  appendBox(buf, [w * 0.97, Math.max(h * 0.045, 0.014), t * 1.02], [0, -h * 0.47, 0], edge);

  // 三道木纹，顺着板子长边走；轻微抖动别太规整
  const alongX = w >= h;
  for (let i = 0; i < 3; i++) {
    const off = (i - 1) * 0.24 + (rnd.next() - 0.5) * 0.05;
    if (alongX) {
      appendBox(
        buf,
        [w * (0.84 + rnd.next() * 0.1), Math.max(h * 0.026, 0.012), 0.012],
        [0, off * h, front],
        grain,
      );
    } else {
      appendBox(
        buf,
        [Math.max(w * 0.026, 0.012), h * (0.84 + rnd.next() * 0.1), 0.012],
        [off * w, 0, front],
        grain,
      );
    }
  }

  // 四角铁钉：小方头，压在木纹之上
  const nail = Math.max(Math.min(w, h) * 0.075, 0.02);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      appendBox(buf, [nail, nail, 0.014], [sx * w * 0.36, sy * h * 0.34, front + 0.006], 0x3d4249);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.normal, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.color, 3));
  geo.computeBoundingSphere();
  return geo;
}

/** 一块木板的一次飞行：起终点 + 目标朝向 + 起飞姿态 + 时间参数。 */
export interface PlankFlight {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  /** 到位时的 yaw（原墙片朝向） */
  yaw: number;
  tiltX: number;
  tiltZ: number;
  /** 拱高（世界单位） */
  arc: number;
  /** 起飞延迟（秒），同档里错开 */
  delay: number;
  seconds: number;
}

export interface PlankPose {
  /** 还没到起飞时刻：不渲染，别在起点摆一块静止的板子 */
  visible: boolean;
  /** 已经钉上墙：调用方摘掉 mesh，露出 `WallShell` 里那块同色补片 */
  done: boolean;
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  scale: number;
}

/**
 * 解析姿态：给 age 直接算，不依赖帧率（掉帧 / 快进结果一致）。
 * 位置 easeOutCubic 收拢 + 一条 sin 拱；姿态从"斜着拿在手里"归到墙面朝向；
 * 最后 12% 有一记轻微的"拍实"缩放，像钉子敲进去那一下。
 */
export function plankPoseAt(f: PlankFlight, age: number): PlankPose {
  const t = age - f.delay;
  if (t < 0) {
    return {
      visible: false, done: false,
      x: f.from.x, y: f.from.y, z: f.from.z,
      rx: 0, ry: f.yaw, rz: 0, scale: 1,
    };
  }
  const k = Math.min(1, t / f.seconds);
  const ease = 1 - (1 - k) ** 3;
  const x = f.from.x + (f.to.x - f.from.x) * ease;
  const z = f.from.z + (f.to.z - f.from.z) * ease;
  const y = f.from.y + (f.to.y - f.from.y) * ease + Math.sin(Math.PI * k) * f.arc;
  const turn = 1 - (1 - k) ** 2;
  const slam = k > 0.88 ? Math.sin(((k - 0.88) / 0.12) * Math.PI) * 0.035 : 0;

  return {
    visible: true,
    done: k >= 1,
    x, y, z,
    rx: f.tiltX * (1 - turn),
    ry: f.yaw + 0.35 * (1 - turn),
    rz: f.tiltZ * (1 - turn),
    scale: (0.86 + 0.14 * Math.min(1, k * 4)) * (1 + slam),
  };
}
