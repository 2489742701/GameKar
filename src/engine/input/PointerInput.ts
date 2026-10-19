/**
 * 指针手势层 —— 一套代码同时伺候手指与鼠标。
 *
 * 单指拖 = 平移，单指轻点 = 选中，双指捏合 = 缩放，双指旋转 = 转视角，
 * 鼠标滚轮 = 缩放，鼠标移动 = 悬停高亮。引擎只发事件，不认识"建筑"。
 */

export interface PointerHandlers {
  onPan?(dx: number, dy: number): void;
  onTap?(x: number, y: number): void;
  onZoom?(factor: number, x: number, y: number): void;
  onRotate?(degrees: number, x: number, y: number): void;
  onHover?(x: number, y: number): void;
}

interface Tracked {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startAt: number;
}

const TAP_SLOP = 9; // px
const TAP_MS = 450;

export class PointerInput {
  private readonly pointers = new Map<number, Tracked>();
  private dragging = false;
  private pinchDist = 0;
  private pinchAngle = 0;
  private attached = false;

  constructor(
    private readonly el: HTMLElement,
    private readonly h: PointerHandlers,
  ) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.el.style.touchAction = 'none';
    this.el.addEventListener('pointerdown', this.onDown);
    this.el.addEventListener('pointermove', this.onMove);
    this.el.addEventListener('pointerup', this.onUp);
    this.el.addEventListener('pointercancel', this.onUp);
    this.el.addEventListener('wheel', this.onWheel, { passive: false });
    this.el.addEventListener('contextmenu', this.preventMenu);
  }

  dispose(): void {
    if (!this.attached) return;
    this.attached = false;
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
    this.el.removeEventListener('contextmenu', this.preventMenu);
    this.pointers.clear();
  }

  private readonly preventMenu = (e: Event) => e.preventDefault();

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onDown = (e: PointerEvent) => {
    const { x, y } = this.local(e);
    this.el.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x, y, startX: x, startY: y, startAt: performance.now() });
    this.dragging = false;

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(b!.x - a!.x, b!.y - a!.y);
      this.pinchAngle = Math.atan2(b!.y - a!.y, b!.x - a!.x);
    }
  };

  private readonly onMove = (e: PointerEvent) => {
    const tracked = this.pointers.get(e.pointerId);
    const { x, y } = this.local(e);

    // 没有按下也在动 = 鼠标悬停，交给上层做地块高亮
    if (!tracked) {
      if (e.pointerType === 'mouse') this.h.onHover?.(x, y);
      return;
    }

    if (this.pointers.size >= 2) {
      tracked.x = x;
      tracked.y = y;
      this.handlePinch();
      return;
    }

    const dx = x - tracked.x;
    const dy = y - tracked.y;
    tracked.x = x;
    tracked.y = y;

    if (!this.dragging && Math.hypot(x - tracked.startX, y - tracked.startY) > TAP_SLOP) {
      this.dragging = true;
    }
    if (this.dragging) this.h.onPan?.(dx, dy);
    else if (e.pointerType === 'mouse') this.h.onHover?.(x, y);
  };

  private handlePinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;

    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;

    if (this.pinchDist > 0 && dist > 0) {
      this.h.onZoom?.(dist / this.pinchDist, cx, cy);
    }
    if (this.pinchAngle !== 0) {
      // atan2 在 -PI/PI 边界会跳变，绕回来
      const deg = wrapAngleDegrees(angle - this.pinchAngle);
      if (Math.abs(deg) > 0.05) this.h.onRotate?.(deg, cx, cy);
    }
    this.pinchDist = dist;
    this.pinchAngle = angle;
    this.dragging = true;
  }

  private readonly onUp = (e: PointerEvent) => {
    const tracked = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.el.hasPointerCapture?.(e.pointerId)) this.el.releasePointerCapture(e.pointerId);

    if (this.pointers.size < 2) {
      this.pinchDist = 0;
      this.pinchAngle = 0;
    }
    if (!tracked) return;

    const moved = Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY);
    const held = performance.now() - tracked.startAt;
    if (!this.dragging && moved <= TAP_SLOP && held <= TAP_MS) {
      this.h.onTap?.(tracked.x, tracked.y);
    }
    if (this.pointers.size === 0) this.dragging = false;
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    // 指数映射：滚一格约等于 1.1 倍缩放，双向对称
    const factor = Math.exp(-e.deltaY * 0.0016);
    this.h.onZoom?.(factor, e.clientX - r.left, e.clientY - r.top);
  };
}

/** 把角度差折叠到 (-180, 180]，避免双指划过 0° 时视角猛转一圈。 */
function wrapAngleDegrees(rad: number): number {
  let d = rad;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return (d * 180) / Math.PI;
}
