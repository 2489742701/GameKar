/**
 * **开发者模式开关**（2026-11-08 用户："把调试默认设为看不见，
 * 在设置里面，将'开发者模式'开关默认设为关闭"）。
 *
 * 一个开关同时管住三样：`F2` 快捷键、工具行的「调试」按钮、相机调试面板本身。
 * 默认 `false` —— 正常玩家一进游戏看不到任何调试入口。
 *
 * `?debug=1` 是给无头探针 / 开发机留的强制入口（只影响本次启动的初值，
 * 不写进存档，所以在设置里关掉仍然有效）。
 * 状态由 `main.ts` 单点持有，HUD 只通过回调读写，不另存一份布尔值。
 */
export const DEV_KEY = 'gamekar.devMode.v1';

export function loadDevMode(): boolean {
  try {
    return localStorage.getItem(DEV_KEY) === '1';
  } catch {
    // 无头 / 隐私模式：默认关
    return false;
  }
}

export function saveDevMode(on: boolean): void {
  try {
    localStorage.setItem(DEV_KEY, on ? '1' : '0');
  } catch {
    // 存不下不影响这一局
  }
}
