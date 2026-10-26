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

const CAP = { arrow: 48, cannon: 24, magic: 32, smoke: 64, flash: 16, haze: 72 };

/** 单栋楼同时最多几团雾（global cap 之上的第二道闸，防止一栋楼吃满全场） */
const PER_SITE_HAZE = 26;

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

/**
 * 体积雾的一张"雾团"：中心近实、边缘化到全透明，再拿几个圆把渐变挖出豁口。
 * 三张不同种子 ⇒ 叠在一起不会看成同一个甜甜圈盖了两遍。
 *
 * 和命中烟的像素风刻意不同：那是"溅起的土"，这是"悬在空气里的尘"，
 * 所以这里走 LinearFilter 的软边，不是 NearestFilter 的硬块。
 */
function hazeTexture(seed: number): THREE.Texture {
  const size = 96;
  const { c, ctx } = canvasOf(size);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  // 一团雾 = 5 个错开的白团相加：中间叠满、边上自然稀，轮廓是团絮状的而不是一个圆
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 5; i++) {
    const cx = size * (0.3 + rnd() * 0.4);
    const cy = size * (0.3 + rnd() * 0.4);
    const r = size * (0.26 + rnd() * 0.2);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.26)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  // 收边：整张乘一个大径向遮罩，别让雾在画布方框上被切成四道直边。
  // （上一版用 destination-out 挖洞，16 个圆加起来比整张画布还大 ⇒ 把雾擦干净了，
  //   于是"雾生成了、读数是 42 团、屏幕上一片没有"。）
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(size / 2, size / 2, size * 0.26, size / 2, size / 2, size * 0.5);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.7, 'rgba(255,255,255,0.85)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // 96×96 是非 2 的幂：配 mipmap 在部分 WebGL 实现里会得到"贴图不完整"，
  // 采样结果整片 alpha=0（实测：雾生成了 42 团、贴图 alpha 0.89、屏幕上一片没有）。
  // 雾要的是软，不是锐，所以干脆不要 mipmap，直接双线性。
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
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
  /** 水平漂移（格/秒）：炮口的烟要往炮管方向推出去，不是原地往上飘 */
  driftX: number;
  driftZ: number;
}

/** 一团体积雾：大到能挡住楼、淡到不脏屏，起身快、散得慢。 */
interface Haze {
  sprite: THREE.Sprite;
  /** 哪栋楼的雾（按楼限额用；同一栋楼的雾才有资格抢同一个配额） */
  key: number;
  life: number;
  seconds: number;
  scale: number;
  alpha: number;
  rise: number;
  driftX: number;
  driftZ: number;
  rotate: number;
}

export interface FxReadout {
  arrows: number;
  cannons: number;
  magics: number;
  puffs: number;
  haze: number;
  dropped: number;
}

export class BattleFx {
  readonly group = new THREE.Group();
  private readonly tex = {
    arrow: arrowTexture(),
    flash: flashTexture(),
    magic: magicTexture(),
    smoke: [smokeTexture(7), smokeTexture(101), smokeTexture(2023)],
    haze: [hazeTexture(11), hazeTexture(77), hazeTexture(313)],
  };
  private readonly box = new THREE.BoxGeometry(0.17, 0.17, 0.17);
  private readonly iron = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.62, metalness: 0.35, flatShading: true });
  private readonly cubes: THREE.Mesh[] = [];
  private readonly quads = new Map<string, THREE.Sprite[]>();
  private readonly puffs: Puff[] = [];
  private readonly hazes: Haze[] = [];
  /** 散掉的雾不销毁，留着下一团复用 —— 否则每团一次材质分配，跑十分钟就是几千份 */
  private readonly hazeFree: THREE.Sprite[] = [];
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
    this.step(dt);
  }

  /**
   * 只推进粒子寿命。
   * 对战模式的弹丸自己算（不经过 Combat），只要调用 `muzzle()` / `impact()` 再每帧 `step(dt)`，
   * 不用为了冒烟去造一个假的战斗对象。
   */
  step(dt: number): void {
    this.age(dt);
    this.ageHaze(dt);
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

  /**
   * 开火那一下的炮口效果。
   *
   * 上一版只有一颗 0.14 秒的火星，而且落在**塔心**（from 坐标）不是炮口 ——
   * 炮塔转起来以后火光还留在原地，看着像"塔在冒烟"。现在由视图把炮口位置算好传进来，
   * 再按朝向补几团往前吹的烟，炮才有后坐感。
   */
  muzzle(x: number, z: number, y: number, ammo: Shot['ammo'] = 'arrow', dirX = 0, dirZ = 1): void {
    const heavy = ammo === 'cannon';
    this.flash(x, z, y, heavy ? 0.55 : ammo === 'magic' ? 0.34 : 0.2);
    if (!heavy) {
      // 轻武器也留一小撮：箭塔开火至少要有一缕，不然玩家看到的就是"什么都没有"
      this.puff(x + dirX * 0.08, z + dirZ * 0.08, y, 0.2, 0.3);
      return;
    }
    // 炮口的烟要"扑出来"：四团、越靠前越大、活得也久一点（上一版三团太小、太快散）
    for (let i = 0; i < 4; i++) {
      const ahead = 0.12 + i * 0.14;
      this.puff(x + dirX * ahead, z + dirZ * ahead, y + 0.03 * i, 0.3 + i * 0.13, 0.45 + i * 0.1);
    }
  }

  /**
   * 建造雾霭：一块地上升起几团软雾，楼身在雾里半遮半露。
   *
   * 和 `impact` 的像素烟是两套东西：那是"打中了、土飞起来"，硬边、短命、几十粒；
   * 这是"工地扬尘"，软边、大、慢，主要作用是**挡住** —— 所以强度靠叠层数，
   * 不靠把单张调黑（调黑就成黑烟了）。
   */
  buildHaze(x: number, z: number, baseY: number, radius: number, strength: number, key: number): void {
    /**
     * 每栋楼自己的配额。
     *
     * 只做全局上限是不够的：开局议事厅也在建造，它一栋就能把 72 团的额度吃满，
     * 后面开工的楼一团雾都排不上（实测 dropped 99、屏幕上只有议事厅在冒烟）。
     */
    let live = 0;
    for (const h of this.hazes) if (h.key === key) live++;
    if (live >= PER_SITE_HAZE) return;

    // 一次只出 2 团：单团叠太多就是一块白布，叠不动反而看得清楼
    const count = Math.max(1, Math.round(2 * strength));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      // 开方是为了让点在圆里均匀，直接取 r=random 会挤在中心，雾团叠成一坨
      const r = Math.sqrt(Math.random()) * radius;
      this.spawnHaze(
        x + Math.cos(a) * r,
        z + Math.sin(a) * r,
        baseY + Math.random() * 0.9,
        /**
         * 单团直径 ≈ 1.0~1.7 个世界单位（半格到一格）。
         * 这个数是量出来的：sprite 的 scale 就是世界单位，上一版给到 3~5 ⇒
         * 一团雾 3 格多宽，几团一叠屏幕上就是一整块白布，楼都看不见了。
         */
        (1.5 + Math.random() * 0.7) * (0.85 + radius * 0.3),
        0.3 * strength,
        2.6 + Math.random() * 1.4,
        key,
      );
    }
    // 贴地那一层：更宽更扁更久，负责"脚下看不清"。半空孤零零几团雾看着像贴片，
    // 有了落地这一层，整团雾才"站"在地上。它最淡，因为它是底噪不是主体。
    this.spawnHaze(x, z, baseY - 0.04, 2.2 + radius * 0.6, 0.18 * strength, 3.4 + Math.random(), key);
  }

  private spawnHaze(
    x: number,
    z: number,
    y: number,
    scale: number,
    alpha: number,
    seconds: number,
    key: number,
  ): void {
    if (this.hazes.length >= CAP.haze) {
      this.dropped++;
      return;
    }
    let sprite = this.hazeFree.pop();
    if (!sprite) {
      sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          transparent: true,
          depthWrite: false,
          /**
           * **不做深度测试**：雾要在楼前面。
           *
           * 试过守着 depthTest：雾心就在楼里，楼把它挡掉 80%，屏幕上只剩楼上沿一小片 ——
           * 那就成了"楼后面有雾"，不是"楼在雾里"。关掉之后雾永远叠在世界之上，
           * 这才是"看不清楚"该有的样子。
           */
          depthTest: false,
          opacity: 0,
          color: 0xe8eef6,
        }),
      );
      sprite.renderOrder = 8;
      this.group.add(sprite);
    }
    const mat = sprite.material as THREE.SpriteMaterial;
    const variant = this.tex.haze[(this.hazes.length + Math.floor(Math.random() * 3)) % 3]!;
    if (mat.map !== variant) {
      mat.map = variant;
      // 贴图是后挂上去的：不标脏，着色器还停在没有 map 的那套程序上
      mat.needsUpdate = true;
    }
    mat.rotation = Math.random() * Math.PI * 2;
    mat.opacity = 0;
    sprite.visible = true;
    sprite.position.set(x, y, z);
    sprite.scale.set(scale, scale, 1);
    this.hazes.push({
      sprite,
      key,
      life: 0,
      seconds,
      scale,
      alpha,
      rise: 0.22 + Math.random() * 0.2,
      driftX: (Math.random() - 0.5) * 0.35,
      driftZ: (Math.random() - 0.5) * 0.35,
      rotate: (Math.random() - 0.5) * 0.6,
    });
  }

  private ageHaze(dt: number): void {
    for (let i = this.hazes.length - 1; i >= 0; i--) {
      const h = this.hazes[i]!;
      h.life += dt;
      const k = h.life / h.seconds;
      if (k >= 1) {
        h.sprite.visible = false;
        this.hazeFree.push(h.sprite);
        this.hazes.splice(i, 1);
        continue;
      }
      // 前 15% 涌上来，之后按幂次散：雾是"先压过来再慢慢化开"，线性淡出像开关
      const fade = Math.min(1, k / 0.15) * Math.pow(1 - k, 1.35);
      const mat = h.sprite.material as THREE.SpriteMaterial;
      mat.opacity = h.alpha * fade;
      mat.rotation += h.rotate * dt;
      h.sprite.position.x += h.driftX * dt;
      h.sprite.position.y += h.rise * dt;
      h.sprite.position.z += h.driftZ * dt;
      const grow = h.scale * (1 + k * 0.8);
      h.sprite.scale.set(grow, grow, 1);
    }
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
    this.puffs.push({ sprite, life: 0, seconds: 0.14, rise: 0, scale, driftX: 0, driftZ: 0 });
    this.release('flash', 1);
  }

  private puff(
    x: number,
    z: number,
    y: number,
    scale: number,
    seconds: number,
    driftX = 0,
    driftZ = 0,
  ): void {
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
    this.puffs.push({ sprite, life: 0, seconds, rise: 0.9, scale, driftX, driftZ });
  }

  private age(dt: number): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      p.life += dt;
      p.sprite.position.x += p.driftX * dt;
      p.sprite.position.z += p.driftZ * dt;
      const k = p.life / p.seconds;
      if (k >= 1) {
        // 必须真的摘掉：只 visible=false 的话，每团烟都留一份材质和一个场景节点，
        // 一局下来就是几千份 —— 这是"看不见的 draw call 与显存"，不是"没事发生"
        p.sprite.removeFromParent();
        (p.sprite.material as THREE.Material).dispose();
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
      haze: this.hazes.length,
      dropped: this.dropped,
    };
  }

  dispose(): void {
    this.box.dispose();
    this.iron.dispose();
    for (const list of this.quads.values()) for (const s of list) (s.material as THREE.Material).dispose();
    for (const p of this.puffs) (p.sprite.material as THREE.Material).dispose();
    for (const s of [...this.hazes.map((h) => h.sprite), ...this.hazeFree]) {
      (s.material as THREE.Material).dispose();
    }
    this.hazes.length = 0;
    this.hazeFree.length = 0;
  }
}
