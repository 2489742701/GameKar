/**
 * Capacitor 配置 —— GAMEKAR 安卓**测试分发版**（2026-11-06）。
 *
 * 桌面分发版 = 纯 HTML（dist/ 静态托管，不做任何封装）；
 * 安卓测试分发版 = 把同一份 dist 塞进原生 WebView（Capacitor），出 debug APK。
 *
 * webDir 用 dist-android（由 tools/prepare_android_web.mjs 从 dist 复制并
 * 把 arena.html 换到 index.html）—— 安卓一开就是**对战模式**，
 * 老模式留在 classic.html。没有任何游戏逻辑分叉，两边同一份构建产物。
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gamekar.arena',
  appName: 'GAMEKAR',
  webDir: 'dist-android',
  // 本地 WebView 用 https://localhost 提供文件，dist 里的 /assets/... 绝对路径照常可用
  server: {
    androidScheme: 'https',
  },
  android: {
    // test 分发用 debug 签名即可；正式上架前再换 release 签名 + 版本号
    allowMixedContent: false,
  },
};

export default config;
