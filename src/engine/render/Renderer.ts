/**
 * WebGL 渲染器封装 —— 只管"怎么画得好看"，不认识游戏概念。
 */

import * as THREE from 'three';

export interface QualityProfile {
  shadowMapSize: number;
  maxPixelRatio: number;
  shadows: boolean;
}

/**
 * 画质档（2026-11-07 深夜，为 PC 卡顿加的）。
 *
 * 老口径是"像素量 ≥ 0.6MP ⇒ 阴影 2048 + DPR 2" —— 几乎所有 PC 窗口都命中这一档，
 * 于是桌面永远是 2× 超采样的后备缓冲 + PCFSoft 阴影；手机 CSS 视口反而更小、
 * 落到"低档"，这就是**手机不卡、PC 卡**的原因。更离谱的是那个 2048 从来没接进
 * `LightingRig`（它固定 1024），属于"装上了但没生效"的假配置。
 *
 * 现在改成用户可切的三档，默认 `balanced`（DPR ≤1.5、阴影开）。
 * 真正影响帧率的是 **DPR 与阴影开关**，不是 mapSize，所以别再拿 mapSize 当旋钮。
 */
export type QualityPreset = 'high' | 'balanced' | 'low';

export const QUALITY_KEY = 'gamekar.quality.v1';

export function loadQuality(): QualityPreset {
  try {
    const raw = localStorage.getItem(QUALITY_KEY);
    if (raw === 'high' || raw === 'balanced' || raw === 'low') return raw;
  } catch {
    // 无头 / 隐私模式：用默认档
  }
  return 'balanced';
}

export function saveQuality(preset: QualityPreset): void {
  try {
    localStorage.setItem(QUALITY_KEY, preset);
  } catch {
    // 存不下不影响这一局
  }
}

/** 按像素总量降档：高分屏和低端手机共用一套代码。 */
export function pickQuality(
  cssPixels: number,
  _devicePixelRatio: number,
  preset: QualityPreset = 'balanced',
): QualityProfile {
  // 小屏判定只看 **CSS 视口**，不乘 dpr：手机 dpr 3 的物理像素量比桌面还大，
  // 用物理像素判会把手机误判成"大屏"（老口径就是这么错的）。
  const small = cssPixels < 0.6e6;
  if (preset === 'high') return { shadowMapSize: 1024, maxPixelRatio: small ? 1.5 : 2, shadows: true };
  if (preset === 'low') return { shadowMapSize: 1024, maxPixelRatio: 1, shadows: false };
  return { shadowMapSize: 1024, maxPixelRatio: 1.5, shadows: true };
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
