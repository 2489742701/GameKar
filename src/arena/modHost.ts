/**
 * 模组宿主（2026-11-08）—— 主程序和热插拔模组之间**唯一**的接触面。
 *
 * 设计见 `docs/工作笔记/大地图模组化架构_20261108.md`。三条红线：
 *   ① 模组不静态 import 主程序玩法（ArenaWorld / config / ArenaApp / ArenaHud）；
 *   ② 依赖靠 host 注入（three / engine / DOM），不重复打包、不搅乱主 chunk；
 *   ③ 模组坏了只 warn + 画一块提示，绝不把主程序拖下水。
 *
 * 这个文件只被薄薄的 `main.ts` 引用；vanilla.ts 完全不知道它存在。
 * 所有引擎依赖都是**动态** import —— 普通对战不会为模组多加载一个字节。
 *
 * ## 页面上的命名空间（2026-11-15）
 *
 * 模组挂到页面上之后，调试工具 / 无头探针要能读到它。约定是有**一个根命名空间**：
 *
 *     window.GamekarMods            ← 根，模组自己建、自己撤（空了要删掉）
 *       .active                     ← 当前挂着的模组 id
 *       .<modId>                    ← 各模组自己的探针面，互不干扰
 *
 * 主程序**不去写**这个对象（主程序不该知道有哪些模组），但测试会校验：
 * 模组不许再往 `window.__xxx` 上散挂全局（`__dbg` 是主程序自己的，别撞）。
 * 见 `tests/mod_isolation_20261108.test.ts` 的命名空间锁。
 */

import type { GameLoop, GameLoopOptions } from '@engine/core/GameLoop';

const MANIFEST_URL = '/mods/manifest.json';
const HOST_API = 1;
/** id / entry 都做白名单，别让 manifest 里的 `../` 把 import 拐到别处去 */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ENTRY_RE = /^[a-zA-Z0-9._-]+\.js$/;

export interface ModEntry {
  id: string;
  name: string;
  entry: string;
  api: number;
  /**
   * **开发版标记**（2026-11-09 用户："把这个大地图归成开发版"）。
   * `true` 的模组仍可从菜单进入（方便开发机随时看），但会挂 DEV 角标 +
   * 虚线边框，明确不是正式内容。正式发布时在 `loadManifest()` 里
   * 加一句 `&& !m.dev` 就能一处关掉全部开发版入口。
   */
  dev?: boolean;
  /**
   * **尚未实现**（2026-11-15 明确）。留着字段是为了将来做远程 HTTPS 增量更新时
   * 不用改清单格式；`loadManifest()` 现在**不读它**，写了也不会生效。
   *
   * 留着而不是删掉的理由：清单是**对外格式**，模组作者会照着写。
   * 所以这里必须让"写了也没用"这件事有声音 —— 见 `loadManifest()` 里的 warn。
   */
  remote?: string | null;
}

interface ModManifest {
  version: number;
  mods: ModEntry[];
}

export interface ModHost {
  readonly api: 1;
  readonly canvas: HTMLCanvasElement;
  readonly uiRoot: HTMLDivElement;
  /** three 的具名子集，见 modDeps.ts —— 不是完整命名空间 */
  readonly three: typeof import('./modDeps').modThree;
  /** 只借引擎，不借玩法 */
  readonly engine: typeof import('./modDeps').modEngine;
  /** 主游戏的 3D 视觉资产工厂（模型长得和 1v1 一模一样） */
  readonly assets: typeof import('./modDeps').modAssets;
  /** 开放 API：卡池 / 卡面图标 / 手牌工厂（卡牌驱动就靠它） */
  readonly modApi: typeof import('./modDeps').modApi;
  makeLoop(options: GameLoopOptions): GameLoop;
  toast(message: string): void;
  /** 清掉 ?mod= 并 reload —— 复用项目已有的「改 URL + reload」范式 */
  exit(): void;
}

interface GamekarMod {
  mount(host: ModHost): void | Promise<void>;
  unmount?(): void;
}

/** 读清单。fetch 失败 / 版本不对 / 字段不合法一律返回空数组，不抛。 */
export async function loadManifest(): Promise<ModEntry[]> {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as ModManifest;
    if (data.version !== 1 || !Array.isArray(data.mods)) return [];
    const accepted = data.mods.filter(
      (m) =>
        m &&
        ID_RE.test(m.id) &&
        ENTRY_RE.test(m.entry) &&
        m.api === HOST_API &&
        typeof m.name === 'string',
    );
    // `remote` 是**没有实现**的字段。清单里写了它的人会以为热更新能用，
    // 所以宁可吵一句，也不要安静地按本地文件加载。每个模组最多 warn 一次。
    for (const m of accepted) {
      if (m.remote) {
        console.warn(
          `[modHost] 模组 "${m.id}" 的 remote 字段**尚未实现**，本次仍按本地 /mods/ 加载：${m.remote}`,
        );
      }
    }
    return accepted;
  } catch (err) {
    console.warn('[modHost] 模组清单读不到（按"没装模组"处理）：', err);
    return [];
  }
}

/** 出错时画一块自包含的提示，不依赖主程序 CSS、也不碰 canvas。 */
function showFallback(reason: string): void {
  const ui = document.getElementById('arena-ui') ?? document.body;
  const box = document.createElement('div');
  box.style.cssText = [
    'position:absolute', 'inset:0', 'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center', 'gap:14px',
    'pointer-events:auto', 'color:#e8edf7', 'font:500 14px/1.6 system-ui,sans-serif',
    'text-align:center', 'padding:24px',
  ].join(';');
  const title = document.createElement('div');
  title.textContent = '模组没挂上';
  title.style.cssText = 'font-size:18px';
  const detail = document.createElement('div');
  detail.textContent = reason;
  detail.style.cssText = 'opacity:.7;max-width:32em';
  const back = document.createElement('button');
  back.textContent = '返回主程序';
  back.style.cssText = [
    'margin-top:8px', 'padding:10px 20px', 'border-radius:8px',
    'border:1px solid #4a5a72', 'background:#16202f', 'color:#e8edf7',
    'font:inherit', 'cursor:pointer',
  ].join(';');
  back.addEventListener('click', () => {
    const p = new URLSearchParams(location.search);
    p.delete('mod');
    location.href = location.pathname + (p.toString() ? `?${p}` : '');
  });
  box.append(title, detail, back);
  ui.append(box);
}

async function makeHost(): Promise<ModHost> {
  const canvas = document.getElementById('arena-stage');
  const uiRoot = document.getElementById('arena-ui');
  if (!(canvas instanceof HTMLCanvasElement) || !(uiRoot instanceof HTMLDivElement)) {
    throw new Error('arena.html 缺少 #arena-stage / #arena-ui');
  }

  // 只有真的进模组模式才会付这部分代价。
  // 必须走 modDeps 的具名导出：直接 import('three') 会钉住整个命名空间，
  // three chunk 从 496 KB 涨到 690 KB（见 modDeps.ts 注释）。
  const { modThree, modEngine, modAssets, modApi } = await import('./modDeps');

  return {
    api: 1,
    canvas,
    uiRoot,
    three: modThree,
    engine: modEngine,
    assets: modAssets,
    modApi,
    makeLoop: (options) => {
      const loop = new modEngine.GameLoop(options);
      loop.start();
      return loop;
    },
    toast: (message) => {
      const tip = document.createElement('div');
      tip.textContent = message;
      tip.style.cssText = [
        'position:absolute', 'left:50%', 'top:16px', 'transform:translateX(-50%)',
        'padding:8px 16px', 'border-radius:8px', 'background:#16202f',
        'border:1px solid #4a5a72', 'color:#e8edf7', 'pointer-events:none',
        'font:500 13px/1.4 system-ui,sans-serif',
      ].join(';');
      uiRoot.append(tip);
      window.setTimeout(() => tip.remove(), 2200);
    },
    exit: () => {
      const p = new URLSearchParams(location.search);
      p.delete('mod');
      location.href = location.pathname + (p.toString() ? `?${p}` : '');
    },
  };
}

/** 挂一个模组。任何一步失败都只提示，不抛到顶层。 */
export async function mountMod(id: string): Promise<void> {
  if (!ID_RE.test(id)) {
    showFallback(`模组 id 不合法：${id}`);
    return;
  }
  const mods = await loadManifest();
  const entry = mods.find((m) => m.id === id);
  if (!entry) {
    showFallback(`清单里没有这个模组：${id}（或 api 版本不匹配）`);
    return;
  }
  try {
    const host = await makeHost();
    // 变量 URL + @vite-ignore：否则 Vite 会在构建期去解析这个运行期才存在的路径
    const url = `/mods/${encodeURIComponent(id)}/${entry.entry}`;
    const mod = (await import(/* @vite-ignore */ url)) as GamekarMod;
    if (typeof mod.mount !== 'function') {
      showFallback(`${entry.name} 没有导出 mount(host)`);
      return;
    }
    await mod.mount(host);
    hookTeardown(mod);
  } catch (err) {
    console.warn(`[modHost] 模组 ${id} 加载失败：`, err);
    showFallback(`${entry.name} 加载失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 把模组的 `unmount()` 接到**真正会发生的时刻**（2026-11-15 补）。
 *
 * 起因：`unmount?()` 在契约里躺了很久，模组也老老实实实现了完整的清理
 * （停循环、dispose 场景、删探针钩子），但**全项目 0 个调用点** —— 死代码。
 *
 * 为什么不用「运行时卸载模组」那条路：`ArenaApp` 没有整体 dispose，
 * 硬做就得改主程序（见架构文档 §2）。但**页面正在离开**是另一回事：
 * 这时不做任何"切回主程序"的假设，只是让 WebGL 上下文、rAF、window 监听
 * 在该释放的时候放掉 —— 尤其手机上，WebView 返回/切后台时能省掉一轮泄漏。
 *
 * 两个钩子都挂上，因为它们的触发时机不重叠：
 *   `pagehide` —— 前进/后退、关标签、移动端切后台（最可靠的那个）
 *   `beforeunload` —— 桌面端刷新/关闭，某些浏览器只给这一个
 * 用 once + 幂等标记，保证只跑一次（两个钩子可能先后都触发）。
 */
function hookTeardown(mod: GamekarMod): void {
  if (typeof mod.unmount !== 'function') return;
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    try {
      mod.unmount?.();
    } catch (err) {
      // 清理失败只记一笔：这时候页面已经在走了，不能因此拦住导航
      console.warn('[modHost] 模组 unmount 抛错（已被吞掉，不影响离开页面）：', err);
    }
  };
  window.addEventListener('pagehide', run, { once: true });
  window.addEventListener('beforeunload', run, { once: true });
}

/**
 * 普通模式下把模组按钮追加到开始菜单的模式行。
 * `StartMenu.ts` 一行都不用改 —— 这里只认它已经存在的 `.start__row`。
 * 读清单是异步的，所以同时做「立即试一次」+「MutationObserver 等菜单出现」。
 */
export function injectModButtons(): void {
  // 无头探针 / 截图通道跳过菜单，别让 observer 对着每帧刷新的 HUD 空转
  const p = new URLSearchParams(location.search);
  if (p.get('auto') || p.get('play')) return;
  void loadManifest().then((mods) => {
    if (!mods.length) return;
    const append = (): boolean => {
      const row = document.querySelector<HTMLElement>('.start__row');
      if (!row || row.dataset['modsInjected'] === '1') return false;
      row.dataset['modsInjected'] = '1';
      for (const m of mods) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'start__btn start__btn--pve';
        btn.textContent = m.name;
        btn.dataset['mod'] = m.id;
        if (m.dev) {
          btn.dataset['dev'] = '1';
          btn.title = '开发版模组：仍在迭代，随时可能改动或撤回';
          // 角标样式内联，一行都不改 start.css
          btn.style.borderStyle = 'dashed';
          btn.style.borderColor = '#d8b25c';
          const tag = document.createElement('span');
          tag.textContent = 'DEV';
          tag.style.cssText = 'margin-left:6px;font-size:10px;letter-spacing:.08em;color:#f6dc9c';
          btn.append(tag);
        }
        btn.addEventListener('click', () => {
          const p = new URLSearchParams(location.search);
          p.set('mod', m.id);
          location.search = p.toString();
        });
        row.append(btn);
      }
      return true;
    };
    if (append()) return;
    // 只盯 #arena-ui（StartMenu 就挂在这里），不要盯整个 body
    const ui = document.getElementById('arena-ui');
    if (!ui) return;
    const observer = new MutationObserver(() => {
      if (append()) observer.disconnect();
    });
    observer.observe(ui, { childList: true, subtree: true });
  });
}
