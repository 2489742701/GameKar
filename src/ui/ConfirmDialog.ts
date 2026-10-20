/**
 * 确认框 —— 只在"这一格压着晶脉"时出现。
 *
 * 它不改世界状态，只把玩家的选择原样交回 GameApp.resolveConfirm：
 * 取消 = 一格都不动，确定 = 才真的把矿脉毁掉。
 */

import { make, type HudWidget } from './dom';

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmText?: string;
  /** 底部那个"不再提示"复选框的文案；不给就不显示 */
  dontAskText?: string;
}

export class ConfirmDialog implements HudWidget {
  readonly el = make('div', { class: 'overlay overlay--dialog', attrs: { hidden: '' } });
  private readonly title = make('h2');
  private readonly body = make('div', { class: 'confirm__body' });
  private readonly dontAsk = make('input', { class: 'confirm__check-input', attrs: { type: 'checkbox' } });
  private readonly dontAskRow = make('label', { class: 'confirm__check' });
  private readonly panel = make('div', { class: 'confirm panel' });
  private onAnswer: ((agree: boolean, neverAsk: boolean) => void) | null = null;

  constructor() {
    const buttons = make('div', { class: 'confirm__actions' }, [
      make('button', { class: 'btn', text: '取消', onClick: () => this.answer(false) }),
      make('button', { class: 'btn btn--gold', text: '确定', onClick: () => this.answer(true) }),
    ]);

    this.dontAskRow.append(
      this.dontAsk,
      make('span', { class: 'confirm__check-text', text: '不再提示' }),
    );

    this.el.append(this.panel);
    this.panel.append(make('div', { class: 'confirm__head' }, [this.title]), this.body, this.dontAskRow, buttons);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(request: ConfirmRequest, onAnswer: (agree: boolean, neverAsk: boolean) => void): void {
    this.onAnswer = onAnswer;
    this.title.textContent = request.title;
    this.body.textContent = request.body;
    this.dontAsk.checked = false;
    this.dontAskRow.hidden = request.dontAskText === undefined;
    if (request.dontAskText) {
      this.dontAskRow.querySelector('.confirm__check-text')!.textContent = request.dontAskText;
    }
    this.panel.querySelector('.btn--gold')!.textContent = request.confirmText ?? '确定';
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
    this.onAnswer = null;
  }

  /** 玩家做出选择；没给回调（比如弹窗已经关了）就当取消。 */
  private answer(agree: boolean): void {
    const neverAsk = this.dontAsk.checked;
    const callback = this.onAnswer;
    this.hide();
    callback?.(agree, neverAsk);
  }
}
