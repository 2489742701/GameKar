/**
 * 建筑头顶/地面的那些小牌子：血条、缺后勤提示、出兵旗，以及几个"楼叫什么"的纯函数。
 *
 * 单独一个文件是因为它们**不碰任何状态**：给参数就出 Object3D，
 * 和 `ArenaApp` 里那套输入/相机/同步没有关系；放在一起时它们占了文件末尾 100 多行，
 * 但读者要翻半天才知道"这不是 App 的一部分"。
 */

import * as THREE from 'three';
import type { ArenaBuilding, Side } from '../ArenaWorld';
import { sideColor } from '../theme';
import { needIconUrl, type NeedIcon } from './needIcons';

/** 这座楼要不要占后勤名额（兵营/箭塔/炮塔要；磨坊/民居/大本营不要）。 */
export function needsStaffing(kind: ArenaBuilding['kind']): boolean {
  return kind === 'barracks' || kind === 'arrowTower' || kind === 'cannonTower';
}

/** 建筑的中文名（长按提示、toast 用）。术语按用户 2026-11-01 的纠正：叫大本营，不叫核心。 */
export function labelOf(b: ArenaBuilding): string {
  return b.kind === 'core'
    ? '大本营'
    : b.kind === 'barracks'
      ? '兵营'
      : b.kind === 'mill'
        ? '磨坊'
        : b.kind === 'house'
          ? '民居'
          : b.kind === 'gearFactory'
            ? '齿轮工厂'
            : b.kind === 'orcLair'
              ? '兽人巢穴'
              : '防御塔';
}

/**
 * 血条：一条贴在楼头顶的扁平面片（`depthTest: false` —— 它必须压在楼身上，不被自己挡住）。
 * 满血不挂（`ArenaApp` 那边按 `frac < 0.999` 控制 visible），掉血才出现。
 */
export function makeHpBar(frac: number, color: number, width = 1.6): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(width, 0.2);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
  const bar = new THREE.Mesh(geo, mat);
  bar.renderOrder = 10;
  bar.scale.x = Math.max(0.02, frac);
  bar.userData['frac'] = frac;
  bar.userData['base'] = color;
  return bar;
}

/** 血条随血量变短；掉到 30% 以下翻红（颜色是"这一下很危险"的信号，不是装饰）。 */
export function updateHpBar(bar: THREE.Mesh, frac: number): void {
  const clamped = Math.max(0, Math.min(1, frac));
  const prev = bar.userData['frac'] as number;
  // 变化小于 0.5% 就不动：20Hz 的同步里重设 color 会白白触发材质更新
  if (Math.abs(prev - clamped) < 0.005) return;
  bar.userData['frac'] = clamped;
  bar.scale.x = Math.max(0.02, clamped);
  const base = bar.userData['base'] as number;
  (bar.material as THREE.MeshBasicMaterial).color.setHex(clamped < 0.3 ? 0xff6b6b : base);
}

/**
 * 缺后勤的提示牌（「缺 磨坊 + 民居」/「缺 民居」）。
 *
 * 用 canvas 画一张贴图再做成 Sprite —— 不用字体几何，因为中文字形在 3D 里要么模糊要么缺字。
 * 画布只有 256×64、放大用 NearestFilter，所以和像素小人是同一套"像素质感"。
 */
/**
 * 楼顶「缺后勤」牌子 —— **SVG 图标**（2026-11-06 用户：「都改成 SVG，
 * 比如说是一个小房屋的图标，然后打个叉叉」）。
 *
 * 之前是 256×64 的 canvas 文字横条，在 3D 里被父级缩放压扁后字都糊了。
 * 现在是 64×64 的正方形剪影：房屋（+ 缺磨坊时的小风车）斜跨一个红叉。
 * 贴图从 data URL 异步解码，头一帧可能空白，之后自动更新 —— 一帧的延迟不影响读图。
 */
export function makeNeedLabel(kind: NeedIcon): THREE.Sprite {
  const tex = new THREE.TextureLoader().load(needIconUrl(kind));
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(1.35, 1.35, 1);
  sprite.visible = false;
  return sprite;
}

/**
 * 出兵点那面小旗（点兵营 → 点地面，旗子挪过去）。
 * 不是建筑屋顶上的阵营旗 —— 那面在 `props.ts` 里。
 */
export function makeFlag(side: Side, selected: boolean): THREE.Group {
  const g = new THREE.Group();
  const color = sideColor(side);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.04, 1.1, 6),
    new THREE.MeshStandardMaterial({ color: 0x6b4526, roughness: 0.9, flatShading: true }),
  );
  pole.position.y = 0.55;
  const cloth = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 0.34, 4),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: selected ? 0.9 : 0.35,
      roughness: 0.5,
      flatShading: true,
    }),
  );
  cloth.position.set(0, 1.05, 0);
  g.add(pole, cloth);
  return g;
}
