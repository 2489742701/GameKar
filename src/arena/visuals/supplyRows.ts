/**
 * 卡牌「增 / 减」两行需求（2026-11-07 设计文档 A 节；同日中午按用户的新经济规则返工）。
 *
 * 用户："加和减需要处理，不要堆在一起……一行显示增，一行显示减"，
 * 以及"单位调整 SVG 也要一起落地，卡面也要一起落地"。
 *
 * **判据只有一处**：`config.ts` 的 `BUILDING_POP` 表与 `armySupplyOf()`。
 * `ArenaWorld.supplyOf / supplyBlocked`、`ai.canPlay` 和这里画 SVG 的个数
 * 全部读同一套数，卡面不会自己算账 —— 否则会画出"扣 2 人口"却实际只扣 1。
 *
 * 现在的具体口径：
 *  - 民居 +2 人口上限、不占；磨坊 +2 面包、只占 **1** 人口；
 *  - 箭塔占 **1** 人口、炮塔占 **2**，兵营 / 工厂 / 兽人巢穴占 2；
 *  - **民兵集结 / 兽人军队不画人口图标**（零人口）；兽人每人吃 **2** 份面包；
 *  - 其余军队 n 人 ⇒ −n 人口 −n 面包（牧师小队 2 人 ⇒ −2人 −2包）。
 *
 * 输出是两段 HTML，HUD 只负责塞进容器：`data-need` 保留给 data-short 红色告警。
 */
import { SUPPLY, armySupplyOf, buildingPopOf, type ArenaCard } from '../config';
import { BREAD_ICON, POP_ICON } from '../supplyIcons';

const group = (need: 'pop' | 'bread', inner: string): string =>
  `<span class="ahud__card__need__grp" data-need="${need}">${inner}</span>`;
const repeat = (need: 'pop' | 'bread', svg: string, n: number): string =>
  n > 3 ? group(need, `${svg}<b>×${n}</b>`) : group(need, svg.repeat(n));

/** 一行：`+` 金色（增）/ `−` 珊瑚红（减），后面跟若干组需求图标。 */
const row = (kind: 'plus' | 'minus', groups: string): string =>
  groups ? `<span class="ahud__card__need__row" data-row="${kind}"><b class="ahud__card__need__sign">${kind === 'plus' ? '+' : '−'}</b>${groups}</span>` : '';

export interface SupplyRows {
  plus: string;
  minus: string;
}

/** 拆成「增 / 减」两行（纯函数，好单测）。 */
export function supplyRows(card: ArenaCard): SupplyRows {
  if (card.kind === 'building') {
    if (card.building === 'house') {
      return { plus: group('pop', POP_ICON.repeat(SUPPLY.housePop)), minus: '' };
    }
    const pop = buildingPopOf(card.building!);
    if (card.building === 'mill') {
      return {
        plus: group('bread', BREAD_ICON.repeat(SUPPLY.millBread)),
        minus: group('pop', POP_ICON.repeat(pop)),
      };
    }
    return { plus: '', minus: group('pop', POP_ICON.repeat(pop)) };
  }
  const n = (card.squad ?? []).reduce((sum, g) => sum + g.count, 0);
  const supply = armySupplyOf(card);
  // 面包按**实际口粮**画（民兵 6 人 ×0.5 ⇒ 3 个；兽人 2 人 ×2 ⇒ 4 个），别按人头骗玩家
  const breadN = Math.ceil(n * supply.breadPerMan);
  return {
    plus: '',
    minus:
      (supply.popPerMan > 0 ? repeat('pop', POP_ICON, n * supply.popPerMan) : '') +
      repeat('bread', BREAD_ICON, breadN),
  };
}

/** HUD 直接塞进 `.ahud__card__need` 的 HTML：先增行后减行，缺的行不占位。 */
export function supplyRowsHtml(card: ArenaCard): string {
  const { plus, minus } = supplyRows(card);
  return row('plus', plus) + row('minus', minus);
}
