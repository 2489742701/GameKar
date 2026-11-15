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

describe('模组自身不静态依赖主程序（允许内部相对 import）', () => {
  const manifest = JSON.parse(read('public/mods/manifest.json')) as {
    version: number;
    mods: { id: string; name: string; entry: string; api: number }[];
  };

  /** 模组根目录下的 .js（不含 tests/），合并成一份文本做静态断言 */
  const modSources = (): string[] => {
    const out: string[] = [];
    for (const m of manifest.mods) {
      const dir = join(ROOT, 'public/mods', m.id);
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.js')) out.push(readFileSync(join(dir, name), 'utf8'));
      }
    }
    return out;
  };

  /** 只锁"真正的 import 来源"：模组内部 ./ 相对路径可以，主程序/three 一律不行 */
  const forbiddenDeps = (src: string): string[] =>
    [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1]!)
      .filter((spec) => !spec.startsWith('./'));

  it('清单版本与 host 契约一致，且入口文件真的存在', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.mods.length).toBeGreaterThan(0);
    for (const m of manifest.mods) {
      expect(m.api).toBe(1);
      expect(existsSync(join(ROOT, 'public/mods', m.id, m.entry))).toBe(true);
    }
  });

  it('反证：模组拆成几个文件没问题，但绝不能 import 主程序 / three', () => {
    const all = stripComments(modSources().join('\n'));
    expect(modSources().length).toBeGreaterThanOrEqual(3); // rules / view / index
    expect(forbiddenDeps(all)).toEqual([]);
    // 反证：这些写法放回去必须被抓到
    expect(forbiddenDeps("import { ArenaWorld } from '@arena/ArenaWorld';")).toContain('@arena/ArenaWorld');
    expect(forbiddenDeps("import * as T from 'three';")).toContain('three');
    expect(forbiddenDeps("import { createGame } from './rules.js';")).toEqual([]);
  });

  it('入口契约齐全：mount / unmount / host.exit() 都在', () => {
    const all = stripComments(modSources().join('\n'));
    expect(all).toContain('export function mount');
    expect(all).toContain('export function unmount');
    expect(all).toContain('host.exit()');
    expect(all).toContain('host.makeLoop');       // 循环用注入的引擎，不自己 setInterval
    expect(all).not.toContain('setInterval');
  });

  /**
   * 注入面白名单（2026-11-15 补齐）。
   *
   * 原来这条只扫 `T.*`（three），`A.*`（modAssets）和 `API.*`（modApi）是**无锁**的 ——
   * 实测在 view.js 里写一行 `A.ThisMemberDoesNotExist`，42 条锁全绿，直到运行期才崩。
   * 而架构文档 §2.4 记的第一次事故（`T.Group is not a constructor`）正是同一类问题。
   *
   * ⚠️ 难点：注入到模组的句柄有**两种**传递方式，只认第一种会漏掉一半文件：
   *   ① `const A = host.assets`  —— view.js 用的；
   *   ② 函数形参 `export function createSky(T, ...)` 由 view.js 传 `T` 进来 —— sky.js / hand.js 用的。
   * 早先的版本只扫 `T.*` 且按字面别名，所以 sky.js 里的 `T.NopeGroup` 和 hand.js 里的
   * `api.NotARealMember` 都**静默通过**（实测）。现在两种都认，且逐文件解析各自的绑定。
   */
  it('反证：模组用到的每一个注入成员（three / assets / modApi）都必须真的注入了', () => {
    const deps = read('src/arena/modDeps.ts');
    /** 从 `export const <name> = { ... }` 里抠出键名 */
    const keysOf = (name: string): Set<string> => {
      const start = deps.indexOf(`export const ${name}`);
      expect(start, `modDeps.ts 里找不到 ${name}`).toBeGreaterThanOrEqual(0);
      const end = deps.indexOf('\n};', start);
      const block = deps.slice(start, end);
      return new Set([...block.matchAll(/^\s+(\w+)\s*[,:]/gm)].map((m) => m[1]!));
    };
    const byKind = {
      T: keysOf('modThree'),
      A: keysOf('modAssets'),
      API: keysOf('modApi'),
    };
    for (const [kind, keys] of Object.entries(byKind)) {
      expect(keys.size, `modThree/modAssets/modApi 里的 ${kind} 一个成员都没解析出来`).toBeGreaterThan(2);
    }

    // 逐文件的"别名 → 注入种类"映射。两种来源都收：
    //   显式绑定：const T = host.three / const A = host.assets / const API = host.modApi
    //   形参绑定：由 view.js 把自己的绑定当实参传进 createSky(T,...) / createHand(API,...)
    const kindOfAlias = new Map<string, string>([
      ['T', 'T'], ['A', 'A'], ['API', 'API'],
      // 形参名到种类的对应：createHand(api, ...) 收的是 host.modApi
      ['api', 'API'],
    ]);

    const violations: string[] = [];
    let scanned = 0;
    for (const src of modSources()) {
      const code = stripComments(src);
      // 显式绑定优先：文件自己声明了什么就用什么（防止把别的变量误判成注入）
      const declared = new Map<string, string>();
      for (const [, alias, prop] of code.matchAll(/const\s+(\w+)\s*=\s*host\.(\w+)/g)) {
        const kind = prop === 'three' ? 'T' : prop === 'assets' ? 'A' : prop === 'modApi' ? 'API' : null;
        if (kind) declared.set(alias!, kind);
      }
      // 形参注入：扫 `export function name(<形参列表>)` 里出现的已知注入名
      for (const [, params] of code.matchAll(/export function \w+\s*\(([^)]*)\)/g)) {
        for (const raw of params!.split(',')) {
          const name = raw.trim().split(/[\s=]/)[0]!;
          if (!name || declared.has(name)) continue;
          const kind = kindOfAlias.get(name);
          if (kind) declared.set(name, kind);
        }
      }

      for (const [alias, kind] of declared) {
        const used = [...new Set(
          [...code.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))].map((m) => m[1]!),
        )];
        scanned += used.length;
        const keys = byKind[kind as keyof typeof byKind]!;
        for (const member of used) {
          if (!keys.has(member)) violations.push(`${alias}.${member}（${kind} 注入面里没有 ${member}）`);
        }
      }
    }
    expect(scanned, '一个注入成员都没扫到，判据失效了').toBeGreaterThan(40);
    expect(violations, `模组用了没注入的成员：\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('反证：这条白名单判据本身抓得住缺成员（喂假数据必须红）', () => {
    const provided = new Set(['Group', 'Mesh', 'Scene']);
    const missingOf = (used: string[]): string[] => used.filter((k) => !provided.has(k));
    expect(missingOf(['Group', 'Scene'])).toEqual([]);
    expect(missingOf(['Group', 'ThisMemberDoesNotExist'])).toEqual(['ThisMemberDoesNotExist']);
    // 而 modDeps 的真实白名单里，确实没这个成员 —— 与上面一致
    expect(read('src/arena/modDeps.ts')).not.toContain('ThisMemberDoesNotExist');
    // 形参路径也必须被覆盖：sky.js / hand.js 是靠实参注入的，不能只锁显式 const 绑定
    const sky = stripComments(read('public/mods/grand-map/sky.js'));
    expect(sky).toMatch(/export function createSky\(\s*\w+/);
    expect(sky).toContain('T.');
  });
});
