/**
 * 大地图模组的**无头实机验收**（2026-11-09，P-087）。
 *
 * 为什么单独一支探针：arena_shot.mjs 只认 window.arena（vanilla 模式），
 * 模组模式挂的是 window.__modActive / window.__grandMap，读的东西完全不同。
 *
 * 用法（先 npm run build，再起一个静态服务）：
 *   node tools/grand_map_probe.mjs [url] [输出目录]
 *
 * 检查项：
 *   · 模组挂上、四张 .ahud__card 手牌、主程序卡面样式确实生效；
 *   · 大六边形地形格数 / 六芒星道路 / 近路 / 对径都在；
 *   · 落一张牌：金币只扣一次、占领 +1、抽象网格同步；
 *   · 点集市开商路设置、点主城开外交、切晚上时段 tint 生效；
 *   · 截图不是黑屏（解码 PNG 算平均亮度和颜色数）；
 *   · 页面 exception 一条都不许有。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const EDGE = process.env.EDGE_BIN ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PAGE_URL = process.argv[2] ?? 'http://127.0.0.1:4188/arena.html?mod=grand-map';
const OUT = process.argv[3] ?? 'docs';
/**
 * 视口可用 `PROBE_SIZE=390,844` 切成手机竖屏（P-095：用户让"用浏览器处理"，
 * 同一套 37 项检查得能在窄屏复跑，不能只会验桌面）。
 */
const [VIEW_W, VIEW_H] = (process.env.PROBE_SIZE ?? '1280,760').split(',').map(Number);
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 最小 PNG 解码：只算平均亮度和颜色桶，够判断「有没有画出东西」。 */
function pngStats(buf) {
  let p = 8, w = 0, h = 0, color = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); color = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = color === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  let prev = Buffer.alloc(stride);
  let sum = 0, n = 0;
  const buckets = new Set();
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < w; x += 4) {
      const i = x * bpp;
      const r = line[i], g = line[i + 1], bl = line[i + 2];
      sum += 0.299 * r + 0.587 * g + 0.114 * bl;
      n++;
      buckets.add(`${r >> 5},${g >> 5},${bl >> 5}`);
    }
    prev = line;
  }
  return { w, h, brightness: +(sum / n).toFixed(2), colorBuckets: buckets.size };
}

mkdirSync(OUT, { recursive: true });

const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--disable-gpu-sandbox', '--enable-unsafe-swiftshader',
  `--window-size=${VIEW_W},${VIEW_H}`, '--no-first-run',
  '--user-data-dir=' + process.env.TEMP + '/grand-map-probe-profile',
  'about:blank',
], { stdio: 'ignore' });

let ws;
const pending = new Map();
let nextId = 1;
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); } }, 20000);
  });
}

try {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break; }
    catch { /* 端口还没起来 */ }
  }
  if (!targets?.length) throw new Error('调试端口没起来');
  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  const errors = [];
  const warnings = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const text = d.exception?.description ?? d.text;
      /**
       * 只忽略**浏览器扩展自己**抛的异常（本机装了一个会往页面注入 content.js 的插件，
       * 它偶发 `Cannot read properties of undefined (reading 'query')`）。
       * 判断依据是异常来源 URL / 堆栈里的 `chrome-extension://`，
       * 页面自身（含模组）的任何异常照旧计入 —— 别拿这条当"忽略所有报错"的口子。
       */
      const fromExtension = /chrome-extension:\/\//.test(`${d.url ?? ''} ${text ?? ''}`);
      if (!fromExtension) errors.push(text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'warning' || msg.params.type === 'error')) {
      warnings.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: VIEW_H > VIEW_W,
  });
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(3500);

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  const base = await ev(`(() => {
    const gm = window.__grandMap;
    const cards = [...document.querySelectorAll('.ahud__card')];
    const M = gm?.map;
    return {
      modActive: window.__modActive ?? null,
      cards: cards.length,
      handRoot: !!document.querySelector('.ahud__hand[data-mod-hand="1"]'),
      cardNames: cards.map((c) => c.querySelector('.ahud__card__name')?.textContent ?? ''),
      cardHasArt: cards.every((c) => !!c.querySelector('.ahud__card__art svg')),
      cardWidth: cards[0] ? Math.round(cards[0].getBoundingClientRect().width) : 0,
      topbar: !!document.querySelector('.ahud__top'),
      oldTopbar: !!document.querySelector('.ahud__top.panel.gm-top .ahud__clock'),
      bank: !!document.querySelector('.ahud__bankrow[data-mod-bank] .ahud__bank'),
      bankText: document.querySelector('.ahud__bank__num')?.textContent ?? '',
      topbarGold: !!document.querySelector('.gm-top [data-gold]'),
      debugOpen: !document.querySelector('[data-debug]')?.hidden,
      sizeButtons: document.querySelectorAll('[data-action="size"]').length,
      devTag: !!document.querySelector('.gm-devtag'),
      tipText: document.querySelector('.gm-tip')?.textContent ?? '',
      tipHasBreak: !!document.querySelector('.gm-tip br'),
      logLines: document.querySelectorAll('.gm-log > div').length,
      floor: gm?.floor ?? null,
      terrain: M ? M.terrainCells().length : 0,
      star: M ? M.starRoads().length : 0,
      short: M ? M.shortcuts().length : 0,
      far: M ? M.diameterRoads().length : 0,
      centerSize: M ? M.CENTER.size : 0,
      size: gm?.size ?? null,
      viewRange: gm?.viewRange ?? null,
      claims: gm?.hand?.claims?.size ?? 0,
      gold: gm?.state?.factions?.[0]?.gold ?? null,
      dudesReady: !!gm?.dudesReady,
      zoom: gm?.zoom ?? null,
      fallback: !!document.body.textContent.includes('模组没挂上'),
    };
  })()`);

  // 干净的第一张图：还没点开任何浮层、还没打牌（默认局部视图，地块明显变大）
  const shotClean = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/大地图_P091_局部视图_20261109.png`, Buffer.from(shotClean.data, 'base64'));
  const cardDayBg = await ev(`(() => { const c = document.querySelector('.ahud__card');
    return c ? getComputedStyle(c).backgroundColor : ''; })()`);

  // 「全图」按钮：一键拉远看整张六边形，验镜头真的能逛
  const overviewShot = await ev(`window.__grandMap.setOverview(true); window.__grandMap.zoom`);
  await sleep(500);
  const shotAll = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/大地图_P091_全图_20261109.png`, Buffer.from(shotAll.data, 'base64'));
  const backZoom = await ev(`window.__grandMap.setOverview(false); window.__grandMap.zoom`);

  const play = await ev(`(() => {
    const gm = window.__grandMap;
    if (!gm) return { ok: false, reason: 'no mod' };
    const hand = gm.hand, M = gm.map;
    const slot = hand.cards.findIndex((c) => c && c.kind === 'building' && c.id !== 'market');
    if (slot < 0) return { ok: false, reason: '起始四张里没有建筑卡' };
    // 优先落中心公共区，好把「地图格 → 抽象网格」这条镜像链路也验到
    const cells = [...hand.unlocked()].map((k) => k.split(',').map(Number));
    const center = cells.find(([c, r]) => M.toAbstract(c, r));
    const [col, row] = center ?? cells[0] ?? [];
    if (col === undefined) return { ok: false, reason: '没有可落牌的格子' };
    const cost = hand.cards[slot].cost;
    const before = gm.state.factions[0].gold;
    const res = gm.playCard(slot, col, row);
    const a = M.toAbstract(col, row);
    return {
      ok: res.ok, reason: res.reason ?? '', cost, col, row,
      goldDelta: before - gm.state.factions[0].gold,
      claims: hand.claims.size,
      abstractSynced: a ? gm.state.cells[a.r][a.c].building : 'outside-center',
      cardEmptied: hand.cards[slot] === null,
    };
  })()`);

  // 「点击地面集结军队」：点地面插旗 → 打军队卡出兵 → 兵真的往旗子走
  await sleep(900); // 等 loadPack 异步把像素小人素材包读回来
  const rallyProbe = await ev(`(() => {
    const gm = window.__grandMap;
    const M = gm.map;
    const c = { col: M.MAP.cx, row: M.MAP.cy };
    const drop = gm.rallyAt(c.col, c.row);
    const unitsBefore = gm.rally.units.length;
    const slot = gm.hand.cards.findIndex((x) => x && x.kind !== 'building' && x.id !== 'caravan' && x.id !== 'escort');
    let played = null;
    if (slot >= 0) {
      const k = [...gm.hand.unlocked()][0];
      if (k) {
        const [col, row] = k.split(',').map(Number);
        played = gm.playCard(slot, col, row);
      }
    }
    const units = gm.rally.units;
    const p0 = units[0] ? { col: units[0].col, row: units[0].row } : null;
    for (let i = 0; i < 60; i++) gm.rally.tick(0.05);
    const p1 = units[0] ? { col: units[0].col, row: units[0].row } : null;
    return {
      drop: drop.ok, flag: gm.rally.flag, expectedFlag: c,
      slot, played: played ? { ok: played.ok, reason: played.reason ?? '' } : null,
      unitsBefore, unitsAfter: units.length,
      moved: p0 && p1 ? +Math.hypot(p1.col - p0.col, p1.row - p0.row).toFixed(2) : 0,
      dudesReady: gm.dudesReady, rallyEnabled: gm.rally.enabled,
    };
  })()`);
  await sleep(500);
  const shotRally = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/大地图_P091_集结军队_20261109.png`, Buffer.from(shotRally.data, 'base64'));

  // ===== 宝箱：独立时钟定期刷新 / 满金 50 也照样加 / 兵跑过去自动开箱 =====
  await sleep(3000);
  const clockSpawned = await ev(`window.__grandMap.chests.length`);
  const chestProbe = await ev(`(() => {
    const gm = window.__grandMap;
    const M = gm.map;
    const cap = 50;
    gm.state.factions[0].gold = cap;          // 专门验「到上限也能接着加」
    if (!gm.chests.length) gm.spawnChest();
    const ch = gm.chests[0];
    const before = gm.state.factions[0].gold;
    const collected = gm.collectChest(ch.id);
    const afterCollect = gm.state.factions[0].gold;
    // 再刷一个：把兵生成在箱子格，等下一帧由视图层「跑过去占领」自动开箱
    const ch2 = gm.spawnChest().chest;
    const cell = M.fromAbstract(ch2.r, ch2.c);
    const before2 = gm.state.factions[0].gold;
    gm.rally.spawn(cell.col, cell.row, 1, 'archers');
    return {
      chestGold: ch.gold, collected: collected.ok, before, afterCollect,
      overCap: afterCollect > cap, exact: afterCollect === before + ch.gold,
      walkChestId: ch2.id, before2,
    };
  })()`);
  await sleep(900); // 等 syncChests 检测到士兵进入箱子格
  const chestWalk = await ev(`(() => {
    const gm = window.__grandMap;
    const bank = document.querySelector('.ahud__bank');
    return {
      stillThere: gm.chests.some((c) => c.id === ${chestProbe.walkChestId}),
      gold: gm.state.factions[0].gold,
      bankText: document.querySelector('.ahud__bank__num')?.textContent,
      over: bank?.dataset['over'],
      cap: document.querySelector('.ahud__bank__cap')?.textContent,
    };
  })()`);

  // 截图放在开箱之后：既有宝箱，又能看到金币条上「超过 50」的真实读数
  await ev(`window.__grandMap.spawnChest(); 'ok'`);
  await sleep(250);
  const shotChest = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/大地图_P091_宝箱_20261109.png`, Buffer.from(shotChest.data, 'base64'));

  const panels = await ev(`(() => {
    const gm = window.__grandMap;
    gm.openMarket();
    const market = document.querySelector('.gm-market');
    const m = { visible: !market.hidden, hasNearFar: market.textContent.includes('近路') && market.textContent.includes('远路'),
                hasTargets: market.querySelectorAll('[data-action="target"]').length };
    gm.openDiplomacy(2);
    const dipl = document.querySelector('.gm-dipl');
    const d = { visible: !dipl.hidden, hasAlly: dipl.textContent.includes('结盟'),
                hasBackstabHint: dipl.textContent.includes('背刺') };
    return { market: m, diplomacy: d };
  })()`);

  const shotDay = await send('Page.captureScreenshot', { format: 'png' });
  const dayBuf = Buffer.from(shotDay.data, 'base64');
  writeFileSync(`${OUT}/大地图_P091_白天_20261109.png`, dayBuf);
  const day = pngStats(dayBuf);

  // 收掉浮层再截夜晚，别让面板挡住战场
  await ev(`document.querySelector('.gm-dipl [data-action="close"]')?.click();
            document.querySelector('.gm-market [data-action="close"]')?.click();
            window.__grandMap.setPeriod(3); 'night'`);
  await sleep(400);
  const nightTint = await ev(`document.querySelector('.gm-tint').style.background`);
  const cardNightBg = await ev(`(() => { const c = document.querySelector('.ahud__card');
    return c ? getComputedStyle(c).backgroundColor : ''; })()`);
  const uiPeriod = await ev(`document.getElementById('arena-ui').dataset.period`);
  const shotNight = await send('Page.captureScreenshot', { format: 'png' });
  const nightBuf = Buffer.from(shotNight.data, 'base64');
  writeFileSync(`${OUT}/大地图_P091_夜晚_20261109.png`, nightBuf);
  const night = pngStats(nightBuf);

  // 三档地图：改 URL + reload 之后真的换成小图（截图都拍完了再切，不影响上面的画面）
  const smallUrl = new URL(PAGE_URL);
  smallUrl.searchParams.set('size', 'sm');
  await send('Page.navigate', { url: smallUrl.toString() });
  await sleep(2600);
  const small = await ev(`(() => {
    const gm = window.__grandMap;
    return gm ? {
      size: gm.size, terrain: gm.map.terrainCells().length,
      center: gm.map.CENTER.size, active: window.__modActive,
    } : null;
  })()`);

  // 开始菜单：开发版模组要挂 DEV 角标，但仍能点进去
  const menuUrl = new URL(PAGE_URL);
  menuUrl.searchParams.delete('mod');
  menuUrl.searchParams.delete('size');
  await send('Page.navigate', { url: menuUrl.toString() });
  await sleep(2000);
  const devMenu = await ev(`(() => {
    const btn = document.querySelector('.start__row [data-dev="1"]');
    return { present: !!btn, text: btn?.textContent ?? '' };
  })()`);

  const checks = {
    '模组挂上': base.modActive === 'grand-map' && !base.fallback,
    '菜单有 DEV 开发版角标': devMenu.present && devMenu.text.includes('DEV'),
    '模组内 DEV 角标': base.devTag === true,
    '★ 地板是主程序 GroundView 立体块': base.floor?.engine === 'GroundView' &&
      base.floor.land > 880 * 12 && base.floor.sea === 0 && base.floor.surfaceY > 0.3,
    '左下角提示已收干净': !base.tipHasBreak && base.tipText.length < 40 && base.logLines <= 3,
    '四张主模式卡面': base.cards === 4 && base.handRoot && base.cardHasArt && base.cardWidth > 60,
    '默认最大档 / 地图远超竞技场': base.size === 'lg' && base.terrain > 880 * 12,
    '中心公共区随档位放大': base.centerSize === 33,
    '小 / 中 / 大三档按钮': base.sizeButtons === 3,
    '三档切换真的换图': small?.size === 'sm' && small.active === 'grand-map' &&
      small.terrain < base.terrain && small.center < base.centerSize,
    '内部六芒星 / 近路 / 对径': base.star > 50 && base.short > 50 && base.far > 20,
    '六方起点': base.claims === 12,
    '局部 / 全图镜头': base.zoom === 34 && base.viewRange?.local === 34 &&
      overviewShot === base.viewRange?.lg && backZoom === 34,
    '旧 UI 顶栏': base.topbar && base.oldTopbar && !base.topbarGold,
    '金币条回到手牌下方': base.bank && base.bankText !== '',
    '调试抽屉默认收起': base.debugOpen === false,
    '点击地面插旗': rallyProbe.drop && rallyProbe.flag?.col === rallyProbe.expectedFlag.col && rallyProbe.flag?.row === rallyProbe.expectedFlag.row,
    '军队卡出兵': rallyProbe.played?.ok === true && rallyProbe.unitsAfter > rallyProbe.unitsBefore,
    '士兵真的往旗子走': rallyProbe.moved > 1,
    '像素小人素材已加载': rallyProbe.dudesReady === true,
    '集结默认启用': rallyProbe.rallyEnabled === true,
    '宝箱按独立时钟定期刷新': clockSpawned > 0,
    '★ 满金 50 开箱照样加，不截断不丢弃': chestProbe.collected && chestProbe.overCap && chestProbe.exact,
    '★ 兵跑过去占领自动开箱': !chestWalk.stillThere && chestWalk.gold > chestProbe.before2,
    '金币条照实显示超额': Number(chestWalk.bankText) > 50 && chestWalk.over === 'true',
    '落牌成功': play.ok,
    '金币只扣一次': play.goldDelta === play.cost,
    '中心抽象网格同步': play.abstractSynced === true,
    '打出后留空格': play.cardEmptied,
    '集市面板开得开': panels.market.visible && panels.market.hasNearFar && panels.market.hasTargets === 5,
    '外交面板开得开': panels.diplomacy.visible && panels.diplomacy.hasAlly && panels.diplomacy.hasBackstabHint,
    '白天不是黑屏': day.brightness > 12 && day.colorBuckets > 12,
    '夜晚确实更暗': night.brightness < day.brightness,
    '夜晚 tint 生效': nightTint.includes('8, 16, 42') || nightTint.includes('8,16,42'),
    'HUD 卡面同步入夜': uiPeriod === 'night' && cardNightBg !== cardDayBg,
    '页面零异常': errors.length === 0,
    '主城模型装配无告警': warnings.length === 0,
  };

  console.log('BASE      ', JSON.stringify(base));
  console.log('PLAY      ', JSON.stringify(play));
  console.log('RALLY     ', JSON.stringify(rallyProbe));
  console.log('CHEST     ', JSON.stringify({ clockSpawned, chestProbe, chestWalk }));
  console.log('OVERVIEW  ', JSON.stringify({ overviewShot, backZoom }));
  console.log('SMALL     ', JSON.stringify(small));
  console.log('MENU      ', JSON.stringify(devMenu));
  console.log('PANELS    ', JSON.stringify(panels));
  console.log('DAY/NIGHT ', JSON.stringify({ day, night, nightTint }));
  console.log('ERRORS    ', JSON.stringify(errors));
  console.log('WARNINGS  ', JSON.stringify(warnings));
  console.log('---- CHECKS ----');
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`GATE ${failed.length ? 'FAIL' : 'PASS'} (${Object.keys(checks).length - failed.length}/${Object.keys(checks).length})`);
  if (failed.length) process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  child.kill();
}
