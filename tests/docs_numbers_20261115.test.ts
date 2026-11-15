/**
 * 文档数值锁（2026-11-15，P-101）—— README / 玩法说明里的数字必须和代码对得上。
 *
 * 起因：公开仓库前盘了一遍，README 有 **6 处**数字已经过期（金币上限 20→30、
 * 开局 8→15、箭塔射程 6.8→7.8、炮塔 5.6→6.8、卡池 17→27 张、回归条数 497→914），
 * 而它们全是**从 config.ts 抄过去**的。抄的时候是对的，改表的时候没人回头抄。
 *
 * 所以这里不查"文档写得好不好"，只查一件事：**文档里那些从代码抄来的数字还在不在原位**。
 * 判据一律从真实的 config / 数据表读，不写死 —— 否则这条锁自己就是下一处漂移。
 *
 * ⚠️ 改数值时**两条路**：要么同步改 README / 玩法说明，要么把这里对应的断言删掉
 * 并说明理由。不要为了让测试变绿去改文档里的错数 —— 那正好反过来了。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BUILDINGS } from '@game/data/buildings';
import { CARDS as OLD_CARDS } from '@game/data/cards';
import { UNITS } from '@game/data/units';
import { CARDS, ECONOMY, MATCH, NO_BUILD, TOWER, FIELD, ORC_LAIR, HAND } from '@arena/config';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(ROOT + p, 'utf8');
const readme = read('README.md');
const guide = read('docs/玩法说明_20261106.md');

/**
 * 阿拉伯数字 → 中文数字（只覆盖文档里会用到的量级：1~99）。
 *
 * 为什么需要它：README 里写的是「卡池二十八张」这种**中文数**，
 * 而判据要从 `CARDS.length` 现算。早先的写法是 `n === 27 ? '二十七' : n`，
 * 加第 28 张卡时就把 `28` 这个阿拉伯数字塞进了中文句子 —— 测试红在一个
 * 和数值本身无关的地方，很容易被误判成"文档没改"。
 */
function zhNumber(n: number): string {
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return d[n]!;
  if (n < 20) return n === 10 ? '十' : `十${d[n % 10]}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones === 0 ? `${d[tens]}十` : `${d[tens]}十${d[ones]}`;
}

/** 文档里"共 N 条回归"这类自述，实际条数由 vitest 自己保证，这里只锁两处口径一致 */
describe('README：数据条目数与数据表一致', () => {
  it('老模式：建筑 / 卡 / 兵种三行数字', () => {
    const line = readme.split('\n').find((l) => l.includes('buildings.ts（'));
    expect(line, 'README 目录里的 data/ 那一行不见了').toBeTruthy();
    expect(line).toContain(`buildings.ts（${Object.keys(BUILDINGS).length} 种建筑）`);
    expect(line).toContain(`cards.ts（${Object.keys(OLD_CARDS).length} 张卡`);
    expect(line).toContain(`units.ts（${Object.keys(UNITS).length} 个兵种）`);
  });

  it('对战模式：卡池张数与 CARDS 一致', () => {
    // ⚠️ 别写成 `CARDS.length === 27 ? '二十七' : ...` —— 那种写法在加第 28 张卡时
    // 会把阿拉伯数字塞进中文句子，然后测试红在一个和数值无关的地方。
    expect(readme).toContain(`**卡池${zhNumber(CARDS.length)}张**`);
  });

  it('对战模式：卡表里每一张的价钱都和 CARDS 对得上', () => {
    // ⚠️ 不能全文抠表格：`箭塔` 同时出现在**老模式三塔表**（伤害 8）和**对战卡表**（价 12），
    // 全文扫会把两张表串起来。所以先切出卡表那一段，再逐行比对。
    const block = readme.slice(readme.indexOf('**卡池'), readme.indexOf('- **建筑血条**'));
    expect(block.length, '切不出卡表那一段，判据失效了').toBeGreaterThan(200);

    const price = new Map(CARDS.map((c) => [c.name, c.cost]));
    // 卡表是**三列并排**的（`| 民居 | 8 | 民兵集结 | 5 | 移动弩箭 | 10 |`），
    // 所以不能按"行首第一对"抠 —— 一行里有三对。这个正则每对都吃，且不重叠。
    const rows = [...block.matchAll(/\|\s*([^|\d][^|]*?)\s*\|\s*(\d+)\s*(?=\|)/g)];
    const checked: string[] = [];
    for (const [, rawName, rawCost] of rows) {
      const name = rawName!.trim();
      if (!price.has(name)) continue;
      expect(Number(rawCost), `README 卡表「${name}」的价钱与 config.ts 不一致`).toBe(price.get(name));
      checked.push(name);
    }
    // 卡表里 27 张必须**一张不漏**地出现且价钱对得上 —— 少一张就说明表漏了卡
    expect(checked.sort()).toEqual([...price.keys()].sort());
  });
});

describe('README：对战模式的关键数值', () => {
  it('金币：上限 / 开局 / 每几秒跳一格', () => {
    expect(readme).toContain(`**${ECONOMY.cap} 点金**`);
    expect(readme).toContain(`上限 ${ECONOMY.cap}`);
    expect(readme).toContain(`开局 ${ECONOMY.start}`);
    expect(readme).toContain(`**每 ${ECONOMY.tickSeconds} 秒跳 +${ECONOMY.perTick}**`);
  });

  it('塔的射程：两座塔都和一 config 对齐', () => {
    const arrow = TOWER.arrow.range;
    const cannon = TOWER.cannon.range;
    expect(readme, '箭塔射程写错了').toContain(`箭塔射程 ${arrow}`);
    expect(readme, '炮塔射程写错了').toContain(`炮塔 ${cannon}`);
    expect(readme, `跨中线射程那句还留着旧值`).toContain(`箭塔边缘射程 ${arrow}`);
  });

  it('禁建带宽度 / 地图列数', () => {
    const width = NO_BUILD.halfWidth * 2 + 1;
    expect(readme).toContain(`**${width} 列宽**`);
    expect(readme).toContain(`${FIELD.midCol} ± ${NO_BUILD.halfWidth}`);
    expect(readme).toContain(`${FIELD.cols} 列`);
  });

  it('一局的时长', () => {
    // README 写的是「3 分钟一局」，不是「180 秒」—— 别把判据写成自己脑子里那种写法
    expect(readme).toMatch(new RegExp(`\\*\\*${MATCH.seconds / 60} 分钟一局`));
  });

  it('手牌张数', () => {
    const cn = ['零', '一', '二', '三', '四', '五', '六'];
    expect(readme).toContain(`**${cn[HAND.size]}张手牌**`);
  });

  it('兽人巢穴的价钱在卡表里是最新的（它是最后一个加进来、最容易漏的）', () => {
    const line = readme.split('\n').find((l) => l.includes('| 兽人巢穴 |'));
    expect(line, 'README 卡表里没有兽人巢穴这一行').toBeTruthy();
    expect(line).toContain(`| ${ORC_LAIR.cost} |`);
  });

  it('「实机读数」那段里的金币区间也是最新的', () => {
    // 这一句历史上抄错过两次（8→20 一直没跟着 15→30 改）
    expect(readme).toContain(`金币从 ${ECONOMY.start} 涨到 ${ECONOMY.cap} 停住`);
  });
});

describe('README：测试条数的自述不能虚报', () => {
  /** 直接数源码里的 it( —— 和 vitest 报的数一致，比手写数字可靠 */
  const countTests = (file: string): number =>
    [...read(file).matchAll(/^\s*it\(/gm)].length;

  it('arena.test.ts / models.test.ts 的条数与 README 一致', () => {
    const arena = countTests('/tests/arena.test.ts');
    const models = countTests('/tests/models.test.ts');
    expect(arena).toBeGreaterThan(50); // 判据本身没失效
    expect(readme).toContain(`\`tests/arena.test.ts\` ${arena} 条`);
    expect(readme).toContain(`\`tests/models.test.ts\` ${models} 条`);
  });
});

/**
 * 模组契约文档（`大地图模组化架构_20261108.md` §2.3）里的**成员数**必须等于代码。
 *
 * 起因：这张表是 2026-11-15 才补的，之前文档写的是初版草案（`services: {...}`），
 * 而代码早就有 `assets` / `modApi` 两块 —— 照过期文档写模组会直接踩空。
 * 既然补了，就别让它再漂：数字从 modDeps.ts 现算，文档只负责写。
 */
describe('架构文档 §2.3：注入面的成员数与 modDeps 一致', () => {
  const arch = read('/docs/工作笔记/大地图模组化架构_20261108.md');
  const deps = read('/src/arena/modDeps.ts');

  /** 从 `export const <name> = { ... }` 里数键名 */
  const keyCount = (name: string): number => {
    const start = deps.indexOf(`export const ${name}`);
    expect(start, `modDeps.ts 里找不到 ${name}`).toBeGreaterThanOrEqual(0);
    const end = deps.indexOf('\n};', start);
    return [...deps.slice(start, end).matchAll(/^\s+(\w+)\s*[,:]/gm)].length;
  };

  it('three / engine / assets / modApi 四个数字都对得上', () => {
    const table: [string, number][] = [
      ['three', keyCount('modThree')],
      ['engine', keyCount('modEngine')],
      ['assets', keyCount('modAssets')],
      ['modApi', keyCount('modApi')],
    ];
    for (const [kind, count] of table) {
      expect(count, `${kind} 一个成员都没数出来，判据失效了`).toBeGreaterThan(2);
      const row = arch.split('\n').find((l) => l.startsWith(`| \`${kind}\` |`));
      expect(row, `文档 §2.3 的注入面表里没有 ${kind} 这一行`).toBeTruthy();
      expect(row, `文档里 ${kind} 的成员数写错了（实际 ${count}）`).toContain(`| \`${kind}\` | ${count} |`);
    }
  });

  it('文档不再残留初版草案的 services: { ... } 写法', () => {
    // 那版契约早已被平铺成员取代，留着会让人以为 toast 和 makeLoop 是嵌套的。
    // ⚠️ 只查**代码块**：小节开头那段"以前写的是 services: {...}"是历史说明，
    //    它提到旧写法是故意的（讲清这次为什么重写），不该被判为残留。
    const contract = arch.slice(arch.indexOf('### 2.3 契约'), arch.indexOf('### 2.4'));
    expect(contract.length).toBeGreaterThan(500); // 切到了正确的小节
    const codeStart = contract.indexOf('export interface ModHost');
    expect(codeStart, '§2.3 里找不到 ModHost 的契约代码块').toBeGreaterThanOrEqual(0);
    const code = contract.slice(codeStart, contract.indexOf('```', codeStart));
    expect(code.length).toBeGreaterThan(200);
    expect(code).not.toContain('services: {');
    expect(code).toContain('makeLoop(options: GameLoopOptions): GameLoop;');
    expect(code).toContain('readonly assets:');
    expect(code).toContain('readonly modApi:');
    // 两个版本号必须分开讲清楚
    expect(contract).toContain('host.api === 1');
    expect(contract).toContain('host.modApi.version === 2');
  });
});

describe('玩法说明：面向玩家的那份也不能漂', () => {
  it('金币上限 / 开局与 config 一致', () => {
    // 玩法说明写的是「开局 15 金、上限 30」这类口语，抠数字比对
    expect(guide).toMatch(new RegExp(`(开局|初始).{0,6}${ECONOMY.start}`));
  });

  it('常规时间与加时上限与 MATCH 一致', () => {
    const total = MATCH.seconds + MATCH.overtimeSeconds;
    expect(guide).toContain(`${MATCH.seconds / 60} 分钟`);
    expect(guide).toContain(`总 ${total / 60} 分钟`);
  });
});
