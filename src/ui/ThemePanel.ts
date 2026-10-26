/**
 * 材质面板 —— 让玩家自己调木头与镀金，改动**自动存**，并给一个可分享的独有 ID。
 *
 * 三条设计取舍写在这里，免得下一个人以为是偷懒：
 * 1. **没有"保存"按钮**。滑杆一停就写进本地偏好（存的就是那个 ID，不另存参数），
 *    下次启动直接读回来。用户要的是"改默认保存"。
 * 2. **拖动过程中不重算纹理**。默认木纹重算一次实测 161ms，跟着手指跑必然掉帧；
 *    所以最后一次改动之后防抖 220ms 再算，面板底部把这次算了多少毫秒如实显示出来。
 *    这里故意不做"先用 CSS 滤镜凑一下"的预览：滤镜下的旧纹理和真纹理不是一套东西，
 *    松手会跳一下，玩家反而以为坏了。
 * 3. **贴回来的码不合法就当没听见**：不改当前长相、不崩，只在面板上留一句提示。
 */

import type { Prefs } from '@game/prefs';
import {
  DEFAULT_TUNING,
  PRESETS,
  decodeTuning,
  encodeTuning,
  saveTuning,
  snapTuning,
  type Tuning,
} from './themePrefs';
import { make, setFlag, setText, type HudWidget } from './dom';

interface Row {
  key: keyof Tuning;
  label: string;
  min: number;
  max: number;
  step: number;
  /** 显示格式：'int' 直接整数，'pct' 两位小数 */
  fmt: 'int' | 'pct';
}

const ROWS: Row[] = [
  { key: 'brightness', label: '木头明度', min: 0.2, max: 0.7, step: 0.02, fmt: 'pct' },
  { key: 'steps', label: '色阶档数', min: 3, max: 8, step: 1, fmt: 'int' },
  { key: 'grainY', label: '纹路密度', min: 6, max: 20, step: 1, fmt: 'int' },
  { key: 'plankRows', label: '每块板宽', min: 4, max: 24, step: 2, fmt: 'int' },
  { key: 'seam', label: '板缝深浅', min: 0, max: 0.3, step: 0.05, fmt: 'pct' },
  { key: 'scale', label: '像素块放大', min: 1, max: 5, step: 1, fmt: 'int' },
  { key: 'seedVariant', label: '木纹变体', min: 0, max: 7, step: 1, fmt: 'int' },
  { key: 'gilt', label: '镀金强度', min: 0, max: 200, step: 40, fmt: 'int' },
];

const DEBOUNCE_MS = 220;

export interface ThemePanelHooks {
  prefs: Prefs;
  /** 重算纹理并挂上 CSS 变量；返回耗时读数（毫秒） */
  apply(tuning: Tuning): { woodMs: number; giltMs: number };
  say(text: string, tone?: 'ok' | 'warn'): void;
  /** 难度档：options 静态、state() 动态拿当前与已选待生效、onSet 选档 */
  difficulty?: {
    options: { id: string; label: string }[];
    state(): { activeId: string; pendingId?: string };
    onSet(id: string): void;
  };
}

export class ThemePanel implements HudWidget {
  readonly el = make('div', { class: 'theme panel', attrs: { hidden: '' } });
  private readonly idValue = make('code', { class: 'theme__id num' });
  private readonly timing = make('span', { class: 'theme__timing num' });
  private readonly pasteBox = make('input', { class: 'theme__paste', attrs: { type: 'text', placeholder: '贴上别人的码', spellcheck: 'false' } });
  private readonly inputs = new Map<keyof Tuning, HTMLInputElement>();
  private readonly labels = new Map<keyof Tuning, HTMLElement>();
  private tuning: Tuning;
  private timer: number | null = null;

  constructor(private readonly hooks: ThemePanelHooks) {
    this.tuning = snapTuning(hooks.prefs.themeId ? (decodeTuning(hooks.prefs.themeId) ?? DEFAULT_TUNING) : DEFAULT_TUNING);

    const head = make('div', { class: 'theme__head' }, [
      make('span', { class: 'theme__title', text: '设置' }),
      make('button', {
        class: 'theme__close',
        text: '×',
        attrs: { 'aria-label': '关闭' },
        onClick: () => this.hide(),
      }),
    ]);

    const diffRow = this.buildDifficultyRow();

    const presetRow = make('div', { class: 'theme__row theme__row--presets' });
    for (const preset of PRESETS) {
      presetRow.append(
        make('button', {
          class: 'theme__chip',
          text: preset.name,
          onClick: () => this.commit(preset.tuning, true),
        }),
      );
    }
    presetRow.append(
      make('button', {
        class: 'theme__chip theme__chip--ghost',
        text: '恢复默认',
        onClick: () => this.commit({ ...DEFAULT_TUNING }, true),
      }),
    );

    const rows = make('div', { class: 'theme__rows' });
    for (const row of ROWS) {
      const value = make('span', { class: 'theme__num num', text: this.show(row, this.tuning[row.key]) });
      const input = make('input', {
        class: 'theme__range',
        attrs: { type: 'range', min: String(row.min), max: String(row.max), step: String(row.step) },
      }) as HTMLInputElement;
      input.value = String(this.tuning[row.key]);
      input.addEventListener('input', () => {
        const next = { ...this.tuning, [row.key]: Number(input.value) } as Tuning;
        this.tuning = next;
        setText(value, this.show(row, snapTuning(next)[row.key]));
        // 像素块放大只是 CSS 变量，不用重算纹理，立刻给反馈
        if (row.key === 'scale') document.documentElement.style.setProperty('--tex-wood-tile', `${48 * next.scale}px`);
        this.schedule();
      });
      this.inputs.set(row.key, input);
      this.labels.set(row.key, value);
      rows.append(make('label', { class: 'theme__row' }, [make('span', { class: 'theme__label', text: row.label }), input, value]));
    }

    const idRow = make('div', { class: 'theme__row theme__row--id' }, [
      make('span', { class: 'theme__label', text: '独有 ID' }),
      this.idValue,
      make('button', {
        class: 'theme__chip',
        text: '复制',
        onClick: () => void this.copy(),
      }),
    ]);

    const pasteRow = make('div', { class: 'theme__row theme__row--paste' }, [
      this.pasteBox,
      make('button', {
        class: 'theme__chip',
        text: '应用',
        onClick: () => this.paste(),
      }),
    ]);

    this.el.append(
      head,
      ...(diffRow ? [diffRow] : []),
      make('p', { class: 'theme__hint', text: '改动自动保存在这台机器上；把 ID 发给别人，他能贴出同一块木头。' }),
      presetRow,
      rows,
      idRow,
      pasteRow,
      make('div', { class: 'theme__foot' }, [this.timing]),
    );
    this.renderId();
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  toggle(): void {
    if (this.open) this.hide();
    else {
      this.el.hidden = false;
      this.hooks.say('设置：调完点右上角 × 收起来');
    }
  }

  private readonly diffButtons = new Map<string, HTMLElement>();

  private buildDifficultyRow(): HTMLElement | null {
    const d = this.hooks.difficulty;
    if (!d) return null;
    const row = make('div', { class: 'theme__row theme__row--difficulty' });
    row.append(make('span', { class: 'theme__label', text: '难度' }));
    for (const opt of d.options) {
      const btn = make('button', {
        class: 'theme__chip',
        text: opt.label,
        onClick: () => {
          d.onSet(opt.id);
          this.refreshDifficulty();
        },
      });
      this.diffButtons.set(opt.id, btn);
      row.append(btn);
    }
    this.refreshDifficulty();
    return row;
  }

  private refreshDifficulty(): void {
    const d = this.hooks.difficulty;
    if (!d) return;
    const { activeId, pendingId } = d.state();
    for (const [id, btn] of this.diffButtons) {
      setFlag(btn, 'active', id === activeId);
      setFlag(btn, 'armed', !!pendingId && pendingId !== activeId && id === pendingId);
    }
  }

  hide(): void {
    this.el.hidden = true;
    this.flush();
  }

  /** 当前生效的码，给启动流程与读数用。 */
  get id(): string {
    return encodeTuning(this.tuning);
  }

  private show(row: Row, v: number): string {
    return row.fmt === 'int' ? String(Math.round(v)) : v.toFixed(2);
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, DEBOUNCE_MS);
  }

  /** 落盘 + 重算纹理 + 更新 ID 与耗时。防抖到期、切预设、关闭面板都走这一处。 */
  private flush(): void {
    const t = snapTuning(this.tuning);
    this.tuning = t;
    const id = saveTuning(this.hooks.prefs, t);
    const ms = this.hooks.apply(t);
    setText(this.timing, `纹理重算 ${(ms.woodMs + ms.giltMs).toFixed(0)}ms（木 ${ms.woodMs.toFixed(0)} + 金 ${ms.giltMs.toFixed(0)}）`);
    setText(this.idValue, id);
    for (const row of ROWS) {
      const input = this.inputs.get(row.key);
      if (input) input.value = String(t[row.key]);
      const label = this.labels.get(row.key);
      if (label) setText(label, this.show(row, t[row.key]));
    }
  }

  private commit(next: Tuning, applyNow: boolean): void {
    this.tuning = snapTuning(next);
    if (applyNow) {
      if (this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
      this.flush();
    }
  }

  private paste(): void {
    const raw = this.pasteBox.value.trim();
    const decoded = decodeTuning(raw);
    if (!decoded) {
      this.hooks.say('这个码读不出来，界面保持原样', 'warn');
      return;
    }
    this.pasteBox.value = '';
    this.commit(decoded, true);
    this.hooks.say(`已贴上 ${encodeTuning(decoded)} 这套材质`);
  }

  private async copy(): Promise<void> {
    const id = this.id;
    try {
      await navigator.clipboard.writeText(id);
      this.hooks.say(`已复制 ${id}`);
    } catch {
      // 非安全上下文或浏览器不给权限：至少让玩家能手动选中
      this.hooks.say(`复制不成功，手动选中这个码：${id}`, 'warn');
    }
  }

  private renderId(): void {
    setText(this.idValue, this.id);
    setText(this.timing, '还没重算过纹理');
  }
}
