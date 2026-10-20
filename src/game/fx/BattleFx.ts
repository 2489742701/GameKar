/**
 * 战场特效 —— 弹丸与爆炸，全部是代码画的像素图，不引任何图片素材。
 *
 * 用户这一轮点名的三件事都在这：
 *   箭塔 → **2D 的箭**（一张 16×5 的像素箭，Sprite 跟着速度方向转）；
 *   炮塔 → **3D 的黑色方块**，落地**爆炸**（环 + 一把往上飘的烟）；
 *   开火 → **火焰感**（炮口那一下短促的亮片）+ **像素风烟雾**（alpha 只走 4 个台阶，不平滑）。
 *
 * 上限全部写死：箭 48、炮弹 24、魔弹 32、烟 64、闪光 16。
 * 超了就丢弃并计入 `dropped` —— 宁可少一片烟，也不能让 draw call 无上限地涨。
 */

import * as THREE from 'three';
import type { Combat, Shot } from '@game/systems/Combat';

const CAP = { arrow: 48, cannon: 24, magic: 32, smoke: 64, flash: 16 };

/** 烟雾 alpha 的台阶：0.8 → 0.5 → 0.28 → 0.1，然后收掉。台阶是"像素感"的来源。 */
const SMOKE_STEPS = [0.8, 0.5, 0.28, 0.1];

function canvasOf(size: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('拿不到 2d 上下文，特效纹理生成不了');
  return { c, ctx };
}

/** 像素箭：一根杆 + 一个三角头 + 两片羽。16×5，箭头朝 +x。 */
function arrowTexture(): THREE.Texture {
  const { c, ctx } = canvasOf(16);
  ctx.clearRect(0, 0, 16, 16);
  ctx.fillStyle = '#c9b48a';
  ctx.fillRect(3, 2, 9, 1);
  ctx.fillStyle = '#d9d9e3';
  ctx.fillRect(12, 1, 3, 3);
  ctx.fillStyle = '#8a5f2c';
  ctx.fillRect(1, 0, 2, 2);
  ctx.fillRect(1, 4, 2, 1);
  return pixelTexture(c);
}

/** 一团烟：几个方块堆成的不规则团，边缘硬。 */
function smokeTexture(seed: number): THREE.Texture {
  const { c, ctx } = canvasOf(12);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  ctx.fillStyle = 'rgba(226,226,226,0.95)';
  for (let i = 0; i < 14; i++) {
    const x = Math.floor(rnd() * 10) + 1;
    const y = Math.floor(rnd() * 10) + 1;
    ctx.fillRect(x, y, 2, 2);
  }
  return pixelTexture(c);
}

/** 炮口火光：一个十字亮片。 */
function flashTexture(): THREE.Texture {
  const { c, ctx } = canvasOf(10);
  ctx.fillStyle = '#fff2c4';
  ctx.fillRect(3, 4, 4, 2);
  ctx.fillRect(4, 3, 2, 4);
  ctx.fillStyle = '#ffb545';
  ctx.fillRect(1, 4, 2, 2);
  ctx.fillRect(7, 4, 2, 2);
  ctx.fillRect(4, 1, 2, 2);
  ctx.fillRect(4, 7, 2, 2);
  return pixelTexture(c);
}

/** 魔弹：一个青色亮点。 */
function magicTexture(): THREE.Texture {
  const { c, ctx } = canvasOf(8);
  ctx.fillStyle = '#bff4ff';
  ctx.fillRect(3, 1, 2, 6);
  ctx.fillRect(1, 3, 6, 2);
  ctx.fillStyle = '#74e0ff';
  ctx.fillRect(2, 2, 4, 4);
  return pixelTexture(c);
}

function pixelTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Puff {
  sprite: THREE.Sprite;
  life: number;
  seconds: number;
  rise: number;
  scale: number;
}

export interface FxReadout {
  arrows: number;
  cannons: number;
  magics: number;
  puffs: number;
  dropped: number;
}

export class BattleFx {
  readonly group = new THREE.Group();
  private readonly tex = {
    arrow: arrowTexture(),
    flash: flashTexture(),
    magic: magicTexture(),
    smoke: [smokeTexture(7), smokeTexture(101), smokeTexture(2023)],
  };
  private readonly box = new THREE.BoxGeometry(0.17, 0.17, 0.17);
  private readonly iron = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.62, metalness: 0.35, flatShading: true });
  private readonly cubes: THREE.Mesh[] = [];
  private readonly quads = new Map<string, THREE.Sprite[]>();
  private readonly puffs: Puff[] = [];
  dropped = 0;

  constructor() {
    this.group.name = 'fx';
  }

  /** 每帧：弹丸位置跟着 Combat 的 shots 走，命中由 Combat 发 impact 事件。 */
  sync(combat: Combat, dt: number): void {
    const shots = combat.liveShots();
    const byKind: Record<Shot['ammo'], Shot[]> = { arrow: [], cannon: [], magic: [] };
    for (const s of shots) byKind[s.ammo].push(s);

    this.arrows(byKind.arrow);
    this.cannons(byKind.cannon);
    this.magics(byKind.magic);
    this.age(dt);
  }

  private arrows(list: Shot[]): void {
    const pool = this.take('arrow', list.length, CAP.arrow);
    list.forEach((shot, i) => {
      const sprite = pool[i]!;
      const dx = shot.toX - shot.fromX;
      const dz = shot.toZ - shot.fromZ;
      sprite.position.set(shot.x, 0.55 + shot.y + Math.sin(shot.t * Math.PI * 6) * 0.02, shot.z);
      // 精灵永远朝相机，所以"转向"只能改贴图的旋转量
      (sprite.material as THREE.SpriteMaterial).rotation = -Math.atan2(dz, dx);
      sprite.scale.set(0.52, 0.16, 1);
    });
    this.release('arrow', pool.length);
  }

  private cannons(list: Shot[]): void {
    while (this.cubes.length < Math.min(list.length, CAP.cannon)) {
      const mesh = new THREE.Mesh(this.box, this.iron);
      mesh.castShadow = true;
      this.group.add(mesh);
      this.cubes.push(mesh);
    }
    list.forEach((shot, i) => {
      const mesh = this.cubes[i];
      if (!mesh) {
        this.dropped++;
        return;
      }
      mesh.visible = true;
      mesh.position.set(shot.x, 0.35 + shot.y, shot.z);
      mesh.rotation.x = shot.t * 7;
      mesh.rotation.z = shot.t * 4;
    });
    for (let i = list.length; i < this.cubes.length; i++) this.cubes[i]!.visible = false;
  }

  private magics(list: Shot[]): void {
    const pool = this.take('magic', list.length, CAP.magic);
    list.forEach((shot, i) => {
      const sprite = pool[i]!;
      sprite.position.set(shot.x, 0.7 + shot.y, shot.z);
      const pulse = 0.24 + Math.sin(shot.t * Math.PI * 4) * 0.05;
      sprite.scale.set(pulse, pulse, 1);
    });
    this.release('magic', pool.length);
  }

  /** 一次命中：炮是"环 + 一把烟 + 火"，箭与魔弹只冒两小撮烟。 */
  impact(x: number, z: number, groundY: number, ammo: Shot['ammo'], splash: number): void {
    this.flash(x, z, groundY + 0.5, ammo === 'cannon' ? 0.7 : 0.3);
    const puffs = ammo === 'cannon' ? 7 : ammo === 'magic' ? 3 : 2;
    for (let i = 0; i < puffs; i++) {
      const heavy = ammo === 'cannon';
      this.puff(
        x + (Math.random() - 0.5) * (splash > 0 ? splash : 0.3),
        z + (Math.random() - 0.5) * (splash > 0 ? splash : 0.3),
        groundY + 0.1 + (heavy ? Math.random() * 0.2 : 0),
        heavy ? 0.5 + Math.random() * 0.5 : 0.22,
        0.5 + Math.random() * 0.5,
      );
    }
  }

  /** 开火那一下的炮口火光。 */
  muzzle(x: number, z: number, y: number): void {
    this.flash(x, z, y, 0.3);
  }

  private flash(x: number, z: number, y: number, scale: number): void {
    const pool = this.take('flash', 1, CAP.flash);
    const sprite = pool[0];
    if (!sprite) {
      this.dropped++;
      return;
    }
    sprite.position.set(x, y, z);
    sprite.scale.set(scale, scale, 1);
    this.puffs.push({ sprite, life: 0, seconds: 0.14, rise: 0, scale });
    this.release('flash', 1);
  }

  private puff(x: number, z: number, y: number, scale: number, seconds: number): void {
    if (this.puffs.length >= CAP.smoke) {
      this.dropped++;
      return;
    }
    const map = this.tex.smoke[this.puffs.length % this.tex.smoke.length]!;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map, transparent: true, opacity: SMOKE_STEPS[0], depthWrite: false }),
    );
    sprite.position.set(x, y, z);
    sprite.scale.set(scale, scale, 1);
    this.group.add(sprite);
    this.puffs.push({ sprite, life: 0, seconds, rise: 0.9, scale });
  }

  private age(dt: number): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      p.life += dt;
      const k = p.life / p.seconds;
      if (k >= 1) {
        p.sprite.visible = false;
        if (p.sprite.material.map === null) p.sprite.removeFromParent();
        this.puffs.splice(i, 1);
        continue;
      }
      // alpha 走台阶，不走连续插值：这就是"像素风烟雾"
      const step = Math.min(SMOKE_STEPS.length - 1, Math.floor(k * SMOKE_STEPS.length));
      const mat = p.sprite.material as THREE.SpriteMaterial;
      mat.opacity = SMOKE_STEPS[step]!;
      p.sprite.position.y += p.rise * dt;
      const grow = p.scale * (1 + k * 1.4);
      p.sprite.scale.set(grow, grow, 1);
    }
  }

  private take(kind: 'arrow' | 'magic' | 'flash', want: number, cap: number): THREE.Sprite[] {
    const pool = this.poolOf(kind);
    while (pool.length < Math.min(want, cap)) {
      const map = kind === 'arrow' ? this.tex.arrow : kind === 'magic' ? this.tex.magic : this.tex.flash;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, alphaTest: kind === 'arrow' ? 0.35 : 0 }),
      );
      sprite.visible = false;
      this.group.add(sprite);
      pool.push(sprite);
    }
    const out = pool.slice(0, Math.min(want, cap));
    for (const s of out) s.visible = true;
    if (want > out.length) this.dropped += want - out.length;
    return out;
  }

  private release(kind: 'arrow' | 'magic' | 'flash', used: number): void {
    const pool = this.poolOf(kind);
    for (let i = used; i < pool.length; i++) pool[i]!.visible = false;
  }

  private poolOf(kind: 'arrow' | 'magic' | 'flash'): THREE.Sprite[] {
    return this.quads.get(kind) ?? this.newPool(kind);
  }

  private newPool(kind: 'arrow' | 'magic' | 'flash'): THREE.Sprite[] {
    const pool: THREE.Sprite[] = [];
    this.quads.set(kind, pool);
    return pool;
  }

  get readout(): FxReadout {
    return {
      arrows: this.quads.get('arrow')?.filter((s) => s.visible).length ?? 0,
      cannons: this.cubes.filter((m) => m.visible).length,
      magics: this.quads.get('magic')?.filter((s) => s.visible).length ?? 0,
      puffs: this.puffs.length,
      dropped: this.dropped,
    };
  }

  dispose(): void {
    this.box.dispose();
    this.iron.dispose();
    for (const list of this.quads.values()) for (const s of list) (s.material as THREE.Material).dispose();
    for (const p of this.puffs) (p.sprite.material as THREE.Material).dispose();
  }
}
