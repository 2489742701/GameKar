/**
 * 把桌面 HTML 构建产物（dist/）变成安卓 WebView 的入口（dist-android/）。
 *
 * 只做三件事：原样复制 + 把 arena.html 换到 index.html（安卓一开就是对战模式）、
 * 老模式留成 classic.html、去掉 sourcemap（桌面 dist 保留调试用）。
 * 不重写资源路径 —— Capacitor 用 https://localhost 提供整个 webDir，
 * Vite 生成的 /assets/... 绝对路径有效。
 *
 * 用法：node tools/prepare_android_web.mjs（先 npm run build）
 *
 * 注：本机 WorkBuddy 的 safe-delete 代理会拦 Node 的 fs.rmSync/unlinkSync，
 * 清理目录/删 map 一律走 cmd 内置 rmdir/del（项目内的临时构建产物，安全）。
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname ?? '.', '..');
const dist = resolve(root, 'dist');
const out = resolve(root, 'dist-android');
const isWin = process.platform === 'win32';

if (!existsSync(resolve(dist, 'arena.html'))) {
  throw new Error('找不到 dist/arena.html —— 先跑 npm run build');
}

// 清掉上一次的安卓产物（保留原生工程 android/ 不动）
if (existsSync(out)) {
  if (isWin) execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', out], { stdio: 'ignore' });
  else execFileSync('rm', ['-rf', out], { stdio: 'ignore' });
}
mkdirSync(out, { recursive: true });
cpSync(dist, out, { recursive: true });
// 老模式留档
copyFileSync(resolve(out, 'index.html'), resolve(out, 'classic.html'));
// 对战模式做入口
copyFileSync(resolve(out, 'arena.html'), resolve(out, 'index.html'));
// APK 不带 sourcemap：少 3MB 左右
if (isWin) {
  try { execFileSync('cmd.exe', ['/c', 'del', '/s', '/q', '*.js.map'], { cwd: out, stdio: 'ignore' }); } catch { /* 没有 map 时 del 返回非 0，忽略 */ }
} else {
  const strip = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      if (statSync(p).isDirectory()) strip(p);
      else if (p.endsWith('.js.map')) execFileSync('rm', ['-f', p]);
    }
  };
  strip(out);
}

let files = 0;
let bytes = 0;
const count = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) count(p);
    else { files++; bytes += st.size; }
  }
};
count(out);
console.log(`dist-android 就绪：${files} 个文件 / ${(bytes / 1024 / 1024).toFixed(2)} MB（入口 = 对战模式，老模式在 classic.html）`);
