/**
 * 缺员标记 —— 排不到人手的楼，头顶挂一个"人口头像 + ✕"。
 *
 * 这条读数必须挂在战场上，不能只写在信息卡里：用户的规则是
 * "人口不够照样能盖，但塔不开火、兵营不产兵"。盖下去那一刻看不出问题，
 * 过了一会儿发现塔在发呆 —— 屏幕上没有这枚徽章，玩家只会以为游戏坏了。
 *
 * 头像用 theme.ts 那套现算像素图（`--tex-face`），不引图片文件。
 */

import type { GameWorld } from '@game/world/GameWorld';
import { lift } from './BuildingBars';
import { make, type HudWidget } from './dom';

/** 徽章让开血条一档。 */
const BADGE_LIFT = 26;

export class StaffBadges implements HudWidget {
  readonly el = make('div', { class: 'badges' });
  private readonly nodes = new Map<number, HTMLElement>();

  constructor(private readonly world: GameWorld) {}

  /** 10Hz 刷一次就够：缺员名单只在盖楼/拆楼/结算时变。 */
  refresh(): void {
    const short = this.world.understaffed();
    for (const id of [...this.nodes.keys()]) {
      if (short.has(id) || this.world.buildings.has(id)) continue;
      this.nodes.get(id)!.remove();
      this.nodes.delete(id);
    }
    for (const id of short) {
      if (this.nodes.has(id)) continue;
      const node = make('div', { class: 'badge', attrs: { 'aria-label': '缺员' } }, [
        make('i', { class: 'badge__face' }),
        make('span', { class: 'badge__x', text: '✕' }),
      ]);
      this.nodes.set(id, node);
      this.el.append(node);
    }
  }

  /**
   * 每帧跟着投影走。名单在这里、投影在 GameApp，
   * 所以由本件遍历自己的楼号、找调用方要屏幕位置 —— 反过来把 nodes 交出去会让 Hud 依赖内部结构。
   */
  placeAll(locate: (id: number) => { x: number; y: number; inFront: boolean }): void {
    for (const [id, node] of this.nodes) {
      const p = locate(id);
      node.style.transform = lift(p.x, p.y, BADGE_LIFT);
      node.hidden = !p.inFront || !this.world.buildings.has(id);
    }
  }

  forget(id: number): void {
    this.nodes.get(id)?.remove();
    this.nodes.delete(id);
  }

  get count(): number {
    return this.nodes.size;
  }
}
