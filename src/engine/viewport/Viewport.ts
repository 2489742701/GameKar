/**
 * 视口中枢 —— 尺寸、像素比、朝向的唯一来源。
 *
 * 朝向按真实宽高比判定，但允许手动锁定：
 * 电脑浏览器默认永远是横的，想在桌面上验一验竖屏布局必须能强制切换。
 */

export type Orientation = 'portrait' | 'landscape';
export type OrientationMode = Orientation | 'auto';

export interface ViewportSnapshot {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  orientation: Orientation;
  /** 逻辑像素下的手机特征，供 UI 决定按钮密度 */
  coarse: boolean;
}

type Listener = (snapshot: ViewportSnapshot) => void;

export class Viewport {
  private readonly root = document.documentElement;
  private readonly listeners = new Set<Listener>();
  private observer: ResizeObserver | null = null;
  private media: MediaQueryList | null = null;
  private current: ViewportSnapshot;
  private mode: OrientationMode = 'auto';
  private attached = false;

  constructor(private readonly host: HTMLElement) {
    this.current = this.measure();
    this.publish();
  }

  get snapshot(): ViewportSnapshot {
    return this.current;
  }

  get orientation(): Orientation {
    return this.current.orientation;
  }

  /** 'auto' 之外的一切都会钉死布局档位，方便在桌面预览竖屏。 */
  setOrientationMode(mode: OrientationMode): void {
    this.mode = mode;
    this.remeasure();
  }

  observe(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    listener(this.current);
    return { dispose: () => this.listeners.delete(listener) };
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    this.observer = new ResizeObserver(() => this.remeasure());
    this.observer.observe(this.host);

    this.media = window.matchMedia('(orientation: portrait)');
    this.media.addEventListener('change', this.onMedia);
    window.addEventListener('orientationchange', this.onRotateHack);
    window.addEventListener('resize', this.onMedia);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.media?.removeEventListener('change', this.onMedia);
    window.removeEventListener('orientationchange', this.onRotateHack);
    window.removeEventListener('resize', this.onMedia);
    this.listeners.clear();
    this.attached = false;
  }

  // Android 旋转后视觉视口更新晚一拍，空一帧再量
  private readonly onRotateHack = () => requestAnimationFrame(() => this.remeasure());
  private readonly onMedia = () => this.remeasure();

  private remeasure(): void {
    const next = this.measure();
    const same =
      next.cssWidth === this.current.cssWidth &&
      next.cssHeight === this.current.cssHeight &&
      next.dpr === this.current.dpr &&
      next.orientation === this.current.orientation;
    if (same) return;
    this.current = next;
    this.publish();
  }

  private publish(): void {
    this.root.dataset.orientation = this.current.orientation;
    for (const listener of this.listeners) listener(this.current);
  }

  private measure(): ViewportSnapshot {
    const rect = this.host.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));
    const natural: Orientation = cssWidth >= cssHeight ? 'landscape' : 'portrait';

    return {
      cssWidth,
      cssHeight,
      dpr: Math.min(window.devicePixelRatio || 1, 3),
      orientation: this.mode === 'auto' ? natural : this.mode,
      coarse: window.matchMedia('(pointer: coarse)').matches,
    };
  }
}
