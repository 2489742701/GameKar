/**
 * 2026-11-07 设计文档 A/B/D 节的锁：卡牌增减两行、建筑朝向、机位与竖屏。
 */
import { describe, expect, it } from 'vitest';
import { CARDS, SUPPLY, cardById } from '@arena/config';
import { supplyRows, supplyRowsHtml } from '@arena/visuals/supplyRows';
import { buildingSpinKey, spinOf } from '@arena/visuals/spin';
import { VIEW_PRESETS, ArenaDirector } from '@arena/Camera';
import { CameraRig } from '@engine/render/CameraRig';

describe('卡牌增减两行（P-054 A 节）', () => {
  it('民居只有「增」行，磨坊两行都有，箭塔只有「减」行', () => {
    expect(supplyRows(cardById('house')).plus).toContain('data-need="pop"');
    expect(supplyRows(cardById('house')).minus).toBe('');
    expect(supplyRows(cardById('mill')).plus).toContain('data-need="bread"');
    expect(supplyRows(cardById('mill')).minus).toContain('data-need="pop"');
    expect(supplyRows(cardById('arrowTower')).plus).toBe('');
    expect(supplyRows(cardById('arrowTower')).minus).toContain('data-need="pop"');
  });

  it('牧师小队 2 人 = −2 人口 −2 面包（判据从 SUPPLY 读，卡面不自己算账）', () => {
    const rows = supplyRows(cardById('priests'));
    const men = (cardById('priests').squad ?? []).reduce((n, g) => n + g.count, 0);
    expect(men).toBe(2);
    expect(SUPPLY.unitPop).toBe(1);
    expect(SUPPLY.unitBread).toBe(1);
    expect(rows.plus).toBe('');
    expect(rows.minus.match(/data-need="pop"/g)).toHaveLength(1);
    expect(rows.minus.match(/data-need="bread"/g)).toHaveLength(1);
    expect(rows.minus).toContain('ahud__card__need__grp');
  });

  it('HTML：先增行后减行，符号 + / − 分色；n>3 用 ×n 缩写', () => {
    const mill = supplyRowsHtml(cardById('mill'));
    expect(mill.indexOf('data-row="plus"')).toBeLessThan(mill.indexOf('data-row="minus"'));
    expect(mill).toContain('>+<');
    expect(mill).toContain('>−<');
    const big = supplyRowsHtml(cardById('archersBig'));
    expect(big).toContain('×5');
  });

  it('反证：所有卡不会出现增减行堆在同一行的旧结构', () => {
    for (const card of CARDS) {
      const html = supplyRowsHtml(card);
      expect(html.includes('ahud__card__need__plus'), `${card.id} 不该有旧 + 号`).toBe(false);
    }
  });
});

describe('建筑朝向（P-054 B 节）', () => {
  it('同 key 稳定；不同落点/类型能给出不同朝向', () => {
    const a = spinOf(buildingSpinKey(4, 6, 'house'));
    expect(spinOf(buildingSpinKey(4, 6, 'house'))).toBe(a);
    const directions = new Set<number>();
    for (let col = 0; col < 12; col++) {
      const spin = spinOf(buildingSpinKey(col, 6, 'house'));
      // 四正方向 ±0.04 rad 抖动
      const quarter = Math.round(spin / (Math.PI / 2));
      expect(Math.abs(spin - quarter * (Math.PI / 2))).toBeLessThanOrEqual(0.041);
      directions.add(quarter % 4);
    }
    expect(directions.size, '至少出现两种朝向，不然"随机"是假的').toBeGreaterThanOrEqual(2);
  });
});

describe('机位与竖屏（P-054 D 节）', () => {
  /**
   * 2026-11-07 傍晚用户："视野不要搞得那么复杂，点一下就切换的，切换到我方视角也不对"
   * ⇒ 1v1 只剩「斜视 / 正对」两档，「我方」删掉。这条锁跟着改成"两档且没有'我方'"。
   */
  it('默认仍是斜视 / 正对（「我方」按用户口径删掉），后面挂他自选的四档', () => {
    expect(VIEW_PRESETS).toHaveLength(6);
    expect(VIEW_PRESETS.slice(0, 2).map((v) => v.name)).toEqual(['斜视', '正对']);
    expect(VIEW_PRESETS.some((v) => v.name === '我方')).toBe(false);
    for (let i = 1; i <= 4; i++) {
      const shot = VIEW_PRESETS.find((v) => v.name === `自选 ${i}`)!;
      expect(shot.center, `自选 ${i} 必须带绝对中心格`).toBeDefined();
    }
  });

  it('竖屏：导演把缩放拉近、中心往蓝方挪（同一 fitZoom 对比横屏）', () => {
    const rig = new CameraRig({ tilesAcross: 30 });
    rig.resize(1280, 760);
    const wide = new ArenaDirector();
    wide.portrait = false;
    const tall = new ArenaDirector();
    tall.portrait = true;
    const wideRig = new CameraRig({ tilesAcross: 30 });
    wideRig.resize(1280, 760);
    const tallRig = new CameraRig({ tilesAcross: 30 });
    tallRig.resize(390, 844);
    for (let i = 0; i < 120; i++) {
      wide.update(1 / 60, wideRig, 32, { x: 22, z: 10 });
      tall.update(1 / 60, tallRig, 32, { x: 22, z: 10 });
      wideRig.update(1 / 60);
      tallRig.update(1 / 60);
    }
    expect(tallRig.zoom).toBeLessThan(wideRig.zoom);
    // 「我方」机位（index=2）再叠 centerBias -8 与竖屏 -4 ⇒ 中心明显偏蓝方
    wide.index = 2; tall.index = 2;
    for (let i = 0; i < 120; i++) {
      wide.update(1 / 60, wideRig, 32, { x: 22, z: 10 });
      tall.update(1 / 60, tallRig, 32, { x: 22, z: 10 });
      wideRig.update(1 / 60);
      tallRig.update(1 / 60);
    }
    expect(tallRig.position.x).toBeLessThan(wideRig.position.x);
    void rig;
  });
});
