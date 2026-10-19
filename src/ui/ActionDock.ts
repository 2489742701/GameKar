/**
 * 操作坞 —— 抽卡 / 建造 / 回城三个动作，竖屏贴底，横屏也贴底。
 *
 * 建造托盘只列"手上真有许可"的建筑：这个游戏的建筑全部来自抽卡，
 * 所以托盘内容本身就是抽卡结果的收据。
 */

import { buildingDef, buildingList } from '@game/data/buildings';
import { STARTER_POOL } from '@game/data/cards';
import { RESOURCE_META, type ResourceId } from '@game/config';
import type { GameWorld } from '@game/world/GameWorld';
import { make, setFlag, setText, type HudWidget } from './dom';

export interface DockActions {
  onPull(count: number): void;
  onBuild(buildingId: string): void;
  onCancelBuild(): void;
  onFocusHome(): void;
}

const GLYPH = {
  pull1: '✦',
  pull10: '✧',
  build: '⌂',
  home: '◎',
  cancel: '×',
} as const;

export class ActionDock implements HudWidget {
  readonly el = make('div');
  private readonly tray = make('div', { class: 'tray panel' });
  private readonly trayRow = make('div', { class: 'dock panel' });
  private readonly slots = new Map<string, HTMLElement>();
  private permitSignature = '';
  private trayOpen = false;
  private placing: string | null = null;

  constructor(
    private readonly world: GameWorld,
    private readonly actions: DockActions,
  ) {
    this.tray.hidden = true;
    this.el.append(this.tray, this.trayRow);
    this.buildSlots();
  }

  private slot(kind: string, glyph: string, text: string, onClick: () => void): HTMLElement {
    const node = make('button', { class: 'dock__slot', dataset: { kind }, onClick }, [
      make('span', { class: 'dock__slot__glyph', text: glyph }),
      make('span', { class: 'dock__slot__text', text }),
    ]);
    this.slots.set(kind, node);
    this.trayRow.append(node);
    return node;
  }

  private buildSlots(): void {
    const crystalOf = (count: number) =>
      STARTER_POOL.bundle.find((b) => b.count === count)?.cost.crystal ?? 0;

    this.slot('gacha', GLYPH.pull1, `单抽 · ${crystalOf(1)} 晶钻`, () => this.actions.onPull(1));
    this.slot('gacha10', GLYPH.pull10, `十连 · ${crystalOf(10)} 晶钻`, () => this.actions.onPull(10));
    this.slot('build', GLYPH.build, '建造', () => this.toggleTray());
    this.slot('home', GLYPH.home, '回城', () => this.actions.onFocusHome());
  }

  private toggleTray(): void {
    // 已经握着一张卡时，再点"建造"就是放下它，而不是打开托盘
    if (this.placing) {
      this.actions.onCancelBuild();
      return;
    }
    this.trayOpen = !this.trayOpen;
    this.tray.hidden = !this.trayOpen;
    if (this.trayOpen) this.rebuildTray(true);
  }

  /** 许可集合变了才重建托盘，否则每帧重建会把滚动位置抖掉。 */
  private signature(): string {
    return [...this.world.permits.entries()]
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${id}:${n}`)
      .sort()
      .join('|');
  }

  private rebuildTray(force = false): void {
    const sig = this.signature();
    if (!force && sig === this.permitSignature) return;
    this.permitSignature = sig;

    const owned = buildingList()
      .filter((def) => this.world.permitCount(def.id) > 0)
      .sort((a, b) => (a.cost.gold ?? 0) - (b.cost.gold ?? 0));

    this.tray.replaceChildren();
    if (owned.length === 0) {
      this.tray.append(
        make('div', { class: 'label', text: '还没有建造许可 —— 先去抽一次卡' }),
      );
      return;
    }

    for (const def of owned) {
      const costLabel = Object.entries(def.cost)
        .map(([res, amount]) => `${RESOURCE_META[res as ResourceId].label} ${amount}`)
        .join(' ') || '免费';
      this.tray.append(
        make(
          'button',
          {
            class: 'tray__card',
            dataset: { building: def.id },
            onClick: () => this.actions.onBuild(def.id),
          },
          [
            make('div', { class: 'tray__card__name', text: `${def.name} ×${this.world.permitCount(def.id)}` }),
            make('div', { class: 'tray__card__cost', text: costLabel }),
          ],
        ),
      );
    }
  }

  setPlacing(buildingId: string | null): void {
    this.placing = buildingId;
    const buildSlot = this.slots.get('build');
    const caption = buildSlot?.querySelector<HTMLElement>('.dock__slot__text');
    if (buildSlot && caption) {
      setText(caption, buildingId ? `取消 · ${buildingDef(buildingId).name}` : '建造');
      setFlag(buildSlot, 'active', buildingId !== null);
    }
    if (buildingId) {
      this.trayOpen = true;
      this.tray.hidden = false;
    }
  }

  refresh(): void {
    this.rebuildTray();

    const crystal = this.world.resources.crystal;
    const singleCost = STARTER_POOL.bundle[0]?.cost.crystal ?? 0;
    const tenCost = STARTER_POOL.bundle[1]?.cost.crystal ?? 0;
    this.slots.get('gacha')?.toggleAttribute('disabled', crystal < singleCost);
    this.slots.get('gacha10')?.toggleAttribute('disabled', crystal < tenCost);

    for (const card of this.tray.querySelectorAll<HTMLElement>('.tray__card')) {
      const id = card.dataset['building'];
      if (!id) continue;
      const def = buildingDef(id);
      // 托盘只判"资源与人口够不够"；地块合不合法要等指针落到具体格子
      const affordable =
        this.world.canAfford(def.cost) && def.population <= this.world.populationFree();
      setFlag(card, 'ok', affordable);
      setFlag(card, 'active', id === this.placing);
    }
  }
}
