/**
 * 吐司提示 —— 失败原因的唯一出口。
 *
 * 世界层不想认识 DOM，所以它只发 'toast' 事件；这里是它唯一的落地点。
 */

import { make } from './dom';

const LIFETIME_MS = 2400;

export class Toasts {
  readonly el = make('div', { class: 'toasts' });

  push(text: string, tone: 'ok' | 'warn' = 'ok'): void {
    const node = make('div', { class: 'toast', dataset: { tone }, text });
    this.el.append(node);
    // 一次别叠超过 4 条，多了把最早的直接摘掉
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    window.setTimeout(() => node.remove(), LIFETIME_MS);
  }
}
