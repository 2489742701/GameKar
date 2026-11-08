/**
 * 顶栏三颗按钮的**简要 SVG**（2026-11-08 用户："手机版它们会卡在一起…
 * 只显示简要的 SVG，退出、设置什么都给它们画一下"）。
 *
 * 和 `supplyIcons.ts` 同一套规矩：24×24、`currentColor`、剪影级，
 * 只是这三枚在木牌上要更细一点，所以用 stroke 而不是实心块。
 * 文字标签另放在 `<span>` 里（宽屏才显示），SVG 永远在 —— 手机只剩图标，
 * 右侧工具列从 ~170px 缩到 ~110px，`1fr auto 1fr` 才真的能把时钟压在中线上。
 */

/** 视角：一只眼睛（点一下切下一档机位）。 */
export const VIEW_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2.2 12S6 6.2 12 6.2 21.8 12 21.8 12 18 17.8 12 17.8 2.2 12 2.2 12Z"/>
  <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>
</svg>`;

/**
 * 设置：实心齿轮。轮廓直接复用卡面「齿轮工厂」那颗（`cardIcons.ts`），
 * 中心孔用 evenodd 挖掉而不是填深色 —— 木牌是渐变木纹，填死色会露一个黑点。
 * 早先画成"中心圆 + 八根辐条"的 stroke 版在 17px 下活像太阳，认不出是设置。
 */
export const SETTINGS_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path fill-rule="evenodd" d="M10.6 1h2.8l.5 2.3 1.8.8 2-1.3 2 2-1.3 2 .8 1.8 2.3.5v2.8l-2.3.5-.8 1.8 1.3 2-2 2-2-1.3-1.8.8-.5 2.3h-2.8l-.5-2.3-1.8-.8-2 1.3-2-2 1.3-2-.8-1.8L1.4 13v-2.8l2.3-.5.8-1.8-1.3-2 2-2 2 1.3 1.8-.8L10.6 1ZM12 7.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/>
</svg>`;

/** 退出：门框 + 向外箭头。 */
export const QUIT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M13.5 3.5H5.2v17h8.3"/>
  <path d="M10 12h9.5M16.5 8.5 20 12l-3.5 3.5"/>
</svg>`;
