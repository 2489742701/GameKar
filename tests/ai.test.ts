/**
 * AI 决策大脑的锁（2026-11-06 架构梳理后新增）。
 *
 * 这层全是**纯函数**：给一份 `AiView` 就能断言「刷新 / 出第几张 / 攒钱」，
 * 不用跑一整局，也不用开浏览器。
 *
 * 反证同样重要：不传 `supply` 时必须回到旧行为（旧调用点与旧单测都还依赖它），
 * 而传了 `supply` 之后，人口满时旧 AI 会选一张根本打不出去的塔 —— 新的必须避开。
 */

import { describe, expect, it } from 'vitest';
import { AI, REROLL, SUPPLY, cardById } from '@arena/config';
import { assess, canPlay, chooseCard, constrainedWish, decide, shouldReroll, type AiView } from '@arena/ai';

const view = (ids: (string | null)[], over: Partial<AiView> = {}): AiView => ({
  hand: ids.map((id) => (id ? cardById(id) : null)),
  gold: 20,
  count: () => 0,
  ...over,
});

const FULL: AiView['supply'] = {
  pop: SUPPLY.basePop,
  popMax: SUPPLY.basePop,
  bread: 0,
  breadMax: SUPPLY.baseBread,
};

describe('canPlay：容器不允许的牌不该被挑中', () => {
  it('人口满：塔/兵营不能落，民居永远能落（它是容器本身）', () => {
    expect(canPlay(cardById('arrowTower'), FULL)).toBe(false);
    expect(canPlay(cardById('barracks'), FULL)).toBe(false);
    expect(canPlay(cardById('house'), FULL)).toBe(true);
  });

  it('面包吃光：军队不能落，建筑照常', () => {
    const noBread = { ...FULL!, bread: FULL!.breadMax, pop: 0 };
    expect(canPlay(cardById('archers'), noBread)).toBe(false);
    expect(canPlay(cardById('house'), noBread)).toBe(true);
  });

  it('反证：不传 supply 时保持旧行为（旧单测仍传最小视图）', () => {
    expect(canPlay(cardById('arrowTower'))).toBe(true);
    expect(canPlay(cardById('archers'))).toBe(true);
  });
});

describe('shouldReroll：只在卡住时花 5 金', () => {
  it('一座民居都没有、手里也没有、钱够 → 刷（reroll 保底给民居）', () => {
    // 手上必须一张建筑卡都没有才刷：有塔就先盖塔，别急着花 5 金换民居
    const v = view(['archers', 'mages', 'knights', 'golem']);
    expect(shouldReroll(v)).toBe(true);
  });

  it('场上已有民居且手上有想要的建筑 → 不刷', () => {
    const v = view(['archers', 'arrowTower', 'mages', 'golem'], {
      count: (k) => (k === 'house' ? 1 : 0),
    });
    expect(shouldReroll(v)).toBe(false);
  });

  it('冷却没到 / 钱不够留底 / 空手牌，三道闸都不刷', () => {
    const base = view(['archers', 'arrowTower', 'mages', 'golem']);
    expect(shouldReroll({ ...base, rerollIn: 3 })).toBe(false);
    expect(shouldReroll({ ...base, gold: REROLL.cost + AI.minReserve - 1 })).toBe(false);
    expect(shouldReroll(view([null, null, null, null]))).toBe(false);
  });

  it('手牌全被人口卡住 → 刷（旧 AI 会一直挑打不出去的牌）', () => {
    const v = view(['arrowTower', 'barracks', 'cannonTower', 'mill'], {
      supply: FULL,
      count: (k) => (k === 'house' ? 1 : 0),
    });
    expect(shouldReroll(v)).toBe(true);
  });
});

describe('decide：三态', () => {
  it('该刷 → reroll', () => {
    expect(decide(view(['archers', 'mages', 'knights', 'golem']))).toEqual({ kind: 'reroll' });
  });

  it('不需要刷 → play 第几格（且这一格真的落得下去）', () => {
    const v = view(['arrowTower', 'archers', 'mages', 'golem'], {
      count: (k) => (k === 'house' ? 1 : 0),
    });
    const act = decide(v);
    expect(act.kind).toBe('play');
    if (act.kind === 'play') expect(v.hand[act.slot]?.id).toBe('arrowTower');
  });

  it('全被容器挡住又没钱 → wait，不是 reroll', () => {
    const v = view(['arrowTower', 'barracks', null, null], {
      supply: FULL,
      count: (k) => (k === 'house' ? 1 : 0),
      gold: 1,
    });
    expect(decide(v)).toEqual({ kind: 'wait' });
  });
});

/**
 * 评估层（2026-11-06 P-042，用户："会自己评估适合建什么、不应该建什么，
 * 或者当前不能建什么"）。三类判据全部算得出来，不靠手感 —— 设计见
 * docs/工作笔记/AI决策架构_20261106.md 第五节。
 */
describe('assess：适合 / 不该建 / 不能建（P-042）', () => {
  it('保留槽顶住建筑：塔 blocked、民居照常 ok、军队 ok', () => {
    const s = { pop: 4, popMax: 6, bread: 0, breadMax: 5 };
    expect(assess(cardById('arrowTower'), view(['arrowTower'], { supply: s }))).toBe('blocked');
    expect(assess(cardById('house'), view(['house'], { supply: s }))).toBe('ok');
    // 兽人 2 人：4+2=6 ≤ 6，军队看的是真人口上限，不吃保留槽
    expect(assess(cardById('orcs'), view(['orcs'], { supply: s }))).toBe('ok');
  });

  it('民居够用了还堆 → unwise（消费者 2 座、民居已有 4 座）', () => {
    const v = view(['house'], { count: (k) => (k === 'arrowTower' ? 2 : k === 'house' ? 4 : 0) });
    expect(assess(cardById('house'), v)).toBe('unwise');
  });

  it('反证：民居名额还留着 1 座余量 → ok（下一栋楼有得配）', () => {
    const v = view(['house'], { count: (k) => (k === 'arrowTower' ? 2 : k === 'house' ? 3 : 0) });
    expect(assess(cardById('house'), v)).toBe('ok');
  });

  it('磨坊够用 → unwise；第二座兵营接不住后勤 → unwise（死楼）', () => {
    const millView = view(['mill'], {
      count: (k) => (k === 'barracks' ? 1 : k === 'mill' ? 2 : 0),
    });
    expect(assess(cardById('mill'), millView)).toBe('unwise');
    const barracksView = view(['barracks'], {
      count: (k) =>
        k === 'barracks' ? 1 : k === 'mill' ? 1 : k === 'house' ? 2 : k === 'arrowTower' ? 1 : 0,
    });
    expect(assess(cardById('barracks'), barracksView)).toBe('unwise');
  });

  it('军队永远 ok（保留槽的主人，出兵永远是把名额花在刀刃上）', () => {
    const v = view(['mech'], { count: () => 4 });
    expect(assess(cardById('mech'), v)).toBe('ok');
  });

  it('constrainedWish：建筑名额被保留槽顶住 → house 顶到最前（唯一解锁）', () => {
    const v = view(['mill', 'house'], {
      supply: { pop: 4, popMax: 6, bread: 0, breadMax: 5 },
    });
    expect(constrainedWish(v)[0]).toBe('house');
  });

  it('chooseCard：落得下去的全是"不该建" → 不出（null）', () => {
    const v = view(['house', 'mill', null, null], {
      gold: 20,
      count: (k) =>
        k === 'arrowTower' ? 2 : k === 'barracks' ? 1 : k === 'house' ? 5 : k === 'mill' ? 2 : 0,
    });
    expect(chooseCard(v)).toBeNull();
  });

  it('shouldReroll：全是不该建的牌也刷（手牌换不掉就永远出不了手）', () => {
    const v = view(['house', 'mill', null, null], {
      gold: REROLL.cost + AI.minReserve,
      count: (k) =>
        k === 'arrowTower' ? 2 : k === 'barracks' ? 1 : k === 'house' ? 5 : k === 'mill' ? 2 : 0,
    });
    expect(shouldReroll(v)).toBe(true);
  });
});
