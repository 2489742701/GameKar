/**
 * 光照装置 —— 三点光 + 大气雾。方向光的阴影盒每帧贴合相机视野，
 * 否则要么影子糊成一团，要么地图一放大就断影。
 */

import * as THREE from 'three';
import type { CameraRig } from './CameraRig';

export interface LightingOptions {
  shadowMapSize?: number;
  sunColor?: number;
  sunIntensity?: number;
  skyColor?: number;
  groundColor?: number;
}

/** 太阳相对目标的偏移方向（世界坐标，乘以 shadowReach 得到实际灯位）。 */
const SUN_DIR = new THREE.Vector3(-0.62, 1.0, 0.46).normalize();

export class LightingRig {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly rim: THREE.DirectionalLight;
  private readonly target = new THREE.Object3D();
  private reach = 20;

  constructor(scene: THREE.Scene, options: LightingOptions = {}) {
    const shadowMapSize = options.shadowMapSize ?? 1024;

    this.sun = new THREE.DirectionalLight(options.sunColor ?? 0xffe6bd, options.sunIntensity ?? 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.applyShadowReach();

    this.hemi = new THREE.HemisphereLight(
      options.skyColor ?? 0x8fb8ff,
      options.groundColor ?? 0x2f2a22,
      1.15,
    );

    // 冷色背光：把建筑剪影从地面里"剥"出来，俯视角不糊
    this.rim = new THREE.DirectionalLight(0x74a8ff, 0.55);
    this.rim.position.set(0.7, 0.5, -0.9);

    scene.add(this.sun, this.sun.target, this.hemi, this.rim);
    this.target.visible = false;
    scene.add(this.target);
  }

  private applyShadowReach(): void {
    const cam = this.sun.shadow.camera;
    cam.left = -this.reach;
    cam.right = this.reach;
    cam.top = this.reach;
    cam.bottom = -this.reach;
    cam.updateProjectionMatrix();
  }

  /**
   * 每帧调用：把太阳与阴影盒整体搬到视野中心。
   * 正交视野多大，阴影盒就多大 —— 缩放时阴影分辨率自动跟上。
   */
  follow(rig: CameraRig): void {
    const center = rig.position;
    const reach = rig.viewRadius * 1.15 + 2;
    if (Math.abs(reach - this.reach) > 0.5) {
      this.reach = reach;
      this.applyShadowReach();
    }
    this.sun.position.copy(center).addScaledVector(SUN_DIR, this.reach * 2.2 + 40);
    this.sun.target.position.copy(center);
    this.sun.target.updateMatrixWorld();
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.sun, this.sun.target, this.hemi, this.rim, this.target);
    this.sun.dispose();
  }
}

/**
 * 这里刻意没有雾。
 * 正交俯视角下相机到地面的距离是恒定的 standoff，
 * FogExp2 按距离算衰减 ⇒ 整张图吃同一个雾系数（实测 82%），
 * 画面被雾色整体压暗，看着像"渲染坏了"。要做景深得按屏幕纵坐标造假，不是现在这套距离雾。
 */
