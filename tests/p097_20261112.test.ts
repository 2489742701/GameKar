/**
 * P-097（2026-11-12）两条用户反馈：
 *
 * 1. 「那个缺少房屋的地方，把后面的板子去掉，只保留 SVG。」
 * 2. 「修的时候，就像我们之前那个碎开来的东西一样，把碎掉的部分重新拼一些积木回去……
 *    重新拼上去的是木板的那种感觉和质感。血可以补回去，然后会拼回木板的感觉。」
 *
 * 这里钉住的是**装配与状态**，好不好看由截图判：
 * - 缺配 SVG 透明底、无矩形底板；
 * - `WallShell.restore()` 是 `breach()` 的严格倒放，且能染色；
 * - 破损档位有滞后带，血量卡在阈值上不反复崩/拼；
 * - 回血时 `DamageFx` 真的把木板拼回墙上并造出飞行积木；
 * - 木板几何带木纹/钉头，飞行轨迹到位严丝合缝。
 *
 * 每条主锁都配一条反证：把判据关掉，锁必须红。
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NEED_ICON_SVG } from '../src/arena/visuals/needIcons';
import { ARENA_MODELS } from '../src/arena/models';
import { WallShell } from '../src/arena/shell';
import { Random } from '../src/engine/math/Random';
import { BREAK_HYSTERESIS, DamageFx, hitsFor, targetHits } from '../src/arena/damage';
import {
  PLANK,
  PLANK_WOOD,
  makePlankGeometry,
  plankColor,
  plankPoseAt,
  plankSeed,
  type PlankFlight,
} from '../src/arena/visuals/repairPlanks';

const shellOf = () => new WallShell(ARENA_MODELS.arrowTower(0).shell);

describe('缺配提示：只保留 SVG，后面的板子去掉', () => {
  /** 旧实现那块深色木牌，留在这里只为了让反证能认出它。 */
  const OLD_PLATE =
    '<rect x="2" y="2" width="60" height="60" rx="10" fill="rgba(24,16,10,0.86)" stroke="#c8a24c" stroke-width="3"/>';
  const hasPlate = (s: string): boolean => /<rect[^>]*fill="rgba\(24,16,10/.test(s);

  it('两种图标都是透明底：没有 <rect>、没有旧木牌的金边', () => {
    for (const kind of ['house', 'millHouse'] as const) {
      const svg = NEED_ICON_SVG[kind];
      expect(svg, `${kind} 还有矩形底板`).not.toContain('<rect');
      expect(svg, `${kind} 还有旧木牌描边`).not.toContain('#c8a24c');
      // 可读性靠软投影 + 图形自身描边，不靠再垫一块板
      expect(svg).toContain('filter="url(#needShadow)"');
      expect(svg).toContain('feDropShadow');
      expect(svg).toContain('stroke="#3a2a16"');
      expect(svg).toContain('M32 13');
      expect(svg).toContain('#e2503f');
    }
  });

  it('反证：判据确实能抓到旧底板（把修复删掉这条就会红）', () => {
    expect(hasPlate(OLD_PLATE)).toBe(true);
    expect(hasPlate(NEED_ICON_SVG.house)).toBe(false);
    expect(hasPlate(NEED_ICON_SVG.millHouse)).toBe(false);
  });
});

describe('WallShell.restore()：破损的反向播放', () => {
  it('breach → restore 严格倒放，块数复原且没有重复面片', () => {
    const shell = shellOf();
    const total = shell.count;
    const removed = shell.breach(6, new Random(7));
    expect(removed).toHaveLength(6);
    expect(shell.count).toBe(total - 6);

    const restored = shell.restore(6, new Random(99), () => 0xa97644);
    // 最后崩的先拼回；补片颜色就是调用方给的木色
    expect(restored.map((r) => r.panel)).toEqual([...removed].reverse());
    expect(shell.count).toBe(total);
    expect(shell.patchedCount).toBe(6);
    expect(new Set(shell.remaining).size).toBe(total);
    for (const r of restored) expect(r.color).toBe(0xa97644);
  });

  it('拼回数量超过已崩数量时不会凭空造板，也不会重复拼', () => {
    const shell = shellOf();
    const total = shell.count;
    expect(shell.breach(3, new Random(5))).toHaveLength(3);
    expect(shell.restore(50, new Random(6))).toHaveLength(3);
    expect(shell.count).toBe(total);
    expect(shell.restore(5, new Random(7))).toHaveLength(0);
    expect(shell.count).toBe(total);
  });

  it('补片颜色真的进了墙面顶点色；再崩掉时补片标记同步清掉', () => {
    const shell = shellOf();
    shell.breach(4, new Random(3));
    const restored = shell.restore(4, new Random(3), () => 0xff0000);
    const col = shell.mesh.geometry.getAttribute('color');
    const target = new THREE.Color(0xff0000);
    let woodVerts = 0;
    for (let i = 0; i < col.count; i++) {
      if (
        Math.abs(col.getX(i) - target.r) < 1e-5 &&
        Math.abs(col.getY(i) - target.g) < 1e-5 &&
        Math.abs(col.getZ(i) - target.b) < 1e-5
      ) woodVerts += 1;
    }
    // 一块板 36 个顶点，4 块都应该是补片色
    expect(woodVerts).toBe(restored.length * 36);

    shell.breach(shell.count, new Random(9));
    expect(shell.patchedCount).toBe(0);
  });

  it('反证：不给染色函数就是纯结构恢复，墙上不会留下木板补片', () => {
    const shell = shellOf();
    shell.breach(4, new Random(3));
    shell.restore(4, new Random(3));
    expect(shell.patchedCount).toBe(0);
  });

  it('补片可以先藏后露：破口在木板到位前一直开着，到位才合上', () => {
    const shell = shellOf();
    const total = shell.count;
    shell.breach(5, new Random(13));
    const hurt = shell.count;
    const restored = shell.restore(5, new Random(13), () => 0xa97644);
    expect(shell.count).toBe(total); // restore 本身是纯结构恢复

    shell.hideRestored(restored.map((r) => r.panel));
    expect(shell.hiddenCount).toBe(5);
    expect(shell.count).toBe(hurt); // 画面上破口还在

    shell.reveal(restored.slice(0, 2).map((r) => r.panel));
    expect(shell.count).toBe(hurt + 2);
    shell.revealAll();
    expect(shell.hiddenCount).toBe(0);
    expect(shell.count).toBe(total);
  });

  it('木纹与钉头烘进墙面：补片顶点数是普通板的 10 倍，drawRange 按实际顶点累加', () => {
    const shell = shellOf();
    const total = shell.count;
    const fullVerts = shell.mesh.geometry.getAttribute('position').count;
    expect(fullVerts).toBe(total * 36);

    const removed = shell.breach(3, new Random(7));
    shell.restore(3, new Random(7), () => 0xa97644);
    const patchedVerts = shell.mesh.geometry.getAttribute('position').count;
    // 3 块普通板（36 顶点）换成 3 块木板（10 只 box = 360 顶点）
    expect(patchedVerts).toBe(fullVerts + removed.length * 9 * 36);
    expect(shell.mesh.geometry.getAttribute('color').count).toBe(patchedVerts);

    // 施工露出一半时不能再用 "块数 × 36" 的旧口径
    shell.setBuild(0.5);
    const half = shell.mesh.geometry.drawRange.count;
    expect(Number.isFinite(half)).toBe(true);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(patchedVerts);
    shell.setBuild(1);
  });

  it('飞行木板与墙上补片共用木纹种子，几何顶点数完全一致', () => {
    const panel = ARENA_MODELS.arrowTower(0).shell[0]!;
    const color = 0x9a6b3f;
    const flying = makePlankGeometry(panel, 2.2, color, new Random(plankSeed(panel, color)));
    const wall = makePlankGeometry(panel, 1, color, new Random(plankSeed(panel, color)));
    expect(flying.getAttribute('position').count).toBe(wall.getAttribute('position').count);
    expect([...flying.getAttribute('color').array]).toEqual([...wall.getAttribute('color').array]);
    flying.dispose();
    wall.dispose();
  });

  it('塌楼前 revealAll：等着的补片也会一块不剩地掉下去', () => {
    const shell = shellOf();
    const total = shell.count;
    shell.breach(5, new Random(13));
    const restored = shell.restore(5, new Random(13));
    shell.hideRestored(restored.map((r) => r.panel));
    expect(shell.count).toBe(total - 5);
    shell.revealAll();
    expect(shell.count).toBe(total);
    expect(shell.breach(shell.count, new Random(2))).toHaveLength(total);
  });
});

describe('破损档位的滞后带（只管画面，不改 HP）', () => {
  it('阈值 ±0.02 内保持原档数，涨够 / 掉够才动', () => {
    expect(BREAK_HYSTERESIS).toBe(0.02);
    expect(targetHits(1, 0)).toBe(0);
    expect(targetHits(0.5, 0)).toBe(2);
    expect(targetHits(0, 0)).toBe(5);

    // 第 4 档阈值 0.29
    expect(hitsFor(0.29)).toBe(4);
    expect(targetHits(0.30, 4)).toBe(4); // 刚过阈值：先别拼
    expect(targetHits(0.33, 4)).toBe(3); // 涨够 0.02：拼回一档
    expect(targetHits(0.27, 3)).toBe(4); // 掉够 0.02：再崩一档
  });

  it('反证：不带滞后带时 0.30 会立刻拼回（说明这条锁不是空转）', () => {
    expect(hitsFor(0.30)).toBe(3);
    expect(targetHits(0.30, 4)).not.toBe(hitsFor(0.30));
  });

  it('一路回血，档数只减不增，最后归零', () => {
    let cur = 5;
    for (let f = 0; f <= 1.001; f += 0.005) {
      const next = targetHits(f, cur);
      expect(next, `frac=${f.toFixed(3)}`).toBeLessThanOrEqual(cur);
      cur = next;
    }
    expect(cur).toBe(0);
  });
});

describe('回血时把木板拼回墙上', () => {
  const setup = () => {
    const scene = new THREE.Scene();
    const fx = new DamageFx(scene);
    const shell = shellOf();
    fx.register(1, { center: { x: 0, z: 0 }, groundY: 0.5, scale: 2.2, seed: 7 }, shell);
    return { scene, fx, shell };
  };

  it('掉血崩墙 → 回血按原数拼回木板，墙片数复原、飞行积木会自己收掉', () => {
    const { fx, shell } = setup();
    const total = shell.count;
    let puffs = 0;
    fx.onRestore = () => { puffs += 1; };

    fx.sync(1, 0.2);
    const hurt = shell.count;
    expect(hurt).toBeLessThan(total);
    expect(fx.debrisCount).toBeGreaterThan(0);

    fx.sync(1, 1);
    const patched = total - hurt;
    expect(shell.patchedCount).toBe(patched);
    expect(fx.plankCount).toBe(patched);
    expect(puffs).toBeGreaterThan(0);
    expect(patched).toBeGreaterThan(0);
    // 木板还在飞：墙上破口必须仍然开着，不能瞬间复原
    expect(shell.hiddenCount).toBe(patched);
    expect(shell.count).toBe(hurt);

    // 1.44 秒 > 最长起飞延迟 + 飞行时长
    for (let i = 0; i < 90; i++) fx.update(0.016);
    expect(fx.plankCount).toBe(0);
    expect(shell.hiddenCount).toBe(0);
    expect(shell.count).toBe(total);       // 木板到位，破口逐块合上
    expect(shell.patchedCount).toBe(patched); // 补片留在墙上，不跟着飞行 mesh 消失
  });

  it('反证：把 restore 短路掉（等同 P-097 之前），回血后墙不会复原也没有木板', () => {
    const { fx, shell } = setup();
    const total = shell.count;
    fx.sync(1, 0.2);
    const hurt = shell.count;
    expect(hurt).toBeLessThan(total);

    // 模拟旧实现：只有 breach，没有 restore
    shell.restore = () => [];
    fx.sync(1, 1);
    expect(shell.count).toBe(hurt);
    expect(shell.patchedCount).toBe(0);
    expect(fx.plankCount).toBe(0);
  });

  it('楼塌了 / forget 会收掉还在飞的木板，不钉到不存在的墙上', () => {
    const { fx, shell } = setup();
    fx.sync(1, 0.2);
    fx.sync(1, 1);
    expect(fx.plankCount).toBeGreaterThan(0);
    fx.forget(1);
    expect(fx.plankCount).toBe(0);
    expect(shell.count).toBeGreaterThan(0);
  });

  it('木板颜色来自同一张木色表，且到位后与墙上补片同色', () => {
    const { fx, shell, scene } = setup();
    fx.sync(1, 0.2);
    fx.sync(1, 1);
    const planks = scene.children.filter((o) => o.name === 'repair-plank');
    expect(planks).toHaveLength(fx.plankCount);
    expect(planks.length).toBeGreaterThan(0);

    // 先记下每块飞行木板板身的颜色（线性 RGB，别用 getHex 来回转换，会有 1 位舍入差）
    const key = (r: number, g: number, b: number): string =>
      `${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)}`;
    const bodies: string[] = [];
    for (const mesh of planks as THREE.Mesh[]) {
      const col = (mesh.geometry as THREE.BufferGeometry).getAttribute('color');
      const body = key(col.getX(0), col.getY(0), col.getZ(0));
      bodies.push(body);
      expect(PLANK_WOOD).toContain(
        new THREE.Color(col.getX(0), col.getY(0), col.getZ(0)).getHex(),
      );
    }

    // 等木板全部到位、补片露出来，墙上必须能找到同样的颜色
    for (let i = 0; i < 90; i++) fx.update(0.016);
    const wall = shell.mesh.geometry.getAttribute('color');
    const wallColors = new Set<string>();
    for (let i = 0; i < wall.count; i++) {
      wallColors.add(key(wall.getX(i), wall.getY(i), wall.getZ(i)));
    }
    for (const body of bodies) {
      expect(wallColors.has(body), '飞行木板与墙上补片必须同色').toBe(true);
    }
  });
});

describe('木板积木的几何与飞行轨迹', () => {
  it('一张带顶点色的网格：板身 + 端纹 + 木纹 + 四角钉头', () => {
    const panel = ARENA_MODELS.arrowTower(0).shell[0]!;
    const rnd = new Random(11);
    const wood = plankColor(rnd);
    expect(PLANK_WOOD).toContain(wood);

    const geo = makePlankGeometry(panel, 2.2, wood, rnd);
    const pos = geo.getAttribute('position');
    const col = geo.getAttribute('color');
    // 1 板身 + 2 端纹 + 3 木纹 + 4 钉头 = 10 只非索引 box
    expect(pos.count).toBe(10 * 36);
    expect(col.count).toBe(pos.count);
    expect(geo.getAttribute('normal').count).toBe(pos.count);
    expect([...pos.array].every((v) => Number.isFinite(v))).toBe(true);
    expect(geo.boundingSphere?.radius).toBeGreaterThan(0);

    const colors = new Set<string>();
    for (let i = 0; i < col.count; i++) {
      colors.add(`${col.getX(i).toFixed(3)},${col.getY(i).toFixed(3)},${col.getZ(i).toFixed(3)}`);
    }
    expect(colors.size, '至少木色/端纹/木纹/铁钉四档').toBeGreaterThanOrEqual(4);
    geo.dispose();
  });

  it('起飞前隐藏、途中拱起来、到位严丝合缝贴到墙片原位', () => {
    const f: PlankFlight = {
      from: { x: 2, y: 3, z: 1 },
      to: { x: 0, y: 1, z: 0 },
      yaw: 0.5,
      tiltX: 0.6,
      tiltZ: -0.4,
      arc: 1.2,
      delay: 0.2,
      seconds: PLANK.flySeconds,
    };
    expect(plankPoseAt(f, 0).visible).toBe(false);

    const mid = plankPoseAt(f, 0.2 + PLANK.flySeconds / 2);
    expect(mid.visible).toBe(true);
    expect(mid.done).toBe(false);
    expect(mid.y).toBeGreaterThan(2); // 不是直线插值，中间有一道拱

    const end = plankPoseAt(f, 0.2 + PLANK.flySeconds);
    expect(end.done).toBe(true);
    expect(end.x).toBeCloseTo(f.to.x);
    expect(end.y).toBeCloseTo(f.to.y);
    expect(end.z).toBeCloseTo(f.to.z);
    expect(end.rx).toBeCloseTo(0);
    expect(end.ry).toBeCloseTo(f.yaw);
    expect(end.rz).toBeCloseTo(0);
    expect(end.scale).toBeCloseTo(1);
  });

  it('反证：拱高为 0 时中途就没有"抛起来"的弧线（轨迹锁不是摆设）', () => {
    const base: PlankFlight = {
      from: { x: 2, y: 3, z: 1 }, to: { x: 0, y: 1, z: 0 },
      yaw: 0, tiltX: 0, tiltZ: 0, arc: 1.2, delay: 0, seconds: 0.5,
    };
    const t = 0.25;
    expect(plankPoseAt(base, t).y).toBeGreaterThan(plankPoseAt({ ...base, arc: 0 }, t).y);
  });
});
