# GAMEKAR

抽卡驱动的 2.5D 即时战略。建筑、经济、人口**全部**来自抽卡：盖楼要抽、加产出要抽、涨人口上限也要抽，
抽到的建筑卡就是一张"可以盖一次"的建造许可。

## 跑起来

```bash
npm install
npm run dev          # http://localhost:5173
npm run check        # 类型检查 + 76 条回归
npm run build        # 产物在 dist/，three 单独分包
```

开发期可以在控制台直接敲：

```js
game.pull(10)                 // 十连，走完整结算
game.build('farm')            // 进入田庄的放置模式
game.place('mine', {col:20,row:18})   // 跳过交互直接落位
game.world.resources          // 金币 / 晶钻
game.setOrientation('portrait')       // 在桌面窗口里锁定竖屏档位
```

`?seed=20261019` 换一张地图（同一个 seed 永远同一张图，连抽卡序列也一样）。

## 画面是怎么回事

- **正交投影**：`OrthographicCamera`，远处建筑不会缩小，格子尺寸全程一致 —— 这是红警/帝国时代那种平铺感的地基。
- **2.5D 俯角**：默认俯角 50°、方位角 45°。看得见屋顶，也看得见立面；`game.camera.setPitch(25)` 会更贴红警。
- **短边锁格子**：相机按"屏幕短边看几格"来定视野，所以横竖屏来回切，建筑不会突然变大变小。
- **一次 draw call 铺完地图**：2116 格分两个 InstancedMesh（陆地 + 水面），树/灌/岩各自合批一个。
  水面和发光晶簇不合批 —— 顶点色走不了 emissive，而晶脉"亮着"本身就是玩法信号。
- 建筑目前是**程序化建模**：一份"说明书"（`box/prism/plinth/cyl/cone/crystal`）拼出低多边形模型。
  将来换真实 glTF，只动 `src/game/models/`，玩法和 UI 一行不改。

## 目录

```
src/
├─ engine/            不认识"建筑""抽卡"，只做通用能力
│  ├─ core/           EventBus（强类型）· GameLoop（20Hz 定步长 + 变帧渲染）
│  ├─ math/           Random（种子随机）· Noise（值噪声/fbm）· Grid（格子数学）
│  ├─ render/         Renderer · CameraRig（正交 2.5D 云台）· Lighting（阴影盒贴合视野）
│  ├─ input/          PointerInput（单指拖/轻点、双指捏合缩放旋转、滚轮、悬停）
│  └─ viewport/       Viewport（尺寸·DPR·朝向，可手动锁定档位）
├─ game/
│  ├─ GameApp.ts      门面：接线、输入路由、对外动词
│  ├─ config.ts       调参处：地图、相机、地形表、开局资源
│  ├─ data/           buildings.ts（8 种建筑）· cards.ts（17 张卡 + 卡池）
│  ├─ gacha/          GachaService：先掷稀有度，再在档内按权重挑卡
│  ├─ world/          TileMap · TerrainGenerator · GroundView · PropScatter · Markers · BuildingView · GameWorld
│  ├─ models/         kit.ts（建模套件）· buildings.ts · props.ts · registry.ts
│  └─ systems/        Placement.ts（绿/红幽灵与落位确认）
├─ ui/                dom.ts + 五个部件 + Hud.ts（组装）
└─ styles/            base.css（全部 token）· layout.css（横竖屏网格）· components.css
tests/                grid · random · terrain · world · gacha · data · geometry —— 共 76 条
```

分层只有一条规矩：**`engine/` 不许 import `game/`，`game/` 不许 import `ui/`。**
世界层不 import three，所以单测能直接 `new GameWorld(map)` 跑一百抽。

## 核心循环

```
抽卡 ──▶ 建筑许可 ──▶ 盖楼 ──▶ 产晶钻 ──┐
   ▲                                  │
   └──── 经济卡（永久 +/s）· 人口卡（上限）◀┘
```

人口是闸门：每栋楼占人口，上限来自民居和人口卡。所以"抽到图纸但人口不够"是很自然的卡点，
解法还是抽卡或盖民居。

## 数值现状（实测，不是目标）

| 项 | 读数 |
| --- | --- |
| 地形配比（6 个 seed 现量） | 水 15.8–16.0% ｜ 岸 10.6–11.0% ｜ 岩 7.3–15.0% ｜ 草 57.8–65.5% ｜ 晶脉 0.4% |
| 稀有度实测（无保底，6 万抽） | 贴住卡池概率表，偏差 < 0.8% |
| 保底 | 任意连续 10 抽内至少一张精英及以上 |
| 开局底储 | 金币 320 ｜ 晶钻 640 ｜ 人口上限 6 |

地形阈值用的是**高程分位数**，不是绝对高度：所以换 seed、改噪声频率都不会把地图泡成一整片海。
（写死绝对高度那一版实测泡水 38–44%，已被 `tests/terrain.test.ts` 拦住。）

## 还没做

- 人物与战斗：兵营目前是空壳。等你给的 2D 生成工具接进来。
- 寻路：`engine/math/Grid.ts` 已备好 8 向邻接与距离函数，缺 A*。
- 存档：`GameWorld` 全是可序列化字段，等接入。
- 小地图、战争迷雾、音效。
