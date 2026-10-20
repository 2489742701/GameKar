/**
 * 选中信息卡 —— 点一格或点一座楼，这里说明它是什么、能干什么。
 *
 * 内容随选中重建（一次最多十几个节点），比逐字段 diff 更好读，也不会漏更。
 */

import { TERRAIN } from '@game/config';
import type { Building, GameWorld, Selection } from '@game/world/GameWorld';
import type { Combat } from '@game/systems/Combat';
import { buildingFacts, tileMeaning } from './facts';
import { cssColor, make, type HudWidget } from './dom';

export class SelectionCard implements HudWidget {
  readonly el = make('div', { class: 'selcard panel' });
  private chip: HTMLElement | null = null;
  private current: Building | null = null;
  private lastBuilt = false;

  constructor(
    private readonly world: GameWorld,
    private readonly onDemolish: (id: number) => void,
    private readonly runnersOf?: (id: number) => number,
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

  private renderBuilding(b: Building): void {
    this.current = b;
    this.lastBuilt = b.built;

    const status = b.built ? '运转中' : `建造中 ${Math.round(b.progress * 100)}%`;
    this.chip = make('span', {
      class: 'chip',
      text: status,
      attrs: { style: `color:${cssColor(b.built ? 0x5fd07a : 0xd9b25c)}` },
    });

    const facts = buildingFacts(this.world, b, this.runnersOf, this.combat);

    this.el.append(
      make('div', { class: 'selcard__head' }, [make('span', { class: 'selcard__name', text: b.def.name }), this.chip]),
      make('div', { class: 'label', text: b.def.blurb }),
      this.rows([
        ['坐标', `${b.origin.col}, ${b.origin.row}`],
        ...facts.map((f): [string, string] => ['', f]),
      ]),
      make('button', { class: 'btn', text: '拆除', onClick: () => this.onDemolish(b.id) }),
    );
  }
}
