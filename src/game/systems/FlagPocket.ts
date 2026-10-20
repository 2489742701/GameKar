/**
 * 旗子袋 —— "手里握着哪面旗、是不是在等一个落点"这一小块状态。
 *
 * 单独成一个文件、并且不 import three 也不 import DOM：
 * 这三步手势（收旗 → 点袋 → 点地面）最容易出"点第二下没反应"那类状态漏缝，
 * 而状态漏缝在浏览器里只能靠肉眼看，在这里可以直接在 node 里跑完。
 *
 * 规则是用户 2026-10-20 定下的原话：**一次手里只握一面**。
 * 收第二面的时候第一面自动回位（回位 = 集合点本来就是它原来指的那格，不用改账）。
 */

export type PocketState = 'empty' | 'held' | 'placing';

export class FlagPocket {
  private buildingId: number | null = null;
  private placing = false;

  get state(): PocketState {
    if (this.buildingId === null) return 'empty';
    return this.placing ? 'placing' : 'held';
  }

  /** 手里那面旗属于哪栋楼；空袋返回 null。 */
  get held(): number | null {
    return this.buildingId;
  }

  /** 收旗。手里原来那面直接松开（它指的格子不会因此改变）。 */
  take(buildingId: number): void {
    this.buildingId = buildingId;
    this.placing = false;
  }

  /** 点旗子袋 = 准备落旗。袋是空的就不给进，返回 false。 */
  arm(): boolean {
    if (this.buildingId === null) return false;
    this.placing = true;
    return true;
  }

  /** Esc：退出"等落点"，旗子还在手里。 */
  disarm(): void {
    this.placing = false;
  }

  /** 落点成功之后清空手 —— 旗子已经插回它自己的楼/格子上。 */
  release(): void {
    this.buildingId = null;
    this.placing = false;
  }

  /** 楼没了（被拆、被打掉）：手里那面旗跟着消失，不能留一个指向空楼的落点。 */
  forget(buildingId: number): void {
    if (this.buildingId === buildingId) this.release();
  }
}
