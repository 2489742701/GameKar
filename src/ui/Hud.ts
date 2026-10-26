/**
 * HUD 组装处 —— 把五个部件摆进 layout.css 定义的三块网格。
 *
 * UI 不认识 three，也不改世界状态：它读 GameWorld、发意图（onPull/onBuild…），
 * 所以换一套皮肤不需要动引擎一行。
 */

import type { GameApp } from '@game/GameApp';
import { DIFFICULTY, type Difficulty } from '@game/config';
import { hasRally } from '@game/data/buildings';
import type { Building } from '@game/world/GameWorld';
import { ActionDock } from './ActionDock';
import { BuildingBars } from './BuildingBars';
import { BuildingFx } from './BuildingFx';
import { BuildingBubble } from './BuildingBubble';
import { DefeatPanel, restartUrl } from './DefeatPanel';
import { BuildingMenu } from './BuildingMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { GachaPanel } from './GachaPanel';
import { RaidPreview } from './RaidPreview';
import { RallyFlag } from './RallyFlag';
import { ResourceBar } from './ResourceBar';
import { StaffBadges } from './StaffBadges';
import { SelectionCard } from './SelectionCard';
import { ThemePanel } from './ThemePanel';
import { Toasts } from './Toasts';
import { make } from './dom';
import { installTheme } from './theme';
import { giltOf, woodOf } from './themePrefs';

/** DOM 写入没必要跟着 60fps 跑，10Hz 足够跟手又不抢主线程。 */
const REFRESH_MS = 100;

export class Hud {
  private readonly shell = make('div', { class: 'hud' });
  private readonly resbar: ResourceBar;
  private readonly dock: ActionDock;
  private readonly card: SelectionCard;
  private readonly panel: GachaPanel;
  private readonly confirm: ConfirmDialog;
  private readonly bubble: BuildingBubble;
  private readonly flag: RallyFlag;
  private readonly theme: ThemePanel;
  private readonly bars: BuildingBars;
  private readonly bfx: BuildingFx;
  private readonly raid: RaidPreview;
  private readonly defeat: DefeatPanel;
  private readonly menu: BuildingMenu;
  private readonly badges: StaffBadges;
  private readonly toasts = new Toasts();
  private readonly telemetry = make('div', { class: 'telemetry' });

  private handle: number | null = null;
  private sinceLast = 0;
  private previous = 0;

  constructor(
    host: HTMLElement,
    private readonly app: GameApp,
  ) {
    const world = app.world;

    this.resbar = new ResourceBar(world, () => this.toggleTheme());
    this.bars = new BuildingBars(world, app.combat);
    this.bfx = new BuildingFx(world, app.combat);
    this.raid = new RaidPreview(world, app.combat, app.seed);
    this.defeat = new DefeatPanel(() => {
      app.restart();
      location.href = restartUrl(app.seed, location);
    });
    this.card = new SelectionCard(world, (id) => app.demolish(id), app.combat);
    this.dock = new ActionDock(world, {
      onPull: (count) => {
        const purchase = app.pull(count);
        if (purchase) this.panel.show(purchase);
      },
      onBuild: (id) => app.build(id),
      onCancelBuild: () => app.cancelBuild(),
      onFocusHome: () => app.focusHome(),
      onDemolish: () => app.onDemolishSlot(),
      onPickFlag: (id) => {
        if (app.pickFlag(id)) this.dock.closeTray();
        this.syncDockMode();
      },
    });
    this.panel = new GachaPanel(() => this.panel.hide());
    this.confirm = new ConfirmDialog();
    this.bubble = new BuildingBubble(world, (id) => app.runnersOf(id), app.combat);
    // 头顶那面旗**不是第二个入口**：点它和点旗子袋是同一件事（打开旗架）
    this.flag = new RallyFlag(() => this.dock.openFlagRack());
    this.menu = new BuildingMenu({
      onStance: (b, stance) => {
        this.app.combat.setStance(b, stance);
        this.menu.levels.set(b.id, b.level);
      },
      onUpgrade: (b) => {
        this.app.upgrade(b.id);
        this.syncMenu();
      },
      onDemolish: (b) => this.app.demolish(b.id),
    }, app.combat);
    this.badges = new StaffBadges(world);
    // 面板自己不算纹理也不存盘：apply 交回 installTheme，落盘交给 Prefs，
    // 这样"改了没生效"只可能出在一处
    this.theme = new ThemePanel({
      prefs: app.prefs,
      apply: (t) => installTheme(undefined, woodOf(t), giltOf(t), t.scale),
      say: (text, tone) => this.toasts.push(text, tone ?? 'ok'),
      difficulty: {
        options: [{ id: 'easy', label: '简单' }, { id: 'normal', label: '正常' }, { id: 'hard', label: '困难' }],
        state: () => ({ activeId: this.app.combat.difficulty, pendingId: this.app.pendingDiff ?? undefined }),
        onSet: (id) => { this.app.setDifficulty(id as Difficulty); },
      },
    });

    this.shell.append(
      place(this.resbar.el, 'hud__top'),
      make('div', { class: 'hud__mid' }, [place(this.card.el, 'hud__side')]),
      place(this.dock.el, 'hud__dock'),
    );

    host.append(
      this.shell,
      this.toasts.el,
      this.panel.el,
      this.confirm.el,
      this.bubble.el,
      this.flag.el,
      this.badges.el,
      this.menu.el,
      this.theme.el,
      this.bars.el,
      this.bfx.el,
      this.raid.el,
      this.defeat.el,
      this.telemetry,
    );

    world.bus.on('selection:changed', (sel) => {
      this.card.render(sel);
      this.syncFlag();
      this.syncMenu();
      this.syncDockMode();
    });
    world.bus.on('placing:changed', (id) => this.dock.setPlacing(id));
    world.bus.on('flag:changed', () => {
      this.syncFlag();
      // 落旗之后这一趟就完了：手空了就把旗架收起，别留一排"在手里"的旧卡
      if (this.app.flags.state === 'empty') this.dock.closeTray();
    });
    world.bus.on('rally:changed', () => this.syncFlag());
    world.bus.on('toast', ({ text, tone }) => this.toasts.push(text, tone ?? 'ok'));
    world.bus.on('inspect:target', (building) => this.bubble.show(building));
    world.bus.on('building:removed', (b) => {
      this.bubble.forget(b.id);
      this.flag.forget(b.id);
      this.badges.forget(b.id);
      this.menu.forget(b.id);
      this.bars.forget(b.id);
      this.bfx.forget(b.id);
      this.syncFlag();
      this.bars.refresh();
      this.bfx.refresh();
    });
    // 条上的内容一变就该重画，别等 10Hz 那一拍：挨一发打、封顶、放旗子都是离散事件
    world.bus.on('building:hit', () => this.bars.refresh());
    world.bus.on('building:built', () => {
      this.badges.refresh();
      this.bars.refresh();
      this.bfx.refresh();
    });
    // 新楼当场就要抢岗位池（understaffed 只数已封顶的，所以封顶那条也挂着）
    world.bus.on('building:placed', () => {
      this.bars.refresh();
      this.bfx.refresh();
      this.badges.refresh();
    });
    world.bus.on('rally:changed', () => this.bars.refresh());
    world.bus.on('round:changed', () => {
      this.raid.refresh();
      this.bars.refresh();
      this.bfx.refresh();
      // 难度牌上那句"→某档"要在换档那一刻收掉
      this.resbar.refresh();
    });
    world.bus.on('game:over', ({ round }) => {
      this.defeat.show({
        difficultyLabel: DIFFICULTY[app.combat.difficulty].label,
        round,
        buildings: world.buildings.size,
        enemies: app.combat.enemiesAlive(),
        gold: world.resources.gold,
        crystal: world.resources.crystal,
        bread: world.resources.bread,
      });
    });
    // 盖楼、封顶、结算都会改缺员名单；这三处之外名单不会自己变
    world.bus.on('building:built', () => this.badges.refresh());
    world.bus.on('round:settled', () => {
      this.badges.refresh();
      this.syncMenu();
    });
    world.bus.on('confirm:vein', ({ cells, buildingName }) => {
      this.confirm.show(
        {
          title: '要压掉晶脉吗',
          body: `在这里建${buildingName}会毁掉 ${cells.length} 格晶脉，毁掉之后这块地方再也采不出东西。确定吗？`,
          confirmText: '确定建造',
          dontAskText: '不再提示',
        },
        (agree, neverAsk) => this.app.resolveConfirm(agree, neverAsk),
      );
    });

    this.card.render(world.selection);
    this.syncFlag();
    this.syncMenu();
    this.badges.refresh();
    // 先落一次读数：刷新循环靠 rAF，页面在后台时 rAF 根本不触发，
    // 不补这一刀的话资源栏会一直空着（实测过：innerText 只剩"GAMEKAR"）
    this.refresh();
    this.bindKeys();
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    switch (e.key) {
      case '1': {
        const purchase = this.app.pull(1);
        if (purchase) this.panel.show(purchase);
        break;
      }
      case '2': {
        const purchase = this.app.pull(10);
        if (purchase) this.panel.show(purchase);
        break;
      }
      case 'Escape':
        // 谁在最上面就先收谁：确认框 > 材质面板 > 塔顶菜单 > 开包 > 气泡 > 旗子 > 建造模式
        if (this.confirm.open) this.confirm.hide();
        else if (this.defeat.open) this.defeat.hide();
        else if (this.theme.open) this.theme.hide();
        else if (this.menu.targetBuilding) this.menu.show(null);
        else if (this.panel.open) this.panel.hide();
        else if (this.bubble.targetBuilding) this.bubble.show(null);
        else if (this.app.flags.state !== 'empty') this.app.cancelFlag();
        else this.app.cancelBuild();
        break;
      case 'h':
      case 'H':
        this.app.focusHome();
        break;
      case 't':
      case 'T':
        this.toggleTheme();
        break;
    }
  };

  /**
   * 旗子该挂着哪一栋、袋里那格写什么字，全在这一处算完。
   * 三个动作（收旗 / 点袋 / 落旗）都只改世界或袋子的状态，然后广播一下，由这里重读 ——
   * 这样"点了没反应"只可能是这一处判错，不会散成三个地方各判各的。
   */
  /** 菜单只跟着"选中的是不是一座塔"走，等级从战斗内核现读，不留第二份账。 */
  private syncMenu(): void {
    const sel = this.app.world.selection;
    const building = sel?.kind === 'building' ? sel.building : null;
    this.menu.show(building);
    if (building) this.menu.levels.set(building.id, building.level);
  }

  private positionMenu(): void {
    const target = this.menu.targetBuilding;
    if (!target) return;
    const p = this.app.screenOfBuilding(target);
    this.menu.place(p.x, p.y, p.inFront && this.app.world.buildings.has(target.id));
  }

  private positionBadges(): void {
    this.badges.placeAll((id) => {
      const b = this.app.world.buildings.get(id);
      return b ? this.app.screenOfBuilding(b) : { x: -9999, y: -9999, inFront: false };
    });
  }

  private syncFlag(): void {
    const world = this.app.world;
    const state = this.app.flags.state;
    const held = this.app.flags.held;

    let target: Building | null = null;
    if (state === 'placing' && held !== null) {
      // 等落点时跟着手里那面旗走，而不是跟着选中走：中途点了别处也不该换一面
      target = world.buildings.get(held) ?? null;
    } else if (state === 'empty') {
      const sel = world.selection;
      if (sel?.kind === 'building' && hasRally(sel.building.def)) target = sel.building;
    }

    this.flag.show(target);
    this.flag.setArmed(state === 'placing');
    this.dock.setFlagState(state);
  }

  private toggleTheme(): void {
    this.theme.toggle();
  }


  /** 点旗子袋：袋空着也给一句话，别让玩家按了个没反应还不吭声。 */
  private bindKeys(): void {
    window.addEventListener('keydown', this.onKey);
  }

  /** 挂上 DOM 后开始自转的刷新循环；与渲染循环解耦。 */
  start(): void {
    if (this.handle !== null) return;
    this.previous = performance.now();
    const step = (now: number) => {
      this.handle = requestAnimationFrame(step);
      // 气泡要贴着建筑，一帧都不能落后，所以它每帧跟；其余读数 10Hz 刷
      this.positionBubble();
      this.positionFlag();
      this.positionMenu();
      this.positionBadges();
      this.positionBars();
      this.positionRaid();
      this.sinceLast += now - this.previous;
      this.previous = now;
      if (this.sinceLast < REFRESH_MS) return;
      this.sinceLast = 0;
      this.refresh();
    };
    this.handle = requestAnimationFrame(step);
  }

  private positionBubble(): void {
    const target = this.bubble.targetBuilding;
    if (!target) return;
    const p = this.app.screenOfBuilding(target);
    // 楼被拆掉那一帧 heightOf 已经查不到了，投影会跳到原点：直接收起来
    this.bubble.place(p.x, p.y, p.inFront && this.app.world.buildings.has(target.id));
  }

  /** 头顶条钉在楼顶：一栋楼一格位置，血/生产/弹夹三条共用。 */
  private positionBars(): void {
    this.bars.placeAll((id) => {
      const b = this.app.world.buildings.get(id);
      return b ? this.app.screenOfBuilding(b) : { x: -9999, y: -9999, inFront: false };
    });
    this.bfx.placeAll((id) => {
      const b = this.app.world.buildings.get(id);
      return b ? this.app.screenOfBuilding(b) : { x: -9999, y: -9999, inFront: false };
    });
  }

  private positionRaid(): void {
    if (!this.raid.showing) return;
    const cell = this.raid.cell;
    const world = this.app.world;
    const p = this.app.screenOfCell(cell);
    this.raid.place(p.x, p.y, p.inFront && world.map.terrainAt(cell) !== null);
  }

  private positionFlag(): void {
    const target = this.flag.targetBuilding;
    if (!target) return;
    const p = this.app.screenOfRally(target);
    this.flag.place(p.x, p.y, p.inFront && this.app.world.buildings.has(target.id));
  }

  stop(): void {
    if (this.handle !== null) cancelAnimationFrame(this.handle);
    this.handle = null;
    window.removeEventListener('keydown', this.onKey);
  }

  /** 拆除模式那一格的文案：进入/退出、选中了哪栋楼，都在这里对齐 */
  private syncDockMode(): void {
    this.dock.setDemolish(this.app.demolishMode, this.app.demolishTargetName);
    this.dock.setFlagHeld(this.app.flags.held);
  }

  private refresh(): void {
    this.syncDockMode();
    this.resbar.refresh();
    this.dock.refresh();
    this.card.refresh();
    this.badges.refresh();
    this.bars.refresh();
      this.bfx.refresh();
    this.raid.refresh();
    // 气泡里没有按钮，所以可以整块重写；小人数量是 10Hz 才会变的读数
    const target = this.bubble.targetBuilding;
    if (target && this.app.world.buildings.has(target.id)) this.bubble.show(target);
    const t = this.app.telemetry;
    this.telemetry.textContent =
      `${t.fps} fps ｜ ${t.drawCalls} draw ｜ ${(t.triangles / 1000).toFixed(1)}k tri\n` +
      `${t.orientation} ｜ 建筑 ${t.buildings} ｜ 小人 ${t.runners}（风格 ${t.dudeStyles}）` +
      `${t.capped ? ` ｜ 排队未派 ${t.capped}` : ''}${t.dudesReady ? '' : ' ｜ 素材未加载'}`;
  }
}

function place(node: HTMLElement, className: string): HTMLElement {
  node.classList.add(className);
  return node;
}
