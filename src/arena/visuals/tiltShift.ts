/**
 * 微缩景深（tilt-shift）—— 2026-11-07 深夜，用户问"能不能搞个景深，
 * 模糊背景，比较卡哇伊、有小人的感觉"。
 *
 * 不碰 WebGL 深度缓冲、不用 BokehPass：那套要深度纹理 + 透视相机，
 * 这里是**正交相机**，成本和兼容都不划算。改走移轴微缩的经典做法：
 *   ① 画面中间一条清晰带，越往上下越糊（假装浅景深）；
 *   ② 轻微提饱和 + 提亮 + 一点点暗角（玩具模型的塑料感）。
 * 只需要一个全屏 ShaderPass，8~10 次采样，默认关、强度可调。
 *
 * 关键：`amount = 0` 时 ArenaApp 会**完全跳过 composer**，直接 renderer.render ——
 * 不开这个功能的人一帧额外开销都没有。
 */
import * as THREE from 'three';

export interface TiltShiftShaderDef {
  uniforms: {
    tDiffuse: { value: THREE.Texture | null };
    amount: { value: number };
    resolution: { value: THREE.Vector2 };
    focusY: { value: number };
    focusWidth: { value: number };
  };
  vertexShader: string;
  fragmentShader: string;
}

export const TILT_SHIFT_SHADER: TiltShiftShaderDef = {
  uniforms: {
    tDiffuse: { value: null },
    amount: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    /** 清晰带中心（屏幕纵向 0~1）；0.48 略偏高，正好压在建筑线上 */
    focusY: { value: 0.48 },
    /** 清晰带半宽：0.14 是实机调过的 —— 0.24 太宽，战场几乎全清晰，看不出景深 */
    focusWidth: { value: 0.14 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform vec2 resolution;
    uniform float focusY;
    uniform float focusWidth;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      // 越远离清晰带，模糊越强（0.62 是画面上下边缘的大致归一化距离）
      float d = abs(vUv.y - focusY);
      // 0.46 而不是 0.62：更早开始糊，远景（画面上方）才有"背景虚掉"的感觉
      float blur = smoothstep(focusWidth, 0.46, d) * amount;

      if (blur > 0.002) {
        vec2 texel = 1.0 / resolution;
        float r = 3.0 + blur * 9.0;
        // 环形 10 次采样：4 正方向 + 4 对角 + 更远一圈 2 点，够糊又不糊成一片
        vec4 sum = base * 2.0;
        sum += texture2D(tDiffuse, vUv + vec2( r, 0.0) * texel);
        sum += texture2D(tDiffuse, vUv + vec2(-r, 0.0) * texel);
        sum += texture2D(tDiffuse, vUv + vec2(0.0,  r) * texel);
        sum += texture2D(tDiffuse, vUv + vec2(0.0, -r) * texel);
        vec2 q = vec2(r * 0.7, r * 0.7);
        sum += texture2D(tDiffuse, vUv + vec2( q.x,  q.y) * texel);
        sum += texture2D(tDiffuse, vUv + vec2(-q.x,  q.y) * texel);
        sum += texture2D(tDiffuse, vUv + vec2( q.x, -q.y) * texel);
        sum += texture2D(tDiffuse, vUv + vec2(-q.x, -q.y) * texel);
        base = mix(base, sum / 10.0, blur);
      }

      // 玩具模型的塑料感：饱和 + 提亮，amount=0 时这两行恒等
      float lum = dot(base.rgb, vec3(0.299, 0.587, 0.114));
      base.rgb = mix(vec3(lum), base.rgb, 1.0 + 0.22 * amount);
      base.rgb = min(base.rgb * (1.0 + 0.045 * amount) + 0.006 * amount, vec3(1.0));
      // 很轻的暗角，把注意力收到中间
      vec2 off = vUv - 0.5;
      base.rgb *= 1.0 - amount * 0.14 * dot(off, off) * 3.0;

      gl_FragColor = base;
    }
  `,
};

export const TILT_KEY = 'gamekar.tilt.v1';

/** 强度 0~1；默认 0（关），存 localStorage。 */
export function loadTilt(): number {
  try {
    const raw = Number(localStorage.getItem(TILT_KEY));
    if (Number.isFinite(raw)) return Math.min(1, Math.max(0, raw));
  } catch {
    // 无头 / 隐私模式：默认关
  }
  return 0;
}

export function saveTilt(value: number): void {
  try {
    localStorage.setItem(TILT_KEY, String(Math.min(1, Math.max(0, value))));
  } catch {
    // 存不下不影响这一局
  }
}
