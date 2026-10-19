/**
 * WebGL 渲染器封装 —— 只管"怎么画得好看"，不认识游戏概念。
 */

import * as THREE from 'three';

export interface QualityProfile {
  shadowMapSize: number;
  maxPixelRatio: number;
  shadows: boolean;
}

/** 按像素总量降档：高分屏和低端手机共用一套代码。 */
export function pickQuality(cssPixels: number, devicePixelRatio: number): QualityProfile {
  const megaPixels = (cssPixels * devicePixelRatio ** 2) / 1e6;
  const small = megaPixels < 0.6;
  return {
    shadowMapSize: small ? 1024 : 2048,
    maxPixelRatio: small ? 1.5 : 2,
    shadows: true,
  };
}

export class Renderer {
  readonly instance: THREE.WebGLRenderer;
  private quality: QualityProfile = { shadowMapSize: 1024, maxPixelRatio: 1.5, shadows: true };

  constructor(canvas: HTMLCanvasElement) {
    this.instance = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.instance.setClearColor(0x0b1220, 1);
    this.instance.outputColorSpace = THREE.SRGBColorSpace;
    this.instance.toneMapping = THREE.ACESFilmicToneMapping;
    this.instance.toneMappingExposure = 1.06;
    this.instance.shadowMap.enabled = true;
    this.instance.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  get drawCalls(): number {
    return this.instance.info.render.calls;
  }

  get triangles(): number {
    return this.instance.info.render.triangles;
  }

  /** css 尺寸 + DPR 一起决定后备缓冲；返回本次采用的画质档。 */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number, quality?: QualityProfile): QualityProfile {
    if (quality) this.quality = quality;
    this.instance.setPixelRatio(Math.min(devicePixelRatio, this.quality.maxPixelRatio));
    this.instance.setSize(cssWidth, cssHeight, false);
    return this.quality;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.instance.render(scene, camera);
  }

  /** 阴影贴图尺寸只能在重建贴图前改，故单独暴露给初始化阶段。 */
  configureShadows(enabled: boolean, mapSize: number): void {
    this.instance.shadowMap.enabled = enabled;
    this.instance.shadowMap.needsUpdate = true;
    this.quality = { ...this.quality, shadows: enabled, shadowMapSize: mapSize };
  }

  get shadowMapSize(): number {
    return this.quality.shadowMapSize;
  }

  dispose(): void {
    this.instance.dispose();
  }
}
