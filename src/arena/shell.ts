/**
 * 外墙的"活"部分 —— 把 `models.ts` 给的墙面片合成一张网格，受伤时整块摘掉。
 *
 * 为什么合成一张：一栋楼 30–50 块板，一块一个 Mesh 就是 50 次 draw call × 场上十几栋。
 * 合成之后一栋楼只有 1 次；拆的时候重建顶点（只在掉血那几帧发生，最多 5 次）。
 *
 * 洞的形状 = 面片的轮廓：从一块种子板开始，每次摘掉离它最近的一块，
 * 于是洞口是**连成一片**的，而不是均匀撒了一墙的洞。
 *
 * **P-097（2026-11-12）补了反向播放**：自动修复把血补回去时，`restore()`
 * 把 `destroyed` 里的面片按"最后崩的先拼回"倒放回来，并且可以给它换一个颜色。
 * 视图层把换色设成木色 ⇒ 修好的墙上留着几块**补上去的木板**，
 * 而不是像没被打过一样。补片颜色存在 `patched` 里，**不改 `ShellPanel` 本身**：
 * 模型对象是所有同类楼共用的，就地改色会把全场建筑一起染黄。
 *
 * **补片的质感也烘在同一张网格里**：`rebuild()` 遇到 `patched` 的面片，
 * 直接摆入 `makePlankGeometry()`（板身 + 端纹 + 木纹 + 四角钉头），
 * 和飞回来的那块木板是同一套零件、同一套顶点色。所以木板"钉上去"之后
 * 木纹和钉子还在，而不是退化成一块平涂棕色方块；**仍然只有 1 次 draw call**。
 * 代价是补片顶点数不是 36 ⇒ `drawRange` 改按 `panelVerts` 累加，别再写死 36。
 */

import * as THREE from 'three';
import { Random } from '@engine/math/Random';
import type { ShellPanel } from './models';
import { makePlankGeometry, plankSeed } from './visuals/repairPlanks';

/** 普通墙片展开成非索引几何后的顶点数（BoxGeometry 24 顶点 / 36 索引 → 展开成 36 顶点）。 */
const VERTS_PER_PANEL = 36;

/** 一块被拼回的面片：`color` 是它在墙上最终显示的颜色（补片通常 ≠ 原墙色）。 */
export interface RestoredPanel {
  panel: ShellPanel;
  color: number;
}

/** 一栋楼的外墙网格。 */
export class WallShell {
  readonly mesh: THREE.Mesh;
  /** 这栋楼原本的全部面片（崩掉的不在这里，见 destroyed） */
  private readonly all: ShellPanel[];
  /** 已经崩掉的面片（施工 + 受伤共用一套：崩了就不会因为"垒墙"再冒出来） */
  private readonly destroyed = new Set<ShellPanel>();
  /** P-097：拼回时染上的木板色。键只可能是"当前在墙上的"面片，崩掉时同步删。 */
  private readonly patched = new Map<ShellPanel, number>();
  /**
   * P-097：已经"逻辑拼回"、但飞行木板还没到位的面片 —— **先不渲染**，
   * 让破口在木板一块块飞回来的过程中逐块合上，而不是墙瞬间复原、
   * 同一块木板却还在半空飞（那就成两份了）。
   */
  private readonly hidden = new Set<ShellPanel>();
  /** 当前还在场的面片（= all − destroyed − hidden），**按高度从低到高排好** */
  private panels: ShellPanel[];
  /** 与 `panels` 一一对应的顶点数：普通墙片 36，木板补片 360（10 只 box） */
  private panelVerts: number[] = [];
  /** 补片的**局部**木板几何缓存：rebuild 时只需 clone + 摆位，不重复造 10 只 box */
  private readonly plankCache = new Map<ShellPanel, THREE.BufferGeometry>();
  /** 施工露出比例 0..1（1 = 全部露出来） */
  private shown = 1;

  constructor(panels: readonly ShellPanel[]) {
    this.all = [...panels];
    this.panels = [...panels];
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.92,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'wall-shell';
    this.rebuild();
  }

  get count(): number {
    return this.panels.length;
  }

  /** 还剩哪些面片（只读，测试与调试用）。 */
  get remaining(): readonly ShellPanel[] {
    return this.panels;
  }

  /** P-097：墙上还有几块是"补上去的木板"（测试与调试用）。 */
  get patchedCount(): number {
    return this.patched.size;
  }

  /** P-097：还有几块补片在等飞行木板到位（测试与调试用）。 */
  get hiddenCount(): number {
    return this.hidden.size;
  }

  /**
   * 施工：只露出高度最低的那 `frac` 比例的墙板 —— **墙就一块块垒上来了**。
   *
   * 实现是 `drawRange` 而不是重建几何：面片在 rebuild 时已经按 y 从低到高排好，
   * 截断前 N 块 = 从下往上露出。施工那几秒每帧都调，重建一次 50 块 BoxGeometry
   * 是不能接受的（实测会掉帧）；改 drawRange 是零成本。
   */
  setBuild(frac: number): void {
    const next = Math.max(0, Math.min(1, frac));
    if (Math.abs(next - this.shown) < 0.0005) return;
    this.shown = next;
    this.applyDrawRange();
  }

  private applyDrawRange(): void {
    if (this.shown >= 1) {
      this.mesh.geometry.setDrawRange(0, Infinity);
      return;
    }
    const upto = Math.round(this.panels.length * this.shown);
    let verts = 0;
    for (let i = 0; i < upto; i++) verts += this.panelVerts[i] ?? VERTS_PER_PANEL;
    this.mesh.geometry.setDrawRange(0, verts);
  }

  /**
   * 从墙上崩掉 `count` 块（就近成片）。
   *
   * 优先从**镜头这一侧**（z > 0）起洞：默认机位看不到背面的破洞，
   * 但玩家转镜头时背面也得是完整的，所以只影响"先从哪儿开始"。
   * 返回被摘掉的板，调用方拿它们去做下落动画。
   */
  breach(count: number, rnd: Random): ShellPanel[] {
    if (this.panels.length === 0) return [];
    const visible = this.panels.filter((p) => p.z > 0);
    const pool = rnd.chance(0.75) && visible.length > 0 ? visible : this.panels;
    const seed = pool[rnd.int(0, pool.length)]!;

    const removed: ShellPanel[] = [];
    let cursor = seed;
    while (removed.length < count && this.panels.length > 0) {
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < this.panels.length; i++) {
        const p = this.panels[i]!;
        const d = (p.x - cursor.x) ** 2 + (p.y - cursor.y) ** 2 + (p.z - cursor.z) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      if (best < 0) break;
      cursor = this.panels[best]!;
      removed.push(cursor);
      this.destroyed.add(cursor);
      // 补片被再打掉就不再是补片了，别留着旧木色 / 旧木板几何等下次拼回
      this.patched.delete(cursor);
      this.plankCache.get(cursor)?.dispose();
      this.plankCache.delete(cursor);
      this.panels.splice(best, 1);
    }
    this.rebuild();
    return removed;
  }

  /**
   * **反向播放**：把最近崩掉的 `count` 块面片拼回墙上（P-097 自动修复）。
   *
   * - 顺序是 `destroyed` 的**后进先出**（Set 保留插入顺序）：最后碎的先回来，
   *   和 `breach()` 的成片洞口正好互为倒放，看起来就是"破口一块块补上"。
   * - `rnd` 只用于 `tintOf` 挑木色；**挑哪几块不随随机流变化**，
   *   所以同一栋楼掉血再回血，补的是同一批面片，可复现。
   * - `tintOf` 不给就恢复原墙色（纯结构恢复，不带补丁质感）。
   * - 返回每块板的最终颜色，视图层拿它做飞回来的那块木板 —— 飞到位时
   *   **颜色与墙上补片一致**，不会"啪"一下从木头跳回米色石墙。
   */
  restore(
    count: number,
    rnd: Random,
    tintOf?: (panel: ShellPanel, rnd: Random) => number,
  ): RestoredPanel[] {
    const gone = [...this.destroyed];
    const n = Math.max(0, Math.min(count, gone.length));
    // 倒放：最后崩的那块最先拼回来
    const take = gone.slice(gone.length - n).reverse();
    const out: RestoredPanel[] = [];
    for (const p of take) {
      this.destroyed.delete(p);
      const color = tintOf ? tintOf(p, rnd) : p.color;
      // 没给染色函数 = 纯结构恢复：墙复原成原色，不留补片标记
      if (tintOf) this.patched.set(p, color);
      else this.patched.delete(p);
      // 补片颜色换了，旧的局部木板几何不能再用
      this.plankCache.get(p)?.dispose();
      this.plankCache.delete(p);
      out.push({ panel: p, color });
    }
    if (out.length > 0) this.rebuild();
    return out;
  }

  /**
   * P-097：刚拼回的补片先藏起来，等 `DamageFx` 的木板飞到位再 `reveal()`。
   * `restore()` 本身仍是纯粹的"结构恢复"（锁就这么钉的），藏不藏由视图层决定。
   */
  hideRestored(panels: readonly ShellPanel[]): void {
    let changed = false;
    for (const p of panels) {
      if (this.destroyed.has(p) || this.hidden.has(p)) continue;
      this.hidden.add(p);
      changed = true;
    }
    if (changed) this.rebuild();
  }

  /** 一批木板到位：一次性露出（一帧只重建一次网格，别一块板 rebuild 一遍）。 */
  reveal(panels: readonly ShellPanel[]): void {
    let changed = false;
    for (const p of panels) if (this.hidden.delete(p)) changed = true;
    if (changed) this.rebuild();
  }

  /** 楼塌了：等着的补片全部先回墙，再由 `breach()` 一块不剩地掉下去。 */
  revealAll(): void {
    if (this.hidden.size === 0) return;
    this.hidden.clear();
    this.rebuild();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    for (const geo of this.plankCache.values()) geo.dispose();
    this.plankCache.clear();
  }

  /** 把还在场的面片合成一张带顶点色的网格（flat shading，每块板自己的色调）。 */
  private rebuild(): void {
    // **按高度从低到高排**：施工时 drawRange 一截，露出来的就是下面那几层
    this.panels = this.all
      .filter((p) => !this.destroyed.has(p) && !this.hidden.has(p))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const position: number[] = [];
    const normal: number[] = [];
    const color: number[] = [];
    const tint = new THREE.Color();
    const matrix = new THREE.Matrix4();
    this.panelVerts = [];

    for (const p of this.panels) {
      matrix.makeRotationY(p.yaw);
      matrix.setPosition(p.x, p.y, p.z);
      const patch = this.patched.get(p);
      let geo: THREE.BufferGeometry;

      if (patch === undefined) {
        // 普通墙片：一只 box。
        const src = new THREE.BoxGeometry(p.w, p.h, p.t);
        src.applyMatrix4(matrix);
        // **必须转成非索引**：BoxGeometry 是 24 顶点 + 36 索引，只抄顶点会把角点
        // 当成连续三角形 → 塔身上凭空出现几道白色大叉（这个 bug 是看截图抓到的）。
        geo = src.toNonIndexed();
        src.dispose();
      } else {
        // P-097 补片：直接把「木纹 + 端纹 + 钉头」的木板摆到墙片原位。
        // 局部几何按面片坐标缓存（seed 只由面片位置 + 补片颜色决定，可复现），
        // 每次 rebuild 只 clone 一份再摆位，不重复造 10 只 box。
        let local = this.plankCache.get(p);
        if (!local) {
          local = makePlankGeometry(p, 1, patch, new Random(plankSeed(p, patch)));
          this.plankCache.set(p, local);
        }
        geo = local.clone();
        geo.applyMatrix4(matrix);
      }

      const pos = geo.getAttribute('position');
      const nrm = geo.getAttribute('normal');
      const col = geo.getAttribute('color');
      tint.set(patch ?? p.color);
      for (let i = 0; i < pos.count; i++) {
        position.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        normal.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
        if (col) color.push(col.getX(i), col.getY(i), col.getZ(i));
        else color.push(tint.r, tint.g, tint.b);
      }
      this.panelVerts.push(pos.count);
      geo.dispose();
    }

    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    next.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    next.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
    next.computeBoundingSphere();

    this.mesh.geometry.dispose();
    this.mesh.geometry = next;
    this.applyDrawRange();
  }
}
