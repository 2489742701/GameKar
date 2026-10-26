/**
 * 操作坞 —— 抽卡 / 建造 / 回城三个动作，竖屏贴底，横屏也贴底。
 *
 * 建造托盘只列"手上真有许可"的建筑：这个游戏的建筑全部来自抽卡，
 * 所以托盘内容本身就是抽卡结果的收据。
 */

import { buildingDef, buildingList, hasRally } from '@game/data/buildings';
import { STARTER_POOL } from '@game/data/cards';
import { RESOURCE_META, type ResourceId } from '@game/config';
import type { PocketState } from '@game/systems/FlagPocket';
import type { GameWorld } from '@game/world/GameWorld';
import { iconEl, resourceIcon } from './icons';
import { make, setFlag, setText, type HudWidget } from './dom';

export interface DockActions {
  onPull(count: number): void;
  onBuild(buildingId: string): void;
  onCancelBuild(): void;
  onFocusHome(): void;
  /** 拆除模式里按下那一格：有选中的楼就拆它，没有就退出拆除模式 */
  onDemolish(): void;
  /** 旗架里点了一张旗子卡片：把这面旗拿到手上 */
  onPickFlag(buildingId: number): void;
}

const GLYPH = {
  pull1: '✦',
  pull3: '✶',
  pull5: '✷',
  pull10: '✧',
  build: '⌂',
  home: '◎',
  cancel: '×',
  flag: '⚑',
} as const;

const SINGLE_COST = STARTER_POOL.bundle[0]?.cost.crystal ?? 60;
/** 报价：优先用卡池整包价（十连打折），凑不出整包退回单抽价 × 次数 —— 与 GachaService.priceFor 同口径。 */
const crystalOf = (count: number): number =>
  STARTER_POOL.bundle.find((b) => b.count === count)?.cost.crystal ?? SINGLE_COST * count;

export class ActionDock implements HudWidget {
  readonly el = make('div');
  private readonly tray = make('div', { class: 'tray panel' });
  private readonly trayRow = make('div', { class: 'dock panel' });
  private readonly slots = new Map<string, HTMLElement>();
  private permitSignature = '';
  private pullCount = 10;
  private trayOpen = false;
  private placing: string | null = null;
  /** 拆除模式：和"放建筑"同构，也是"先按一下进入、再按一下执行" */
  private demolishing = false;
  /** 拆除模式下选中的楼名；null = 还没选 */
  private demolishTarget: string | null = null;
  /** 托盘当前装的是"建造卡"还是"旗子卡" */
  private trayMode: 'build' | 'flag' = 'build';
  /** 手上握着哪面旗（外部喂进来，用来给卡片加"在手里"标记） */
  private flagHeld: number | null = null;

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
    this.slot('gacha', GLYPH.pull10, `十连 · ${crystalOf(10)} 晶钻`, () => this.actions.onPull(this.pullCount));
    this.slot('build', GLYPH.build, '建造', () => this.onBuildSlot());
    this.slot('flag', GLYPH.flag, '旗子袋', () => this.onFlagSlot());
    this.slot('home', GLYPH.home, '回城', () => this.actions.onFocusHome());
  }

  /**
   * 旗子袋三态各写一个字：空 / 握着 / 正在等一次落点。
   * 用户那一串点按里最容易迷路的正是第二、三步，所以文案直接写"下一步点什么"。
   */
  setFlagState(state: PocketState): void {
    const node = this.slots.get('flag');
    const caption = node?.querySelector<HTMLElement>('.dock__slot__text');
    if (!node || !caption) return;
    setText(
      caption,
      state === 'placing' ? '点地面放旗' : state === 'held' ? '旗子在手上' : '旗子袋',
    );
    setFlag(node, 'active', state !== 'empty');
    setFlag(node, 'armed', state === 'placing');
  }

  /**
   * "建造"那一格的三态：
   *   ① 托盘关着 → 打开托盘（选建筑）
   *   ② 托盘开着、没在放建筑 → **切到拆除模式**（托盘收起，格子变成"拆除"）
   *   ③ 拆除模式里 → 有选中的楼就拆它，没有就退出
   * 用户原话："在建造那一栏再点一下，改成拆除，然后选择建筑，选择拆除才行。"
   */
  private onBuildSlot(): void {
    if (this.placing) {
      this.actions.onCancelBuild();
      return;
    }
    // 拆除模式里（或托盘已经开着）再点一次 → 交给 App 判"进模式 / 执行 / 退出"
    if (this.demolishing || this.trayOpen) {
      this.actions.onDemolish();
      return;
    }
    this.toggleTray();
  }

  /** 由外部驱动（GameApp 知道选中了哪栋楼）。 */
  setDemolish(on: boolean, targetName?: string | null): void {
    this.demolishing = on;
    this.demolishTarget = targetName ?? null;
    if (on) {
      this.trayOpen = false;
      this.tray.hidden = true;
    }
    const slot = this.slots.get('build');
    const caption = slot?.querySelector<HTMLElement>('.dock__slot__text');
    if (!slot || !caption) return;
    setText(caption, on ? (this.demolishTarget ? `拆除 · ${this.demolishTarget}` : '拆除') : '建造');
    setFlag(slot, 'active', on);
  }

  /**
   * 旗子袋那一格：**永远只做一件事 —— 打开/收起旗架**。
   *
   * 上一版留了条"手上已经有旗就直接进落旗"的近路：结果取旗有两条路
   * （头顶那面旗、旗架里的卡），状态互相串，玩家看到的就是"界面串在一起、
   * 到底先点哪个"。现在取旗只有一条：**旗子袋 → 旗架 → 点卡 → 点地面**。
   */
  private onFlagSlot(): void {
    this.openFlagRack();
  }

  /** 打开旗架（头顶那面旗点一下也走这里，保证只有一条入口）。 */
  openFlagRack(): void {
    if (this.placing) this.actions.onCancelBuild();
    const open = this.trayOpen && this.trayMode === 'flag';
    if (open) {
      this.closeTray();
      return;
    }
    this.trayMode = 'flag';
    this.trayOpen = true;
    this.tray.hidden = false;
    this.rebuildTray(true);
  }

  /** 外部喂"手上握着哪面旗"（Hud 每次旗子状态变化时给）。 */
  setFlagHeld(buildingId: number | null): void {
    if (this.flagHeld === buildingId) return;
    this.flagHeld = buildingId;
    if (this.trayOpen && this.trayMode === 'flag') this.rebuildTray(true);
  }

  closeTray(): void {
    this.trayOpen = false;
    this.tray.hidden = true;
  }

  private toggleTray(): void {
    // 已经握着一张卡时，再点"建造"就是放下它，而不是打开托盘
    if (this.placing) {
      this.actions.onCancelBuild();
      return;
    }
    this.trayMode = 'build';
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
    if (this.trayMode === 'flag') {
      this.rebuildFlagTray();
      return;
    }
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
      // 造价画成"图标 + 数"：卡片一屏七八张，读汉字比读图形慢一档
      const costBits = Object.entries(def.cost).map(([res, amount]) =>
        make('span', { class: 'tray__card__bit', attrs: { title: RESOURCE_META[res as ResourceId]?.label ?? res } }, [
          iconEl(resourceIcon[res] ?? 'gold'),
          make('span', { class: 'num', text: String(amount ?? 0) }),
        ]),
      );
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
            costBits.length > 0
              ? make('div', { class: 'tray__card__cost' }, costBits)
              : make('div', { class: 'tray__card__cost', text: '免费' }),
          ],
        ),
      );
    }
  }

  /**
   * 旗架：所有"插过旗"的楼一张卡。
   *
   * 卡片样式和建造托盘一样（同一套 `.tray__card`），所以一排看过去就是"集市"的感觉；
   * 差别只在内容 —— 名字是"某楼的旗"，副行是集合点坐标 / 在手里。
   */
  private rebuildFlagTray(): void {
    this.tray.replaceChildren();
    /**
     * 一张卡 = 一面"能用的旗"：**盖好、而且这栋楼本来就有集合旗**（有班的楼）。
     * 不看 `rally !== null` —— 没插过旗的楼也有默认集合点，照样可以从旗架上直接拿。
     */
    const rows = [...this.world.buildings.values()].filter((b) => b.built && hasRally(b.def));
    if (rows.length === 0) {
      this.tray.append(
        make('div', { class: 'label', text: '旗架上还没有旗 —— 先盖一座兵营' }),
      );
      return;
    }
    for (const b of rows) {
      const held = this.flagHeld === b.id;
      const at = this.world.rallyOf(b);
      this.tray.append(
        make(
          'button',
          {
            class: `tray__card${held ? ' tray__card--held' : ''}`,
            dataset: { flag: String(b.id) },
            onClick: () => this.actions.onPickFlag(b.id),
          },
          [
            make('div', { class: 'tray__card__name', text: `${b.def.name}的旗` }),
            make('div', { class: 'tray__card__cost', text: held ? '在手里' : `${at.col},${at.row}` }),
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
      this.trayMode = 'build';
      this.trayOpen = true;
      this.tray.hidden = false;
    }
  }

  refresh(): void {
    this.rebuildTray();

    const crystal = this.world.resources.crystal;
    this.pullCount = ([10, 5, 3, 1] as const).find((n) => crystal >= crystalOf(n)) ?? 0;
    const gacha = this.slots.get('gacha');
    const gachaText = gacha?.querySelector<HTMLElement>('.dock__slot__text');
    if (gacha && gachaText) {
      gacha.toggleAttribute('disabled', this.pullCount === 0);
      if (this.pullCount > 0) setText(gachaText, `${this.pullCount}连 · ${crystalOf(this.pullCount)} 晶钻`);
    }

    for (const card of this.tray.querySelectorAll<HTMLElement>('.tray__card')) {
      const id = card.dataset['building'];
      if (!id) continue;
      const def = buildingDef(id);
      // 托盘只判"资源够不够"：人口不再是闸门（缺员照样能盖，只是不干活），
      // 地块合不合法要等指针落到具体格子
      const affordable = this.world.canAfford(def.cost);
      setFlag(card, 'ok', affordable);
      setFlag(card, 'active', id === this.placing);
    }
  }
}
