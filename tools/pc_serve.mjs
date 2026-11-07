/**
 * PC 桌面版启动器 —— 把 dist 用 http 起在本机，供浏览器打开。
 *
 * 为什么不能直接双击 dist/index.html：页面用的是 `<script type="module">` +
 * `/assets/...` 绝对路径，file:// 下会被 CORS 挡掉，表现是白屏或一堆 404。
 * 所以桌面分发 = 「一个静态 http 服务」+「浏览器地址」，不是双击 HTML。
 *
 * 用法：
 *   npm run pc          # 先重新 build，再起服务（日常更新用这个）
 *   npm run pc:serve    # 只起服务（dist 已经是最新时）
 *   PC_PORT=5000 npm run pc:serve
 *
 * 服务只监听 127.0.0.1，不给局域网；端口被占用会直接报错，不偷偷换端口。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const PORT = Number(process.env.PC_PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/arena.html'; // 桌面版默认开对战模式
    const path = resolve(join(ROOT, normalize(rel).replace(/^[/\\]+/, '')));
    // 防目录穿越：算出来的绝对路径必须还在 dist 里面
    if (path !== ROOT && !path.startsWith(ROOT + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache', // 改完重新 build 立刻生效
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.on('error', (err) => {
  console.error(`端口 ${PORT} 起不来：${err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PC 版已就绪：http://127.0.0.1:${PORT}/arena.html`);
  console.log('（对战模式就是这个地址；老模式在 /index.html。Ctrl+C 结束服务）');
});
