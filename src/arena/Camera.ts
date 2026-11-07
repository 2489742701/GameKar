/**
 * 视角导演 —— 几个固定机位 + 自动移动。
 *
 * 用户要"多个视角，而且视角能自动移动"。做成两件事：
 * 1. 三个机位（全景 / 两侧对峙 / 跟随战场），点按钮或按 V 换；
 * 2. **自动模式**：每 9 秒换一个机位、镜头缓慢漂到战场焦点（兵的质心）；
 *    玩家一动手（拖/缩放/转）就退出自动，停手 6 秒后自己回来。
 *
 * 所有位移都走相机自己的阻尼（`centerOnWorld` 不带 instant），所以不会硬跳。
 */

import type { CameraRig } from '@engine/render/CameraRig';

export interface ViewPreset {
  name: string;
  /** 相对"整幅场地入画"的缩放倍率 */
  zoomFactor: number;
  yaw: number;
  pitch: number;
  /** 相机中心往蓝方（自家）挪几格：负值 = 从自家望向敌方 */
  centerBias?: number;
}

/**
 * 静止机位。
 *
 * **2026-11-07 傍晚砍到两档**：用户原话"你的视野不要搞得那么复杂，点一下就切换的，
 * 切换到我方视角也不对" —— 「我方」那一档（低俯角 + 拉近 + 偏蓝方）直接删掉，
 * 剩斜视 / 正对两个"换个角度整片战场"的档，按钮点一下循环。
 * 要精调机位走 F2 调试面板，调好把机位 ID 发回来，再定成新档。
 *
 * 自动巡视仍是默认关，镜头不会自己跑（2026-10-27 用户拍板）。
 */
export const VIEW_PRESETS: ViewPreset[] = [
  // 默认是**斜视**（用户 2026-10-27：更偏向从自己这边斜着看整片战场）
  { name: '斜视', zoomFactor: 1, yaw: 20, pitch: 44 },
  { name: '正对', zoomFactor: 0.96, yaw: 0, pitch: 46 },
];

/**
 * PVE 的四档机位（2026-11-07 用户："手机端额外设置一个视角，给一个斜着的，
 * 还有一个正视角、斜视角，这些都可以设置"）。
 *
 * 为什么不能直接复用 1v1 那三档：PVE 场地的攻防轴是 **col**，必须转到屏幕的上下轴
 * （yaw 270）才是"蓝在下、怪从上涌下来"的塔防读图。1v1 的 yaw 0/8/20 把 60 格长边
 * 摆到横向，竖屏上只能看见半条防线。
 *
 *  - 正对：轴对齐，44° 俯角（`pitchBias = -2`），默认机位，整幅战场入画；
 *  - **斜视**：用户发回一张真机截图定稿（"就是这个角度，斜视嘛，斜图嘛"）—
 *    场地边/黄区带在屏幕上斜约 25°、低俯角、上下留大块场外，只露出战场一角。
 *    按图量出来 `yaw 238 / pitch 32 / zoom ≈ 26 格`：从 270° 拧掉 32°，
 *    压低俯角让 60 格长边投影变短，再拉近（zoomFactor 0.8）把斜切的那一角放大。
 *    这跟"整幅铺满"是**故意相反**的取舍：他要的是斜着切开画面的构图，不是全景；
 *    想看全场自己切「正对」或双指拉远。
 *  - 我方：低俯角 26° + 拉近，自家大本营在画面底部，像站在城墙上往前看；
 *  - 俯视：74° 几乎是俯瞰平面图，摆布局、数格子用。
 *
 * zoomFactor 是**相对 `fitZoom`（= rows×1.02，与档位无关）**的倍率：
 * 1 = 正好把 32 格宽铺满。别让它跟 fitZoom 互相抵消，否则转屏重算时会按
 * "当时那一档"重新洗一遍基准，切档之后大小就不对了。
 */
export const PVE_VIEW_PRESETS: ViewPreset[] = [
  { name: '正对', zoomFactor: 1, yaw: 270, pitch: 46 },
  // pitch 写 34，加上 PVE 的 pitchBias −2 ⇒ 实际 32°；0.8 × 32.64 ⇒ 26.1 格
  { name: '斜视', zoomFactor: 0.8, yaw: 238, pitch: 34 },
  // 「我方」那档同时删掉：和 1v1 一起按用户"不要那么复杂"的口径收敛
  { name: '俯视', zoomFactor: 1.04, yaw: 270, pitch: 76 },
];

/** 竖屏专用：短边是宽度，把 tilesAcross 再压小 = 拉近；中心略往自家挪。
 *  0.58 是实测折中：再大（0.72）战场上下留大片黑，再小两侧建筑被裁掉。 */
const PORTRAIT_ZOOM = 0.58;
const PORTRAIT_BIAS = -2;

/** 自动模式多久换一次机位、玩家停手多久回来。 */
const SWITCH_SECONDS = 9;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 把角度差折到 [-180, 180]，避免镜头绕远路 */
const shortAngle = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

export class ArenaDirector {
  /**
   * 2026-11-07 删掉了这里原有的 `invertOrbit`：它自 2026-10-27 起就**没有任何读者**
   * （全仓库只有这一处定义），是个"装上了但从没生效"的假开关。
   * 真正的四手势反转现在在 `controls.ts`，由 `ArenaApp` 的手势回调直接读，
   * 并能在游戏内设置里改、localStorage 常驻。留两套会让人不知道该拨哪个。
   */
  /**
   * 镜头自动巡视（每 9 秒换机位 + 漂向战场）。**默认关**（用户 2026-10-27：
   * "自动把他关了，默认不需要，留给未来观战"）。观战模式开这个开关就行，
   * 手动机位切换不受它影响。
   */
  autoOrbit = false;
  /** 竖屏视口（ArenaApp.fitCamera 设置）：缩放拉近 + 构图偏自家 */
  portrait = false;
  /**
   * 俯角偏置（度）。PVE 用 **−2**：机位表里写的是 46°，落地是 44°。
   *
   * 上一版给的是 −10（落地 36°），2026-11-07 实机截图证明那是错的 ——
   * 36° 时 60 格纵深只投影出 42 格，战场在竖屏上被压成横向一条，
   * 上下各留一大片空底盘。抬到 44° 才铺满。
   */
  pitchBias = 0;
  /**
   * 当前模式可用的机位表。1v1 用 `VIEW_PRESETS`，PVE 由 `usePresets` 换掉。
   * HUD 的视角菜单直接读它，**不在 UI 里再抄一份名字**。
   *
   * （这里原先还有一个 `yawFix`，用来把 PVE 的朝向钉死在 270°。2026-11-07 拆掉了：
   * PVE 现在自带一份机位表，每档的 yaw 直接写绝对值；锁一个数字再加一份表，
   * 玩家想换视角时还得先拆锁，多一层没有意义的间接。）
   */
  presets: ViewPreset[] = VIEW_PRESETS;
  /** 当前是第几档（HUD 的视角菜单要高亮这一项，是公开读的） */
  index = 0;
  /** 玩家自己拖过镜头：锁在手动，直到他按"视角"按钮（不再 6 秒后偷偷抢回去） */
  locked = false;
  private switchIn = SWITCH_SECONDS;

  get current(): ViewPreset {
    return this.presets[this.index] ?? this.presets[0]!;
  }

  /**
   * 换一整套机位（开局按模式调一次）。**不要在 resize 里调** ——
   * 那会把玩家选好的档位每次转屏都打回第一档。
   */
  usePresets(list: ViewPreset[], startIndex = 0): void {
    if (list.length === 0) return;
    this.presets = list;
    this.index = Math.min(Math.max(0, Math.trunc(startIndex)), list.length - 1);
    this.locked = false;
  }

  /** 直接选第 i 档（HUD 的视角菜单）。越界一律夹回范围里，不抛错。 */
  select(index: number): ViewPreset {
    this.index = Math.min(Math.max(0, Math.trunc(index)), Math.max(0, this.presets.length - 1));
    // 选了机位就必须解锁：否则 `update()` 提前 return，镜头一动不动，
    // 玩家只会觉得"这个按钮坏了"
    this.locked = false;
    this.switchIn = SWITCH_SECONDS;
    return this.current;
  }

  /** 手动换下一个机位：相机平滑挪过去，但不会接着自己转（自动巡视要另外开）。 */
  next(): ViewPreset {
    return this.select((this.index + 1) % this.presets.length);
  }

  /** 玩家碰了相机：锁在手动，直到他再按"视角"。 */
  userTouched(): void {
    this.locked = true;
  }

  /**
   * 每帧一次。`fitZoom` 是"整幅场地入画"的那个缩放值（随视口现算），
   * `focus` 是战场质心（没有兵就是 null）。
   */
  update(dt: number, rig: CameraRig, fitZoom: number, center: { x: number; z: number }): void {
    // 玩家锁住手动时**一帧都不碰相机**：不然他刚拖好画面，镜头又自己飘回去
    if (this.locked) return;

    // 只有自动巡视开着才轮换机位 / 跟随战场；默认关，镜头停在当前机位上不动
    if (this.autoOrbit) {
      this.switchIn -= dt;
      if (this.switchIn <= 0) {
        this.index = (this.index + 1) % this.presets.length;
        this.switchIn = SWITCH_SECONDS;
      }
    }

    const view = this.current;
    // 缩放：指数趋近，太快会晕；竖屏在机位倍率之上再乘 PORTRAIT_ZOOM 拉近
    const targetZoom = fitZoom * view.zoomFactor * (this.portrait ? PORTRAIT_ZOOM : 1);
    rig.zoom = lerp(rig.zoom, targetZoom, 1 - Math.exp(-dt * 1.6));
    // 朝向：只补一小步角度（每档的 yaw 是绝对值，PVE 自己那份表已经是 270° 左右）
    rig.rotateBy(shortAngle(view.yaw - rig.yaw) * Math.min(1, dt * 1.8));
    // 竖屏更俯一点（纵向战场看得清），横屏维持机位俯角
    rig.setPitch(
      lerp(rig.pitch, view.pitch + (this.portrait ? 6 : 0) + this.pitchBias, Math.min(1, dt * 1.2)),
    );
    // 中心：机位偏移 + 竖屏再偏自家；centerOnWorld 自带阻尼，跟随战场那套已删
    const bias = (view.centerBias ?? 0) + (this.portrait ? PORTRAIT_BIAS : 0);
    rig.centerOnWorld(center.x + bias, center.z);
  }

  /** 给 HUD 的一行状态。 */
  get status(): string {
    return this.autoOrbit ? `自动 · ${this.current.name}` : this.current.name;
  }
}
