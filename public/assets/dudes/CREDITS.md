# 小人素材来源与授权状态

这四个文件不是本项目画的，是从 **Pixelart Sprite Mixer** 的数据包里**原样复制**过来的，一个字节都没改：

- 上游：<https://kingbell.itch.io/pixel-sprite-mixer>（作者 KingBell / BellBlitzKing）
- 我们用的这一份是它的 webxdc 移植：<https://github.com/ArcaneCircle/pixeldudes-maker>
- 具体取自该仓库的 `data/Import_config_Hero.zip`

| 文件 | 内容 | 实测 |
| --- | --- | --- |
| `base.png` | 身体+动作表，横着是帧、竖着是体型 | 11248×24 = **703 帧 × 1 个体型** |
| `heads.png` | 头/发/帽表 | 5328×24 = 333 件 |
| `faces.png` | 脸表 | 1648×24 = 103 件 |
| `pack.json` | 帧位与换色定义（原名 `conf.json`） | `w:16 h:24 version:3`，5 组调色板各 39 色，121 个动画名 |

## 授权：两件事要分开看

1. **代码**：
   - itch.io 上的原工具 *Pixel Art Sprite Mixer* 标注 **Code license: MIT**。
   - 我们取素材用的 webxdc 移植仓库 `ArcaneCircle/pixeldudes-maker` 的 `LICENSE` 是
     **GNU AGPL-3.0**（那是移植版的许可证，不是素材的）。
   - 本项目的 `src/game/dudes/` **没有搬任何一方任何一行代码**，
     是我们读通管线（三次 `drawImage` + 按"魔术色"整像素替换）之后自己重写的实现。
2. **美术素材**（就是上面这 4 个文件）：**已确认** itch.io 页面标注
   **Asset license: Creative Commons Attribution v4.0 International (CC BY 4.0)**
   （<https://creativecommons.org/licenses/by/4.0/>），页面另写 "Royalty free license for your projects"。
   作者在评论区答复署名问题时明确说：「Yes, post a link-back to the tool so it can help more creatives find it.」

   许可核实于 2026-11-14（P-100 公开仓库前）。CC BY 4.0 允许个人 / 商业使用与再分发，
   **条件是保留署名、给出许可证链接、说明有无改动**。

### 本项目的署名（CC BY 4.0 要求）

- 作者：**KingBell / BellBlitzKing**
- 来源：<https://kingbell.itch.io/pixel-sprite-mixer>（素材取自 webxdc 移植
  <https://github.com/ArcaneCircle/pixeldudes-maker> 的 `data/Import_config_Hero.zip`）
- 许可：CC BY 4.0 <https://creativecommons.org/licenses/by/4.0/>
- 改动：**无**。这 4 个文件原样复制，一个字节都没改。

真要换掉，只需要把这 4 个文件换成同格式的另数据包，`src/game/dudes/` 不用动——
`pack.ts` 里的头/脸/体型上限都是从图片实际尺寸算出来的，不是写死的。
