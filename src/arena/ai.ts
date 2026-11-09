/**
 * 敌方 / 托管方的**决策大脑** —— 纯函数，不碰世界状态。
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │ ① 局面读取  `AiView`                                        │
 * │    世界把「能看的」打包过来：手牌、金币、场上楼数、             │
 * │    人口/面包容器、刷新冷却。大脑不能自己读全局状态。            │
 * ├─────────────────────────────────────────────────────────────┤
 * │ ② 决策      `decide(view) -> AiAction`  ← 唯一入口            │
 * │    `constrainedWish()` 按容器重排愿望清单                      │
 * │    `shouldReroll()` 判断该不该花 5 金换牌                      │
 * │    `chooseCard()`    判断出第几张 / 攒钱（过滤掉打不出去的牌）  │
 * ├─────────────────────────────────────────────────────────────┤
 * │ ③ 执行      `ArenaWorld.think()`                            │
 * │    只按 action 动手：刷新 / 出牌 / 什么都不做。               │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 为什么单独拆出来（2026-10-28 的教训）：这套「我现在缺什么」的排序最容易被调坏，
 * 原来埋在 `ArenaWorld` 一千行里、要跑完整局才测得出来。抽成纯函数后，
 * 给一份局面就能直接断言「这一轮该刷新还是出第几格」。
 *
 * 2026-11-06 强化：加了人口/面包/民居约束之后，旧 AI 会**一直挑一张打不出去的牌**
 * （人口满了还选塔、面包满了还选军队），而且缺民居时只会干等补牌。
 * 现在它会：① 过滤掉容器不允许的牌 ② 真缺民居/手牌全废时花 5 金刷新（保底民居）
 * ③ 两次刷新之间留冷却，不会把钱刷光。
 */

import {
  AI, ECONOMY, REROLL, SUPPLY,
  armySupplyOf, buildingPopOf,
  type ArenaCard, type BuildingKind,
} from './config';

/** 容器读数（从 `ArenaWorld.supplyOf()` 来，视图与 AI 读同一份，别自己算）。 */
export interface SupplyView {
  pop: number;
  popMax: number;
  bread: number;
  breadMax: number;
}

/** ① 局面读取：旧的最小视图（还能单独传给 `chooseCard` 做单测）。 */
export interface AiHandView {
  /** 手上四张（null = 刚打出去、还在补牌） */
  hand: (ArenaCard | null)[];
  gold: number;
  /** 场上这一类楼有几栋（不含大本营） */
  count: (kind: BuildingKind | 'core') => number;
}

/** ① 完整局面：新加的两项是可选的，旧调用点不传也能工作。 */
export interface AiView extends AiHandView {
  supply?: SupplyView;
  /** 距下次可刷新还有几秒（≤0 才能刷） */
  rerollIn?: number;
}

/** ② 决策输出：三选一，`think()` 只认这三种。 */
export type AiAction =
  | { kind: 'reroll' }
  | { kind: 'play'; slot: number }
  | { kind: 'wait' };

const nonNull = (hand: (ArenaCard | null)[]): ArenaCard[] =>
  hand.filter((c): c is ArenaCard => c !== null);

/**
 * 这张牌现在**落得下去**吗（人口/面包容量 + 槽位制衡）。
 *
 * 民居是例外：它自己 +2 人口上限且不占人口，所以永远能落 —— 这正是
 * 「6/6 满的时候连民居都盖不出来」那个死锁的对侧，AI 也必须知道。
 *
 * 槽位制衡（2026-11-06 用户）：建筑占用最多到 `人口上限 − armyReserve`，
 * 永远给军队留 2 格 —— AI 和玩家受同一条容器法律约束。
 */
export function canPlay(card: ArenaCard, s?: SupplyView): boolean {
  if (!s) return true;
  if (card.kind === 'building') {
    if (card.building === 'house') return true;
    // 建筑人口按种类读表（磨坊/箭塔 1、炮塔 2……），与落牌判据同源
    return s.pop + buildingPopOf(card.building!) <= s.popMax - SUPPLY.armyReserve;
  }
  const n = (card.squad ?? []).reduce((sum, g) => sum + g.count, 0);
  const supply = armySupplyOf(card);
  return (
    (supply.popPerMan === 0 || s.pop + n * supply.popPerMan <= s.popMax) &&
    s.bread + n * supply.breadPerMan * SUPPLY.unitBread <= s.breadMax
  );
}

/**
 * "我现在缺什么" —— 按优先级排成一张卡 id 的清单，越靠前越想要。
 *
 * 顺序是**先能站住、再能产兵、最后才是堆军队**；从 2026-10-31 起，
 * **民居/磨坊排在"盖新楼"前面**：每座塔要 1 座民居、每座兵营要 1 磨坊 + 1 民居，
 * 名额不够时盖出来的楼是停摆的（塔不开火、兵营不出兵），那 6/12 金就是白花。
 */
export function wishList(count: (kind: BuildingKind | 'core') => number): string[] {
  const towers = count('arrowTower') + count('cannonTower');
  const barracks = count('barracks');
  const mills = count('mill');
  const houses = count('house');
  const guilds = count('guild');
  const out: string[] = [];

  // 商行也是「要干活的楼」（2026-11-09）：占 1 座民居名额，算进去才不会把塔挤成死楼
  if (houses < towers + barracks + guilds + 1) out.push('house');
  if (towers < 1) out.push('arrowTower', 'cannonTower');
  if (barracks < 1) {
    if (mills < 1) out.push('mill');
    out.push('barracks');
  }
  if (towers < 2) out.push('cannonTower', 'arrowTower');
  if (barracks < 2) {
    if (mills < barracks) out.push('mill');
    out.push('barracks');
  }
  // 到这里建筑都齐了：剩下的全出军队，贵的排前面
  out.push(
    'mech', 'mobileCannon', 'knightsBig', 'orcsBig', 'mages', 'archersBig',
    'ballista', 'priests', 'knights', 'golem', 'orcs', 'archers',
  );
  return out;
}

/**
 * **落点纵深带**（2026-11-07 用户："AI 可以更智能一点，比如说它放建筑时，
 * 经济类建筑放后面，防御类建筑放前面"）。
 *
 * `t ∈ [0,1]`：**0 = 自家底线，1 = 最靠近中场（前线）**。
 * 这里刻意不写具体 col —— 蓝方前线是 col 大的一端、红方是 col 小的一端，
 * 映射交给 `ArenaWorld.randomSpot` 按阵营翻，判据只留一份。
 *
 * 为什么军队也压前线：卡牌出的兵从落点出发自己推进，落得越靠前，
 * 到对面楼下的时间越短；经济/科技建筑没有攻击、白挨打，该缩在后面。
 */
export interface PlacementBand {
  lo: number;
  hi: number;
}

export function placementBand(card: ArenaCard): PlacementBand {
  if (card.kind !== 'building') return { lo: 0.65, hi: 1 };
  switch (card.building) {
    // 经济 / 被动科技：躲在自家底线那一侧
    case 'house':
    case 'mill':
    case 'guild':
    case 'gearFactory':
      return { lo: 0, hi: 0.4 };
    // 防御塔：顶到最前面才拦得住
    case 'arrowTower':
    case 'cannonTower':
      return { lo: 0.6, hi: 1 };
    // 兵营要产兵，居中偏前，别和塔抢最前排
    case 'barracks':
      return { lo: 0.42, hi: 0.82 };
    default:
      return { lo: 0.2, hi: 0.8 };
  }
}

/** 按容器读数重排愿望：建筑名额被保留槽顶住就先补民居，面包吃光就先补磨坊。 */
export function constrainedWish(view: AiView): string[] {
  const base = wishList(view.count);
  const s = view.supply;
  if (!s) return base;
  /**
   * 建筑只剩保留槽（上限 − pop ≤ armyReserve）⇒ **任何非民居建筑都盖不下去**，
   * 把 house 顶到最前 —— 民居是唯一解锁。这是结构性的顶死，不是边际差 1，
   * 不会有旧注释担心的「盖楼→补民居→再盖楼」循环：不补民居就永远出不了楼。
   */
  if (s.popMax - s.pop <= SUPPLY.armyReserve) {
    return ['house', ...base.filter((id) => id !== 'house')];
  }
  if (s.breadMax - s.bread <= 0 && base.includes('mill')) {
    return ['mill', ...base.filter((id) => id !== 'mill')];
  }
  return base;
}

/**
 * 三类评估（2026-11-06 用户："会自己评估适合建什么、不应该建什么，或者当前不能建什么"）。
 *
 * - **blocked**：容器/保留槽顶住，`playCard` 必然拒绝 —— 当前**不能**建；
 * - **unwise**：落得下去但**不应该**建（判据见下，全是算得出来的账，不靠手感）；
 * - **ok**：适合。
 *
 * 为什么军队永远是 ok：保留槽就是留给军队的，出兵永远是"把名额花在刀刃上"。
 */
export type CardAssess = 'ok' | 'unwise' | 'blocked';

export function assess(card: ArenaCard, view: AiView): CardAssess {
  if (!canPlay(card, view.supply)) return 'blocked';
  if (card.kind !== 'building') return 'ok';

  const towers = view.count('arrowTower') + view.count('cannonTower');
  const barracks = view.count('barracks');
  const mills = view.count('mill');
  const houses = view.count('house');
  const guilds = view.count('guild');
  /** 消费者（要占民居名额的楼）+ 1 座余量：给"下一栋楼"留的活扣 */
  const needHouses = towers + barracks + guilds + 1;

  switch (card.building) {
    // 名额已经多出两座没用：再盖是白花钱（wishList 在 houses < 消费者+1 时才想要）
    case 'house':
      return houses >= towers + barracks + guilds + 2 ? 'unwise' : 'ok';
    // 面包上限够用：至少 1 座（没兵营也要保底），再多一座是冗余
    case 'mill':
      return mills >= Math.max(1, barracks) + 1 ? 'unwise' : 'ok';
    // 商行：产金但占 2 人口 + 1 民居。民居接不住就是一座不吐金的死楼，
    // 而且只留一座（+2 金/5 秒已经够快，堆第二座会把后勤全吃掉）
    case 'guild':
      return guilds >= 1 || houses < needHouses ? 'unwise' : 'ok';
    // 第一座兵营永远值得盖（产兵主路径，缺后勤会由 draw()/reroll() 保底补）；
    // 第二座起，磨坊或民居接不住就是死楼
    case 'barracks':
      return barracks >= 1 && (mills < barracks + 1 || houses < needHouses) ? 'unwise' : 'ok';
    // 盖出来养不起（民居名额全被现有楼占着）＝一座不开火的塔
    case 'arrowTower':
    case 'cannonTower':
      return houses < needHouses ? 'unwise' : 'ok';
    default:
      return 'ok';
  }
}

/**
 * 该不该花 5 金重抽？判据是「卡住了」，不是「手牌不够好」。
 *
 * 三道闸：钱要留够出一张牌、冷却没到、手牌非空（空手会自然补，不用花钱）。
 * 满足之后，三种卡住的情形会刷：
 *   a. 现在最想要的前 3 项里有民居、手里却没有 → `reroll()` 保底给一张民居；
 *   b. 手牌里**一张能落得下去的前 3 想要都没有**（全被人口/面包/名额挡住）；
 *   c. 落得下去的牌**全是"不该建"的**（2026-11-06 评估层新增）——
 *      手牌换不掉就永远出不了手，冷却补牌也补不进来。
 */
export function shouldReroll(view: AiView): boolean {
  if ((view.rerollIn ?? 0) > 0) return false;
  if (view.gold < REROLL.cost + AI.minReserve) return false;
  const hand = nonNull(view.hand);
  if (hand.length === 0) return false;

  const top = constrainedWish(view).slice(0, 3);
  // 只有「一座民居都没有」才值得花钱刷；已经开工之后靠自然补牌就够，
  // 否则每次名额差 1 就刷一次，钱全交给刷新、兵营永远盖不出来（实测红方 120 秒 0 兵）
  if (
    view.count('house') === 0 &&
    top.includes('house') &&
    !hand.some((c) => c.id === 'house') &&
    !hand.some((c) => c.kind === 'building')
  ) return true;

  const playable = hand.filter((c) => canPlay(c, view.supply));
  if (playable.length === 0) return true;
  if (!playable.some((c) => assess(c, view) === 'ok')) return true;
  return !playable.some((c) => top.includes(c.id));
}

/**
 * 这一轮出**第几格**；返回 `null` = 这轮不出（攒钱）。
 *
 * 规矩（2026-10-28 定的）：
 * 1. 先按 `canPlay()` 剔掉容器不允许的牌 —— 2026-11-06 新增，否则 AI 会
 *    反复挑一张 `playCard()` 必然拒绝的牌，看起来像"卡住不动了"；
 * 2. 再按 `assess()` 剔掉"落得下去但不该建"的牌（2026-11-06 评估层）——
 *    名额够用还堆民居/磨坊、后勤接不住的兵营和塔，钱花出去就是浪费；
 * 3. 按愿望清单排位，手上最想要的那张是 `top`；
 * 4. 买得起就直接出；
 * 5. 买不起时按 `top` 的种类分流：**建筑值得等**（长线投资），
 *    **军队不值得等**（出兵要快，能出什么先出什么）。
 */
export function chooseCard(view: AiView): number | null {
  const wish = constrainedWish(view);
  const hand = view.hand;
  const cards = nonNull(hand).filter((c) => assess(c, view) === 'ok');
  if (cards.length === 0) return null;

  const rank = (c: ArenaCard): number => {
    const r = wish.indexOf(c.id);
    return r < 0 ? Number.POSITIVE_INFINITY : r;
  };

  let top = cards[0]!;
  for (const c of cards) if (rank(c) < rank(top)) top = c;

  if (top.cost <= view.gold) return hand.indexOf(top);

  const affordable = cards.filter((c) => c.cost <= view.gold);
  if (affordable.length === 0) return null;
  if (top.kind === 'building') {
    /**
     * 建筑值得等，但**不能无限等**：快顶到金币上限还没花就是纯浪费。
     * 实测（2026-11-06）加了容器过滤之后 AI 变得过于保守：
     * 24 局剩余楼 39.9 栋、平均只拆 1.4 栋、双方 120 秒一个兵都没出 ——
     * 全在「攒钱等一张建筑卡」。钱快满时先出得起的军队推线，才叫强化。
     *
     * 阈值写成 `cap - 4`（2026-11-07 上限 20→30 时从写死的 16 改过来）：
     * 上限 20 ⇒ 16，上限 30 ⇒ 26，保持"离封顶只差 4 金就别再攒"的原意。
     * 写死 16 的话上限提到 30 之后 AI 仍在 16 金就乱花，等于把这次改上限
     * 的一半意义吃掉。判据跟着 `ECONOMY.cap` 走，不另算一套账。
     */
    const army = affordable.filter((c) => c.kind !== 'building');
    if (view.gold >= ECONOMY.cap - 4 && army.length > 0) {
      let bestArmy = army[0]!;
      for (const c of army) if (rank(c) < rank(bestArmy)) bestArmy = c;
      return hand.indexOf(bestArmy);
    }
    return null;
  }

  let best = affordable[0]!;
  for (const c of affordable) if (rank(c) < rank(best)) best = c;
  return hand.indexOf(best);
}

/** ② 唯一决策入口：刷新 > 出牌 > 攒钱。 */
export function decide(view: AiView): AiAction {
  if (shouldReroll(view)) return { kind: 'reroll' };
  const slot = chooseCard(view);
  return slot === null ? { kind: 'wait' } : { kind: 'play', slot };
}
