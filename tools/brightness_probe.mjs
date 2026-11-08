/**
 * **画面亮度探针**（2026-11-08 P-077 起留作常备工具）。
 *
 * 干什么的：开无头 Edge 真跑 WebGL，对同一场景切几组后期参数各截一张屏，
 * 逐像素算**加权平均亮度**（0.299R + 0.587G + 0.114B）和上/中/下三条带，
 * 用来判断"某个效果到底改没改曝光"，而不是靠肉眼说"好像暗了点"。
 * 自带最小 PNG 解码（zlib + 反 filter），不装 pngjs 之类的依赖。
 *
 * 用法（先 `npm run build`，再 `npm run pc:serve`；或直接 `npm run dev` 后覆盖 URL）：
 *   node tools/brightness_probe.mjs
 *   PROBE_URL="http://127.0.0.1:5173/arena.html?auto=1" node tools/brightness_probe.mjs
 *
 * 五档分别量：直出 / composer 空转 / 景深满档 / 只压暗 / 两个都开。
 * 同时把「原图 / 景深亮度守恒 / 夜晚」三张图写到 `docs/`。
 * 除了全幅平均亮度，还会采 7 个固定像素（四角 + 上/下边中点 + 画面中心）的 RGB，
 * 用来区分"整幅曝光变了"和"只有背景/暗区被抬亮"—— P-082 就是靠这个定位的。
 *
 * 可选环境变量：
 *   PROBE_INIT   页面加载后执行一次的 JS（例如把 clearColor 设黑做反证），
 *                表达式里能拿到 `window.arena`（ArenaApp 实例）。
 *   PROBE_STRICT 设成 1 时，若「composer 空转 vs 直出」超过 1.5% 就退出码非零，
 *                可以直接当回归闸门用。
 *
 * 历史读数见 `docs/工作笔记/对战模式计划流水账_20261027.md` P-077 / P-082。
 * 关键基线：旧版（缺 OutputPass）tilt 0→1 是 0.275 → 0.138（−50%）；
 * P-077 后景深满档相对 composer 空转只差 −0.02%，dim=1 是 −45.4%，
 * 但「直出 → 后期」还剩 +10.47% —— P-082 定位为 gl.clearColor 绕过色调映射，
 * 背景改成 1×1 线性贴图后应收到约 0%。
 *
 * 注意：探针共用固定 `--user-data-dir`，localStorage 会残留 —— 所以每一档都
 * **显式** `setTilt` / `setDim`，别拿"默认值"当对照组（P-074 踩过这个坑）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const EDGE = process.env.EDGE_BIN ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.env.PROBE_URL ?? 'http://127.0.0.1:4173/arena.html?auto=1';
const PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 最小 PNG 解码：CDP 截图是 8-bit RGB/RGBA，逐行反 filter 后算平均亮度。 */
function pngStats(buf) {
  let p = 8, w = 0, h = 0, depth = 0, color = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (color !== 2 && color !== 6)) throw new Error(`不支持的 PNG: depth=${depth} color=${color}`);
  const bpp = color === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const bands = [0, 0, 0];
  const counts = [0, 0, 0];
  // 固定采样点：四角 / 上下边中点 / 正中心。角落大概率是 clearColor 背景，
  // 中心大概率是场地几何 —— 两者对比能分清「背景编码路径」和「整幅曝光」。
  const points = [
    ['tl', 5, 5], ['tr', w - 6, 5],
    ['bl', 5, h - 6], ['br', w - 6, h - 6],
    ['top', w >> 1, 5], ['bottom', w >> 1, h - 6],
    ['center', w >> 1, h >> 1],
  ];
  const samples = {};
  let sum = 0, n = 0;
  let off = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[off++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = raw[off++];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
    const band = y < h / 3 ? 0 : y < (2 * h) / 3 ? 1 : 2;
    for (let x = 0; x < w; x++) {
      const i = x * bpp;
      const lum = (0.299 * cur[i] + 0.587 * cur[i + 1] + 0.114 * cur[i + 2]) / 255;
      sum += lum; n++;
      bands[band] += lum; counts[band]++;
    }
    for (const [name, px, py] of points) {
      if (py !== y) continue;
      const i = px * bpp;
      samples[name] = [cur[i], cur[i + 1], cur[i + 2]];
    }
    prev.set(cur);
  }
  return { w, h, mean: sum / n, bands: bands.map((s, i) => s / counts[i]), samples };
}

const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu-sandbox',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1000,600', '--no-first-run',
  '--user-data-dir=' + process.env.TEMP + '/gamekar-brightness-profile',
  'about:blank',
], { stdio: 'ignore' });

let ws;
const pending = new Map();
let nextId = 1;
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 20000);
  });
};

try {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await r.json(); if (targets.length) break; } catch { /* 等 */ }
  }
  if (!targets?.length) throw new Error('调试端口没起来');
  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 600, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL + '&v=' + Date.now() });
  await sleep(5000);

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };
  const shot = async () => {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const png = Buffer.from(r.data, 'base64');
    return { png, stats: pngStats(png) };
  };

  if (process.env.PROBE_INIT) {
    console.log('PROBE_INIT:', JSON.stringify(await ev(process.env.PROBE_INIT)));
  }

  const cases = [
    { tilt: 0, dim: 0, file: 'docs/景深_原图_20261108.png' },       // 基线：直出，零后期
    { tilt: 0.002, dim: 0 },   // 对照：走 composer 但 amount≈0，验色彩空间是否已对齐
    { tilt: 1, dim: 0, file: 'docs/景深_亮度守恒_20261108.png' },       // 景深开到底：亮度应与基线一致
    { tilt: 0, dim: 1, file: 'docs/氛围压暗_夜晚_20261108.png' },       // 只压暗：证明"变暗"能力独立保存下来了
    { tilt: 1, dim: 1 },       // 两个都开：最暗
  ];
  const results = [];
  for (const c of cases) {
    await ev(`(() => {
      const a = window.arena;
      if (!a) return 'no arena';
      if (typeof a.setDim === 'function') a.setDim(${c.dim});
      a.setTilt(${c.tilt});
      return { tilt: a.tilt, dim: a.dim ?? 'n/a' };
    })()`);
    await sleep(1200);
    const { png, stats: s } = await shot();
    if (c.file) writeFileSync(c.file, png);
    const r = {
      tilt: c.tilt, dim: c.dim,
      liveTilt: await ev('window.arena?.tilt'),
      liveDim: await ev('window.arena?.dim ?? null'),
      mean: +s.mean.toFixed(5),
      bands: s.bands.map((v) => +v.toFixed(5)),
      samples: s.samples,
      size: `${s.w}x${s.h}`,
    };
    console.log(JSON.stringify(r));
    results.push(r);
  }
  const base = results[0].mean;
  const pctNum = (v, ref = base) => ((v - ref) / ref) * 100;
  const pct = (v) => +pctNum(v).toFixed(2) + '%';
  const jump = pctNum(results[1].mean);
  console.log('DELTA composer空转 vs 直出:', pct(results[1].mean));
  console.log('DELTA tilt=1,dim=0 vs 直出:', pct(results[2].mean));
  console.log('DELTA tilt=1,dim=0 vs composer空转:', +(((results[2].mean - results[1].mean) / results[1].mean) * 100).toFixed(2) + '%');
  console.log('DELTA tilt=0,dim=1 vs 直出:', pct(results[3].mean));
  console.log(`GATE 直出/后期亮度连续: ${Math.abs(jump) <= 1.5 ? 'PASS' : 'FAIL'} (${jump.toFixed(2)}%)`);
  if (process.env.PROBE_STRICT === '1' && Math.abs(jump) > 1.5) process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill();
}
