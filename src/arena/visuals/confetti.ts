/**
 * **彩带**（2026-11-06 用户："屏幕两边可以飞出彩带，就是那种各种颜色、
 * 3D 感觉的小卡片彩带"）—— 进加时赛的庆祝/气氛件。
 *
 * 实现：两张看台顶各喷一半，小卡片（0.22×0.32 平面）带初速 + 自旋 + 半重力 +
 * 空气阻力，落地后躺 0.8 秒淡出。几何体与卡片池整个生命周期只建一次；
 * 正在飞的时候再 burst 直接忽略（别叠成雪崩）。
 */
import * as THREE from 'three';

const COLORS = [0xff5a5a, 0xffd24a, 0x5ad1ff, 0x7dff8a, 0xd78aff, 0xff9c4a];
const COUNT = 96;
const GEO = new THREE.PlaneGeometry(0.22, 0.32);

interface Card {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  delay: number;
}

export class Confetti {
  readonly group = new THREE.Group();
  private cards: Card[] = [];
  private active = false;

  constructor(
    private cols: number,
    private rows: number,
    private groundY = 0.5,
  ) {
    this.group.visible = false;
  }

  /** 从左右两侧看台喷出一波。正在飞的时候调用是 no-op。 */
  burst(): void {
    if (this.active) return;
    this.active = true;
    this.group.visible = true;
    for (let i = 0; i < COUNT; i++) {
      const left = i % 2 === 0;
      const color = COLORS[i % COLORS.length]!;
      const mesh = new THREE.Mesh(
        GEO,
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 1 }),
      );
      const x0 = left ? -0.6 : this.cols + 0.6;
      mesh.position.set(
        x0 + (Math.random() - 0.5) * 1.2,
        this.groundY + 3 + Math.random() * 1.6,
        2.5 + Math.random() * (this.rows - 5),
      );
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      const dir = left ? 1 : -1;
      const card: Card = {
        mesh,
        vel: new THREE.Vector3(dir * (2 + Math.random() * 3), 4.5 + Math.random() * 3, (Math.random() - 0.5) * 2.5),
        spin: new THREE.Vector3(Math.random() * 9 - 4.5, Math.random() * 9 - 4.5, Math.random() * 9 - 4.5),
        life: 3 + Math.random() * 1.2,
        delay: Math.random() * 0.5,
      };
      mesh.visible = false;
      this.group.add(mesh);
      this.cards.push(card);
    }
  }

  update(dt: number): void {
    if (!this.active) return;
    let alive = false;
    for (const c of this.cards) {
      if (c.delay > 0) {
        c.delay -= dt;
        alive = true;
        continue;
      }
      c.mesh.visible = true;
      // 彩带要飘不要砸：重力减半 + 线性空气阻力
      c.vel.y -= 9.8 * dt * 0.55;
      c.vel.multiplyScalar(Math.max(0, 1 - dt * 0.35));
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      c.life -= dt;
      const mat = c.mesh.material as THREE.MeshBasicMaterial;
      if (c.mesh.position.y <= this.groundY + 0.03) {
        // 落地：躺平淡出
        c.mesh.position.y = this.groundY + 0.03;
        c.vel.set(0, 0, 0);
        c.spin.multiplyScalar(0.9);
      }
      mat.opacity = Math.min(1, Math.max(0, c.life / 0.8));
      if (c.life > 0) alive = true;
    }
    if (!alive) {
      this.active = false;
      this.group.visible = false;
      for (const c of this.cards) {
        c.mesh.removeFromParent();
        (c.mesh.material as THREE.MeshBasicMaterial).dispose();
      }
      this.cards = [];
    }
  }
}
