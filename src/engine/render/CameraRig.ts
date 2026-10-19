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
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
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
    this.pitchDeg = clamp(deg, 18, 82);
  }

  setYaw(deg: number): void {
    this.yawDeg = deg;
  }

  rotateBy(deg: number): void {
    this.yawDeg += deg;
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
    this.desired.x = clamp(this.desired.x, this.bounds.minX, this.bounds.maxX);
    this.desired.z = clamp(this.desired.z, this.bounds.minZ, this.bounds.maxZ);
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
    this.place();
  }

  private place(): void {
    const yaw = THREE.MathUtils.degToRad(this.yawDeg);
    const pitch = THREE.MathUtils.degToRad(this.pitchDeg);
    const cosP = Math.cos(pitch);

    this.camera.position.set(
      this.target.x + Math.sin(yaw) * cosP * this.standoff,
      this.target.y + Math.sin(pitch) * this.standoff,
      this.target.z + Math.cos(yaw) * cosP * this.standoff,
    );
    this.camera.lookAt(this.target);
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
