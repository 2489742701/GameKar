/**
 * 调试面板（F2 开关）—— 给用户"现场调机位 + 记账"用。
 *
 * 2026-11-07 傍晚扩成真正的**相机调试模式**（用户："额外准备一个 debug 模式，
 * 拥有大量数据可以调。我把几个我自己要的相机调到对应的位置，然后把 ID 值发给我"）：
 *   ① 五个滑杆直接改镜头（朝向 / 俯角 / 缩放 / 中心 col / 中心 row），读数实时跟着变；
 *   ② 「存这一档」把当前机位收进槽位列表（最多 8 档），每档一行
 *      `slotN cam-xxxxx yaw … pitch … zoom … center …`，一键复制整份发回来；
 *   ③ 一份"可删项"清单，点一下把 `del-fN` 记进账本（老功能，保留）。
 *
 * 面板是**临时件**：用户说过"后面要删的就是我记下来的"。删它只要去掉
 * `main.ts` 里的 `new DebugPanel` 与 F2 接线。
 */

import type { ArenaApp } from './ArenaApp';
import { DEFAULT_SHOT, encodeCamera, snapShot, type CameraShot } from './cameraId';

const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  textOrChildren?: string | (Node | string)[],
) => {
  const el = document.createElement(tag);
  el.className = className;
  if (typeof textOrChildren === 'string') el.textContent = textOrChildren;
  else if (Array.isArray(textOrChildren)) el.append(...textOrChildren);
  return el;
};

/** 可删项清单：ID 固定，用户报 `del-f3` 就是删移动火炮。 */
export const FEATURES: { id: string; label: string }[] = [
  { id: 'f1', label: '楼头顶血条' },
  { id: 'f2', label: '屋顶阵营旗' },
  { id: 'f3', label: '移动火炮' },
  { id: 'f4', label: '废墟' },
  { id: 'f5', label: '塔互相攻击' },
  { id: 'f6', label: '炮塔四角色块' },
  { id: 'f7', label: '中场禁建黄区' },
  { id: 'f8', label: '视角按钮' },
];

/** 用户自己调好的一档机位（相机三项 + 镜头中心落在哪一格）。 */
interface ShotSlot {
  shot: CameraShot;
  col: number;
  row: number;
}

const MAX_SLOTS = 8;

export class DebugPanel {
  readonly el = make('div', 'dbg panel');
  private readonly yawInput: HTMLInputElement;
  private readonly pitchInput: HTMLInputElement;
  private readonly zoomInput: HTMLInputElement;
  private readonly colInput: HTMLInputElement;
  private readonly rowInput: HTMLInputElement;
  private readonly idText = make('code', 'dbg__id');
  private readonly log = make('textarea', 'dbg__log');
  private readonly slotsBox = make('div', 'dbg__slots');
  private readonly slots: ShotSlot[] = [];
  private open = false;
  private readonly labelOf = new Map<HTMLInputElement, HTMLElement>();

  constructor(private readonly app: ArenaApp) {
    const head = make('div', 'dbg__head');
    head.append(
      make('span', 'dbg__title', '相机调试 · F2'),
      (() => {
        const close = make('button', 'dbg__btn dbg__btn--ghost', '关');
        close.addEventListener('click', () => this.hide());
        return close;
      })(),
    );

    const fs = this.app.world.fieldSize;
    this.yawInput = this.slider('朝向 yaw', 0, 359, 1, DEFAULT_SHOT.yaw);
    this.pitchInput = this.slider('俯角 pitch', 6, 88, 1, DEFAULT_SHOT.pitch);
    this.zoomInput = this.slider('缩放 zoom', 0.5, 1.4, 0.01, DEFAULT_SHOT.zoom);
    this.colInput = this.slider('中心 col', 0, fs.cols, 0.25, fs.cols / 2);
    this.rowInput = this.slider('中心 row', 0, fs.rows, 0.25, fs.rows / 2);

    const record = make('button', 'dbg__btn', '存这一档');
    record.addEventListener('click', () => this.recordSlot());

    const featureBox = make('div', 'dbg__features');
    for (const f of FEATURES) {
      const row = make('div', 'dbg__feature');
      const mark = make('button', 'dbg__btn dbg__btn--ghost', '记下要删');
      mark.addEventListener('click', () => this.push(`del-${f.id}  （${f.label}）`));
      row.append(make('span', 'dbg__feature__id', f.id), make('span', 'dbg__feature__label', f.label), mark);
      featureBox.append(row);
    }

    const copySlots = make('button', 'dbg__btn', '复制全部机位');
    copySlots.addEventListener('click', () => this.copySlots());
    const clearSlots = make('button', 'dbg__btn dbg__btn--ghost', '清空机位');
    clearSlots.addEventListener('click', () => {
      this.slots.length = 0;
      this.paintSlots();
    });

    const foot = make('div', 'dbg__foot');
    const copy = make('button', 'dbg__btn', '复制账本');
    copy.addEventListener('click', () => this.copy());
    const clear = make('button', 'dbg__btn dbg__btn--ghost', '清空账本');
    clear.addEventListener('click', () => {
      this.log.value = '';
    });
    foot.append(copy, clear);

    this.log.readOnly = true;
    this.log.placeholder = '记下的东西会出现在这里，复制后发给我即可';

    const foldBox = make('details', 'dbg__fold');
    foldBox.append(
      make('summary', 'dbg__fold__sum', '要删的东西 / 账本（点开）'),
      featureBox,
      this.log,
      foot,
    );

    this.el.append(
      head,
      make(
        'p',
        'dbg__hint',
        '拖滑杆调机位（WSAD/QE、拖画面、滚轮也行）。满意点「存这一档」，调好几档后「复制全部机位」发我。',
      ),
      this.yawInput.parentElement!,
      this.pitchInput.parentElement!,
      this.zoomInput.parentElement!,
      this.colInput.parentElement!,
      this.rowInput.parentElement!,
      make('div', 'dbg__row', [this.idText, record]),
      make('div', 'dbg__label', '我调的机位（发我这个）'),
      this.slotsBox,
      make('div', 'dbg__row', [copySlots, clearSlots]),
      /**
       * 可删项 + 账本收进折叠区（2026-11-07 晚）。
       * 五根滑杆 + 槽位 + 8 条可删项 + 账本一屏放不下，手机上"存这一档"会被顶到屏幕外 ——
       * 而这一轮真正要用的是上面那半截（调机位）。折叠默认收起，需要时再点开。
       */
      foldBox,
    );
    this.el.hidden = true;
    this.paintSlots();
    /**
     * ⚠️ 构造末尾**不要**调 `userTouched()` / `apply()`：上一版在构造里无条件套了
     * `DEFAULT_SHOT`，一进游戏就把相机从 `ARENA_CAMERA` 拽到滑杆默认值、顺手 `locked`，
     * 导演从此接管不了。面板是隐藏的调试件，凭什么改玩家的镜头？
     */
  }

  private slider(label: string, min: number, max: number, step: number, value: number): HTMLInputElement {
    const input = make('input', 'dbg__range');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const readout = make('span', 'dbg__v num');
    input.addEventListener('input', () => {
      this.app.director.userTouched();
      this.apply();
    });
    const row = make('label', 'dbg__row');
    row.append(make('span', 'dbg__k', label), input, readout);
    this.el.append(row);
    this.labelOf.set(input, readout);
    return input;
  }

  private currentShot(): CameraShot {
    return snapShot({
      yaw: Number(this.yawInput.value),
      pitch: Number(this.pitchInput.value),
      zoom: Number(this.zoomInput.value),
    });
  }

  /** 把滑杆值套到相机上，并刷新 ID 读数。 */
  private apply(): void {
    const shot = this.currentShot();
    this.app.setCameraShot(shot);
    this.app.setCameraCenter(Number(this.colInput.value), Number(this.rowInput.value));
    this.idText.textContent = encodeCamera(shot);
    this.paintReadouts();
    this.syncSliders(shot);
  }

  private paintReadouts(): void {
    this.labelOf.get(this.yawInput)!.textContent = this.yawInput.value;
    this.labelOf.get(this.pitchInput)!.textContent = this.pitchInput.value;
    this.labelOf.get(this.zoomInput)!.textContent = Number(this.zoomInput.value).toFixed(2);
    this.labelOf.get(this.colInput)!.textContent = Number(this.colInput.value).toFixed(1);
    this.labelOf.get(this.rowInput)!.textContent = Number(this.rowInput.value).toFixed(1);
  }

  private syncSliders(shot: CameraShot): void {
    if (this.yawInput.value !== String(shot.yaw)) this.yawInput.value = String(shot.yaw);
    if (this.pitchInput.value !== String(shot.pitch)) this.pitchInput.value = String(shot.pitch);
    if (this.zoomInput.value !== String(shot.zoom)) this.zoomInput.value = String(shot.zoom);
  }

  /** 把当前机位收进槽位列表（超过 8 档就顶掉最早那条）。 */
  private recordSlot(): void {
    const shot = this.currentShot();
    const col = Number(this.colInput.value);
    const row = Number(this.rowInput.value);
    if (this.slots.length >= MAX_SLOTS) this.slots.shift();
    this.slots.push({ shot, col, row });
    this.paintSlots();
  }

  private slotLine(s: ShotSlot, i: number): string {
    return `slot${i + 1} ${encodeCamera(s.shot)}  yaw ${s.shot.yaw} · pitch ${s.shot.pitch} · zoom ${s.shot.zoom.toFixed(2)} · center ${s.col.toFixed(1)}, ${s.row.toFixed(1)}`;
  }

  private paintSlots(): void {
    this.slotsBox.textContent = '';
    if (this.slots.length === 0) {
      this.slotsBox.append(make('span', 'dbg__empty', '还没存。调好一档点「存这一档」。'));
      return;
    }
    this.slots.forEach((s, i) => {
      const row = make('div', 'dbg__slot');
      row.append(make('code', 'dbg__slot__txt', this.slotLine(s, i)));
      const del = make('button', 'dbg__btn dbg__btn--ghost', '删');
      del.addEventListener('click', () => {
        this.slots.splice(i, 1);
        this.paintSlots();
      });
      row.append(del);
      this.slotsBox.append(row);
    });
  }

  private async copySlots(): Promise<void> {
    const text = this.slots.map((s, i) => this.slotLine(s, i)).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.push('（已复制 ' + this.slots.length + ' 档机位）');
    } catch {
      this.push('复制失败，请手动抄：\n' + text);
    }
  }

  private push(line: string): void {
    this.log.value = this.log.value ? `${this.log.value}\n${line}` : line;
    this.log.scrollTop = this.log.scrollHeight;
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.log.value);
    } catch {
      this.log.select();
    }
  }

  /** 每帧由 main 调一次：手动拖了镜头之后，读数要跟着变。 */
  refresh(): void {
    if (!this.open) return;
    const shot = snapShot({
      yaw: this.app.rig.yaw,
      pitch: this.app.rig.pitch,
      zoom: this.app.rig.zoom / this.app.fitZoomNow,
    });
    this.idText.textContent = encodeCamera(shot);
    this.syncSliders(shot);
    const c = this.app.cameraCenterCell;
    const col = String(Math.round(c.col * 4) / 4);
    const row = String(Math.round(c.row * 4) / 4);
    if (this.colInput.value !== col) this.colInput.value = col;
    if (this.rowInput.value !== row) this.rowInput.value = row;
    this.paintReadouts();
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.el.hidden = false;
    this.app.director.userTouched();
    this.refresh();
  }

  hide(): void {
    this.open = false;
    this.el.hidden = true;
  }

  get visible(): boolean {
    return this.open;
  }
}
