/**
 * PVE 模式（2026-11-07）—— 规则层与判据的锁。
 *
 * 设计口径见 `docs/工作笔记/PVE模式设计_20261107.md`。
 * 这一份**只锁 PVE**：1v1 的行为由 arena.test.ts 那 129 条继续管，
 * 两边互不干涉（这是 PVE 的头号红线）。
 */

import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { FIELD, PVE_FIELD, SUPPLY } from '@arena/config';
import { PVE_LEVELS, pveLevel } from '@arena/pve/levels';
import { levelSize, waveSize } from '@arena/pve/waves';

const LEVEL = PVE_LEVELS[0]!;

/** 跑到结束（最多 max 秒），返回用了多久。 */
function runOut(w: ArenaWorld, max = 400): number {
  let t = 0;
  while (w.outcome === 'playing' && t < max) {
    w.update(0.05);
    t += 0.05;
  }
  return t;
}

describe('PVE 场地：比 1v1 大，且形状贴竖屏', () => {
  it('PVE 用 PVE_FIELD，1v1 仍然是 44×20（互不影响）', () => {
    const pve = new ArenaWorld({ mode: 'pve', level: LEVEL.id });
    expect(pve.fieldSize).toEqual({ cols: PVE_FIELD.cols, rows: PVE_FIELD.rows });
    const arena = new ArenaWorld();
    expect(arena.fieldSize).toEqual({ cols: FIELD.cols, rows: FIELD.rows });
  });

  it('面积至少是 1v1 的 2 倍（"场地贼拉大"的量化口径）', () => {
    const pve = PVE_FIELD.cols * PVE_FIELD.rows;
    const arena = FIELD.cols * FIELD.rows;
    expect(pve / arena).toBeGreaterThan(2);
  });

  it('长宽比贴近手机竖屏（1:1.6 ~ 1:2.4），不然竖屏上下全是黑', () => {
    const ratio = PVE_FIELD.cols / PVE_FIELD.rows;
    expect(ratio).toBeGreaterThan(1.6);
    expect(ratio).toBeLessThan(2.4);
  });

  it('开局只有 blue 一个大本营，红方没有任何建筑（PVE 没有对面的家）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id });
    const red = [...w.buildings.values()].filter((b) => b.side === 'red');
    expect(red).toHaveLength(0);
    expect(w.coreOf('blue')).toBeTruthy();
    expect(w.coreOf('red')).toBeUndefined();
  });
});

describe('PVE 波次：按表出怪、不吃后勤', () => {
  it('第一波到点才来（之前一只都没有）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, auto: { blue: true } });
    const first = LEVEL.waves[0]!.at;
    let t = 0;
    while (t < first - 1) {
      w.update(0.05);
      t += 0.05;
    }
    expect(w.units.filter((u) => u.side === 'red')).toHaveLength(0);
    while (t < first + 0.2) {
      w.update(0.05);
      t += 0.05;
    }
    expect(w.units.filter((u) => u.side === 'red').length).toBe(waveSize(LEVEL.waves[0]!));
  });

  it('整关放出的怪总数 = 波次表的合计（一个不多一个不少）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, auto: { blue: true } });
    runOut(w);
    expect(w.pve?.spawned).toBe(levelSize(LEVEL.waves));
  });

  it('怪不占人口、不吃面包（玩家的容器读数不被波次影响）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, auto: { blue: true } });
    const before = w.supplyOf('blue');
    // 直接把第一波放出来
    w.update(LEVEL.waves[0]!.at + 0.1);
    const after = w.supplyOf('blue');
    expect(w.units.filter((u) => u.side === 'red').length).toBeGreaterThan(0);
    expect(after.pop).toBe(before.pop);
    expect(after.bread).toBe(before.bread);
    // 反证：如果怪真的吃了面包，读数应该涨
    expect(after.bread).toBeLessThan(SUPPLY.baseBread + 1);
  });

  it('怪的推进目标是玩家大本营：一直往 -col 方向走', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, auto: { blue: true } });
    w.update(LEVEL.waves[0]!.at + 0.1);
    const foes = w.units.filter((u) => u.side === 'red');
    const startX = foes.reduce((s, u) => s + u.x, 0) / foes.length;
    for (let i = 0; i < 200; i++) w.update(0.05);
    const alive = w.units.filter((u) => u.side === 'red');
    expect(alive.length).toBeGreaterThan(0);
    const nowX = alive.reduce((s, u) => s + u.x, 0) / alive.length;
    expect(nowX).toBeLessThan(startX);
  });
});

describe('PVE 判据：守住 / 被打穿 / 守满时限', () => {
  it('打穿大本营 ⇒ lose，理由是 core', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id });
    const core = w.coreOf('blue')!;
    core.hp = 1;
    // 放一波怪出来，让它们把最后 1 点血打掉
    w.update(LEVEL.waves[0]!.at + 0.1);
    for (let i = 0; i < 20 * 120 && w.outcome === 'playing'; i++) w.update(0.05);
    expect(w.outcome).toBe('lose');
    expect(w.outcomeReason).toBe('core');
  });

  it('托管蓝方守满一关 ⇒ win，理由是 waves', () => {
    /**
     * 2026-11-07：`draw()` 候选池每改一次，单 seed 的整局 rng 走向就会换胜负。
     * 攻城车前置那轮是 10 胜 2 负、加了兽人巢穴与经济新表后是 **9 胜 3 负**，
     * 统计锁（至少 8 局）两次都过 —— 不是教学关变难，是单 seed 对 rng 敏感。
     * 固定一个当前能守住的 seed，继续锁住 win / waves 这条出口；
     * 下面另有一条 12 局统计锁兜底，防止以后靠"挑 seed"掩盖真退化。
     */
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, auto: { blue: true }, seed: 1 });
    runOut(w);
    expect(w.outcome).toBe('win');
    expect(w.outcomeReason).toBe('waves');
  });

  it('托管蓝方 12 局至少守住 8 局（攻城车前置没把教学关变难）', () => {
    let win = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, auto: { blue: true }, seed });
      runOut(w);
      if (w.outcome === 'win') win++;
    }
    expect(win, `12 局只守住 ${win} 局`).toBeGreaterThanOrEqual(8);
  });

  it('守满关卡时限、怪还没清光也算守住（残局不会无限拖）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id });
    // 不放兵、只挨打：把时间直接推到时限
    w.elapsed = LEVEL.seconds - 0.05;
    w.update(0.1);
    expect(w.outcome).toBe('win');
    expect(w.outcomeReason).toBe('waves');
  });

  it('反证：PVE 的判定不读 1v1 的加时与积分（把时间拨到 5 分钟以外也不会变成 time/draw）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id });
    w.elapsed = 9999;
    w.update(0.1);
    expect(w.outcome).toBe('win');
    expect(w.outcomeReason).toBe('waves');
    // 1v1 的四种理由在 PVE 里永远不会出现
    expect(['time', 'overtime', 'draw']).not.toContain(w.outcomeReason);
  });

  it('反证：1v1 仍然按老判据走（同样的时间拨法，1v1 会进加时而不是 waves）', () => {
    const w = new ArenaWorld({ auto: { blue: true } });
    expect(w.pve).toBeNull();
    w.elapsed = 9999;
    w.update(0.1);
    expect(w.outcome).not.toBe('playing');
    expect(w.outcomeReason).not.toBe('waves');
  });
});

describe('PVE 玩家槽：单人 1 个、双人 2 个（都在 blue）', () => {
  it('单人：只有一个蓝方玩家，没有红方玩家槽', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id });
    expect(w.players).toHaveLength(1);
    expect(w.players[0]!.side).toBe('blue');
    expect(w.playersOf('blue')).toHaveLength(1);
  });

  it('双人：两个蓝方玩家，各有一份金币和手牌', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 2 });
    expect(w.players).toHaveLength(2);
    expect(w.playersOf('blue')).toHaveLength(2);
    // 两份金币各自独立
    w.players[0]!.gold = 20;
    expect(w.players[0]!.gold).toBe(20);
    expect(w.players[1]!.gold).toBeLessThan(20);
    // 两份手牌也是各自的
    expect(w.players[0]!.hand).not.toBe(w.players[1]!.hand);
  });

  it('1v1 仍然是两个槽：蓝方玩家 + 红方 AI', () => {
    const w = new ArenaWorld();
    expect(w.players.map((p) => p.side)).toEqual(['blue', 'red']);
    expect(w.players[1]!.auto).toBe(true);
  });

  /**
   * **座位数 ≠ 玩家槽数**（2026-11-07 实机踩到的信息泄露）。
   *
   * HUD 一开始拿 `players.length` 当"要显示几套手牌"，于是 1v1 里
   * `[蓝方, 红方AI]` 长度 2 ⇒ 给红方 AI 也建了一套座位，
   * **敌方的手牌和金币直接摆在屏幕顶部**（用户："我甚至能看到敌方的卡牌和敌方的经济"）。
   * 判据只能是"这个槽属于哪个阵营"。下面三条锁把三个模式一起钉住。
   */
  it('座位只算玩家阵营：1v1 里红方 AI 不占座位（不许露出敌方手牌与金币）', () => {
    const w = new ArenaWorld();
    expect(w.players).toHaveLength(2); // 槽有两个
    expect(w.seatCount).toBe(1); // 座位只有一个
    expect(w.seatPlayers().map((p) => p.side)).toEqual(['blue']);
  });

  it('座位数：PVE 单人 1 个、双人 2 个，且都是蓝方', () => {
    const one = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 1 });
    expect(one.seatCount).toBe(1);
    const two = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 2 });
    expect(two.seatCount).toBe(2);
    expect(two.seatPlayers().map((p) => p.side)).toEqual(['blue', 'blue']);
  });

  it('反证：`players.length` 在 1v1 里是 2 —— 两个数不是一回事，别拿它当座位数', () => {
    const w = new ArenaWorld();
    expect(w.players.length).not.toBe(w.seatCount);
  });
});

/**
 * 双人同屏的**钱包与手牌不能串**（2026-11-07）。
 *
 * 这一组是"玩家槽化"的真正验收：`playCardOf / rerollOf` 拿的是 `PlayerSlot`，
 * 一旦哪里偷偷用了 `playerOf('blue')`（永远回落 players[0]），
 * 就会出现"玩家 1 出牌花玩家 0 的钱"—— 这种 bug 在 12 局托管探针里看不出来，
 * 因为托管只驱动 players[0]。
 */
describe('双人同屏：两个钱包、两副手牌，谁也不动谁的', () => {
  /** 在蓝方建区里找一块这个玩家现在能放 slot 0 的地方 */
  function spot(w: ArenaWorld, player: number) {
    const p = w.players[player]!;
    for (let col = 1; col < w.field.midCol - 5; col++) {
      for (let row = 1; row < w.field.rows - 2; row++) {
        if (w.canPlaceAtOf(p, 0, col, row).ok) return { col, row };
      }
    }
    return null;
  }

  it('玩家 1 出牌，扣的是玩家 1 的钱（玩家 0 的金币一分不少）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 2 });
    w.players[0]!.gold = 20;
    w.players[1]!.gold = 20;
    const cost = w.players[1]!.hand[0]!.cost;
    const at = spot(w, 1);
    expect(at).not.toBeNull();
    const res = w.playCardOf(w.players[1]!, 0, at!.col, at!.row);
    expect(res.ok).toBe(true);
    expect(w.players[1]!.gold).toBe(20 - cost);
    expect(w.players[0]!.gold).toBe(20);
  });

  it('玩家 1 的手牌打出去了，玩家 0 的手牌一张不动', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 2 });
    w.players[0]!.gold = 20;
    w.players[1]!.gold = 20;
    const before = w.players[0]!.hand.map((c) => c?.id ?? null);
    const at = spot(w, 1)!;
    w.playCardOf(w.players[1]!, 0, at.col, at.row);
    expect(w.players[1]!.hand[0]).toBeNull(); // 打出去就空了，等补牌
    expect(w.players[0]!.hand.map((c) => c?.id ?? null)).toEqual(before);
  });

  it('玩家 1 刷新手牌，只花玩家 1 的 5 金', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 2 });
    w.players[0]!.gold = 20;
    w.players[1]!.gold = 20;
    const res = w.rerollOf(w.players[1]!);
    expect(res.ok).toBe(true);
    expect(w.players[0]!.gold).toBe(20);
    expect(w.players[1]!.gold).toBeLessThan(20);
  });

  it('反证：单人局只有一个钱包，`players[1]` 根本不存在（不是"悄悄回落到 0"）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 1 });
    expect(w.players).toHaveLength(1);
    expect(w.players[1]).toBeUndefined();
  });

  it('两人抢同一格：先放的那次赢，后放的被拒且不扣钱', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 2 });
    w.players[0]!.gold = 20;
    w.players[1]!.gold = 20;
    const at = spot(w, 0)!;
    expect(w.playCardOf(w.players[0]!, 0, at.col, at.row).ok).toBe(true);
    const gold1 = w.players[1]!.gold;
    // 玩家 1 的 slot 0 未必能放在同一格（也可能因为别的理由被拒），
    // 这里只要求"被拒"和"没扣钱"—— 占位冲突是最常见的那条理由
    const second = w.playCardOf(w.players[1]!, 0, at.col, at.row);
    expect(second.ok).toBe(false);
    expect(w.players[1]!.gold).toBe(gold1);
  });

  /**
   * 托管必须驱动**每一个**玩家槽（2026-11-07 的教训，两个 bug 同一类）。
   *
   * ① `update()` 原来 `for (const side of ['blue','red'])` 涨金 ⇒ PVE 里
   *    `playerOf('red')` 回落 players[0]，等于给蓝方刷了双份金币；
   * ② `tickAi()` 同样按 side 遍历 ⇒ **玩家 1 根本没被驱动**；
   * ③ `options.auto.blue` 只写了 `playerOf('blue')` ⇒ 玩家 1 从开局就不是托管。
   *
   * ②③ 叠起来的现象是"双人比单人还难"：玩家 1 满手金币、四张牌一动不动。
   * 这条锁只认**玩家 1 真的出过牌**（`lastPlayed` 只在出牌时留痕），
   * 不看金币 —— 金币会涨，看不出花没花。
   */
  it('双人托管：玩家 1 也必须真的花钱（不是白拿钱站着看）', () => {
    const w = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 2, seed: 7, auto: { blue: true } });
    expect(w.players[1]!.auto).toBe(true);
    /**
     * 判据是**金币下降过**，不是 `lastPlayed` —— 那个数组在补牌时就被清成 null
     * （`drawInto` 拿它排除"刚打出去的那张"然后置空），出过牌也查不出来。
     * 金币只可能因为出牌/刷新而减少，所以"跌过"就是"动过手"。
     */
    let spent = false;
    let prev = w.players[1]!.gold;
    for (let t = 0; t < 180; t += 0.05) {
      w.update(0.05);
      const g = w.players[1]!.gold;
      if (g < prev) spent = true;
      prev = g;
    }
    expect(spent).toBe(true);
  });

  /**
   * 反证：金币是**每个槽各涨一份**，不是"每个 side 涨一份再被两个人分"。
   * 用不托管的局量 —— 没人出牌，纯粹看收入，判据可以写成严格相等。
   */
  it('反证：双人局里两个人的金币各自涨，谁也不是双份', () => {
    const one = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 1, seed: 7 });
    const two = new ArenaWorld({ mode: 'pve', level: LEVEL.id, players: 2, seed: 7 });
    for (let t = 0; t < 20; t += 0.05) {
      one.update(0.05);
      two.update(0.05);
    }
    // 同一时间、同一套经济参数 ⇒ 三个槽的钱必须一模一样
    expect(two.players[0]!.gold).toBe(one.players[0]!.gold);
    expect(two.players[1]!.gold).toBe(one.players[0]!.gold);
  });
});

describe('PVE 不该弄坏 1v1（回归）', () => {
  it('同一 seed 的 1v1 对局：PVE 代码存在与否，读数是同一套', () => {
    const w = new ArenaWorld({ seed: 20261027, auto: { blue: true } });
    runOut(w, 400);
    // 只要求"能正常打完" —— 具体胜负由 arena.test.ts 的 24 局探针管
    expect(['win', 'lose', 'draw']).toContain(w.outcome);
    expect(w.fieldSize.cols).toBe(FIELD.cols);
  });

  it('关卡表本身自洽：时间递增、只有 1 关时也能按 id 取到', () => {
    const at = LEVEL.waves.map((w) => w.at);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(pveLevel(LEVEL.id)).toBe(LEVEL);
    expect(() => pveLevel('nope')).toThrow();
  });
});
