/**
 * 图集烘焙 —— 把一个风格的 17 帧（stand1+idle4+run4+hurt4+die4）横排画进一张 canvas。
 *
 * 分两半是有原因的：
 *  - atlasLayout 是纯数学（哪帧在第几格、总宽多少），能在 node 里断言；
 *  - buildAtlas 要 document/canvas，只在浏览器跑。
 * 每帧画完立刻整帧换色再抄进图集，所以换色只做 17 次，不是每像素重复。
 */

import { ANIM_NAMES, KNOWN_ANIMS, type AnimName } from './anims';
import type { DudePack } from './pack';
import { colorSetOf, type DudeStyle } from './style';
import { compileRules, recolorRgba } from './recolor';

export interface FrameSlot {
  anim: AnimName;
  /** 帧号 */
  index: number;
  /** 在图集里第几格 */
  slot: number;
}

export interface AtlasLayout {
  frameCount: number;
  width: number;
  height: number;
  /** anim → 该动画在图集里的起始格号与帧数 */
  byAnim: Record<AnimName, { start: number; frames: number }>;
}

/** 纯数学部分：不碰 DOM，所以能被单测钉住。 */
export function atlasLayout(pack: DudePack): AtlasLayout {
  const byAnim = {} as Record<AnimName, { start: number; frames: number }>;
  let slot = 0;

  for (const anim of ANIM_NAMES) {
    const spec = KNOWN_ANIMS[anim];
    byAnim[anim] = { start: slot, frames: spec.frames };
    slot += spec.frames;
  }

  return {
    frameCount: slot,
    width: slot * pack.w,
    height: pack.h,
    byAnim,
  };
}

export interface Atlas {
  canvas: HTMLCanvasElement;
  layout: AtlasLayout;
  style: DudeStyle;
}

/**
 * 把一帧画进 scratch 上下文：三次 drawImage 取"表里的这一格"，再整帧换色。
 * 偏移公式和上游一致 —— 表是横向取帧、纵向取体型行。
 */
function paintFrame(ctx: CanvasRenderingContext2D, pack: DudePack, style: DudeStyle, anim: AnimName, frame: number): void {
  const spec = KNOWN_ANIMS[anim];
  const images = pack.images;
  if (!images) throw new Error('pack.images 还没加载，先 await loadPack()');

  ctx.clearRect(0, 0, pack.w, pack.h);
  ctx.drawImage(images.base, -(spec.col + frame) * pack.w, -style.base * pack.h);
  ctx.drawImage(images.heads, -style.head * pack.w, pack.offsetY('head', spec.key, frame));
  ctx.drawImage(images.faces, -style.face * pack.w, pack.offsetY('face', spec.key, frame));

  const imd = ctx.getImageData(0, 0, pack.w, pack.h);
  recolorRgba(imd.data, compileRules(pack), colorSetOf(style));
  ctx.putImageData(imd, 0, 0);
}

/** 浏览器侧：烘一张风格图集。返回的 canvas 交给 DudeView 变成纹理。 */
export function buildAtlas(pack: DudePack, style: DudeStyle): Atlas {
  const layout = atlasLayout(pack);
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  canvas.style.imageRendering = 'pixelated';

  // 先画到等大的 scratch 上，再把整帧抄进图集：getImageData 的坐标就能一直是 (0,0,w,h)
  const scratch = document.createElement('canvas');
  scratch.width = pack.w;
  scratch.height = pack.h;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  const actx = canvas.getContext('2d');
  if (!sctx || !actx) throw new Error('拿不到 2d 上下文');

  for (const anim of ANIM_NAMES) {
    const spec = KNOWN_ANIMS[anim];
    for (let f = 0; f < spec.frames; f++) {
      paintFrame(sctx, pack, style, anim, f);
      actx.drawImage(scratch, (layout.byAnim[anim].start + f) * pack.w, 0);
    }
  }

  return { canvas, layout, style };
}

/** 某个动画某一帧在图集里的像素矩形，DudeView 用它算 UV。 */
export function frameRect(layout: AtlasLayout, pack: DudePack, anim: AnimName, frame: number): { x: number; y: number; w: number; h: number } {
  const entry = layout.byAnim[anim];
  const index = entry.start + (entry.frames > 1 ? frame % entry.frames : 0);
  return { x: index * pack.w, y: 0, w: pack.w, h: pack.h };
}
