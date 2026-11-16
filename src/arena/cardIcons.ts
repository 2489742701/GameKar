/**
 * 卡面图标 —— 每张卡一张内联 SVG，**不加载任何图片**。
 *
 * 三条约束（都是这套 UI 的既有风格）：
 * 1. 单色 + `currentColor`：卡面会按"买得起/买不起/选中"改颜色，图标要跟着走；
 * 2. 24×24 网格、只用路径和矩形：像素风的卡面里放一张细线条插画会糊；
 * 3. 形状要**一眼分得开**：塔的轮廓、帐篷的轮廓、房子的轮廓，在 62px 高的卡上只剩 28px，
 *    细节全丢，所以只做剪影级的设计。
 */

export const CARD_ICON: Record<string, string> = {
  // ---------------------------------------------------------------- 建筑

  /** 兵营：一顶帐篷，中间掏出帐篷门 */
  barracks: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path fill-rule="evenodd" d="M12 2.6 1.8 20.4h20.4L12 2.6Zm0 7.2 4.9 8.6H7.1L12 9.8Z"/>
  </svg>`,

  /** 箭塔：方塔身 + 一支朝上的箭 */
  arrowTower: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" d="M8.4 21.2V8.6h7.2v12.6H8.4Zm1.9-10.7v2.4h3.4v-2.4h-3.4Z"/>
    <path d="M12 1.6v5.4M9.4 4.2 12 6.8l2.6-2.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  /** 炮塔：方塔身 + 一根粗炮管 */
  cannonTower: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M8.6 21.2V10.4h6.8v10.8H8.6Z"/>
    <rect fill="currentColor" x="11" y="5.2" width="10.6" height="4.4" rx="1.2"/>
    <rect fill="currentColor" x="6.4" y="8.2" width="4" height="2.4" rx="0.8"/>
  </svg>`,

  /**
   * 磨坊：四片**斜**叶的风车。
   *
   * 注意别画成"圆 + 十字" —— 第一版就是那样，缩小到 27px 和牧师的十字一模一样。
   * 叶片是斜的、还带一点宽度，剪影才和十字分得开。
   */
  mill: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <g fill="currentColor">
      <path d="M12.6 10.9 13.4 2.6 16.2 9.8 12.6 10.9Z"/>
      <path d="M12.6 10.9 13.4 2.6 16.2 9.8 12.6 10.9Z" transform="rotate(90 12 12)"/>
      <path d="M12.6 10.9 13.4 2.6 16.2 9.8 12.6 10.9Z" transform="rotate(180 12 12)"/>
      <path d="M12.6 10.9 13.4 2.6 16.2 9.8 12.6 10.9Z" transform="rotate(270 12 12)"/>
      <circle cx="12" cy="12" r="2.3"/>
    </g>
  </svg>`,

  /** 商行：铺面 + 檐下招牌 + 一枚金币（和磨坊的风车剪影分得开） */
  guild: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <g fill="currentColor">
      <path d="M2.6 9.4 12 4.2l9.4 5.2v2H2.6v-2Z"/>
      <path d="M4.4 12.8h15.2v8H4.4v-8Z"/>
    </g>
    <circle cx="12" cy="16.6" r="2.9" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <path d="M12 15.1v3M11 16.6h2" fill="none" stroke="currentColor" stroke-width="1.2"/>
  </svg>`,

  /** 民居：尖顶 + 门窗 */
  house: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" d="M12 2.4 2.2 11h2.6v10.2h5.4v-6.4h3.6v6.4h5.4V11h2.6L12 2.4Z"/>
  </svg>`,

  // ---------------------------------------------------------------- 军队

  /** 弓箭手：一张弓 + 一支搭上去的箭 */
  archers: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7.4 2.6c6.6 2.4 6.6 16.4 0 18.8" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
    <path d="M7.4 2.6v18.8" stroke="currentColor" stroke-width="1.2" opacity="0.55"/>
    <path d="M17.4 5.2v13.6M14.8 7.8l2.6-2.6 2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  /** 骑士：盾 */
  knights: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" d="M12 1.8 3.6 5v7c0 5.2 3.5 8.4 8.4 10.2 4.9-1.8 8.4-5 8.4-10.2V5L12 1.8Zm0 3.2 5.2 2v4.6c0 3.5-2.2 5.8-5.2 7.2-3-1.4-5.2-3.7-5.2-7.2V7l5.2-2Z"/>
  </svg>`,

  /** 法师：六芒星 */
  mages: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 1.6l2.5 6.3 6.7.4-5.2 4.3 1.8 6.5L12 15.6 6.2 19.1l1.8-6.5L2.8 8.3l6.7-.4L12 1.6Z"/>
  </svg>`,

  /** 牧师：十字 */
  priests: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M9.8 1.8h4.4v6.4h6.2v4.4h-6.2v9.6H9.8v-9.6H3.6V8.2h6.2V1.8Z"/>
  </svg>`,

  /** 石怪：两块石头 */
  golem: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect fill="currentColor" x="6.6" y="2.8" width="10.8" height="8.4" rx="1.2"/>
    <rect fill="currentColor" x="3.2" y="12.8" width="17.6" height="8.4" rx="1.4"/>
  </svg>`,

  /** 兽人：**双刃**斧。单刃在 27px 下会被当成一面旗子 */
  orcs: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect fill="currentColor" x="10.9" y="1.8" width="2.2" height="20.4" rx="1"/>
    <path fill="currentColor" d="M10 5.4C4.8 5.4 1.8 8.4 1.8 12s3 6.6 8.2 6.6V5.4Z"/>
    <path fill="currentColor" d="M14 5.4c5.2 0 8.2 3 8.2 6.6s-3 6.6-8.2 6.6V5.4Z"/>
  </svg>`,

  /** 机器巨人：齿轮 */
  mech: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <circle fill="currentColor" cx="12" cy="12" r="4.6"/>
    <path d="M12 1.6v3.2M12 19.2v3.2M1.6 12h3.2M19.2 12h3.2M4.6 4.6l2.3 2.3M17.1 17.1l2.3 2.3M19.4 4.6l-2.3 2.3M6.9 17.1l-2.3 2.3"
      stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>
  </svg>`,

  /** 移动火炮：轮子 + 上扬的炮管 */
  mobileCannon: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M2.6 11.4h11.8l7-3.6v4.2l-7 3.6H2.6v-4.2Z"/>
    <circle fill="currentColor" cx="7.2" cy="17.6" r="3.2"/>
    <circle fill="currentColor" cx="16.4" cy="17.6" r="3.2"/>
  </svg>`,

  /** 移动弩箭：横弩 + 竖架 */
  ballista: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect fill="currentColor" x="2.6" y="6.2" width="18.8" height="3.4" rx="0.9"/>
    <path d="M12 9.6v11.2M7.8 20.8h8.4" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" fill="none"/>
  </svg>`,

  // ---------------------------------------------------------------- 大队卡
  // 三张 "xxxBig" 是同一兵种的加量版：图标做成"两个"，一眼能看出是大队，
  // 又不会和基础卡完全一样（第一版漏了这三张，卡面上是个虚线空框）。

  /** 弓箭手大队：两把弓 + 中间那支箭 */
  archersBig: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5.2 2.8c5.2 2 5.2 14.4 0 16.4M11.2 2.8c5.2 2 5.2 14.4 0 16.4"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M19 4.6v15M16.8 7l2.2-2.4 2.2 2.4" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  /** 骑士大队：两面盾 */
  knightsBig: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M6.6 2.2 1.4 4.2v6c0 4 2.6 6.6 5.2 8 2.6-1.4 5.2-4 5.2-8v-6L6.6 2.2Zm0 2.4 3 1.2v3.4c0 2.5-1.3 4.1-3 5-1.7-.9-3-2.5-3-5V5.8l3-1.2Z"/>
    <path fill="currentColor" d="M17.4 2.2 12.2 4.2v6c0 4 2.6 6.6 5.2 8 2.6-1.4 5.2-4 5.2-8v-6l-5.2-2Zm0 2.4 3 1.2v3.4c0 2.5-1.3 4.1-3 5-1.7-.9-3-2.5-3-5V5.8l3-1.2Z"/>
  </svg>`,

  /** 兽人大队：两把交叉的斧 */
  orcsBig: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M6.2 2.6 8.2 2 21 19.4l-1.4 1L6.2 2.6Z"/>
    <path fill="currentColor" d="M17.8 2.6 15.8 2 3 19.4l1.4 1L17.8 2.6Z"/>
    <path fill="currentColor" d="M6.8 1.8c3.2 0 5.6 1.9 5.6 4.2 0 1.6-1.2 2.8-3 3.3L6.8 1.8Z"/>
    <path fill="currentColor" d="M17.2 1.8C14 1.8 11.6 3.7 11.6 6c0 1.6 1.2 2.8 3 3.3l2.6-7.5Z"/>
  </svg>`,

  /** 长矛兵小队：三支长矛 */
  spearmen: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 1.5 14 5.5h-4l2-4Zm0 4.2 1 13.8h-2l1-13.8Z"/>
    <path fill="currentColor" d="M5.5 2.5 7 6H4l1.5-3.5Zm.8 4 .8 12.5H5.5l.8-12.5Z"/>
    <path fill="currentColor" d="M18.5 2.5 20 6h-3l1.5-3.5Zm-.8 4 .8 12.5h-.8l0-12.5Z"/>
  </svg>`,

  /** 弩手小队：弩臂 + 弦 */
  crossbowmen: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M11 3h2v16h-2V3Zm-1 7h4v2h-4v-10Z"/>
    <path d="M3 6c4 2 14 2 18 0M3 6l5 4M21 6l-5 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`,

  /** 盾卫：一面重盾 */
  shields: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 1.8 2.8 5v7c0 5 3.8 8.4 9.2 10.2 5.4-1.8 9.2-5.2 9.2-10.2V5L12 1.8Zm0 2.4 7 2.5v5.3c0 3.7-2.7 6.2-7 7.8-4.3-1.6-7-4.1-7-7.8V6.7l7-2.5Z"/>
    <path fill="currentColor" d="M11 6h2v10h-2V6Zm-4 4h10v2H7v-2Z"/>
  </svg>`,

  /** 热气球：球囊 + 吊绳 + 吊篮（和飞行器是两回事，07:45 用户纠正） */
  balloon: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 1.5c4.1 0 7 3.2 7 7.2 0 3.7-2.6 6.6-5.4 8.3h-3.2C7.6 15.3 5 12.4 5 8.7c0-4 2.9-7.2 7-7.2Z"/>
    <path d="M10 17h4l1 5H9l1-5Zm1-2 1 2m2-2-1 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`,

  /** 达芬奇空气螺旋机：尖锥吊舱 + 旋转螺旋帆 */
  airscrew: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 13 7.5 21h9L12 13Z"/>
    <path d="M12 2v11M4.5 4c5 2 10 2 15 0M4.5 8c5 2 10 2 15 0M4.5 12c5 2 10 2 15 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <circle fill="currentColor" cx="12" cy="2" r="1.4"/>
  </svg>`,

  /** 扑翼轰炸机：龙骨 + 双三角翼 + 燕尾 */
  bomber: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M11.2 3h1.6v18h-1.6V3Z"/>
    <path fill="currentColor" d="M11.2 7 2 11.5 4 13l7.2-3V7Zm1.6 0 9.2 4.5L20 13l-7.2-3V7Z"/>
    <path fill="currentColor" d="M11.2 17 7 21h10l-4.2-4h-1.6Z"/>
    <circle fill="currentColor" cx="12" cy="3" r="1.3"/>
  </svg>`,

  /** 民兵集结：三支草叉 + 一张弓 */
  militia: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M6 1.5 7.5 5H4.5L6 1.5Zm0 3.7.8 14H5.2l.8-14ZM12 1.5 13.5 5h-3L12 1.5Zm0 3.7.8 14h-1.6l.8-14ZM18 1.5 19.5 5h-3L18 1.5Zm0 3.7.8 14h-1.6l.8-14Z"/>
    <path d="M5 9c5 3 9 3 14 0M5 9l3 4m11-4-3 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`,

  /** 齿轮工厂：大齿轮 + 烟囱 */
  gearFactory: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M10.6 1h2.8l.5 2.3 1.8.8 2-1.3 2 2-1.3 2 .8 1.8 2.3.5v2.8l-2.3.5-.8 1.8 1.3 2-2 2-2-1.3-1.8.8-.5 2.3h-2.8l-.5-2.3-1.8-.8-2 1.3-2-2 1.3-2-.8-1.8L1.4 13v-2.8l2.3-.5.8-1.8-1.3-2 2-2 2 1.3 1.8-.8L10.6 1Z"/>
    <circle cx="12" cy="11" r="3.6" fill="#0e0b08"/>
    <path fill="currentColor" d="M18.5 17h2v5h-2v-5Z"/>
  </svg>`,

  /** 兽人巢穴：石窟拱门 + 一对獠牙 + 骨刺（2026-11-07 新增建筑） */
  orcLair: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M3 21v-9a9 9 0 0 1 18 0v9h-4v-8a5 5 0 0 0-10 0v8H3Z"/>
    <path fill="currentColor" d="M5.5 2.5 8 8.4 5 7.6l.5-5.1Zm13 0L16 8.4l3-.8-.5-5.1Z"/>
    <path fill="currentColor" d="M11 0h2v3.2h-2V0Z"/>
    <rect x="9.5" y="14" width="5" height="7" rx="2.5" fill="#0e0b08"/>
  </svg>`,

  // ---------------------------------------------------------------- 肉盾（P-109）

  /**
   * 兽人坦克：一面**大盾 + 獠牙**的正面剪影。
   *
   * 剪影要能一眼看出"这是拿来挡的"：主体是盾牌，不是人形 ——
   * 24×24 下画小人会糊成一根柱子，盾牌加獠牙才有辨识度。
   */
  orcTank: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 1.8 4.4 4.6v7.2c0 5 3.2 9.5 7.6 10.9 4.4-1.4 7.6-5.9 7.6-10.9V4.6L12 1.8Z"/>
    <path fill="currentColor" opacity=".55" d="M12 4.4 6.6 6.4v5.4c0 3.6 2.3 6.8 5.4 7.8 3.1-1 5.4-4.2 5.4-7.8V6.4L12 4.4Z"/>
  </svg>`,

  /**
   * 兽人巨人：比坦克更高更宽的人形巨兽 —— **两个獠牙 + 宽肩**。
   *
   * 和坦克的区别靠"人物轮廓 vs 盾牌"：这里能看出头、肩、腿。
   */
  orcGiant: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M8.2 2.2h7.6v3.4H8.2V2.2Z"/>
    <path fill="currentColor" d="M6 6.4h12l1.6 5.2-2.2.7v9.5h-3.6v-7h-3.6v7H6.6v-9.5l-2.2-.7L6 6.4Z"/>
    <path fill="currentColor" d="M9.2 9.8h1.5v2.4H9.2zm4.1 0h1.5v2.4h-1.5z"/>
  </svg>`,

  // ---------------------------------------------------------------- 法术（P-103 / P-104）
  /**
   * 法术工厂（P-104）：一口大锅炉 + 旁边一间小屋。
   *
   * 和「磨坊」（风车帆）、「齿轮工厂」（大齿轮）都要一眼分开：
   * 这里主体必须是**圆肚子 + 烟囱**，右边再挂一个方方正正的小屋。
   */
  spellForge: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M3.2 21v-2.2h1.1V11a4.2 4.2 0 0 1 8.4 0v7.8h1.1V21H3.2Z"/>
    <path fill="currentColor" d="M6.6 2.2h1.4v3.6H6.6z"/>
    <path fill="currentColor" d="M5.9 2.2h2.8v.9H5.9z"/>
    <rect x="6.6" y="13" width="2.8" height="2.4" rx=".4" fill="#0e0b08"/>
    <path fill="currentColor" d="M15 21v-6.6h6V21h-1.7v-5h-2.6v5H15Z"/>
    <path fill="currentColor" d="M14.4 13.2 18 10.6l3.6 2.6v1.1h-7.2v-1.1Z"/>
  </svg>`,

  /**
   * 火球术：一团火球 + 内层更亮的心（用 opacity 分两层，卡面变色时跟着 currentColor 走）。
   *
   * 剪影上要和「法师小队」分开 —— 法师卡是两个小人影，这里必须是**单个火团**。
   * 24×24 网格下只做主体 + 内焰，细节再多就糊成一坨。
   */
  fireball: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 2.4c2.7 2.7 2.2 4.7 1.2 6.3 1.4-.3 2.4-1.2 3-2.3 2 2.4 3.4 5 3.4 7.8a7.6 7.6 0 1 1-15.2 0c0-3.4 2-7.1 4.6-9.8.1 1.4.4 2.4 1.1 3.1.7-1.7.7-3.6 1.9-5.1Z"/>
    <path fill="currentColor" opacity=".5" d="M12 12.2c1.4 1.5 1.2 2.6.6 3.5.8-.2 1.3-.7 1.6-1.3 1.1 1.3 1.8 2.7 1.8 4.2a4 4 0 0 1-8 0c0-1.8 1.1-3.9 2.5-5.4.1.8.2 1.3.5 1.7.5-1 .5-1.9 1-2.7Z"/>
  </svg>`,

  /**
   * 剑雨：五把朝下的短剑从上往下落。
   *
   * 剪影要和火球**完全不像** —— 火球是一个圆团，这里必须是"一堆细长竖条"，
   * 24×24 下一眼就能分出"这是打兵的"。
   */
  arrowRain: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M4.6 2h1.6v9.6l2.6 3.2-3.4 4.4-3.4-4.4 2.6-3.2V2Z"/>
    <path fill="currentColor" d="M11.2 1h1.6v7.4l2.6 3.2-3.4 4.4-3.4-4.4 2.6-3.2V1Z"/>
    <path fill="currentColor" d="M17.8 2h1.6v9.6l2.6 3.2-3.4 4.4-3.4-4.4 2.6-3.2V2Z"/>
    <path fill="currentColor" opacity=".55" d="M8.4 15.4h1.4v3H8.4zM15 15.4h1.4v3H15z"/>
  </svg>`,

  /**
   * 导弹：一枚朝下坠的弹体（尖头 + 尾翼 + 尾焰）。
   *
   * 和剑雨的"多根细条"要分开，所以这里必须是**单个粗壮的纺锤**；
   * 尾翼用两条斜线，24×24 下能看出"带翅膀的弹"。
   */
  missile: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 1.6c2.2 2.6 3.2 5.6 3.2 8.8v4.2H8.8v-4.2c0-3.2 1-6.2 3.2-8.8Z"/>
    <path fill="currentColor" d="M8.8 10.4 5.2 14.6v3l3.6-2.2v-5Zm6.4 0 3.6 4.2v3l-3.6-2.2v-5Z"/>
    <rect x="9.6" y="15.4" width="4.8" height="2.2" rx=".6" fill="currentColor"/>
    <path fill="currentColor" opacity=".6" d="M12 18.4l1.8 4-1.8-1.2-1.8 1.2 1.8-4Z"/>
  </svg>`,
};

/** 取一张卡的图标；卡池里新加卡但忘了画图时退回一个空框，不要崩。 */
export function iconOf(cardId: string): string {
  return (
    CARD_ICON[cardId] ??
    `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 3"/></svg>`
  );
}
