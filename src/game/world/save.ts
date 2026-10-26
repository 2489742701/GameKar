/**
 * 存档 —— 只存"世界账本"，不存战场上的兵与弹。
 *
 * 口径是用户 2026-10-20 定回合制时给的：回合之间才是结算点，
 * 所以**刷新 = 回到上一次结算**：楼、资源、许可、回合号、塔的等级都还在，
 * 正在打的这一波重新来。面板文案里也这么写，不假装能续战斗。
 *
 * 两条硬规矩：
 * 1. 档里带版本号。版本不符就**放弃旧档**（不猜、不迁移）—— 猜错的存档比没有存档更坏。
 * 2. seed 不符也放弃。存档里的楼是按格子记的，换一张图去盖它们等于凭空造 bug。
 */

import { buildingDef } from '@game/data/buildings';
import type { Combat } from '@game/systems/Combat';
import type { GridPos } from '@engine/math/Grid';
import { pos } from '@engine/math/Grid';
import type { Difficulty, ResourceId } from '@game/config';
import type { GameWorld } from './GameWorld';

/**
 * v2：档里开始记"这一局是哪一档"。
 * v1 的整份丢掉（不猜）：不知道来敌节奏的存档，读回来等于换了一个游戏。
 */
export const SAVE_VERSION = 2;

export interface SavedBuilding {
  /** 建筑表 id */
  d: string;
  c: number;
  r: number;
  /** 建造进度 0..1 */
  p: number;
  built: boolean;
  hp: number;
  /** 集合旗：null = 没挪过 */
  rally: [number, number] | null;
  /** 塔的等级 */
  lv: number;
  placedAt: number;
}

export interface SavedWorld {
  v: number;
  seed: number;
  /** 这一局的难度档：决定接下来几波怎么来 */
  diff: Difficulty;
  time: number;
  res: Record<ResourceId, number>;
  yields: Record<ResourceId, number>;
  permits: [string, number][];
  seen: string[];
  bonusCap: number;
  round: { index: number; phase: 'prep' | 'raid'; left: number; approved: number };
  buildings: SavedBuilding[];
}

export function snapshot(world: GameWorld, combat: Combat): SavedWorld {
  const buildings: SavedBuilding[] = [];
  for (const b of world.buildings.values()) {
    const level = b.level;
    buildings.push({
      d: b.def.id,
      c: b.origin.col,
      r: b.origin.row,
      p: b.progress,
      built: b.built,
      hp: b.hp,
      rally: b.rally ? [b.rally.col, b.rally.row] : null,
      lv: level,
      placedAt: b.placedAt,
    });
  }
  return {
    v: SAVE_VERSION,
    seed: world.seed,
    diff: combat.difficulty,
    time: world.time,
    res: { ...world.resources },
    yields: { ...world.cardYields },
    permits: [...world.permits.entries()],
    seen: [...world.seenCards],
    bonusCap: world.bonusPopulationCap,
    round: world.roundState,
    buildings,
  };
}

/** 解出来的东西只信"形状对不对"，不信它一定合理：不合理就整份丢掉。 */
export function parseSave(raw: string | null): SavedWorld | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const s = data as Partial<SavedWorld>;
  if (s.v !== SAVE_VERSION) return null;
  if (typeof s.seed !== 'number' || !Array.isArray(s.buildings)) return null;
  if (!s.res || !s.round) return null;
  // 档位也按"形状对不对"判：不认识的值就是坏档，不替它猜一个
  if (s.diff !== 'easy' && s.diff !== 'normal' && s.diff !== 'hard') return null;
  if (s.buildings.some((b) => !b || typeof b.d !== 'string' || !buildingDefSafe(b.d))) return null;
  return s as SavedWorld;
}

/** 建筑表里查不到就是坏档 —— 宁可不读，也不要在地上摆一个空盒子。 */
function buildingDefSafe(id: string): boolean {
  try {
    buildingDef(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把档读回世界。调用方负责在这之前**不要**跑 bootstrap（会多盖一座主城）。
 * 返回没盖成的楼数（正常应为 0：地形由同一个 seed 生成，格子一定还在）。
 */
export function applySave(world: GameWorld, combat: Combat, saved: SavedWorld): number {
  // 先回到那一局记录的档位：来敌节奏是那局的一部分，不跟玩家后来改的偏好走
  combat.setDifficulty(saved.diff);
  world.loadLedger({
    resources: saved.res,
    cardYields: saved.yields,
    permits: saved.permits,
    seenCards: saved.seen,
    bonusPopulationCap: saved.bonusCap,
    time: saved.time,
  });

  let skipped = 0;
  for (const b of saved.buildings) {
    const origin: GridPos = pos(b.c, b.r);
    const adopted = world.adopt(b.d, origin, {
      progress: b.p,
      built: b.built,
      hp: b.hp,
      rally: b.rally ? pos(b.rally[0], b.rally[1]) : null,
      placedAt: b.placedAt,
    });
    if (!adopted) {
      skipped++;
      continue;
    }
    if (b.lv > 1) combat.setLevel(adopted.id, b.lv);
  }

  world.loadRound(saved.round);
  return skipped;
}
