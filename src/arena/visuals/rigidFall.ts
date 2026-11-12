/**
 * **确定性刚体下落**（P-096，用户："能不能用物理引擎模拟一下？而不是咱们手造动画"）。
 *
 * 这里不引 cannon / rapier：那会把 three 之外再塞一个求解器进包，
 * 而这几块板子只需要"重力 + 角动量 + 落地反弹 + 摩擦"。本项目要的是白盒可审计，
 * 所以把最小刚体积分写成纯函数，**墙片脱落（damage.ts）与废墟摊落（ruinView.ts）
 * 共用同一套常量和同一套碰撞规则**，不再各写一条手造缓动曲线。
 *
 * 两种入口：
 * - `stepRigid(s, dt)`：逐帧半隐式欧拉，给有状态的墙片用；
 * - `rigidPoseAt(s, age)`：**解析多段抛物线**，无状态、O(弹跳次数)，
 *   给每帧重建姿态的废墟用（掉帧/快进/重放结果一致，不依赖帧率）。
 *
 * 关键口径：落地**不再硬摆姿态**。旧版在触地那一帧 `rotation.set(-π/2+tilt,...)`
 * 把板子瞬间摆平，于是"斜着翻滚掉下来、最后啪一下躺正"—— 用户看到的
 * 「斜躺着掉落，但动画直直往下，两者不匹配」就是这么来的。现在姿态只由
 * 角速度积分 + 碰撞衰减决定，最后停在物理算出来的角度。
 */

export const RIGID = {
  /** 重力（格/s²） */
  g: 12,
  /** 触地法向速度保留比例 */
  bounce: 0.3,
  /** 触地后水平速度保留比例（地面摩擦） */
  friction: 0.55,
  /** 触地后角速度保留比例 */
  angDamp: 0.5,
  /** 低于这个法向速度就贴地静止，不再弹 */
  restSpeed: 1.2,
  /** 解析版最多算几次弹跳 */
  maxBounces: 4,
} as const;

/** 一块刚体的完整状态（角度单位弧度，位置单位格）。 */
export interface RigidState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
  /** 静止时中心离地高度（一般是碎块厚度/2） */
  floor: number;
}

export interface RigidPose {
  x: number; y: number; z: number;
  rx: number; ry: number; rz: number;
}

/**
 * 推进一步。**会就地改 s**（逐帧积分，调用方持有状态）。
 * 返回 `landed` = 这一帧触地、`rest` = 已经彻底停下。
 */
export function stepRigid(s: RigidState, dt: number): { landed: boolean; rest: boolean } {
  s.vy -= RIGID.g * dt;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.z += s.vz * dt;
  s.rx += s.wx * dt;
  s.ry += s.wy * dt;
  s.rz += s.wz * dt;
  if (s.y > s.floor) return { landed: false, rest: false };

  s.y = s.floor;
  const impact = Math.abs(s.vy);
  if (impact > RIGID.restSpeed) {
    s.vy = impact * RIGID.bounce; // 反弹向上
    s.vx *= RIGID.friction;
    s.vz *= RIGID.friction;
    s.wx *= RIGID.angDamp;
    s.wy *= RIGID.angDamp;
    s.wz *= RIGID.angDamp;
    return { landed: true, rest: false };
  }
  // 静止：速度清零，但**姿态保持积分结果**，不许外部再摆正
  s.vy = 0; s.vx = 0; s.vz = 0;
  s.wx = 0; s.wy = 0; s.wz = 0;
  return { landed: true, rest: true };
}

/**
 * 解析版：从初态直接算 `age` 秒后的姿态，不依赖中间帧率。
 *
 * 每段都是 `y = y0 + vy·t − ½g·t²`，落地时刻解二次方程；
 * 触地按 `bounce / friction / angDamp` 换一组初速继续下一段。
 * 弹到 `restSpeed` 以下就贴地停住，剩余时间不再改变姿态。
 */
export function rigidPoseAt(b: RigidState, age: number): RigidPose {
  let { x, y, z, vx, vy, vz, rx, ry, rz, wx, wy, wz, floor } = b;
  const t = Math.max(0, age);
  let elapsed = 0;
  for (let bounce = 0; bounce < RIGID.maxBounces; bounce++) {
    const h = Math.max(0, y - floor);
    const disc = Math.max(0, vy * vy + 2 * RIGID.g * h);
    const tLand = (vy + Math.sqrt(disc)) / RIGID.g;
    const seg = Math.max(0, Math.min(tLand, t - elapsed));
    x += vx * seg;
    z += vz * seg;
    y += vy * seg - 0.5 * RIGID.g * seg * seg;
    rx += wx * seg;
    ry += wy * seg;
    rz += wz * seg;
    elapsed += seg;
    // 还在空中，或时间刚好用尽 ⇒ 直接返回这一段的结果
    if (seg < tLand - 1e-9 || elapsed >= t - 1e-9) return { x, y, z, rx, ry, rz };
    y = floor;
    const impact = Math.sqrt(disc);
    if (impact <= RIGID.restSpeed) {
      return { x, y: floor, z, rx, ry, rz };
    }
    vy = impact * RIGID.bounce;
    vx *= RIGID.friction;
    vz *= RIGID.friction;
    wx *= RIGID.angDamp;
    wy *= RIGID.angDamp;
    wz *= RIGID.angDamp;
  }
  return { x, y: Math.max(floor, y), z, rx, ry, rz };
}
