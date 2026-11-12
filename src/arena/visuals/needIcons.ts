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
 *
 * **P-097（2026-11-12）用户："那个缺少房屋的地方，把后面的板子去掉，只保留 SVG。"**
 * 原来图标后面垫了一块 60×60 的深色木牌（`PLATE`），本意是在草地 / 屋顶两种
 * 背景前都读得清，实测却变成"房顶又挂了一块牌子"，和修复图标去掉边框的口径打架。
 * 现在**整块底板删掉，SVG 自身就是全部内容**：透明背景，只剩房屋 / 风车 / 红叉。
 * 可读性改由两处承担，都不引入任何矩形：
 * 1. 图形自己的深色描边（房屋 2.2、风车 2）；
 * 2. 一层 `feDropShadow` 软投影，把剪影从草地上"托"起来。
 *    ⚠️ 别再加回 `<rect>` 底板 / border / box-shadow —— `needIcons.test.ts` 钉着这条。
 */

export type NeedIcon = 'house' | 'millHouse';

/**
 * 软投影：只给图形边缘一圈暗影，不是底板。
 * 用 `filterUnits="userSpaceOnUse"` 把滤镜区域放大，否则 64×64 的 viewBox
 * 会把斜下方的影子裁掉一条直边，看起来又像一块板子。
 */
const SHADOW = `<defs>
  <filter id="needShadow" x="-25%" y="-25%" width="150%" height="150%" filterUnits="objectBoundingBox">
    <feDropShadow dx="0" dy="2" stdDeviation="1.8" flood-color="#160f08" flood-opacity="0.7"/>
  </filter>
</defs>`;

/** 小房屋：尖顶 + 方身 + 门。和 `cardIcons.house` 同一套剪影语言。 */
const HOUSE = `<path d="M32 13 11 31h6v20h10V39h10v12h10V31h6L32 13Z" fill="#f0d08a" stroke="#3a2a16" stroke-width="2.2" stroke-linejoin="round"/>`;

/** 小风车：四片斜叶 + 圆心（和 `cardIcons.mill` 同形）。描边保证草地上读得出。 */
const MILL = `<g transform="translate(11 40) scale(0.42)" fill="#e7c98a" stroke="#4a341c" stroke-width="2" stroke-linejoin="round">
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
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${SHADOW}<g filter="url(#needShadow)">${body}</g></svg>`;

/** P-097：透明底，只有图形本体；没有卡片、没有 `<rect>` 底板。 */
export const NEED_ICON_SVG: Record<NeedIcon, string> = {
  house: svgOf(`${HOUSE}${CROSS}`),
  millHouse: svgOf(`${HOUSE}${MILL}${CROSS}`),
};

/** 给 `THREE.TextureLoader` 用的 data URL（SVG 必须 encode，否则 # 会被当锚点）。 */
export function needIconUrl(kind: NeedIcon): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(NEED_ICON_SVG[kind])}`;
}
