/**
 * 对战模式的**实机读数器**：开一个无头 Edge，把页面真跑几秒，读世界状态 + HUD 文案 + 截一张图。
 *
 * 为什么不用 `--dump-dom`：那条路只拿到"初始化那一帧"，`--virtual-time-budget` 不推进 rAF 时钟，
 * HUD 永远停在 3:00，也看不到结算面板。这里用 CDP 真等一下再问。
 *
 * 用法（先 `npm run dev`）：
 *   node tools/arena_shot.mjs <url> <等几秒> <输出png> [导航后先执行的JS]
 *
 * 例：
 *   node tools/arena_shot.mjs http://localhost:5173/arena.html?auto=1 14 shot.png
 *   # 把时钟拨到快结束，验结算面板：
 *   node tools/arena_shot.mjs "http://localhost:5173/arena.html?auto=1" 5 end.png \
 *     "new Promise(r=>setInterval(()=>{if(window.arena){window.arena.world.elapsed=178.5;r('set')}},100))"
 *
 * 浏览器路径可用环境变量 EDGE_BIN 覆盖（默认 Windows 版 Edge）。
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const EDGE =
  process.env.EDGE_BIN ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2] ?? 'http://localhost:5173/arena.html?auto=1';
const seconds = Number(process.argv[3] ?? 12);
const outPng = process.argv[4] ?? 'shot.png';
/** 可选：导航后先执行一段 JS（比如把 elapsed 拨到快结束，验结算面板）。
 *  传 `@文件路径` 则从文件读（长脚本别在命令行里转义）。 */
let preEval = process.argv[5] ?? '';
if (preEval.startsWith('@')) preEval = readFileSync(preEval.slice(1), 'utf8');
const port = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--disable-gpu-sandbox',
    '--enable-unsafe-swiftshader',
    // 无头环境默认没有用户手势，AudioContext 会一直 suspended —— 音效探针要靠它
    '--autoplay-policy=no-user-gesture-required',
    // 竖屏 / 小屏复验：`SHOT_SIZE=390x844 node tools/arena_shot.mjs ...`
    `--window-size=${process.env.SHOT_SIZE ?? '1280,760'}`,
    '--no-first-run',
    '--user-data-dir=' + process.env.TEMP + '/arena-probe-profile',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
const pending = new Map();
let nextId = 1;

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 20000);
  });
}

try {
  // 等调试端口起来
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await res.json();
      if (targets.length) break;
    } catch {
      // 还没起来
    }
  }
  if (!targets?.length) throw new Error('调试端口没起来');

  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  // 收集页面报错，跑完一起打
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
  });

  // 视口尺寸：`--window-size` 在 headless 下不一定生效，用 CDP 强制覆盖
  const [viewW, viewH] = (process.env.SHOT_SIZE ?? '1280,760').split(',').map(Number);
  await send('Emulation.setDeviceMetricsOverride', {
    width: viewW,
    height: viewH,
    deviceScaleFactor: 1,
    mobile: viewH > viewW,
  });
  await send('Page.navigate', { url });
  await sleep(1500 + seconds * 1000);

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };

  if (preEval) {
    await sleep(600);
    console.log('preEval →', JSON.stringify(await ev(preEval)));
  }

  const read = await ev(`(() => {
    const w = window.arena?.world;
    if (!w) return { ok: false, reason: 'window.arena 不存在' };
    const s = w.summary();
    return {
      ok: true,
      elapsed: Number(w.elapsed.toFixed(1)),
      outcome: s.outcome,
      reason: s.reason,
      timeLeft: s.timeLeft,
      gold: s.gold,
      cores: [s.blueCore, s.redCore],
      destroyed: s.destroyed,
      staffed: s.staffed,
      staffingNeeded: s.staffingNeeded,
      units: s.units,
      clockText: document.querySelector('.ahud__clock__num')?.textContent,
      staffText: document.querySelector('.ahud__staff__num')?.textContent,
      staffShort: document.querySelector('.ahud__staff')?.dataset.short,
      hand: [...document.querySelectorAll('.ahud__card')].map((c) => c.textContent),
      endVisible: (() => { const e = document.querySelector('.ahud__end'); return e ? !e.hidden : null; })(),
    };
  })()`);
  console.log(JSON.stringify(read, null, 2));
  if (errors.length) console.log('页面报错：\n' + errors.join('\n'));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
  console.log('截图：' + outPng);
} finally {
  try {
    ws?.close();
  } catch {
    // 忽略
  }
  child.kill();
}
