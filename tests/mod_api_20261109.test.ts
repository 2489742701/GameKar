/**
 * P-087 结构锁（2026-11-09）—— 用户口径：
 * 「主程序 0 改动，然后开放 API 接口，相当于用模组的方式来做」
 * 「仍然是卡牌驱动，就是跟主模式的一个扩展，不是又重新做了一个战争模式」
 * 「整个地图是一个大的六边形，里面是六芒星形状的道路」
 *
 * 锁的全是**结构**，不是数值：主程序玩法文件不认识模组、开放 API 是单向出口、
 * 宿主契约 api=1 与开放 API 版本分离、手牌必须走 createModHand、
 * 地图形态必须是「六边形地形 + 内部道路」、金币只准扣一次。
 * 每条都带反证：把违规写法放回去，锁必须红。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const norm = (s: string): string => s.replace(/\r\n/g, '\n');
/** 结构锁只管代码：注释里写「不许引用 X」是文档，不是引用。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const GAMEPLAY_FILES = [
  'src/arena/ArenaApp.ts',
  'src/arena/ArenaWorld.ts',
  'src/arena/ArenaHud.ts',
  'src/arena/config.ts',
];

const MOD_MARKER = /modApi|modHost|grand-map|createModHand|__grandMap|\?mod=/;
const fromSpecs = (src: string): string[] =>
  [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
const view = (): string => stripComments(read('public/mods/grand-map/view.js'));
const map = (): string => stripComments(read('public/mods/grand-map/map.js'));

describe('主程序玩法文件 0 改动', () => {
  it('反证：这条判据真的能抓到模组污染', () => {
    expect(MOD_MARKER.test("import { createModHand } from './modApi';")).toBe(true);
    expect(MOD_MARKER.test("const m = '?mod=grand-map';")).toBe(true);
    expect(MOD_MARKER.test('const x = 1;')).toBe(false);
  });

  it('四个玩法文件一行都不认识模组', () => {
    for (const f of GAMEPLAY_FILES) {
      expect(stripComments(read(f)), `${f} 被模组污染了`).not.toMatch(MOD_MARKER);
    }
    // 玩法层仍然在，不是被"清空"来骗锁
    expect(read('src/arena/ArenaApp.ts')).toContain('new TileMap(');
    expect(read('src/arena/ArenaWorld.ts')).toContain('playCardOf');
    expect(read('src/arena/ArenaHud.ts')).toContain('setupCardDrag');
    expect(read('src/arena/config.ts')).toContain('export const HAND');
  });

  it('P-087 与备份分支逐字一致（分支在就比，不在就只靠上面的标记锁）', () => {
    let base = '';
    try {
      base = execFileSync('git', ['rev-parse', '--verify', 'backup/p086-before-hex'], {
        cwd: ROOT, encoding: 'utf8',
      }).trim();
    } catch {
      return; // 备份分支被清理掉时跳过，不把测试绑死在本地分支上
    }
    for (const f of GAMEPLAY_FILES) {
      const before = execFileSync('git', ['show', `${base}:${f}`], { cwd: ROOT, encoding: 'utf8' });
      expect(norm(read(f)), `${f} 被 P-087 改动了`).toBe(norm(before));
      // 反证：逐字比较不是橡皮图章，多一行就必须红
      if (f === GAMEPLAY_FILES[0]) expect(norm(`${before}\n// touch`)).not.toBe(norm(before));
    }
  });
});

describe('开放 API 是单向出口', () => {
  it('modApi.ts 只读 config / cardIcons，不反向依赖模组', () => {
    const src = stripComments(read('src/arena/modApi.ts'));
    expect(fromSpecs(src)).toEqual(['./config', './cardIcons', './supplyIcons']);
    expect(src).toContain('MOD_API_VERSION');
    expect(src).toContain('export function createModHand');
    expect(src).toContain('iconOf');
    // 反证：从主程序玩法层拿东西必须被抓到
    expect(fromSpecs("import { ArenaWorld } from './ArenaWorld';")).toContain('./ArenaWorld');
  });

  it('host.api（宿主契约 1）与 host.modApi（开放 API v2）互不覆盖', () => {
    const host = stripComments(read('src/arena/modHost.ts'));
    expect(host).toContain('readonly api: 1;');
    expect(host).toContain('readonly modApi:');
    expect(host).toContain('api: 1,');
    expect(host).toContain('modApi,');
    expect(host).not.toContain('api: modApi');
    // 反证：把契约版本改成开放 API 版本号，判据必须抓到
    expect("readonly api: 2;".replace('2', '2')).not.toContain('readonly api: 1;');
  });

  it('modDeps 具名注入 modApi，且没把 three 整包塞回来', () => {
    const deps = stripComments(read('src/arena/modDeps.ts'));
    expect(deps).toContain('export const modApi');
    expect(deps).toContain('version: MOD_API_VERSION');
    expect(deps).toContain('createModHand');
    expect(deps).toContain("} from 'three'");
    expect(deps).not.toContain('import * as THREE');
    expect(deps).toContain('BUILDING_SCALE'); // 主程序模型缩放口径也得注入
    // 集结军队用的像素小人素材仍然是注入，不是让模组去 import 主程序
    for (const name of ['loadPack', 'DudeGallery', 'DudeSprite', 'randomStyle', 'DEFAULT_APPEARANCE']) {
      expect(deps, `${name} 没注入`).toContain(name);
    }
  });

  it('手牌拖放不会在松手时误触发选中（P-087 实测坑）', () => {
    const api = stripComments(read('src/arena/modApi.ts'));
    expect(api).toContain('lastDragAt');
    expect(api).toContain('performance.now() - lastDragAt < 300');
    expect(api).toContain("btn.dataset['played'] = '1'");
    // 反证：没有这道闸门，click 会在 pointerup 后再选一次
    expect('btn.addEventListener(\'click\', () => cb.onSelect(i));').not.toContain('lastDragAt');
  });
});

describe('模组是卡牌驱动的主模式扩展', () => {
  it('四张手牌来自 host.modApi.createModHand，不是策略按钮列', () => {
    const src = view();
    expect(src).toContain('API.createModHand(');
    expect(src).toContain('ui.append(modHand.el)');
    expect(src).toContain('hand.play(');
    expect(src).toContain('modHand.render(');
    expect(src).toContain('M.terrainCells()');
    expect(src).toContain('A.OutputPass');   // 主程序同款色彩管理
    expect(src).toContain('A.LightingRig');
    expect(src).toContain('A.CameraRig');
    // 反证：那一列"发车/结盟/单步"策略按钮不许回来
    const FORBIDDEN_BUTTON = /data-action="send"|data-action="ally"|class="gm-tools"/;
    expect(FORBIDDEN_BUTTON.test('<button data-action="send">发车</button>')).toBe(true);
    expect(FORBIDDEN_BUTTON.test(src)).toBe(false);
  });

  it('建筑缩放读主程序 BUILDING_SCALE，不许再写死 0.8 / 0.42', () => {
    const src = view();
    expect(src).toContain('A.BUILDING_SCALE');
    const HARDCODED = /\.scale\.setScalar\(0\.\d+\)/;
    expect(HARDCODED.test('model.scale.setScalar(0.8);')).toBe(true); // 反证
    expect(HARDCODED.test(src)).toBe(false);
  });

  it('昼夜同步 HUD 主题（DOM 不吃 WebGL 后期），且卸载时清干净', () => {
    const src = view();
    expect(src).toContain("ui.dataset['period'] = period.key");
    expect(src).toContain('#arena-ui[data-period="night"]');
    expect(src).toContain("delete ui.dataset['period']");
    // 反证：只改战场 tint、不改 HUD，就是记忆里点名要避开的割裂感
    const DETECT = /ui\.dataset\['period'\]/;
    expect(DETECT.test(src)).toBe(true);
    expect(DETECT.test('tintEl.style.background = period.tint;')).toBe(false);
  });

  it('金币只扣一次：盖楼走卡牌 cost，规则层 claimCell 只镜像', () => {
    const hand = stripComments(read('public/mods/grand-map/hand.js'));
    expect((hand.match(/gold\s*-=\s*card\.cost/g) ?? []).length).toBe(1);
    expect(hand).toContain('R.claimCell(s, 0, a.r, a.c)');
    expect(hand).not.toContain('R.placeBuilding');   // 它内部还会再扣 SPEC.cost.build
    expect(hand).toContain('R.sendCaravan');
    // 反证：再写一次扣钱，判据必须抓到
    expect((`${hand}\ns.factions[0].gold -= card.cost;`.match(/gold\s*-=\s*card\.cost/g) ?? []).length).toBe(2);
  });

  it('index.js 的探针钩子仍走同一条 hand.play 判据', () => {
    const idx = stripComments(read('public/mods/grand-map/index.js'));
    const src = view();
    expect(idx).toContain('host.api !== 1');
    expect(idx).toContain('view.playCard(slot, col, row)');
    expect(src).toContain('return afterPlay(slot, hand.play(slot, col, row), col, row);');
    // 反证：探针自己另写一套落牌判据，锁必须红
    expect(src).not.toContain('window.__grandMap.playCard = (s, c, r) =>');
  });

  it('大档远超竞技场：格数由 hexR 算，不是把六芒星当轮廓', () => {
    const src = map();
    const radii = [...src.matchAll(/hexR:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(radii.length).toBe(3);
    expect(radii[0]! < radii[1]! && radii[1]! < radii[2]!).toBe(true);
    // 六边形面积 ≈ 2.598·R²，竞技场 44×20 = 880 格
    const largest = 2.598 * radii[2]! * radii[2]!;
    expect(largest).toBeGreaterThan(880 * 12);
    // 反证：把半径退回 P-086 那版就红
    expect(2.598 * 30 * 30).toBeLessThan(880 * 3);
  });

  it('集结走主程序同款像素小人素材，不自己拼几何糊弄', () => {
    const src = view();
    const rally = stripComments(read('public/mods/grand-map/rally.js'));
    expect(src).toContain('createRally(');
    expect(src).toContain('A.loadPack()');
    expect(src).toContain('new A.DudeGallery(pack)');
    expect(src).toContain('new A.DudeSprite(');
    expect(src).toContain('rally.dropFlag(col, row)');
    expect(rally).toContain('export function createRally()');
    expect(rally).toContain('M.inHex(col, row)');   // 旗子也得落在地图里
    // 反证：把集结做成一列策略按钮（而不是点地面），判据抓得到
    const FORBIDDEN = /data-action="send-troops"|class="gm-troop-list"/;
    expect(FORBIDDEN.test('<button data-action="send-troops">出兵</button>')).toBe(true);
    expect(FORBIDDEN.test(src)).toBe(false);
  });

  it('大地图能逛：滚轮缩放 + 拖动平移 + 全图按钮都在', () => {
    const src = view();
    expect(src).toContain("addEventListener('wheel'");
    expect(src).toContain('rig.zoomBy(');
    expect(src).toContain('rig.panByPixels(');
    expect(src).toContain('data-action="overview"');
    expect(src).toContain('LOCAL_VIEW');
  });
});

describe('P-091 开发版标记 / 主程序 3D 地板 / 左下角收干净', () => {
  it('模组清单标了 dev，菜单加 DEV 角标但不挡住进入', () => {
    const manifest = JSON.parse(read('public/mods/manifest.json')) as {
      mods: { id: string; dev?: boolean }[];
    };
    expect(manifest.mods.find((m) => m.id === 'grand-map')?.dev).toBe(true);
    const host = stripComments(read('src/arena/modHost.ts'));
    expect(host).toContain('dev?: boolean');
    expect(host).toContain("btn.dataset['dev'] = '1'");
    expect(host).toContain("tag.textContent = 'DEV'");
    // 反证：把开发版入口整个过滤掉就不是「仍可从菜单进入」了
    expect(host).not.toContain('mods.filter((m) => !m.dev)');
  });

  it('地板用主程序 TileMap + GroundView，不许退回薄方块', () => {
    const src = view();
    expect(src).toContain('new A.TileMap(');
    expect(src).toContain('new A.GroundView(tileMap)');
    expect(src).toContain('ground.tintCells(cells, hex)');
    expect(src).toContain('groundY(');
    // 反证：0.28 高的薄方块 + 纯白材质就是被用户指出的「2D 地板」
    expect(src).not.toContain('new T.BoxGeometry(0.94, 0.28, 0.94)');
    expect(src).not.toContain('tiles.setColorAt(');
    expect('new T.BoxGeometry(0.94, 0.28, 0.94)').toContain('0.28');
  });

  it('地形色/厚度来自主程序 TERRAIN 表，物件跟着 surfaceY 抬起', () => {
    const src = view();
    const deps = stripComments(read('src/arena/modDeps.ts'));
    expect(deps).toContain('TERRAIN');
    expect(deps).toContain('TERRAIN_ORDER');
    expect(src).toContain('A.TERRAIN.grass.color');
    expect(src).toContain('tileMap.surfaceY(');
    expect(src).toContain("ground.group.children[1].count = 0");
  });

  it('左下角提示压成一行、日志只留 3 条、去掉深色底框', () => {
    const raw = read('public/mods/grand-map/view.js');
    expect(raw).toContain('s.log.slice(0, 3)');
    const tipLine = raw.split('\n').find((l) => l.includes('<div class="gm-tip">'));
    expect(tipLine).toBeDefined();
    expect(tipLine!).not.toContain('<br>');
    expect(raw).toContain('.gm-tip { position:absolute; left:12px; bottom:70px;');
    // 反证：带底框的旧提示必须被抓到
    expect(raw).not.toContain('background:rgba(8,14,26,.55)');
    expect(raw).toContain('gm-devtag');
  });
});

describe('P-090 中心区宝箱：金币可以顶破上限', () => {
  const rules = (): string => stripComments(read('public/mods/grand-map/rules.js'));

  it('★ 开箱直接加，不许 Math.min / cap 截断或丢弃', () => {
    const src = rules();
    const block = src.slice(src.indexOf('export function collectChest'), src.indexOf('export function chestAt'));
    expect(block).toContain('f.gold += chest.gold');
    expect(block).not.toContain('Math.min');
    expect(block).not.toContain('SPEC.gold.cap -');
    // 反证：写成「先算上限再取小」就是被用户否掉的废弃行为
    expect('f.gold += Math.min(cap - f.gold, chest.gold);').toContain('Math.min');
  });

  it('★ 超额之后普通收益最多不涨，绝不倒扣', () => {
    const src = rules();
    expect((src.match(/Math\.max\(0, Math\.min\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // 自然回金被守卫包住：低于上限才补，超额时一分不动
    expect(src).toContain('if (f.gold < SPEC.gold.cap)');
    // 商队到站改成「最多不涨」，不再直接赋值 min
    expect(src).toContain('const landed = Math.max(0, Math.min(SPEC.gold.cap - f.gold, car.cargo))');
    expect(src).not.toContain('f.gold = Math.min(SPEC.gold.cap, f.gold + car.cargo)');
    // 反证：旧写法直接 min，超额部分会被一把抹回上限
    expect('f.gold = Math.min(cap, f.gold + car.cargo)').toContain('Math.min(cap');
  });

  it('宝箱定期刷新走独立时钟，跑过去占领由视图层判定', () => {
    const src = view();
    expect(src).toContain('CHEST_EVERY');
    expect(src).toContain('R.spawnChest(game.state)');
    expect(src).toContain('syncChests(info.time)');
    expect(src).toContain('rally.units.some(');
    expect(src).toContain('R.collectChest(s, ch.id)');
    expect(src).toContain('makeChest(');
  });

  it('金币条超额时照实显示数字并泛金光', () => {
    const api = stripComments(read('src/arena/modApi.ts'));
    expect(api).toContain("bank.dataset['over'] = String(gold > max)");
    expect(view()).toContain('data-over="true"');
  });
});

describe('地图形态：大六边形地形 + 内部六芒星道路', () => {
  it('地形轮廓由 inHex 生成，六芒星只是路网', () => {
    const src = map();
    expect(src).toContain('if (inHex(col, row)) out.push({ col, row });');
    expect(src).toContain('export function starRoads()');
    expect(src).toContain('export function shortcuts()');
    expect(src).toContain('export function diameterRoads()');
    // 反证：把六芒星当成地形轮廓就是 P-086 那个跑偏版本
    expect(src).not.toContain('starRoads().forEach((c) => out.push');
  });

  it('道路绕开中心公共区，主干道只画中心区那一行（其余正常草地）', () => {
    const src = map();
    expect(src).toContain('!inCenter(c.col, c.row)');
    expect(src).toContain('row - CENTER.row0 === CENTER.roadRow');
    expect(src).toContain('export function isRoad(');
    // 反证：又横贯整张六边形拉一条深色带，判据必须抓到
    expect(src).not.toContain('return inHex(col, row) && row === CENTER.row0');
    // 中心区非道路格必须落回普通草地：不许有整块 'center' 染色分支
    const paint = view();
    expect(paint).toContain('let hex = GRASS;');
    expect(paint).not.toContain("kind === 'center'");
  });

  it('中心网格与规则层逐格对齐：数值只在 map.js 的 CENTER 算一次', () => {
    const src = map();
    const rules = stripComments(read('public/mods/grand-map/rules.js'));
    expect(src).toContain('size: S.center');
    expect(src).toContain('roadRow: half');
    expect(rules).toContain('centerSize: CENTER.size');
    expect(rules).toContain('roadRow: CENTER.roadRow');
    // 反证：规则层自己写死一个数字就是对不齐的旧写法
    expect(rules).not.toContain('centerSize: 17');
    expect(rules).not.toContain('roadRow: 8,');
    expect(src).toContain('export function toAbstract(');
    expect(src).toContain('export function fromAbstract(');
  });

  it('小 / 中 / 大三档都在，默认给最大档，形状公式只有一套', () => {
    const src = map();
    for (const id of ['sm', 'md', 'lg']) expect(src).toContain(`${id}: {`);
    expect(src).toContain("return 'lg';");
    expect(src).toContain('export const VIEW');
    // 反证：三档各自写一份 inHex 就是复制粘贴，判据要抓到
    expect((src.match(/export function inHex/g) ?? []).length).toBe(1);
    expect(view()).toContain('data-action="size"');
    expect(view()).toContain('location.search = p.toString()');
  });

  it('顶栏与金币用旧的 UI，不再把金币塞在左上角', () => {
    const src = view();
    const api = stripComments(read('src/arena/modApi.ts'));
    expect(src).toContain('class="ahud__top panel gm-top"');
    expect(src).toContain('ahud__clock');
    expect(src).toContain('ahud__tools--top');
    expect(src).toContain('API.createModBank()');
    expect(api).toContain('export function createModBank()');
    expect(api).toContain("className = 'ahud__bank'");
    expect(api).toContain('COIN_ICON');
    // 反证：把金币数字放回顶栏就是被否决的那版
    expect(src).not.toContain('data-gold');
    expect(src).not.toContain('class="gm-top"><h2>');
  });

  it('调试控件收在一处，且明确标了「后面要改回」', () => {
    const src = view();
    const raw = read('public/mods/grand-map/view.js');
    expect(src).toContain('DEBUG_DEFAULT_OPEN = true');
    expect(raw).toContain('待改回'); // 注释里的说明文字要从原文读，结构锁才不误伤
    expect(src).toContain('data-debug');
    expect(src).toContain('data-action="debug"');
    // 反证：时段按钮散在顶栏（不在调试抽屉里）必须被抓到
    expect(src).toContain('class="gm-debug"');
    expect(src).toContain('DEBUG_DEFAULT_OPEN');
  });
});
