/**
 * 选中信息卡 —— 点一格或点一座楼，这里说明它是什么、能干什么。
 *
 * 内容随选中重建（一次最多十几个节点），比逐字段 diff 更好读，也不会漏更。
 */

import { TERRAIN } from '@game/config';
import type { Building, GameWorld, Selection } from '@game/world/GameWorld';
import type { Combat } from '@game/systems/Combat';
import { powerOf } from '@game/systems/Readouts';
import { buildingStats, tileMeaning } from './facts';
import { iconEl } from './icons';
import { cssColor, make, type HudWidget } from './dom';

export class SelectionCard implements HudWidget {
  readonly el = make('div', { class: 'selcard panel' });
  private chip: HTMLElement | null = null;
  private current: Building | null = null;
  private lastBuilt = false;

  constructor(
    private readonly world: GameWorld,
    private readonly onDemolish: (id: number) => void,
    // 小人数量不再进卡（那是过程信息，气泡里还有）；卡上只留成本/产出/人手
    private readonly combat?: Combat,
  ) {}

  private get map() {
    return this.world.map;
  }

  render(selection: Selection): void {
    this.chip = null;
    this.current = null;
    this.el.replaceChildren();
    if (!selection) {
      this.el.append(make('div', { class: 'label', text: '点一格看看地形，点一座楼看它干什么' }));
      return;
    }
    if (selection.kind === 'tile') this.renderTile(selection.pos);
    else this.renderBuilding(selection.building);
  }

  /**
   * 每 100ms 调一次，只改状态那一枚 chip 的文字。
   * 整卡重建会把按钮换掉——手指按下与抬起之间节点被替换，拆除就点不响。
   */
  refresh(): void {
    if (!this.chip || !this.current) return;
    if (this.current.built !== this.lastBuilt) {
      this.render({ kind: 'building', building: this.current });
      return;
    }
    const b = this.current;
    if (!b.built) this.chip.textContent = `建造中 ${Math.round(b.progress * 100)}%`;
  }

  private rows(pairs: [string, string][]): HTMLElement {
    const grid = make('div', { class: 'selcard__grid' });
    for (const [k, v] of pairs) {
      grid.append(make('span', { class: 'selcard__k', text: k }));
      grid.append(make('span', { class: 'selcard__v num', text: v }));
    }
    return grid;
  }

  private renderTile(p: { col: number; row: number }): void {
    const terrain = this.map.terrainAt(p);
    const label = terrain ? TERRAIN[terrain].label : '边界外';
    const meaning = tileMeaning(this.world, p);
    const buildable = meaning === '可建造';

    this.el.append(
      make('div', { class: 'selcard__head' }, [
        make('span', { class: 'selcard__name', text: label }),
        make('span', {
          class: 'chip',
          text: meaning,
          attrs: {
            style: `color:${cssColor(buildable ? 0x5fd07a : meaning === '盖这里要毁掉矿脉' ? 0xd9b25c : 0xff6b6b)}`,
          },
        }),
      ]),
      this.rows([
        ['坐标', `${p.col}, ${p.row}`],
        ['占用', this.map.buildingAt(p) === null ? '无' : `建筑 #${this.map.buildingAt(p)}`],
      ]),
    );
  }

  /**
   * 战力一行：图标 + 数字（剑 = 攻击，盾 = 防御，心 = 血，人 = 要几个手，面包 = 每回合底产）。
   * 数一律来自 `powerOf`，那一处又只从开火与伤害的地方拿数 —— 卡片不会跟实战算出两个数。
   */
  private powerStrip(b: Building): HTMLElement | null {
    // 只留战斗那一列（剑/盾/心）。成本、人口、产出都搬到右栏的标签行了，
    // 再在左边画一排图标，就是同一件事说两遍。
    const fight = new Set(['sword', 'shield', 'heart']);
    const bits = powerOf(b, this.combat).filter((bit) => fight.has(bit.icon));
    // 塔楼、田地这类"既不打人也不用人"的楼，这行干脆不出现，别留一个空框
    if (bits.length === 0) return null;
    const row = make('div', { class: 'selcard__power' });
    for (const bit of bits) {
      row.append(
        make('span', { class: 'powerbit', attrs: { title: bit.title } }, [
          iconEl(bit.icon),
          make('span', { class: 'powerbit__n num', text: bit.value }),
        ]),
      );
    }
    return row;
  }

  private renderBuilding(b: Building): void {
    this.current = b;
    this.lastBuilt = b.built;

    const status = b.built ? '运转中' : `建造中 ${Math.round(b.progress * 100)}%`;
    this.chip = make('span', {
      class: 'chip',
      text: status,
      attrs: { style: `color:${cssColor(b.built ? 0x5fd07a : 0xd9b25c)}` },
    });

    /**
     * 卡面分两栏：**左边"它是谁"，右边"它花多少 / 产多少 / 占几个人"**。
     *
     * 上一版把所有东西堆成一列：坐标、派人采几格脉、跑运输的小人来回几格、
     * 要不要人口……一屏十几行，真正的"成本/产出"埋在中间没人看。
     * 现在左栏只留名字、状态、一句简介；右栏一行一件事，行首带标签。
     * 坐标整行删掉 —— 矿井这类楼玩家不关心它在第几列。
     */
    const strip = this.powerStrip(b);
    const stats = buildingStats(this.world, b, this.combat);

    const main = make('div', { class: 'selcard__main' }, [
      make('div', { class: 'selcard__head' }, [make('span', { class: 'selcard__name', text: b.def.name }), this.chip]),
      make('div', { class: 'label', text: b.def.blurb }),
      ...(strip ? [strip] : []),
      /**
       * 议事厅（unique）不给拆除按钮：拆了就没有"家"了，这一局直接没法玩。
       * 与其点下去弹一句"不能拆"，不如根本不出现 —— 按钮不在，问题就不存在。
       */
      ...(b.def.unique ? [] : [make('button', { class: 'btn', text: '拆除', onClick: () => this.onDemolish(b.id) })]),
    ]);

    const side = make(
      'div',
      { class: 'selcard__stats' },
      stats.map((row) =>
        make('div', { class: 'statrow', dataset: { tone: row.tone ?? 'plain' } }, [
          make('span', { class: 'statrow__k', text: row.label }),
          // 值一律"图标 + 数字"：资源名不写字，用顶栏那套像素图标
          make(
            'span',
            { class: 'statrow__v num' },
            row.items.map((item) =>
              make('span', { class: 'statbit' }, [
                ...(item.icon ? [iconEl(item.icon)] : []),
                make('span', { text: item.text }),
              ]),
            ),
          ),
        ]),
      ),
    );

    this.el.append(make('div', { class: 'selcard__body' }, [main, side]));
  }
}
