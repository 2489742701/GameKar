/**
 * 大地图的卡牌驱动层（2026-11-09，P-087）。
 *
 * 用户：「我们仍然是以卡牌驱动的，就是跟主模式的一个扩展」。
 * 所以四张手牌、补牌冷却、长按拖放、落牌判据全部对齐 /arena.html，
 * 卡面用 host.modApi 的 CARDS + iconOf（同一套素材）。
 * 外交 / 商路 / 集市是**附加规则**，通过卡牌和点建筑触发，不是一列策略按钮。
 *
 * 判据只有一处：本文件的 `play()`。规则层的 `claimCell()` 只做「镜像」，
 * 绝不重复扣钱 —— 大六边形地图的 4 邻域辐射和中心抽象网格是两套视图，
 * 但金币只能从卡牌 cost 扣一次。
 */
import * as M from './map.js';
import * as R from './rules.js';

const MARKET_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 8h18l-1.6 4H4.6L3 8Zm2 5h14v8H5v-8Zm3 2v4h2v-4H8Zm6 0v4h2v-4h-2Z"/><path d="M12 2 3 7h18L12 2Z"/></svg>`;
const CARAVAN_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 15h13V8h4l3 4v3h-2a2.5 2.5 0 0 1-5 0H9a2.5 2.5 0 0 1-5 0H2v-3Z"/><circle cx="6.5" cy="17.5" r="1.6"/><circle cx="17.5" cy="17.5" r="1.6"/></svg>`;
const ESCORT_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1 3 5v6c0 5.2 3.6 9.9 9 12 5.4-2.1 9-6.8 9-12V5l-9-4Zm-1 13-3-3 1.4-1.4L11 11.2l4.6-4.6L17 8l-6 6Z"/></svg>`;

/** 大地图扩展卡：新增的功能性建筑与商队，仍走同一套手牌 */
export const EXTRA_CARDS = [
  { id: 'market', name: '集市', blurb: '点开可发车、处理来车', kind: 'building', cost: 8, building: 'mill', icon: MARKET_ICON },
  { id: 'caravan', name: '商队', blurb: '落在商路上发车，到站结算', kind: 'squad', cost: 3, icon: CARAVAN_ICON },
  { id: 'escort', name: '护航', blurb: '派兵护送，封死路段也照过', kind: 'squad', cost: 4, icon: ESCORT_ICON },
];

const key = (col, row) => `${col},${row}`;
const NEIGHBORS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export function createHand(api, game) {
  const pool = [...api.CARDS, ...EXTRA_CARDS];
  const cards = new Array(api.HAND.size).fill(null);
  const cooldowns = new Array(api.HAND.size).fill(0);
  /** 大六边形地图的占领：格 -> { owner, seed, card, kind } */
  const claims = new Map();
  let selected = -1;
  let seed = 20261109;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  /**
   * 发牌对齐主模式 `ArenaWorld.draw()`：手牌里不重复 + **建筑卡保底**。
   * 保底不是稀有度加权：池里每张仍等概率，只是手里一张建筑都没有时，
   * 这一张只从建筑卡里抽 —— 否则实测起手四张全军队，玩家一座楼都盖不下去。
   */
  const draw = () => {
    const taken = new Set(cards.filter(Boolean).map((c) => c.id));
    let p = pool.filter((c) => !taken.has(c.id));
    if (!p.length) p = pool;
    if (!cards.some((c) => c && c.kind === 'building')) {
      const buildings = p.filter((c) => c.kind === 'building');
      if (buildings.length) p = buildings;
    }
    return p[Math.floor(rnd() * p.length)];
  };

  /** 每方两处起点：主城前哨 + 中心公共区的规则层抢滩点，都按 4 邻域辐射。 */
  function seedClaims() {
    claims.clear();
    for (let i = 0; i < 6; i++) {
      const p = M.POINTS[i];
      const home = {
        col: Math.round(p.col * 0.45 + M.MAP.cx * 0.55),
        row: Math.round(p.row * 0.45 + M.MAP.cy * 0.55),
      };
      const center = M.fromAbstract(R.SEEDS[i][0], R.SEEDS[i][1]);
      claims.set(key(home.col, home.row), { owner: i, seed: true, home: true });
      claims.set(key(center.col, center.row), { owner: i, seed: true, center: true });
    }
  }

  function reset() {
    seedClaims();
    for (let i = 0; i < cards.length; i++) { cards[i] = null; cooldowns[i] = 0; }
    for (let i = 0; i < cards.length; i++) cards[i] = draw();
    selected = -1;
    game.tradeTarget = 2;
    game.tradeKind = 'near';
  }

  /** 可续放的格：己方楼 4 邻域 + 六边形范围内、非道路、无人占 */
  const unlocked = () => {
    const set = new Set();
    for (const [k, v] of claims) {
      if (v.owner !== 0) continue;
      const [col, row] = k.split(',').map(Number);
      for (const [dc, dr] of NEIGHBORS) {
        const nc = col + dc, nr = row + dr;
        if (!M.inHex(nc, nr) || M.isRoad(nc, nr) || claims.has(key(nc, nr))) continue;
        set.add(key(nc, nr));
      }
    }
    return set;
  };

  const isRoad = (col, row) => M.isRoad(col, row);

  function select(slot) {
    selected = selected === slot ? -1 : slot;
    return selected;
  }

  function setTrade(target, kind) {
    game.tradeTarget = target;
    game.tradeKind = kind === 'far' ? 'far' : 'near';
  }

  /** 集市：玩家自己盖出来的 market 格 */
  function markets() {
    const out = [];
    for (const [k, v] of claims) {
      if (v.owner === 0 && v.card === 'market') {
        const [col, row] = k.split(',').map(Number);
        out.push({ col, row, key: k });
      }
    }
    return out;
  }

  /** 落牌：点选放置和长按拖放走同一条判据。 */
  function play(slot, col, row) {
    const card = cards[slot];
    const s = game.state;
    if (!card) return { ok: false, reason: '这张牌已经打出去了' };
    if (s.factions[0].gold < card.cost) return { ok: false, reason: '金币不够' };
    if (!M.inHex(col, row)) return { ok: false, reason: '落在地图外了' };

    const k = key(col, row);
    if (card.id === 'caravan' || card.id === 'escort') {
      // 商队卡必须落在道路上（或自己的集市），空地发车没意义
      const onRoad = M.isRoad(col, row);
      const onMarket = claims.get(k)?.card === 'market' && claims.get(k)?.owner === 0;
      if (!onRoad && !onMarket) return { ok: false, reason: '商队要落在商路或自己的集市上' };
      const target = game.tradeTarget ?? 2;
      const kind = game.tradeKind ?? 'near';
      const res = R.sendCaravan(s, 0, target, kind, card.id === 'escort');
      if (!res.ok) return { ok: false, reason: `发不出车（${res.reason}）` };
      // 规则层已按 SPEC.cost 扣过车费，这里不再扣卡牌 cost
    } else {
      if (isRoad(col, row)) return { ok: false, reason: '道路格不能建造' };
      if (claims.has(k)) return { ok: false, reason: '这格已经有人占了' };
      if (!unlocked().has(k)) return { ok: false, reason: '还没辐射到这格，先往旁边放一栋' };
      s.factions[0].gold -= card.cost;
      claims.set(k, { owner: 0, seed: true, card: card.id, kind: card.kind });
      // 镜像进中心抽象网格：封路 / 积分继续生效，但不重复扣钱、不重复判据
      const a = M.toAbstract(col, row);
      if (a) R.claimCell(s, 0, a.r, a.c);
      else R.note(s, `${card.name} 落在边角陆地 (${col},${row})`);
    }

    cards[slot] = null;
    cooldowns[slot] = api.HAND.refillSeconds;
    selected = -1;
    R.note(s, `打出「${card.name}」· −${card.cost} 金`);
    return { ok: true, card };
  }

  function tick(dt) {
    for (let i = 0; i < cards.length; i++) {
      if (cards[i]) continue;
      cooldowns[i] = Math.max(0, cooldowns[i] - dt);
      if (cooldowns[i] <= 0) cards[i] = draw();
    }
  }

  seedClaims();
  for (let i = 0; i < cards.length; i++) cards[i] = draw();

  return {
    get cards() { return cards; },
    get selected() { return selected; },
    get claims() { return claims; },
    unlocked,
    isRoad,
    select,
    play,
    tick,
    reset,
    setTrade,
    markets,
  };
}
