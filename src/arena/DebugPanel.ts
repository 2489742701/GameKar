/**
 * 调试面板（F2 开关）—— 给用户"现场调机位 + 记账"用。
 *
 * 为什么要有它：用户想自己找喜欢的视角，并且把"以后要删的东西"记成 ID 发回来。
 * 所以面板只做两件事：
 *   ① 三个滑杆直接改镜头，旁边实时显示**机位 ID**（同一个角度永远是同一个码）；
 *   ② 一份"可删项"清单，每项一个固定 ID，点一下就把 `del-fN` 记进下面的账本。
 * 账本可以一键复制，用户贴回来我照着删。
 *
 * 面板本身是临时件：用户说"后面要删的就是我记下来的"—— 到时候删掉这个文件与两处接线即可。
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

export class DebugPanel {
  readonly el = make('div', 'dbg panel');
  private readonly yawInput: HTMLInputElement;
  private readonly pitchInput: HTMLInputElement;
  private readonly zoomInput: HTMLInputElement;
  private readonly idText = make('code', 'dbg__id');
  private readonly log = make('textarea', 'dbg__log');
  private open = false;

  constructor(private readonly app: ArenaApp) {
    const head = make('div', 'dbg__head');
    head.append(
      make('span', 'dbg__title', '调试 · F2'),
      (() => {
        const close = make('button', 'dbg__btn dbg__btn--ghost', '关');
        close.addEventListener('click', () => this.hide());
        return close;
      })(),
    );

    this.yawInput = this.slider('朝向 yaw', 0, 359, 1, DEFAULT_SHOT.yaw);
    this.pitchInput = this.slider('俯仰 pitch', 20, 80, 1, DEFAULT_SHOT.pitch);
    this.zoomInput = this.slider('缩放 zoom', 0.5, 1.2, 0.01, DEFAULT_SHOT.zoom);

    const record = make('button', 'dbg__btn', '记下这个机位');
    record.addEventListener('click', () => {
      const shot = this.currentShot();
      this.push(`${encodeCamera(shot)}  （yaw ${shot.yaw} · pitch ${shot.pitch} · zoom ${shot.zoom.toFixed(2)}）`);
    });

    const featureBox = make('div', 'dbg__features');
    for (const f of FEATURES) {
      const row = make('div', 'dbg__feature');
      const mark = make('button', 'dbg__btn dbg__btn--ghost', '记下要删');
      mark.addEventListener('click', () => this.push(`del-${f.id}  （${f.label}）`));
      row.append(make('span', 'dbg__feature__id', f.id), make('span', 'dbg__feature__label', f.label), mark);
      featureBox.append(row);
    }

    const foot = make('div', 'dbg__foot');
    const copy = make('button', 'dbg__btn', '复制账本');
    copy.addEventListener('click', () => this.copy());
    const clear = make('button', 'dbg__btn dbg__btn--ghost', '清空');
    clear.addEventListener('click', () => {
      this.log.value = '';
    });
    foot.append(copy, clear);

    this.log.readOnly = true;
    this.log.placeholder = '记下的东西会出现在这里，复制后发给我即可';

    this.el.append(
      head,
      make('p', 'dbg__hint', '拖滑杆找角度；满意就「记下这个机位」。不想要的模块点「记下要删」。'),
      this.yawInput.parentElement!,
      this.pitchInput.parentElement!,
      this.zoomInput.parentElement!,
      make('div', 'dbg__row', [this.idText, record]),
      make('div', 'dbg__label', '可删项'),
      featureBox,
      make('div', 'dbg__label', '账本'),
      this.log,
      foot,
    );
    this.el.hidden = true;
    /**
     * ⚠️ 这里**不要**调 `userTouched()` / `apply()`（2026-11-07 修）。
     *
     * 上一版在构造末尾无条件套了一遍 `DEFAULT_SHOT`（yaw 24 / pitch 50），后果是：
     * 一进游戏相机就被从 `ARENA_CAMERA` 的机位拽到滑杆默认值，而且顺手 `locked`，
     * 导演从此再也接管不了 —— PVE 想设"正对 + 俯角 36"完全没反应
     * （实测 yaw 停在 24、pitch 停在 50，查了半天数据才发现是这块面板干的）。
     * 面板是隐藏的调试件，凭什么改玩家的镜头？改成**打开时才把滑杆同步成相机**。
     */
  }

  private slider(label: string, min: number, max: number, step: number, value: number): HTMLInputElement {
    const input = make('input', 'dbg__range');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      this.app.director.userTouched();
      this.apply();
    });
    const row = make('label', 'dbg__row');
    row.append(make('span', 'dbg__k', label), input, make('span', 'dbg__v num'));
    this.el.append(row);
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
    this.idText.textContent = encodeCamera(shot);
    this.el.querySelectorAll('.dbg__v').forEach((node, i) => {
      const shotValues = [shot.yaw, shot.pitch, shot.zoom.toFixed(2)];
      node.textContent = String(shotValues[i] ?? '');
    });
    this.syncSliders(shot);
  }

  private syncSliders(shot: CameraShot): void {
    if (this.yawInput.value !== String(shot.yaw)) this.yawInput.value = String(shot.yaw);
    if (this.pitchInput.value !== String(shot.pitch)) this.pitchInput.value = String(shot.pitch);
    if (this.zoomInput.value !== String(shot.zoom)) this.zoomInput.value = String(shot.zoom);
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
    const shot = snapShot({ yaw: this.app.rig.yaw, pitch: this.app.rig.pitch, zoom: this.app.rig.zoom / this.app.fitZoomNow });
    this.idText.textContent = encodeCamera(shot);
    this.syncSliders(shot);
    this.el.querySelectorAll('.dbg__v').forEach((node, i) => {
      const values = [shot.yaw, shot.pitch, shot.zoom.toFixed(2)];
      node.textContent = String(values[i] ?? '');
    });
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
