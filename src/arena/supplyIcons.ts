/**
 * 左上角那两个读数的图标：**人**和**面包**。
 *
 * 用户 2026-11-06："那个面包和人都画一个 SVG 代替小图片呀不然不好看呀。"
 *
 * 和 `cardIcons.ts` 同一套规矩：24×24、`currentColor`、剪影级。
 * 区别是这里只有 13px 高，所以形状必须**极简**：人 = 一圆一肩，面包 = 一椭圆 + 三道切口。
 */

/** 一个人：头 + 肩。再细就成一团墨点了。 */
export const POP_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <circle cx="12" cy="7" r="3.6"/>
  <path d="M4.4 21.6c0-4.2 3.4-7.6 7.6-7.6s7.6 3.4 7.6 7.6H4.4Z"/>
</svg>`;

/**
 * 一条面包：椭圆 + 三道切口。
 * 切口用半透明黑描边而不是挖空 —— 挖空在深色面板上会露出底下的木纹，看着像裂开的洞。
 */
export const BREAD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <ellipse cx="12" cy="12.4" rx="9.4" ry="6.2" fill="currentColor"/>
  <path d="M7.9 8.9 6.4 12.6M12 7.9v4.8M16.1 8.9l1.5 3.7"
    stroke="rgba(0,0,0,0.42)" stroke-width="1.5" stroke-linecap="round" fill="none"/>
</svg>`;

/**
 * 一枚金币（2026-11-06）：底部金币栏的图标。
 * 填充条本身就是金色的，图标只要剪影 + 一圈压暗的内环（和面包切口同一招：
 * 挖空在金色渐变上会露出底下的条色，用半透明黑描边最稳）。
 */
export const COIN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="9.4" fill="currentColor"/>
  <circle cx="12" cy="12" r="5.4" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="1.8"/>
</svg>`;
