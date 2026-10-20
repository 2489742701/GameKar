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

1. **代码**：上游 `LICENSE` 是 **GNU AGPL-3.0**。所以本项目的 `src/game/dudes/` **没有搬它任何一行代码**，
   是我们读通管线（三次 `drawImage` + 按"魔术色"整像素替换）之后自己重写的实现。
2. **美术素材**（就是上面这 4 个文件）：**授权条款在这个仓库里找不到**——上游只带了代码的 AGPL 许可，
   itch.io 页面才有素材条款，而这里没抓取。

⇒ 所以：**对外发布前需要确认 itch 页面的素材许可**（个人/商业使用、能否再分发）。
真要换掉，只需要把这 4 个文件换成同格式的另数据包，`src/game/dudes/` 不用动——
`pack.ts` 里的头/脸/体型上限都是从图片实际尺寸算出来的，不是写死的。
