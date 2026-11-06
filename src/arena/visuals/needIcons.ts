/**
 * 楼顶「缺后勤」牌子的 SVG 图标（2026-11-06 用户要求）。
 *
 * 用户原话：「房顶上缺房屋或者缺什么，都改成 SVG，比如说是一个小房屋的图标，
 * 然后打个叉叉。」
 *
 * 之前是一张 256×64 的 canvas 文字牌，写着「缺 民居」/「缺 磨坊 + 民居」——
 * 字在 3D 里被父级缩放压扁、还和 HUD 的中文重复。现在改成剪影级图标：
 * **缺什么画什么，一律斜跨一个红叉**（一眼就是"这个没配齐"）。
 *
 * 尺寸统一 64×64，Sprite 是正方形；`millHouse` 在房子左下角再叠一个小风车，
 * 表示兵营还额外缺磨坊。
 */

export type NeedIcon = 'house' | 'millHouse';

/** 一块深色木牌底：图标浮在上面，在草地/屋顶两种背景前都读得清。 */
const PLATE = `<rect x="2" y="2" width="60" height="60" rx="10" fill="rgba(24,16,10,0.86)" stroke="#c8a24c" stroke-width="3"/>`;

/** 小房屋：尖顶 + 方身 + 门。和 `cardIcons.house` 同一套剪影语言。 */
const HOUSE = `<path d="M32 13 11 31h6v20h10V39h10v12h10V31h6L32 13Z" fill="#f0d08a" stroke="#3a2a16" stroke-width="2.2" stroke-linejoin="round"/>`;

/** 小风车：四片斜叶 + 圆心（和 `cardIcons.mill` 同形）。 */
const MILL = `<g transform="translate(11 40) scale(0.42)" fill="#e7c98a">
  <path d="M12.6 10.9 13.4 2.6 16.2 9.8 12.6 10.9Z"/>
  <path d="M12.6 10.9 13.4 2.6 16.2 9.8 12.6 10.9Z" transform="rotate(90 12 12)"/>
  <path d="M12.6 10.9 13.4 2.6 16.2 9.8 12.6 10.9Z" transform="rotate(180 12 12)"/>
  <path d="M12.6 10.9 13.4 2.6 16.2 9.8 12.6 10.9Z" transform="rotate(270 12 12)"/>
  <circle cx="12" cy="12" r="2.3"/>
</g>`;

/**
 * 缺配角标：右上角一枚红底白叉。
 *
 * 第一版是一条斜跨全图的大红叉 —— 实测截图里房子被叉盖住了，只剩一个「X」，
 * 读不出「缺的是房屋」。改成角标后：图标主体清楚、叉仍然一眼可见。
 */
const CROSS = `<circle cx="50" cy="14" r="11" fill="#e2503f" stroke="#2a100c" stroke-width="2"/>
<path d="M45.5 9.5 54.5 18.5 M54.5 9.5 45.5 18.5" stroke="#fff3ec" stroke-width="3" stroke-linecap="round"/>`;

const svgOf = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${body}</svg>`;

export const NEED_ICON_SVG: Record<NeedIcon, string> = {
  house: svgOf(`${PLATE}${HOUSE}${CROSS}`),
  millHouse: svgOf(`${PLATE}${HOUSE}${MILL}${CROSS}`),
};

/** 给 `THREE.TextureLoader` 用的 data URL（SVG 必须 encode，否则 # 会被当锚点）。 */
export function needIconUrl(kind: NeedIcon): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(NEED_ICON_SVG[kind])}`;
}
