/**
 * HUD 组装处 —— 把五个部件摆进 layout.css 定义的三块网格。
 *
 * UI 不认识 three，也不改世界状态：它读 GameWorld、发意图（onPull/onBuild…），
 * 所以换一套皮肤不需要动引擎一行。
 */

import type { GameApp } from '@game/GameApp';
import { ActionDock } from './ActionDock';
import { GachaPanel } from './GachaPanel';
import { ResourceBar } from './ResourceBar';
import { SelectionCard } from './SelectionCard';
import { Toasts } from './Toasts';
import { make } from './dom';

/** DOM 写入没必要跟着 60fps 跑，10Hz 足够跟手又不抢主线程。 */
const REFRESH_MS = 100;

export class Hud {
  private readonly shell = make('div', { class: 'hud' });
  private readonly resbar: ResourceBar;
  private readonly dock: ActionDock;
  private readonly card: SelectionCard;
  private readonly panel: GachaPanel;
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

    this.resbar = new ResourceBar(world);
    this.card = new SelectionCard(world.map, (id) => app.demolish(id));
    this.dock = new ActionDock(world, {
      onPull: (count) => {
        const purchase = app.pull(count);
        if (purchase) this.panel.show(purchase);
      },
      onBuild: (id) => app.build(id),
      onCancelBuild: () => app.cancelBuild(),
      onFocusHome: () => app.focusHome(),
    });
    this.panel = new GachaPanel(() => this.panel.hide());

    this.shell.append(
      place(this.resbar.el, 'hud__top'),
      make('div', { class: 'hud__mid' }, [place(this.card.el, 'hud__side')]),
      place(this.dock.el, 'hud__dock'),
    );

    host.append(this.shell, this.toasts.el, this.panel.el, this.telemetry);

    world.bus.on('selection:changed', (sel) => this.card.render(sel));
    world.bus.on('placing:changed', (id) => this.dock.setPlacing(id));
    world.bus.on('toast', ({ text, tone }) => this.toasts.push(text, tone ?? 'ok'));

    this.card.render(world.selection);
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
        if (this.panel.open) this.panel.hide();
        else this.app.cancelBuild();
        break;
      case 'h':
      case 'H':
        this.app.focusHome();
        break;
    }
  };

  private bindKeys(): void {
    window.addEventListener('keydown', this.onKey);
  }

  /** 挂上 DOM 后开始自转的刷新循环；与渲染循环解耦。 */
  start(): void {
    if (this.handle !== null) return;
    this.previous = performance.now();
    const step = (now: number) => {
      this.handle = requestAnimationFrame(step);
      this.sinceLast += now - this.previous;
      this.previous = now;
      if (this.sinceLast < REFRESH_MS) return;
      this.sinceLast = 0;
      this.refresh();
    };
    this.handle = requestAnimationFrame(step);
  }

  stop(): void {
    if (this.handle !== null) cancelAnimationFrame(this.handle);
    this.handle = null;
    window.removeEventListener('keydown', this.onKey);
  }

  private refresh(): void {
    this.resbar.refresh();
    this.dock.refresh();
    this.card.refresh();
    const t = this.app.telemetry;
    this.telemetry.textContent =
      `${t.fps} fps ｜ ${t.drawCalls} draw ｜ ${(t.triangles / 1000).toFixed(1)}k tri\n` +
      `${t.orientation} ｜ 建筑 ${t.buildings} ｜ 地图 ${t.tiles} 格`;
  }
}

function place(node: HTMLElement, className: string): HTMLElement {
  node.classList.add(className);
  return node;
}
