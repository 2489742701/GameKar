/**
 * 指针手势层 —— 一套代码同时伺候手指与鼠标。
 *
 * 单指拖 = 平移，单指轻点 = 选中，双指捏合 = 缩放，双指旋转 = 转视角，
 * 双指整体上下推 = 调俯仰角，鼠标滚轮 = 缩放，鼠标移动 = 悬停高亮。
 * 引擎只发事件，不认识"建筑"。
 */

export interface PointerHandlers {
  onPan?(dx: number, dy: number): void;
  onTap?(x: number, y: number): void;
  /**
   * 按住不动超过 LONG_PRESS_MS：查详情用的手势，跟"点一下"互斥。
   *
   * **返回 true = 这次手势被上层接管**（2026-11-07：选中手牌后长按地图要出影子放牌）：
   * 接管之后这一根手指的 move/up 不再走平移与点击，而是转给
   * `onGrabMove` / `onGrabEnd` —— 否则玩家一边挪影子、镜头一边跟着平移。
   */
  onLongPress?(x: number, y: number, pointerType: string): boolean | void;
  /** 接管期间手指移动（客户端相对画布坐标）。 */
  onGrabMove?(x: number, y: number, pointerType: string): void;
  /** 接管期间松手（x/y 是松手位置）。 */
  onGrabEnd?(x: number, y: number, pointerType: string): void;
  onZoom?(factor: number, x: number, y: number): void;
  onRotate?(degrees: number, x: number, y: number): void;
  /**
   * 双指**整体**上下移动（px，正值 = 往下推）：调俯仰角用。
   *
   * 和缩放/旋转是三个正交量：两根手指一起平移时距离几乎不变、夹角几乎不变，
   * 只有中心点在动 —— 所以同一手势里就能同时识别"捏合 / 拧 / 推"。
   */
  onTilt?(dy: number): void;
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
const LONG_PRESS_MS = 380;

export class PointerInput {
  private readonly pointers = new Map<number, Tracked>();
  private dragging = false;
  private pinchDist = 0;
  private pinchAngle = 0;
  /** 双指中心点的上一次 y（调俯仰角用；抬起来就归零，免得下次跳一下） */
  private pinchCy = 0;
  private attached = false;
  private longPressTimer: number | null = null;
  private longPressFired = false;
  /** 长按被上层接管（放牌）：这一根手指后续的 move/up 不再走平移与点击 */
  private grabbed = false;
  /** 当前指针类型（长按定时器里拿不到事件对象，只能先记下来） */
  private pointerType = 'mouse';

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
    // 摘掉还没到点的长按定时器，否则它会在解绑之后回调一次
    this.clearLongPress();
  }

  private readonly preventMenu = (e: Event) => e.preventDefault();

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onDown = (e: PointerEvent) => {
    const { x, y } = this.local(e);
    // 先登记，再抢捕获：setPointerCapture 对"当前不活跃的 pointerId"会抛 NotFoundError，
    // 写在前面会让这根手指根本进不了表 —— 双指捻合就是这么变成空手势的
    this.pointers.set(e.pointerId, { x, y, startX: x, startY: y, startAt: performance.now() });
    this.pointerType = e.pointerType || 'mouse';
    this.dragging = false;

    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // 抢不到捕获不影响手势判定，顶多是手指划出元素后收不到 move
    }

    if (this.pointers.size === 2) {
      // 第二根手指落下来就是双指手势，长按判定作废
      this.clearLongPress();
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(b!.x - a!.x, b!.y - a!.y);
      this.pinchAngle = Math.atan2(b!.y - a!.y, b!.x - a!.x);
      this.pinchCy = (a!.y + b!.y) / 2;
      return;
    }

    this.longPressFired = false;
    this.clearLongPress();
    this.longPressTimer = window.setTimeout(() => {
      if (this.dragging || this.pointers.size !== 1) return;
      this.longPressFired = true;
      const tracked = this.pointers.values().next().value as Tracked | undefined;
      this.grabbed = this.h.onLongPress?.(tracked?.x ?? x, tracked?.y ?? y, this.pointerType) === true;
    }, LONG_PRESS_MS);
  };

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

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

    // 长按已被接管（放牌）：影子跟着手指走，**不**平移镜头
    if (this.grabbed) {
      this.h.onGrabMove?.(x, y, this.pointerType);
      return;
    }

    if (!this.dragging && Math.hypot(x - tracked.startX, y - tracked.startY) > TAP_SLOP) {
      this.dragging = true;
      this.clearLongPress();
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
    /**
     * 双指整体上下推 = 调俯仰角。
     * 留 0.8px 死区：捏合/拧动时中心点会抖一点，不设死区镜头会跟着喘。
     */
    const tilt = cy - this.pinchCy;
    if (Math.abs(tilt) > 0.8) this.h.onTilt?.(tilt);
    this.pinchCy = cy;

    this.pinchDist = dist;
    this.pinchAngle = angle;
    this.dragging = true;
  }

  private readonly onUp = (e: PointerEvent) => {
    const tracked = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    this.clearLongPress();
    try {
      if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    } catch {
      // 同上：捕获本来就没抢到，释放失败不是错误
    }

    if (this.pointers.size < 2) {
      this.pinchDist = 0;
      this.pinchAngle = 0;
      this.pinchCy = 0;
    }
    if (!tracked) return;

    if (this.grabbed) {
      this.grabbed = false;
      this.longPressFired = false;
      this.dragging = false;
      this.h.onGrabEnd?.(tracked.x, tracked.y, this.pointerType);
      return;
    }

    const moved = Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY);
    const held = performance.now() - tracked.startAt;
    // 长按已经替玩家做了"看详情"，松手就不要再补一次点击选中
    if (!this.dragging && !this.longPressFired && moved <= TAP_SLOP && held <= TAP_MS) {
      this.h.onTap?.(tracked.x, tracked.y);
    }
    if (this.pointers.size === 0) {
      this.dragging = false;
      this.longPressFired = false;
    }
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
