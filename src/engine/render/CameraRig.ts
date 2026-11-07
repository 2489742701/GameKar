/**
 * 正交 2.5D 相机云台 —— 红警/帝国时代的平铺视角在这里成型。
 *
 * 约定：
 *  - 世界 Y 轴朝上，地图铺在 XZ 平面。
 *  - 相机永远平行投影（正交），所以远处建筑不会缩小，格子尺寸全程一致。
 *  - `tilesAcross` 指"屏幕短边能看到几格"，这是横竖屏切换后画面密度不变的钥匙。
 */

import * as THREE from 'three';

export interface CameraBounds {
  /** 写死边界；给了 `field` 时这四个被忽略（不传也行） */
  minX?: number;
  maxX?: number;
  minZ?: number;
  maxZ?: number;
  /**
   * **随视野动态的场内边界**（2026-11-06 用户："往自己家里移动会被限位"、
   * "放大的时候好像会卡"——其实是撞在写死的边界上）。
   *
   * 给了 field 之后，minX/maxX/minZ/maxZ 每帧按当前视野重算：
   * 中心允许出场地 `out = min(reach×0.6, 场地×0.18/0.25)` 格——
   * 放大时（reach 小）可以贴到自家门口看细节；缩小时（reach 大）自动收回，
   * 不会拖出一屏黑。写死的 minX/maxX 此时被忽略。
   */
  field?: { cols: number; rows: number };
}

export interface VisibleRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface CameraRigOptions {
  /** 俯视角：0=平视地平线，90=正上方。50° 是"看得见立面又看得见地板"的甜点位。 */
  pitchDeg?: number;
  yawDeg?: number;
  tilesAcross?: number;
  minTilesAcross?: number;
  maxTilesAcross?: number;
  damping?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 俯仰角的活动范围（度）。
 *
 * 2026-11-07 用户："最大可以转到平行的那种感觉，往下俯视，最大可以再往下来一点。"
 * 原来是 `clamp(18, 82)`，两头都差一口气 —— 18° 还明显是俯视，82° 也没到正上方。
 *
 * 为什么不给到 0 / 90：
 *  - **0°** 视线与地面完全平行，`screenToGround` 的射线求交无解（手指点哪都落不了地），
 *    平移用的"屏幕上向"投影也塌成零向量 —— 6° 是还留着这点余量的极限；
 *  - **90°** 正上方时 `lookAt` 的上方向退化，镜头会翻面。88° 在视觉上已经是平面图了。
 */
export const PITCH_MIN = 6;
export const PITCH_MAX = 88;

export class CameraRig {
  readonly camera: THREE.OrthographicCamera;

  private pitchDeg: number;
  private yawDeg: number;
  private tilesAcross: number;
  private readonly minTiles: number;
  private readonly maxTiles: number;
  private readonly damping: number;
  private readonly standoff = 120;

  private readonly target = new THREE.Vector3();
  /** 震动强度 0..1（`shake()` 提高，`update()` 里按 3.2/秒 衰减） */
  private shakeAmt = 0;
  private shakeClock = 0;
  private readonly desired = new THREE.Vector3();
  private bounds: CameraBounds = { minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 };

  private cssWidth = 1;
  private cssHeight = 1;
  private groundY = 0;

  private readonly ndc = new THREE.Vector2();
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();

  constructor(options: CameraRigOptions = {}) {
    this.pitchDeg = options.pitchDeg ?? 50;
    this.yawDeg = options.yawDeg ?? 45;
    this.tilesAcross = options.tilesAcross ?? 11;
    this.minTiles = options.minTilesAcross ?? 5;
    this.maxTiles = options.maxTilesAcross ?? 34;
    this.damping = options.damping ?? 16;

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.5, this.standoff * 3);
    this.camera.rotation.order = 'YXZ';
    this.desired.copy(this.target);
    this.applyFrustum();
    this.place();
  }

  // ---------------------------------------------------------------- 视口

  /** 画布 CSS 尺寸变化（含横竖屏翻转）后必须调用。 */
  resize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.applyFrustum();
  }

  /**
   * 短边锁定可见格数：
   *  - 横屏短边是"高"，于是竖向铺满 tilesAcross 格；
   *  - 竖屏短边是"宽"，于是横向铺满 tilesAcross 格。
   * 这样旋转屏幕不会让建筑突然变大变小。
   */
  private applyFrustum(): void {
    const aspect = this.cssWidth / this.cssHeight;
    const height = aspect >= 1 ? this.tilesAcross : this.tilesAcross / aspect;
    const width = height * aspect;
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
  }

  worldPerPixel(): number {
    return (this.camera.right - this.camera.left) / this.cssWidth;
  }

  /** 沿短边的可见格数，供 UI 判断"是不是该多留白"。 */
  get currentTilesAcross(): number {
    return this.tilesAcross;
  }

  // ---------------------------------------------------------------- 姿态

  setPitch(deg: number): void {
    this.pitchDeg = clamp(deg, PITCH_MIN, PITCH_MAX);
  }

  setYaw(deg: number): void {
    this.yawDeg = deg;
  }

  rotateBy(deg: number): void {
    // 归一化到 [0,360)：自由拖拽几圈之后角度会累积到几千度，
    // 雖然 sin/cos 无所谓，但调试读数和机位插值会越来越难看
    this.yawDeg = ((this.yawDeg + deg) % 360 + 360) % 360;
  }

  get yaw(): number {
    return this.yawDeg;
  }

  get pitch(): number {
    return this.pitchDeg;
  }

  // ---------------------------------------------------------------- 平移/缩放

  panByPixels(dx: number, dy: number): void {
    const wpp = this.worldPerPixel();
    this.groundBasis(this.tmpRight, this.tmpUp);
    // 手指拖动的是"内容"，所以相机目标往反方向走：横向取负、纵向取正（屏幕 y 向下增长）
    this.desired.addScaledVector(this.tmpRight, -dx * wpp);
    this.desired.addScaledVector(this.tmpUp, dy * wpp);
    this.clampDesired();
  }

  zoomBy(factor: number, anchorX?: number, anchorY?: number): void {
    const before =
      anchorX !== undefined && anchorY !== undefined ? this.screenToGround(anchorX, anchorY) : null;

    this.tilesAcross = clamp(this.tilesAcross / factor, this.minTiles, this.maxTiles);
    this.applyFrustum();

    if (before) {
      const after = this.screenToGround(anchorX!, anchorY!);
      if (after) this.desired.add(before.sub(after));
    }
    this.clampDesired();
  }

  get zoom(): number {
    return this.tilesAcross;
  }

  set zoom(tilesAcross: number) {
    this.tilesAcross = clamp(tilesAcross, this.minTiles, this.maxTiles);
    this.applyFrustum();
  }

  centerOnWorld(x: number, z: number, instant = false): void {
    this.desired.set(x, this.groundY, z);
    this.clampDesired();
    if (instant) {
      this.target.copy(this.desired);
      this.place();
    }
  }

  setBounds(bounds: CameraBounds): void {
    this.bounds = bounds;
    this.clampDesired();
  }

  setGroundHeight(y: number): void {
    this.groundY = y;
    this.plane.constant = -y;
  }

  private clampDesired(): void {
    let minX = this.bounds.minX ?? -1e6;
    let maxX = this.bounds.maxX ?? 1e6;
    let minZ = this.bounds.minZ ?? -1e6;
    let maxZ = this.bounds.maxZ ?? 1e6;
    if (this.bounds.field) {
      const { cols, rows } = this.bounds.field;
      const rect = this.visibleRect(0);
      const reach = Math.max(rect.maxX - rect.minX, rect.maxZ - rect.minZ) / 2;
      const outX = Math.min(reach * 0.6, cols * 0.18);
      const outZ = Math.min(reach * 0.6, rows * 0.25);
      minX = -outX;
      maxX = cols + outX;
      minZ = -outZ;
      maxZ = rows + outZ;
    }
    this.desired.x = clamp(this.desired.x, minX, maxX);
    this.desired.z = clamp(this.desired.z, minZ, maxZ);
  }

  /** 屏幕右向与屏幕上向在 XZ 平面上的投影 —— 拖拽手感的地基。 */
  private groundBasis(right: THREE.Vector3, up: THREE.Vector3): void {
    right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    right.y = 0;
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    else right.normalize();

    up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    up.y = 0;
    if (up.lengthSq() < 1e-8) up.set(0, 0, -1);
    else up.normalize();
  }

  // ---------------------------------------------------------------- 拾取

  /** 画布 CSS 像素 -> 地面世界点；视线与地面平行时返回 null。 */
  screenToGround(cssX: number, cssY: number): THREE.Vector3 | null {
    this.ndc.set((cssX / this.cssWidth) * 2 - 1, -((cssY / this.cssHeight) * 2 - 1));
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
    return hit;
  }

  // ---------------------------------------------------------------- 每帧

  get position(): THREE.Vector3 {
    return this.target;
  }

  update(dt: number): void {
    const t = 1 - Math.exp(-dt * this.damping);
    this.target.lerp(this.desired, Math.min(1, t));
    if (this.shakeAmt > 0) this.shakeAmt = Math.max(0, this.shakeAmt - dt * 3.2);
    this.shakeClock += dt;
    this.place();
  }

  /**
   * 屏幕震动（炮击落地、建筑倒塌、大本营被打）。
   *
   * 强度取**最大值**而不是累加：三发炮弹同时落在同一片区域时，
   * 累加会把镜头甩出去，取最大只是"这一下很重"。
   * 衰减 3.2/秒 —— 差不多 0.3 秒，刚好是一次打击的手感长度。
   */
  shake(strength: number): void {
    this.shakeAmt = Math.min(1, Math.max(this.shakeAmt, strength));
  }

  private place(): void {
    const yaw = THREE.MathUtils.degToRad(this.yawDeg);
    const pitch = THREE.MathUtils.degToRad(this.pitchDeg);
    const cosP = Math.cos(pitch);

    // 震动只平移视点（不改角度）：正交俯视下这读作"地面被震了一下"，
    // 改角度会变成"镜头被人拽了一把"，那是另一种手感
    const s = this.shakeAmt * this.shakeAmt * 0.42;
    const cx = this.target.x + Math.sin(this.shakeClock * 61.3) * s;
    const cz = this.target.z + Math.cos(this.shakeClock * 47.7) * s;
    const cy = this.target.y + Math.sin(this.shakeClock * 71.1) * s * 0.45;

    this.camera.position.set(
      cx + Math.sin(yaw) * cosP * this.standoff,
      cy + Math.sin(pitch) * this.standoff,
      cz + Math.cos(yaw) * cosP * this.standoff,
    );
    this.camera.lookAt(cx, cy, cz);
  }

  /** 当前可见的地面矩形（比实际范围略宽一点，用于实例裁剪）。 */
  visibleRect(margin = 1): VisibleRect {
    const w = (this.camera.right - this.camera.left) / 2 + margin;
    const h = (this.camera.top - this.camera.bottom) / 2 + margin;
    // 正交俯视角下，地面可见范围是相机半幅在 XZ 上的外接盒
    const reach = Math.max(w, h);
    return {
      minX: this.target.x - reach,
      maxX: this.target.x + reach,
      minZ: this.target.z - reach,
      maxZ: this.target.z + reach,
    };
  }

  /** 供阴影相机贴合视野使用：世界单位下的可见半径。 */
  get viewRadius(): number {
    const w = (this.camera.right - this.camera.left) / 2;
    const h = (this.camera.top - this.camera.bottom) / 2;
    return Math.hypot(w, h);
  }
}
