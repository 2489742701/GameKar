# 署名与第三方声明

`LICENSE` 里是 **AGPL-3.0** 的原文（许可证正文按 FSF 要求一字未改）。
本文件放版权信息与必须被传递下去的第三方声明 —— 这两类东西都不能塞进 `LICENSE` 里。

---

## 一、本项目代码

```
GAMEKAR
Copyright (C) 2026 2489742701

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

**为什么是 AGPL 而不是 MIT**：这是本项目的选择，不是上游传染的结果 ——
`src/` 下没有一行代码来自 AGPL 项目（见下面第二节第 3 条）。选它的意思是：
**你可以随便玩、随便改、随便拿去跑服务器，但你改完的东西也得同样开源。**

> ⚠️ AGPL 第 13 条：如果把这个游戏改完部署成**联网服务**（比如以后做的联机版），
> 得让用户能拿到你改后的源码。单机 / APK 分发自带源码即可，和 GPL 一样。

---

## 二、美术素材（**不是 AGPL，别合在一起**）

| 项 | 内容 |
| --- | --- |
| 文件 | `public/assets/dudes/` 下的 `base.png` · `heads.png` · `faces.png` · `pack.json` |
| 作者 | **KingBell / BellBlitzKing** |
| 来源 | <https://kingbell.itch.io/pixel-sprite-mixer>（取自 webxdc 移植 <https://github.com/ArcaneCircle/pixeldudes-maker> 的 `data/Import_config_Hero.zip`） |
| 许可 | **CC BY 4.0** <https://creativecommons.org/licenses/by/4.0/> |
| 改动 | **无**。四个文件原样复制，一个字节都没改 |

详细核实过程（页面标注、作者答复、许可链接）见
[`public/assets/dudes/CREDITS.md`](public/assets/dudes/CREDITS.md)。

### 三条容易被传错的边界

1. **素材是 CC BY 4.0，不是 AGPL。** 上面那个移植仓库的 `LICENSE` 是 AGPL-3.0，
   但那是**移植版代码**的许可证；itch 页面对**素材本身**标的是 CC BY 4.0。
   本项目对素材的署名义务只来自 CC BY 4.0（署名 + 许可链接 + 说明有无改动），
   **不会**因为本项目是 AGPL 就给素材套上 AGPL。
2. **反过来也成立**：CC BY 4.0 允许商用与再分发，所以这 4 个文件跟着仓库一起发布没问题；
   但你要是把本项目**改成闭源分发**，AGPL 那部分不允许，而素材那部分本身是允许的 —— 别混淆。
3. **代码是我们自己重写的。** `src/game/dudes/` 没搬任何一方任何一行代码：
   读通"三次 `drawImage` + 按魔术色整像素替换"这条管线之后，用 TypeScript 重写了实现。

---

## 三、第三方运行依赖

均为 npm 依赖，**不复制进本仓库**，各自遵循自己的许可证：

| 包 | 用途 | 许可 |
| --- | --- | --- |
| `three` | 3D 渲染 | MIT |
| `vite` / `vitest` | 构建与测试 | MIT |
| `typescript` | 类型检查 | Apache-2.0 |
| `@capacitor/*` | 安卓打包 | MIT |

---

## 四、素材替换成本

真要换掉小人的素材包，只需要替换那 4 个文件同格式的替代品：
`src/game/dudes/pack.ts` 里的头/脸/体型上限都是从图片实际尺寸**算出来**的，不是写死的。
