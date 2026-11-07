/**
 * 卡牌「增 / 减」两行需求（2026-11-07 设计文档 A 节）。
 *
 * 用户："加和减需要处理，不要堆在一起……一行显示增，一行显示减"。
 * 判据全部从 SUPPLY 读（卡面不自己算账），和 `supplyBlocked` 同一套数值：
 *  - 建筑占 2 人口（减）；民居给 2 人口（增）；磨坊给 2 面包（增）且占 2 人口（减）；
 *  - 军队 n 人：扣 n 人口 + n 面包（减）—— 牧师小队 2 人 ⇒ −2人 −2包。
 *
 * 输出是两段 HTML，HUD 只负责塞进容器：`data-need` 保留给 data-short 红色告警。
 */
import { SUPPLY, type ArenaCard } from '../config';
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
  const pop = SUPPLY.buildingPop;
  if (card.kind === 'building') {
    if (card.building === 'house') {
      return { plus: group('pop', POP_ICON.repeat(SUPPLY.housePop)), minus: '' };
    }
    if (card.building === 'mill') {
      return {
        plus: group('bread', BREAD_ICON.repeat(SUPPLY.millBread)),
        minus: group('pop', POP_ICON.repeat(pop)),
      };
    }
    return { plus: '', minus: group('pop', POP_ICON.repeat(pop)) };
  }
  const n = (card.squad ?? []).reduce((sum, g) => sum + g.count, 0);
  // 面包按**实际口粮**画（民兵每人 0.5 ⇒ 6 人只画 3 个面包），别按人头骗玩家
  const breadN = Math.ceil(n * (card.breadPerMan ?? 1));
  return {
    plus: '',
    minus: repeat('pop', POP_ICON, n) + repeat('bread', BREAD_ICON, breadN),
  };
}

/** HUD 直接塞进 `.ahud__card__need` 的 HTML：先增行后减行，缺的行不占位。 */
export function supplyRowsHtml(card: ArenaCard): string {
  const { plus, minus } = supplyRows(card);
  return row('plus', plus) + row('minus', minus);
}
