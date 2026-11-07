/**
 * 微缩景深（tilt-shift）—— 2026-11-07 深夜，用户问"能不能搞个景深，
 * 模糊背景，比较卡哇伊、有小人的感觉"。
 *
 * 不碰 WebGL 深度缓冲、不用 BokehPass：那套要深度纹理 + 透视相机，
 * 这里是**正交相机**，成本和兼容都不划算。改走移轴微缩的经典做法：
 *   ① 画面中间一条清晰带，越往上下越糊（假装浅景深）；
 *   ② 轻微提饱和（玩具模型的塑料感）。
 * 只需要一个全屏 ShaderPass，8~10 次采样，默认关、强度可调。
 *
 * **2026-11-08 修曝光**：用户"画面理论上不应该是变暗的"。
 * 实测景深开到 1，整幅平均亮度 0.275 → 0.138（**掉了 50%**），有两个独立的病根：
 *   ① composer 链路缺 `OutputPass` —— 直出走 ACESFilmic + sRGB 编码，
 *      后期链路却把线性值直接写屏，既没色调映射也没色彩编码（主因，见 ArenaApp）；
 *   ② shader 里把"提亮 + 暗角"挂在 `amount` 上，一开景深就叠一层曝光变化。
 * 现在：`amount` **只管模糊 + 提饱和**（提饱和以 lum 为中心线性外插，加权亮度守恒），
 * 压暗整段拆到独立的 `dim` 通道。
 *
 * 修完的四档实测（1000×600 逐像素平均亮度，CDP 无头 Edge）：
 * | 档 | 平均亮度 | 相对直出 |
 * | --- | --- | --- |
 * | 直出 tilt=0 dim=0 | 0.280 | — |
 * | composer 空转 tilt≈0 | 0.309 | +10.5% |
 * | 景深开到底 tilt=1 dim=0 | 0.309 | +10.5%（相对空转 **−0.02%**）|
 * | 只压暗 dim=1 | 0.153 | −45.4% |
 * 也就是说**景深强度本身一滴都不改亮度**；剩下那 +10% 是"从直出切进后期"的
 * 一次性链路差异（three 的线性 render target 与直出 clearColor 路径不同，
 * 两种 pass 顺序都约 10%，未定位到具体一行，记为已知项），不是效果造成的。
 *
 * **dim 是刻意留的接口，不是残余效果**：用户后续要做「10 分钟一大局，从早上打到晚上」
 * 的夕阳 / 夜晚。到时候时间轴只要调 `ArenaApp.setDim(t)`，白天 0 仍然是零后期开销。
 * 色温（暖橙 / 冷蓝）等第二个昼夜用例出现再加，这一版只做曝光。
 *
 * 关键：`amount = 0 && dim = 0` 时 ArenaApp 会**完全跳过 composer**，直接 renderer.render ——
 * 不开这两个功能的人一帧额外开销都没有。
 */
import * as THREE from 'three';

/** 昼夜压暗系数（唯一来源）：曝光下降 + 边缘暗角。GLSL 和测试都从这里读。 */
export const DIM_SHADE = {
  /** dim=1 时整体曝光保留多少（0.55 ⇒ 降到 45%） */
  exposure: 0.55,
  /** 边缘暗角强度，沿用旧景深那一档，用户说"变暗可以保存" */
  vignette: 0.14,
} as const;

export interface TiltShiftShaderDef {
  uniforms: {
    tDiffuse: { value: THREE.Texture | null };
    /** 微缩景深强度：**只影响模糊与饱和，不影响曝光** */
    amount: { value: number };
    /** 昼夜氛围压暗：独立通道，0 = 白天/不改画面 */
    dim: { value: number };
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
    dim: { value: 0 },
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
    uniform float dim;
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

      // 玩具模型的塑料感：**只提饱和**。mix 的中心就是 lum，线性外插不改变加权亮度，
      // 所以景深本身一滴都不改曝光。旧的「提亮 + 暗角」已挪进下面的 dim 通道。
      float lum = dot(base.rgb, vec3(0.299, 0.587, 0.114));
      base.rgb = mix(vec3(lum), base.rgb, 1.0 + 0.22 * amount);

      // ---- 昼夜氛围：与景深强度完全解耦（后续 10 分钟大局的夕阳/夜晚入口）----
      if (dim > 0.001) {
        vec2 off = vUv - 0.5;
        float vignette = 1.0 - dim * ${DIM_SHADE.vignette.toFixed(2)} * dot(off, off) * 3.0;
        base.rgb *= (1.0 - dim * ${DIM_SHADE.exposure.toFixed(2)}) * vignette;
      }

      gl_FragColor = base;
    }
  `,
};

export const TILT_KEY = 'gamekar.tilt.v1';
/** 昼夜压暗独立存档：不和景深共用 key，调景深不会把昼夜档冲掉 */
export const DIM_KEY = 'gamekar.dim.v1';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function readStored(key: string): number {
  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw)) return clamp01(raw);
  } catch {
    // 无头 / 隐私模式：默认关
  }
  return 0;
}

function writeStored(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(clamp01(value)));
  } catch {
    // 存不下不影响这一局
  }
}

/** 景深强度 0~1；默认 0（关），存 localStorage。 */
export function loadTilt(): number {
  return readStored(TILT_KEY);
}

export function saveTilt(value: number): void {
  writeStored(TILT_KEY, value);
}

/** 昼夜压暗 0~1；默认 0（白天/不改画面），独立存档。 */
export function loadDim(): number {
  return readStored(DIM_KEY);
}

export function saveDim(value: number): void {
  writeStored(DIM_KEY, value);
}
