/**
 * 卡牌与卡池 —— 这个游戏的唯一获取通道。
 *
 * 建筑、经济、人口三样全部从这里出。所以卡池表就是游戏的设计说明书：
 * 想让哪条路变强，改权重，不改代码。
 */

import type { ResourceId } from '@game/config';

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export const RARITY_LABEL: Record<Rarity, string> = {
  common: '常规',
  rare: '稀有',
  epic: '精英',
  legendary: '传说',
};

export const RARITY_ORDER: readonly Rarity[] = ['common', 'rare', 'epic', 'legendary'];

export type CardKind = 'building' | 'economy' | 'population';

export const KIND_LABEL: Record<CardKind, string> = {
  building: '建筑',
  economy: '经济',
  population: '人口',
};

export type CardEffect =
  /** 盖进建造许可：抽到 = 拿到一张"可以盖一次"的凭证 */
  | { kind: 'permit'; buildingId: string; count: number }
  /** 直接入库 */
  | { kind: 'grant'; resource: ResourceId; amount: number }
  /** 永久提高每秒产出，叠算 */
  | { kind: 'yield'; resource: ResourceId; perSecond: number }
  /** 永久提高人口上限 */
  | { kind: 'populationCap'; amount: number };

export interface CardDef {
  id: string;
  name: string;
  kind: CardKind;
  rarity: Rarity;
  blurb: string;
  effects: CardEffect[];
}

export const CARDS: Record<string, CardDef> = {
  // ---------------------------------------------------------------- 常规
  supplyCrate: {
    id: 'supplyCrate',
    name: '补给箱',
    kind: 'economy',
    rarity: 'common',
    blurb: '一笔现成金币，够立刻盖一座民居。',
    effects: [{ kind: 'grant', resource: 'gold', amount: 90 }],
  },
  crystalSand: {
    id: 'crystalSand',
    name: '零头晶砂',
    kind: 'economy',
    rarity: 'common',
    blurb: '抽卡用的晶钻回了一小口。',
    effects: [{ kind: 'grant', resource: 'crystal', amount: 45 }],
  },
  farmLease: {
    id: 'farmLease',
    name: '田契',
    kind: 'building',
    rarity: 'common',
    blurb: '一张田庄建造许可。经济的地基。',
    effects: [{ kind: 'permit', buildingId: 'farm', count: 1 }],
  },
  shedPermit: {
    id: 'shedPermit',
    name: '工棚许可',
    kind: 'building',
    rarity: 'common',
    blurb: '一张民居建造许可，人口 +3。',
    effects: [{ kind: 'permit', buildingId: 'house', count: 1 }],
  },
  arrowWrit: {
    id: 'arrowWrit',
    name: '箭塔批文',
    kind: 'building',
    rarity: 'common',
    blurb: '箭塔建造许可。一弹夹 4 支，是前期最划算的火力。',
    effects: [{ kind: 'permit', buildingId: 'arrowTower', count: 1 }],
  },
  fieldGrant: {
    id: 'fieldGrant',
    name: '田亩拨给',
    kind: 'building',
    rarity: 'common',
    blurb: '一张田地建造许可。得贴着磨坊才管用。',
    effects: [{ kind: 'permit', buildingId: 'field', count: 1 }],
  },
  scoutPost: {
    id: 'scoutPost',
    name: '哨所批文',
    kind: 'building',
    rarity: 'common',
    blurb: '一张瞭望塔建造许可，不占人口。',
    effects: [{ kind: 'permit', buildingId: 'tower', count: 1 }],
  },

  // ---------------------------------------------------------------- 稀有
  tradePact: {
    id: 'tradePact',
    name: '商会契约',
    kind: 'economy',
    rarity: 'rare',
    blurb: '不用盖楼，每秒金币永久 +0.7。',
    effects: [{ kind: 'yield', resource: 'gold', perSecond: 0.7 }],
  },
  settlersCharter: {
    id: 'settlersCharter',
    name: '移民特许',
    kind: 'population',
    rarity: 'rare',
    blurb: '人口上限 +4。抽到它就能同时多开工两栋。',
    effects: [{ kind: 'populationCap', amount: 4 }],
  },
  mineWarrant: {
    id: 'mineWarrant',
    name: '矿权凭证',
    kind: 'building',
    rarity: 'rare',
    blurb: '一张矿井建造许可，晶钻主力。',
    effects: [{ kind: 'permit', buildingId: 'mine', count: 1 }],
  },
  marketWrit: {
    id: 'marketWrit',
    name: '市集批文',
    kind: 'building',
    rarity: 'rare',
    blurb: '一张市集建造许可，金币产出最高的民用楼。',
    effects: [{ kind: 'permit', buildingId: 'market', count: 1 }],
  },
  millCharter: {
    id: 'millCharter',
    name: '磨坊执照',
    kind: 'building',
    rarity: 'rare',
    blurb: '磨坊建造许可。面包从这里来，房屋从面包来。',
    effects: [{ kind: 'permit', buildingId: 'mill', count: 1 }],
  },
  bowyerWarrant: {
    id: 'bowyerWarrant',
    name: '弓手营批文',
    kind: 'building',
    rarity: 'rare',
    blurb: '一张弓手营建造许可。四个弓箭手，先手射程 3.6 格。',
    effects: [{ kind: 'permit', buildingId: 'archery', count: 1 }],
  },
  laborCorps: {
    id: 'laborCorps',
    name: '工班调令',
    kind: 'population',
    rarity: 'rare',
    blurb: '人口上限 +2，外加一批现成金币。',
    effects: [
      { kind: 'populationCap', amount: 2 },
      { kind: 'grant', resource: 'gold', amount: 80 },
    ],
  },

  // ---------------------------------------------------------------- 精英
  refineryBlueprint: {
    id: 'refineryBlueprint',
    name: '精炼厂图纸',
    kind: 'building',
    rarity: 'epic',
    blurb: '精炼厂建造许可。小人脚程快，能同时包三个矿点，是收益拐点。',
    effects: [{ kind: 'permit', buildingId: 'refinery', count: 1 }],
  },
  recruitDecree: {
    id: 'recruitDecree',
    name: '征兵令',
    kind: 'building',
    rarity: 'epic',
    blurb: '兵营建造许可。三个骑士，营位就是布防点。',
    effects: [{ kind: 'permit', buildingId: 'barracks', count: 1 }],
  },
  cannonFoundry: {
    id: 'cannonFoundry',
    name: '炮坊契约',
    kind: 'building',
    rarity: 'epic',
    blurb: '炮塔建造许可。铁弹落地炸一片，专治成群来的敌人。',
    effects: [{ kind: 'permit', buildingId: 'cannonTower', count: 1 }],
  },
  arcaneLattice: {
    id: 'arcaneLattice',
    name: '秘法晶格',
    kind: 'building',
    rarity: 'epic',
    blurb: '魔法塔建造许可。射速最快、单发最轻，升级也最贵。',
    effects: [{ kind: 'permit', buildingId: 'magicTower', count: 1 }],
  },
  warrenTreaty: {
    id: 'warrenTreaty',
    name: '兽穴盟约',
    kind: 'building',
    rarity: 'epic',
    blurb: '兽穴建造许可。三个兽人会冲撞，把对面的阵型顶散。',
    effects: [{ kind: 'permit', buildingId: 'warren', count: 1 }],
  },
  templeDecree: {
    id: 'templeDecree',
    name: '神龛敕令',
    kind: 'building',
    rarity: 'epic',
    blurb: '神龛建造许可。两个牧师在后排奶，前面才站得住。',
    effects: [{ kind: 'permit', buildingId: 'temple', count: 1 }],
  },
  royalRoad: {
    id: 'royalRoad',
    name: '皇家商路',
    kind: 'economy',
    rarity: 'epic',
    blurb: '每秒金币永久 +2.2，顶两座市集。',
    effects: [{ kind: 'yield', resource: 'gold', perSecond: 2.2 }],
  },
  cityCharter: {
    id: 'cityCharter',
    name: '建城宪章',
    kind: 'population',
    rarity: 'epic',
    blurb: '人口上限 +9。一次抽到，一整局不用再盖民居。',
    effects: [{ kind: 'populationCap', amount: 9 }],
  },

  // ---------------------------------------------------------------- 传说
  vaultCore: {
    id: 'vaultCore',
    name: '金库核心',
    kind: 'economy',
    rarity: 'legendary',
    blurb: '每秒金币永久 +5。经济直接封顶的感觉。',
    effects: [{ kind: 'yield', resource: 'gold', perSecond: 5 }],
  },
  crystalResonance: {
    id: 'crystalResonance',
    name: '晶脉共鸣',
    kind: 'economy',
    rarity: 'legendary',
    blurb: '每秒晶钻永久 +1.2，比议事厅自己产的还多。',
    effects: [{ kind: 'yield', resource: 'crystal', perSecond: 1.2 }],
  },
  goldenHorde: {
    id: 'goldenHorde',
    name: '黄金部众',
    kind: 'population',
    rarity: 'legendary',
    blurb: '人口上限 +20，并当场补给一笔晶钻。',
    effects: [
      { kind: 'populationCap', amount: 20 },
      { kind: 'grant', resource: 'crystal', amount: 240 },
    ],
  },
};

export const cardList = (): CardDef[] => Object.values(CARDS);

export function cardDef(id: string): CardDef {
  const c = CARDS[id];
  if (!c) throw new Error(`未知卡牌 "${id}"`);
  return c;
}

// ------------------------------------------------------------------ 卡池

export interface PoolEntry {
  cardId: string;
  /** 同稀有度内部的相对权重 */
  weight: number;
}

export interface GachaPool {
  id: string;
  name: string;
  blurb: string;
  /** 稀有度概率，必须和为 1；UI 的概率表直接读这里 */
  rates: Record<Rarity, number>;
  /** 连抽次数与其总价，按抽数升序 */
  bundle: { count: number; cost: Partial<Record<ResourceId, number>> }[];
  /** 保底：连续多少抽没出该稀有度及以上，就强制补一发 */
  pity: { rarity: Rarity; within: number };
  entries: PoolEntry[];
}

export const STARTER_POOL: GachaPool = {
  id: 'starter',
  name: '开拓卡池',
  blurb: '什么都出。建筑、经济、人口全靠它。',
  rates: { common: 0.62, rare: 0.27, epic: 0.09, legendary: 0.02 },
  bundle: [
    { count: 1, cost: { crystal: 60 } },
    { count: 10, cost: { crystal: 540 } },
  ],
  pity: { rarity: 'epic', within: 10 },
  entries: [
    { cardId: 'supplyCrate', weight: 26 },
    { cardId: 'crystalSand', weight: 24 },
    { cardId: 'farmLease', weight: 22 },
    { cardId: 'shedPermit', weight: 16 },
    { cardId: 'scoutPost', weight: 12 },
    { cardId: 'fieldGrant', weight: 14 },
    { cardId: 'arrowWrit', weight: 16 },

    { cardId: 'tradePact', weight: 24 },
    { cardId: 'settlersCharter', weight: 24 },
    { cardId: 'mineWarrant', weight: 20 },
    { cardId: 'marketWrit', weight: 18 },
    { cardId: 'bowyerWarrant', weight: 16 },
    { cardId: 'millCharter', weight: 18 },
    { cardId: 'laborCorps', weight: 14 },

    { cardId: 'refineryBlueprint', weight: 30 },
    { cardId: 'recruitDecree', weight: 26 },
    { cardId: 'cannonFoundry', weight: 12 },
    { cardId: 'arcaneLattice', weight: 10 },
    { cardId: 'warrenTreaty', weight: 14 },
    { cardId: 'templeDecree', weight: 12 },
    { cardId: 'royalRoad', weight: 24 },
    { cardId: 'cityCharter', weight: 20 },

    { cardId: 'vaultCore', weight: 34 },
    { cardId: 'crystalResonance', weight: 33 },
    { cardId: 'goldenHorde', weight: 33 },
  ],
};

export const POOLS: Record<string, GachaPool> = { starter: STARTER_POOL };
