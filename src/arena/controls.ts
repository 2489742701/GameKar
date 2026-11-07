/**
 * 操作方向偏好 —— 2026-11-07 用户："双指上下滑动能不能反转一下？我个人的偏好是
 * 反转过来的……你在设置里面可以把操作反转之类的都设置好，可以常态化保存。"
 *
 * 这里只做两件事：**存档**（localStorage，坏了就回落默认，绝不让设置把游戏搞崩）
 * 和**判方向的纯函数**。纯函数是关键：四个手势的方向只在这一处算，
 * `ArenaApp` 的手势回调和单测读的是同一套判据，不另写一份符号。
 *
 * 「默认方向」定义成用户要的那一侧：
 *  - 双指**往下滑** = 更俯视（看得见全场）；**往上滑** = 更平（贴近地面看兵线）。
 *  - 设置里的「反转」勾上，才回到上一版那个方向（`pitch - dy·k`）。
 * 换句话说默认值全是 `false`，不是"默认反着"，读代码的人不用再猜一层。
 */

export interface ControlPrefs {
  /** 双指整体上下推 → 俯仰角 */
  tiltInvert: boolean;
  /** 单指拖 → 平移 */
  panInvert: boolean;
  /** 双指拧 → 转 yaw */
  rotateInvert: boolean;
  /** 捏合 / 滚轮 → 缩放 */
  zoomInvert: boolean;
}

export const CONTROL_KEY = 'gamekar.controls.v1';

export const DEFAULT_CONTROLS: Readonly<ControlPrefs> = {
  tiltInvert: false,
  panInvert: false,
  rotateInvert: false,
  zoomInvert: false,
};

/** 0.22°/px：一根手指走 300px 能扫完大半段俯仰行程，再快就一碰就过头。 */
export const TILT_DEG_PER_PX = 0.22;

/** 有些环境（无头测试、隐私模式）连 `localStorage` 这个标识符都不能碰，先探一手。 */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 读档：只认布尔值，一个字段坏了不影响其余三个。
 * 存档是用户数据，不因为某个版本多写了个字段就把整份偏好丢掉。
 */
export function loadControls(storage: Storage | null = safeStorage()): ControlPrefs {
  const out: ControlPrefs = { ...DEFAULT_CONTROLS };
  if (!storage) return out;
  try {
    const raw = storage.getItem(CONTROL_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return out;
    const record = parsed as Record<string, unknown>;
    for (const key of Object.keys(out) as (keyof ControlPrefs)[]) {
      if (typeof record[key] === 'boolean') out[key] = record[key] as boolean;
    }
  } catch {
    // JSON 坏了 / 存储被禁：回落默认，别抛到启动流程里
  }
  return out;
}

export function saveControls(prefs: ControlPrefs, storage: Storage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(CONTROL_KEY, JSON.stringify(prefs));
  } catch {
    // 配额满 / 隐私模式：这一局仍然生效，只是下次不记得 —— 不打断游戏
  }
}

// ---------------------------------------------------------------- 方向判据

/** `dy > 0` = 两指向下滑。默认往下滑更俯视；勾了反转就取反。 */
export function pitchDelta(dy: number, prefs: ControlPrefs): number {
  return (prefs.tiltInvert ? -dy : dy) * TILT_DEG_PER_PX;
}

export function panDelta(dx: number, dy: number, prefs: ControlPrefs): [number, number] {
  return prefs.panInvert ? [-dx, -dy] : [dx, dy];
}

export function rotateDelta(deg: number, prefs: ControlPrefs): number {
  return prefs.rotateInvert ? -deg : deg;
}

/** 缩放是"倍率"不是"位移"，反转取倒数（张开变拉远、捏合变拉近）。 */
export function zoomDelta(factor: number, prefs: ControlPrefs): number {
  return prefs.zoomInvert ? 1 / factor : factor;
}
