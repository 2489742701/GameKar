/**
 * 小人的 3D 呈现 —— 一张竖起来的像素卡片，永远正对相机。
 *
 * 为什么不做左右翻面：实测这批素材是**正面**的，不是侧视
 * （idle/run/run_one/run_ninja 四组动画的剪影左右对称度 0.917–0.969，接近 1）。
 * 翻一张正面的脸并不会让它"转身"，只会让它看起来像被水平镜像过。
 * 所以小人只绕 Y 轴转到正对相机，走位方向靠位置与动作表达。
 *
 * UV 写在各自己的几何体上，不动纹理的 offset/repeat：
 * 同风格的多个小人共用一张纹理，动纹理就是互相踩。
 */

import * as THREE from 'three';
import { KNOWN_ANIMS, type AnimName } from './anims';
import { atlasLayout, buildAtlas, frameRect, type Atlas, type AtlasLayout } from './atlas';
import type { DudePack } from './pack';
import type { DudeStyle } from './style';

export interface DudeAppearance {
  /** 世界单位身高：一格 = 1，0.7 就是"比一格矮一点" */
  height: number;
  /** 离地块顶面再抬多少，避免和地面贴脸 */
  lift: number;
}

export const DEFAULT_APPEARANCE: DudeAppearance = { height: 0.7, lift: 0.012 };

/** 帧号：单帧动画恒为 0；die 不循环，播到最后一帧停住。 */
export function frameOf(anim: AnimName, time: number, loop = true): number {
  const spec = KNOWN_ANIMS[anim];
  if (spec.frames <= 1) return 0;
  const raw = Math.floor(time * spec.fps);
  return loop ? raw % spec.frames : Math.min(raw, spec.frames - 1);
}

export class DudeSprite {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly uv: THREE.BufferAttribute;
  private stamp = '';
  private anim: AnimName = 'idle';

  constructor(
    private readonly pack: DudePack,
    private readonly atlas: Atlas,
    texture: THREE.Texture,
    appearance: DudeAppearance = DEFAULT_APPEARANCE,
  ) {
    // 素材一帧是 16x24，卡片要保住这个比例，不然人就变胖或变瘦
    const width = appearance.height * (pack.w / pack.h);

    this.geometry = new THREE.PlaneGeometry(width, appearance.height);
    this.uv = this.geometry.getAttribute('uv') as THREE.BufferAttribute;
    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // PlaneGeometry 是居中的，所以底边贴地要把身高抬一半
    this.mesh.position.y = appearance.height / 2 + appearance.lift;
    // 构造就定一帧：不写 UV 的话，几何体带着 PlaneGeometry 默认的 0..1，
    // 会先把整张图集拉扁在一张卡片上，直到下一次 update 才盖掉
    this.play('idle', 0);
  }

  get playing(): AnimName {
    return this.anim;
  }

  faceCamera(yawDeg: number): void {
    this.mesh.rotation.y = THREE.MathUtils.degToRad(yawDeg);
  }

  play(anim: AnimName, time: number, loop = true): void {
    this.anim = anim;
    const frame = frameOf(anim, time, loop);
    const next = `${anim}|${frame}`;
    if (next === this.stamp) return;
    this.stamp = next;

    const rect = frameRect(this.atlas.layout, this.pack, anim, frame);
    const canvasWidth = this.atlas.canvas.width;
    const u0 = rect.x / canvasWidth;
    const u1 = (rect.x + rect.w) / canvasWidth;

    // PlaneGeometry 顶点序：左上、右上、左下、右下
    this.uv.setXY(0, u0, 1);
    this.uv.setXY(1, u1, 1);
    this.uv.setXY(2, u0, 0);
    this.uv.setXY(3, u1, 0);
    this.uv.needsUpdate = true;
  }

  moveTo(x: number, z: number): void {
    this.mesh.position.x = x;
    this.mesh.position.z = z;
  }

  /** 每个小人有自己的几何体与材质，纹理是共享的，所以这里不碰纹理。 */
  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * 风格 → 图集与纹理的缓存：一个风格一张纹理。
 * 20 个小人如果是同一风格，显存里只有一份 208×24。
 */
export class DudeGallery {
  private readonly entries = new Map<string, { atlas: Atlas; texture: THREE.Texture }>();

  constructor(private readonly pack: DudePack) {}

  /** 内容寻址：同一份长相不管对象是谁，都落到同一条缓存。 */
  static keyOf(style: DudeStyle): string {
    return [style.base, style.head, style.face, ...Object.values(style.hex)].join('|');
  }

  get styleCount(): number {
    return this.entries.size;
  }

  get layout(): AtlasLayout {
    return atlasLayout(this.pack);
  }

  /** 已烘的像素总量，用来判断"风格数是不是涨过头了"。 */
  get atlasPixels(): number {
    let n = 0;
    for (const { atlas } of this.entries.values()) n += atlas.canvas.width * atlas.canvas.height;
    return n;
  }

  acquire(style: DudeStyle): { atlas: Atlas; texture: THREE.Texture } {
    const key = DudeGallery.keyOf(style);
    const cached = this.entries.get(key);
    if (cached) return cached;

    const atlas = buildAtlas(this.pack, style);
    const texture = new THREE.CanvasTexture(atlas.canvas);
    // 像素画：近邻采样 + 不要 mipmap，否则一缩放就糊成灰
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    const entry = { atlas, texture };
    this.entries.set(key, entry);
    return entry;
  }

  createSprite(style: DudeStyle, appearance?: DudeAppearance): DudeSprite {
    const { atlas, texture } = this.acquire(style);
    return new DudeSprite(this.pack, atlas, texture, appearance);
  }

  dispose(): void {
    for (const { texture } of this.entries.values()) texture.dispose();
    this.entries.clear();
  }
}
