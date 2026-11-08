/**
 * 对战模式的背景（P-082，2026-11-08）。
 *
 * **为什么不能再用 `renderer.setClearColor(0x0b1220)` 当背景**（P-077 遗留的 +10% 跳变）：
 *
 * 清屏色是 `gl.clearColor` 写的，**不经过材质着色器，也就不经过色调映射**。
 *   · 直出链路：WebGLBackground 按 `outputColorSpace(sRGB)` 把清屏色写进默认帧缓冲，
 *     画面上就是 (11,18,32)；
 *   · composer 链路：`RenderPass` 先 `renderer.clear()`，此时 GL 的清屏色状态还是上一次
 *     直出留下的 **sRGB 数值**，却被清进了**线性** render target（RenderPass 的 clear 发生在
 *     `WebGLBackground.setClear()` 之前，来不及换成线性值）。随后 `OutputPass` 又对这整幅
 *     线性缓冲做了一次 ACES + sRGB —— 清屏色被凭空色调映射了一遍，变成 (45,66,97)。
 * 于是「把景深从 0 拉到 0.002」这一下，几何像素一模一样，只有背景被抬亮，
 * 整幅平均亮度 **+10.47%**。
 *
 * 反证（`tools/brightness_probe.mjs` 的 PROBE_INIT）：把 clearColor 设成纯黑后，
 * 直出 0.27005 / composer 空转 0.27012，跳变只剩 **+0.03%** —— 黑色对任何色调映射
 * 都是不动点，证明差异 100% 来自清屏色，不是模糊/提饱和/resolution。
 *
 * **修法**：让背景变成"被渲染出来的几何"，而不是"被 clear 出来的状态"。
 * `scene.background` 给一张 1×1 的 `DataTexture`，three 会用 `ShaderLib.background`
 * 的全屏平面画它；该材质 `toneMapped = true`（前提是纹理不是 sRGB 色域），
 * fragment 里带 `tonemapping_fragment` + `colorspace_fragment`：
 *   · 直出：材质里做 ACES + sRGB；
 *   · composer：渲到线性 RT 时 three 自动跳过这两步，由 `OutputPass` 做同一套。
 * 两条链路对背景和几何走的是同一套数学，亮度自然一致。
 *
 * 数值仍取旧清屏色的三个字节 (0x0b,0x12,0x20)，但现在**当作线性值**喂给色调映射：
 * 这样"默认开着后期"看到的底色和改之前一致，只有把景深拉到 0 的直出档不再变暗。
 * clearColor 退成纯黑只作兜底（万一有像素没被背景平面覆盖）。
 *
 * 老模式 /index.html 不走这里，仍用 `Renderer` 构造里的清屏色。
 */
import * as THREE from 'three';

/** 旧清屏色 0x0b1220 的三通道；在这里是**线性**数值（见文件头）。 */
export const BACKDROP_RGB = [0x0b, 0x12, 0x20] as const;

/**
 * 把背景与清屏色一起装好。必须在 composer 创建之前调用。
 * 只在对战模式用；老模式保留自己的清屏色。
 */
export function installArenaBackdrop(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
  renderer.setClearColor(0x000000, 1);

  const tex = new THREE.DataTexture(
    new Uint8Array([...BACKDROP_RGB, 0xff]),
    1,
    1,
    THREE.RGBAFormat,
  );
  // NoColorSpace ⇒ ColorManagement.getTransfer() 返回 LinearTransfer ≠ SRGBTransfer
  // ⇒ WebGLBackground 把背景平面材质的 toneMapped 设为 true。改成 SRGBColorSpace 会
  // 让直出链路跳过色调映射、composer 链路照做，+10% 的跳变立刻回来（别改）。
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  scene.background = tex;
}
