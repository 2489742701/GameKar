/**
 * 模组隔离锁（2026-11-08）—— 用户："大世界改成热插拔，最好别污染主程序"。
 *
 * 这一族锁的是**结构**，不是玩法：
 *   · 主程序 src/ 里不许出现任何指向 mods/ 的静态 import；
 *   · 入口必须是薄分流器，原入口原样留在 vanilla.ts；
 *   · 动态 import 的 @vite-ignore 不能删（删了 Vite 构建期会去找运行期才有的路径）；
 *   · manifest 的 id / entry / api 闸门不能松（防路径穿越 + 旧模组崩主程序）；
 *   · 模组自身不许有 import 语句，依赖全靠 host 注入。
 *
 * 每条都带**反证**：把违规写法放回去，锁必须红。
 * 详见 `docs/工作笔记/大地图模组化架构_20261108.md`。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadManifest } from '@arena/modHost';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** 和真实扫描用的是同一个判据 —— 反证锁才有意义。 */
const FORBIDDEN_MOD_IMPORT = /(?:from\s+|import\s*\(\s*)['"][^'"]*\/mods\//;
const hasForbiddenModImport = (src: string): boolean => FORBIDDEN_MOD_IMPORT.test(src);

/** 结构锁只管代码：注释里写"不许引用 ArenaApp"是文档，不是引用。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allSourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe('主程序不许静态引用模组', () => {
  it('反证：这条判据真的能抓到违规写法', () => {
    expect(hasForbiddenModImport("import { x } from './mods/grand-map/index.js';")).toBe(true);
    expect(hasForbiddenModImport("const m = await import('../public/mods/x.js');")).toBe(true);
    expect(hasForbiddenModImport("const url = '/mods/' + id;")).toBe(false); // 运行期 URL 是允许的
    expect(hasForbiddenModImport("import { loadManifest } from './modHost';")).toBe(false);
  });

  it('src/ 全表扫描：一处静态 import 都不许有', () => {
    const files = allSourceFiles(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(50);
    const bad = files.filter((p) => hasForbiddenModImport(readFileSync(p, 'utf8')));
    expect(bad).toEqual([]);
  });

  it('入口是薄分流器：不认识 ArenaApp / StartMenu / ArenaWorld / ArenaHud', () => {
    const main = read('src/arena/main.ts');
    const code = stripComments(main);
    expect(code).toContain("await import('./vanilla')");
    expect(code).toContain('mountMod(modId)');
    expect(code).toContain('injectModButtons()');
    for (const word of ['ArenaApp', 'StartMenu', 'ArenaWorld', 'ArenaHud', "from './config'"]) {
      expect(code, `分流器不该出现 ${word}`).not.toContain(word);
    }
    // 反证：把 import 塞回代码里，这条判据必须能抓到
    expect(stripComments("import { ArenaApp } from './ArenaApp';")).toContain('ArenaApp');
    expect(hasForbiddenModImport(code)).toBe(false);
  });

  it('vanilla.ts 还是原来那份入口，且完全不知道模组存在', () => {
    const vanilla = read('src/arena/vanilla.ts');
    expect(vanilla).toContain('await ArenaApp.boot(');
    expect(vanilla).toContain('new StartMenu(');
    expect(vanilla).toContain('window.arena = app;');
    expect(vanilla).toContain('declare global');
    expect(vanilla).not.toContain('modHost');
    expect(vanilla).not.toContain('?mod=');
  });

  it('arena.html / vite.config.ts 一行没改（分流靠入口，不靠配置）', () => {
    expect(read('arena.html')).toContain('/src/arena/main.ts');
    const vite = read('vite.config.ts');
    expect(vite).toContain("./index.html");
    expect(vite).toContain("./arena.html");
    expect(vite).not.toContain('mods');
  });
});

describe('modHost 的加载闸门', () => {
  it('反证：删掉 @vite-ignore，构建期就会去解析运行期才存在的模组路径', () => {
    const host = read('src/arena/modHost.ts');
    expect(host).toContain('import(/* @vite-ignore */ url)');
    expect(host).toContain("const url = `/mods/${encodeURIComponent(id)}/${entry.entry}`");
    expect(host).toContain('showFallback');
  });

  it('反证：host 不许 import three 完整命名空间（会把共享 chunk 撑大 39%）', () => {
    // 注释里写了"不许 import('three')"是文档，只扫代码
    const host = stripComments(read('src/arena/modHost.ts'));
    const deps = stripComments(read('src/arena/modDeps.ts'));
    expect(host).toContain("await import('./modDeps')");
    expect(host).not.toContain("import('three')");
    expect(deps).toContain('export const modThree');
    expect(deps).toContain('export const modEngine');
    // 这里必须用具名 import，不能整包塞进命名空间对象
    expect(deps).toContain("} from 'three'");
    expect(deps).not.toContain('import * as THREE');
    // 反证：把整包 import 放回代码，判据必须抓到
    expect(stripComments("const T = await import('three');")).toContain("import('three')");
  });

  it('清单读不到 / 版本不对 ⇒ 返回空数组，绝不抛', async () => {
    vi.stubGlobal('console', { ...console, warn: vi.fn() });
    vi.stubGlobal('fetch', async () => ({ ok: false }));
    expect(await loadManifest()).toEqual([]);
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    expect(await loadManifest()).toEqual([]);
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ version: 9, mods: [] }) }));
    expect(await loadManifest()).toEqual([]);
  });

  it('反证：路径穿越的 id、非法 entry、api 不匹配的条目全被挡掉', async () => {
    vi.stubGlobal('console', { ...console, warn: vi.fn() });
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        version: 1,
        mods: [
          { id: 'grand-map', name: '大地图', entry: 'index.js', api: 1 },
          { id: '../evil', name: '越界', entry: 'index.js', api: 1 },
          { id: 'traverse', name: '越界文件', entry: '../../secrets.js', api: 1 },
          { id: 'old', name: '旧模组', entry: 'index.js', api: 99 },
        ],
      }),
    }));
    expect((await loadManifest()).map((m) => m.id)).toEqual(['grand-map']);
  });
});

describe('模组自身是零静态依赖的自包含 ESM', () => {
  const manifest = JSON.parse(read('public/mods/manifest.json')) as {
    version: number;
    mods: { id: string; name: string; entry: string; api: number }[];
  };

  it('清单版本与 host 契约一致，且入口文件真的存在', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.mods.length).toBeGreaterThan(0);
    for (const m of manifest.mods) {
      expect(m.api).toBe(1);
      expect(existsSync(join(ROOT, 'public/mods', m.id, m.entry))).toBe(true);
    }
  });

  it('反证：模组用到的每个 host.three 成员都必须在 modDeps 白名单里', () => {
    const deps = read('src/arena/modDeps.ts');
    const block = deps.slice(deps.indexOf('export const modThree'), deps.indexOf('export const modEngine'));
    const provided = new Set([...block.matchAll(/^\s*(\w+),?\s*$/gm)].map((m) => m[1]!));
    const missingOf = (used: string[]) => used.filter((k) => !provided.has(k));
    expect(provided.has('Group')).toBe(true); // 这次真踩过：漏注入 Group 会让 mount 直接失败
    for (const m of manifest.mods) {
      const src = read(`public/mods/${m.id}/${m.entry}`);
      const used = [...new Set([...src.matchAll(/\bT\.(\w+)/g)].map((x) => x[1]!))];
      expect(missingOf(used), `模组用到的 three 成员没注入：${used.join(', ')}`).toEqual([]);
    }
    // 反证：把没注入的成员塞回去，判据必须抓到
    expect(missingOf(['WebGLRenderer', 'NotInjected'])).toEqual(['NotInjected']);
  });

  it('反证：模组里出现任何 import 语句都算破坏隔离', () => {
    for (const m of manifest.mods) {
      const src = read(`public/mods/${m.id}/${m.entry}`);
      // 注释里提到 "import" 无所谓，只锁真正的语句（行首 import）
      expect(src).not.toMatch(/^\s*import\s/m);
      expect(src).toContain('host.three');       // 依赖来自注入
      expect(src).toContain('export function mount');
      expect(src).toContain('export function unmount');
      expect(src).toContain('host.exit()');
    }
    expect("import { x } from '@arena/ArenaWorld';").toMatch(/^\s*import\s/m);
  });
});
