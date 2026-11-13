/**
 * PVE 关卡表（2026-11-07）。
 *
 * 垂直切片先做 **1 关 5 波**（前两波各自散开，末三批 12 秒一压）。
 * 数值不是拍脑袋：每波的总血量 / 总 DPS 按"玩家此刻大概有几金、立了几栋楼"估，
 * 再用 12 个 seed 的托管对局实测守率（见 `docs/工作笔记/PVE模式设计_20261107.md` §5）。
 *
 * 改关卡只改这个文件；`ArenaWorld` 不认识具体关卡，只认识 `PveLevel`。
 */

import { PVE_FIELD, type FieldSpec } from '../config';
import type { Wave } from './waves';

export interface PveLevel {
  id: string;
  name: string;
  /** 菜单/结算上的一句话 */
  blurb: string;
  field: FieldSpec;
  /** 怪的出生列（玩家可建区的右边那一大片） */
  spawnCol: number;
  /** 默认出生行范围（关卡级的 lane，波次可以自己覆盖） */
  lane: [number, number];
  /**
   * 这一关最多打多久（秒）。到点还活着 = **守住**。
   *
   * 为什么必须有：塔防的残局会僵持 —— 一只石怪拆一栋 520 血的塔要 137 秒，
   * 实测最后一波 154 秒就出完，却拖到 **376 秒**还在磨（日志见 PVE 设计文档 §5）。
   * 5 分钟是塔防的常识上限，也让"守多久"本身成为一条明确的胜利条件。
   */
  seconds: number;
  waves: Wave[];
}

/**
 * 第一关「前哨」。
 *
 * 节奏口径（关键，别随手改）：
 * - **第一波 20 秒** —— 开局 8 金，20 秒再攒 10 金 = 18 金，够一栋兵营或一座箭塔
 *   再搭一队小队。少于 12 秒玩家连一栋楼都立不起来，多于 25 秒就没有"来得及吗"的紧张感了；
 * - 前两波间隔 50~60 秒（20 → 70 → 130）—— 金币 2 秒/格，这期间能攒 25~30 金 + 磨坊产出，
 *   够补 2~3 栋楼或一队兵。**不靠加钱解决节奏**（对战模式红线，PVE 也不破）；
 * - 末三批 130 / 142 / 154，**12 秒一压** —— 一次全出会被几座塔叠加秒清，
 *   分批才有"这波怎么还没完"的压迫感；塔防的节奏靠批次，不靠单批数量；
 * - 最后一批放一台移动火炮：它射程 7.2 > 箭塔 6.8，会白嫖玩家的塔 ——
 *   这是逼玩家"别只堆塔、要出兵去拆它"的那一手。
 */
export const PVE_LEVEL_OUTPOST: PveLevel = {
  id: 'outpost',
  name: '前哨',
  blurb: '五波，末三批连续压上。守住大本营。',
  field: PVE_FIELD,
  spawnCol: 46,
  lane: [4, 26],
  seconds: 300,
  waves: [
    {
      at: 20,
      spawns: [
        { unitId: 'militia', count: 3, row: 8 },
        { unitId: 'militia', count: 3, row: 20 },
      ],
    },
    {
      at: 70,
      spawns: [
        { unitId: 'militia', count: 5, row: 6 },
        { unitId: 'spearman', count: 3, row: 16 },
        { unitId: 'militia', count: 5, row: 24 },
        { unitId: 'archer', count: 2, row: 12 },
      ],
    },
    // 第三波**分三批**压上（130 / 142 / 154）：一次全出会被几座塔叠加秒清，
    // 分批才有"这波怎么还没完"的压迫感 —— 塔防的节奏靠批次，不靠单批数量。
    {
      at: 130,
      elite: true,
      spawns: [
        { unitId: 'militia', count: 5, row: 8 },
        { unitId: 'spearman', count: 4, row: 22 },
        { unitId: 'crossbowman', count: 2, row: 15 },
      ],
    },
    {
      at: 142,
      elite: true,
      spawns: [
        { unitId: 'militia', count: 4, row: 8 },
        { unitId: 'spearman', count: 4, row: 22 },
        { unitId: 'shieldbearer', count: 1, row: 10 },
        { unitId: 'crossbowman', count: 2, row: 15 },
      ],
    },
    {
      at: 154,
      elite: true,
      spawns: [
        { unitId: 'spearman', count: 5, row: 22 },
        { unitId: 'crossbowman', count: 2, row: 15 },
        { unitId: 'shieldbearer', count: 1, row: 10 },
        /**
         * P-098（2026-11-13）：精英波次的兽人按 P-095 的对空口径混编 ——
         * 卡池里「兽人 / 兽人大队」是 [orc + orcThrower]，这里之前孤零零 3 个纯近战
         * 是历史遗留（`AA_SOURCES` 那轮只改了卡池，没改波次表）。
         * **总人数仍是 3**（2 近 + 1 远），`levelSize()` 与整关怪总数锁不受影响；
         * 投矛手单独站 row 6，别和 row 4 的两个近战叠成一坨。
         */
        { unitId: 'orc', count: 2, row: 4 },
        { unitId: 'orcThrower', count: 1, row: 6 },
        { unitId: 'mobileCannon', count: 1, row: 26 },
      ],
    },
  ],

};

export const PVE_LEVELS: PveLevel[] = [PVE_LEVEL_OUTPOST];

export function pveLevel(id: string): PveLevel {
  const lv = PVE_LEVELS.find((l) => l.id === id);
  if (!lv) throw new Error(`未知 PVE 关卡 "${id}"`);
  return lv;
}
