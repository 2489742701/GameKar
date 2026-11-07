/**
 * 模式规划（2026-11-06，详见 `docs/工作笔记/产品路线图_20261106.md`）。
 *
 * 这一份数值表**当前只服务「竞技场 1v1」**：双方对称、3 分钟、拆楼多者胜。
 *
 * 后面两个阶段是计划、不是已实现：
 * - **单人 PVE**：波次表 + 单线行进 AI + 守 N 波判胜。金币 / 手牌 / 建筑产能 / 人口面包
 *   这些都能直接复用，所以这里不要为 PVE 另开一套数值常量。
 * - **多人 PVE / 联机**：服务器跑同一份 `ArenaWorld` 广播快照（状态同步）。
 *
 * ⚠️ 顺序约束：TapTap 官方 FAQ 说「单机改联网」要重新处理资质 ——
 * 联机若要上，得和备案在同一版做完。别先上单机再补。
 */

/**
 * 对战模式的全部可调数值 —— 集中在这一处，逻辑层一行不写死。
 *
 * 设计口径（用户 2026-10-27 定的方向 + 我拍的数，见 docs/工作笔记/对战模式计划流水账）：
 * **以建筑为主、军队为辅**：建筑贵、军队便宜，但建筑能一直产出（兵营出兵、磨坊生金、塔防守），
 * 所以"先立建筑"是自然选择，而不是靠规则强按。
 *
 * 和《皇室战争》刻意不同的一条：**建筑没有寿命**。不会自己掉血、更不会定时消失，
 * 只能被兵拆掉。这一条是用户点名要的，别顺手加回来。
 */

import type { UnitDef } from '@game/data/units';

export type Side = 'blue' | 'red';

/**
 * 一块场地的形状（2026-11-07 抽出来给 PVE 用）。
 *
 * 原来 `FIELD` 是模块级常量，PVE 要"场地贼拉大"就没法变了。
 * 现在世界持有 `world.field`，`FIELD` 只是**1v1 的默认值** —— 1v1 一个数都不改。
 */
export interface FieldSpec {
  cols: number;
  rows: number;
  midCol: number;
}

/** 战场：竖屏为主，蓝在南（下方），红在北（上方）。 */
export const FIELD: FieldSpec = {
  /**
   * 横版：34 列宽、20 行高。左边（小 col）是蓝方，右边是红方。
   * 建筑统一 3×3 之后，26×16 太挤（一栋楼就占掉半个半场），所以整体放大一档。
   */
  cols: 44,
  rows: 20,
  /** 中间这条线左右各归一方，兵只能放在自己这半场 */
  midCol: 22,
};

/**
 * PVE 的场地（2026-11-07 用户："场地贼拉大"）。
 *
 * 口径见 `docs/工作笔记/PVE模式设计_20261107.md` §1。**形状比面积更重要**：
 * 第一版做 56×36（横宽），实测在手机竖屏（比例 1:2.17）上"上下游一大片黑"——
 * 因为竖屏的短边是**宽**，36 行铺满的时候垂直方向能看到 80 格，而场地只有 56 深。
 *
 * 所以改成 **60 深 × 32 宽**：面积 1920 格（1v1 的 2.2 倍，"贼拉大"仍然成立），
 * 但长宽比 1:1.9 贴近手机竖屏，整条防线一眼能看全。
 *
 * 分区：玩家 col 0~29（30 列可建）· 黄带 30~38（9 列）· 怪出生区 39~59。
 * 出生点在 `pve/levels.ts` 里按波次配（44），不写在这里。
 */
export const PVE_FIELD: FieldSpec = {
  cols: 60,
  rows: 32,
  midCol: 34,
};

/**
 * 中间的**禁建带**（用户 2026-10-27 要求 3 列 → 5 列，2026-11-02 又要求"再大一点" → **7 列**）。
 * 以 midCol 为中心左右各 4 格 ⇒ 9 列宽的"无人区"：楼和兵都放不进去，
 * 两边的射程够不着对面，谁先越过谁挨打。地块本身染成黄沙色（见 ArenaApp）。
 */
/**
 * 2026-11-06 用户：「中间那个黄色土地有点少，希望比原先扩大一点，但不要影响建筑土地。」
 *
 * 只把 `halfWidth` 改大会**吃掉两边的可建列**（红方靠中线的起点从 25 推到 27）。
 * 所以同时把地图从 42 列加宽到 44 列、中线从 21 挪到 22：
 * 黄区 7 → 9 列，而 AI 的落点范围（红 13 个起点 / 蓝 12 个）**一列不少**。
 * 判据和染色都读这里的 `halfWidth`，两边不会脱节。
 */
export const NO_BUILD = { halfWidth: 4, color: 0xd8b45c };

/**
 * 楼要盖多久（秒）。
 *
 * 2026-11-02 用户："这个建筑建起来是要时间的。建筑建起来的时候，我想着有几个脚手架，
 * 建筑慢慢升起来，咱们在外面做的那个破损墙壁刚刚好可以派上用场，那个墙壁就慢慢地凭空垒上来了。"
 *
 * 施工期间这栋楼**不干活**：塔不开火、兵营不出兵、磨坊不生金（和"缺后勤"同一条口径）。
 * 塔/兵营给的时间长一点，因为它们是最值钱的；民居最快 —— 它只是名额。
 */
export const BUILD = {
  seconds: {
    house: 2.2,
    mill: 2.8,
    arrowTower: 3.4,
    cannonTower: 3.8,
    barracks: 4.2,
    orcLair: 3.6,
  } as Record<'house' | 'mill' | 'arrowTower' | 'cannonTower' | 'barracks' | 'orcLair', number>,
};

/**
 * 人口 / 面包 —— **容器**，不是随时间增长的收入。
 *
 * 用户 2026-11-05 定的规矩（原话）：
 * 「面包和人口是恒定的，在左上角它们相当于是一个容器值，而不是一个会随时间增长的值。
 *  这就是我们限制建造和区分的一个东西。」
 *
 * 这两个读数是**还剩几个位置**，不是「库存有多少」：
 * - **人口** 由民居提供（每座 +2），建筑占 2、每个兵占 1 —— 限制「能盖多少楼、能养多少兵」；
 * - **面包** 由磨坊提供（每座 +2），只有兵吃（每个 1）—— 单独限制「能出多少兵」。
 *
 * **不要把它改成随时间涨** —— 那就变成第二个金币，这两个数就失去「限制建造」的意义了。
 */
export const SUPPLY = {
  /**
   * 开局就有的容器（一座民居/磨坊都没有时也有这么多）。
   * `baseBread: 3` 是实测定的：给 4 时面包占用率只有 33%、几乎不卡；
   * 给 2 时连一队 3 人弓箭手都放不出来。取 3 能出 1 队，想多出兵就得先盖磨坊。
   */
  basePop: 6,
  baseBread: 3,
  /** 民居提供的人口 / 磨坊提供的面包 */
  housePop: 2,
  millBread: 2,
  /**
   * 建筑占用的人口**按建筑种类**读 `BUILDING_POP`（2026-11-07 用户调整：
   * 磨坊 1、箭塔 1、炮塔 2）。这里不再放一个统一数字 ——
   * 判据、卡面 SVG、AI 评估必须读同一张表，不能各写一个 2。
   */
  housePopCost: 0,
  /** 每个兵吃多少 */
  unitPop: 1,
  unitBread: 1,
  /**
   * **槽位制衡**（2026-11-06 用户）："不能一建一堆建筑物，最高是需要留一些槽位
   *  来给我们的军队的，有一个制衡。"
   *
   * 建筑占用的人口**最多到 人口上限 − armyReserve** —— 永远给军队留 2 格。
   * 为什么是规则而不是 AI 习惯：玩家和 AI 受同一条容器法律约束，"AI 会克制"
   * 只是它比玩家先读懂这条规则。民居不在此列（先加容器再看占用，防死锁）；
   * 军队卡就是保留槽的主人，更不受限。
   */
  armyReserve: 2,
};

export const ECONOMY = {
  /**
   * 金币上限：2026-11-07 用户"金币上限默认改到 30 个"（原来 20）。
   *
   * **涨速没动**：仍是 `tickSeconds = 2`（2 秒/格）。建筑协调经济是主约束、
   * 钱是次约束，钱来得快会让"攒钱铺楼"变成无脑解 —— 提高的是**能囤多少**，
   * 不是**来得多快**。攒到 30 够一次铺两栋楼，所以这一改会把节奏往前推，
   * 100 局读数记在流水账 P-062，不假装没影响。
   */
  cap: 30,
  /**
   * 开局金币：2026-11-07 用户"15 金币开局"（原来 8）。
   *
   * 8 点只够立一栋民居再补一张小队，开局三十秒基本在等钱；15 点能直接
   * "一栋楼 + 一支小队"或两栋便宜的楼，把第一波交锋提前。
   * **涨速仍然没动**（`tickSeconds = 2`）—— 改的是起点，不是水龙头。
   */
  start: 15,
  /**
   * 金币按**跳格**涨：每 2 秒 +1（2026-10-27 用户要求"一格一格跳"，
   * 2026-10-31 又要求"金钱的问题改得慢一点"：1.5 秒 → **2 秒**）。
   *
   * 慢下来的理由不是"难"，是因为**把节奏让给建筑**：
   * 钱来得越快，"先攒钱铺楼"就越是无脑解，民居/磨坊那道配给约束立刻被钱冲垮。
   * 2 秒/格 ⇒ 一局 180 秒白给 90 金，加磨坊产出，够立 5–7 栋 —— 每一栋都得想清楚。
   * （先试过 2.5 秒：实测蓝方托管 60 秒连一栋楼都立不起来，节奏塌了，退回 2 秒。）
   */
  tickSeconds: 2,
  perTick: 1,
  /** 磨坊每隔多久吐一次金，每次多少 */
  millInterval: 5,
  millBonus: 2,
};

/**
 * 一局的时间轴（2026-10-31 补）。
 *
 * 为什么必须有这一条：**这套规则原来没有"时间会到"这件事**。
 * 实测 8 个 seed、双方托管各跑 600 秒：**4 局（50%）跑到 10 分钟仍是 playing、双方大本营 1200 满血**
 * （seed 1 / 3 / 4 / 6），也就是缺的不是数值平衡，是缺一个"必须结束"的出口。
 * `ArenaWorld.elapsed` 之前一直在记，但没有任何一处读它 —— 又一个"写了没接上"。
 *
 * 到点之后的判定口径（2026-10-31 用户定的方向：**攻防的抓手是拆对方的建筑**）：
 * 大本营剩血 → 拆掉对方的楼数（谁把对方的体系拆得多谁赢）→ 都一样才判平。
 * 刻意**不比"还剩几栋楼"**：那个判据奖励铺楼，和"建筑要协调经济"的设计正好打架 ——
 * 实测 12 局里按"剩楼数"判，蓝方 1 胜 9 负，而它只是楼盖得少，不代表打得差。
 */
export const MATCH = {
  /** 常规时间（秒） */
  seconds: 180,
  /** 最后这么多秒倒计时变红 */
  warnSeconds: 30,
  /**
   * 加时赛（2026-11-06 用户："一般来说没拆掉大本营有一个加时赛"）。
   *
   * 常规 180 秒打完、两边大本营都还立着 ⇒ **不判胜负**，进加时（sudden death）：
   * 加时里谁先拆掉对面大本营谁赢（`reason = 'core'`）。
   *
   * **加时上限 2026-11-06 改口径**：总时长最长 5 分钟（overtime 120 秒）；
   * 打满后按**双方建筑存活数**比积分（多者胜），再比大本营剩血、拆掉的楼数，
   * 都一样才判平。用户原话："最长到 5 分钟结束之后，按照局内双方建筑的存活数
   *  来比拼积分"——10 分钟档留给以后的模式（"取决于不同的局，到时候我们再设计"）。
   */
  overtimeSeconds: 120,
};

/**
 * 后勤配给 —— **这一版最硬的那条约束**（用户 2026-10-31 的原话）：
 * "必须要有一个磨坊提供食物，还有一处民房，防御建筑也占一处民房。要求是严格的，
 *  咱们是要拖他的建筑，去处理攻防。"
 *
 * 所以：**每座要干活的楼都得占一份民居**，兵营还额外要一座磨坊。
 * 意味着一局能同时养多少楼，是被民居/磨坊的数量卡住的 —— 而不是被金币卡住的。
 * 拆掉对方的民居，对方后配的塔就哑火、兵营就停产，这就是"拖他的建筑"。
 *
 * 名额按**先盖先得**分（楼号小的先配），和兵营开工资格那条同一口径，
 * 所以同 seed 同摆法的结果一定可复现。
 */
export const LOGISTICS = {
  /** 兵营：1 座磨坊 + 1 座民居 */
  barracksMill: 1,
  barracksHouse: 1,
  /** 防御塔（箭塔/炮塔）：1 座民居 */
  towerHouse: 1,
};

/**
 * 对战模式的机位 —— 和老模式（45° 斜看）不一样，这里**正对**战场：
 * 蓝在下、红在上，和皇室战争那种"上下对峙"的读图一致。
 * 斜 45° 会把场地转成菱形，四角全是黑洞（截图里就是这个毛病）。
 */
export const ARENA_CAMERA = {
  pitchDeg: 46,
  yawDeg: 0,
  /** 16 列宽的场地整幅入画，两侧留一点边 */
  tilesAcross: 30,
  minTilesAcross: 12,
  maxTilesAcross: 44,
};

export const CORE = {
  /** 双方大本营（术语按用户 2026-11-01 的纠正：不叫"核心"）：3×3 占地 */
  cols: 3,
  rows: 3,
  hp: 1200,
  /**
   * **水晶魔法攻击**（2026-11-06 用户："主城就是可以射击，顶上的水晶可以魔法攻击"）。
   *
   * 口径三条：
   * - **只打地面兵、不打建筑也不对空**：移动火炮射程 7.2 > 这里的 6.5，
   *   仍然能白嫖大本营 —— "攻城武器白嫖主城"是核心博弈，水晶是最后防线不是主炮台。
   *   （提高到 6.5 是用户"主城可以更远一点"，仍刻意留在 7.2 之下。）
   * - **不需要民居配给**：大本营是地图本身，不是玩家盖的楼；
   * - 射程从**占地边缘**量（和塔同一口径，+1.5）。
   */
  attack: { damage: 14, range: 6.5, interval: 1.6 },
};

/**
 * **手动修复**（2026-11-08 用户："建筑脱战一段时间后，上面会冒出一个小锤子按钮，
 * 点一下就有 SVG 小动画，锤子在打板子，说明在修复"）。
 *
 * 三条口径，别在 UI 里另算一遍：
 * - **脱战**从最后一次挨打算起（不是"没兵在附近"）：`elapsed - lastHitAt >= idleSeconds`；
 * - 点一下 = 启动**一段**修复（`seconds` 秒），期间按各楼 `maxHp` 的比例持续回血、
 *   锤子动画循环；修满或再次挨打就停。不是"一键满血"，也不是纯装饰动画 ——
 *   动画播的时候血是真的在涨，判据和画面读同一个 `repairLeft`。
 * - **大本营不参与**：它是胜负判据本身（先拆掉大本营就赢），免费修会让
 *   "拆家收尾"这条出口失效。要放开就改 `excludeCore`，别在视图层偷偷放行。
 *
 * 数值只放这一处；AI / 托管方这一版**不会**自动点锤子（它是玩家交互，
 * 不是 AI 决策），所以纯逻辑的拆楼台账不受影响。这个不对称记在流水账 P-078。
 */
export const REPAIR = {
  /** 脱战多久才冒按钮（秒） */
  idleSeconds: 4,
  /** 一次修复持续多久（秒） */
  seconds: 3.2,
  /** 每秒回多少比例的最大血量（3.2s × 0.16 ≈ 一回修 51%） */
  fractionPerSecond: 0.16,
  /** 大本营不显示锤子（见上） */
  excludeCore: true,
};

export const BARRACKS = {
  /** 兵营每隔几秒自动出一个兵（不花金） */
  interval: 6,
  /** 一栋兵营最多同时在场几个兵，超了就不再出 */
  cap: 6,
  hp: 420,
};

export const TOWER = {
  /** 箭塔：2026-11-08 用户"防御性建筑可以射得更远一点" ⇒ 6.8 → 7.8 */
  arrow: { hp: 520, damage: 9, range: 7.8, interval: 0.75, ammo: 'arrow' as const },
  /** 炮塔：慢、重、带溅射；5.6 → 6.8。炮弹够不着天上，不对空（见 AA_SOURCES） */
  cannon: { hp: 640, damage: 24, range: 6.8, interval: 1.7, ammo: 'cannon' as const, splash: 1.3 },
};

/**
 * **对空判据的唯一来源**（2026-11-08 用户："火炮理论上没办法射击，空军只有箭塔可以射击"）。
 *
 * 炮弹是平射/曲射的，够不着天上的东西；水晶是魔法弹但也只打地面兵；
 * 所有兵种（含移动火炮、弩车、弓箭手）同样不对空。
 * 只有箭塔能拦空军 —— 想加第二个防空单位，改这张表，别在四处 if 里各写一遍。
 */
export const AA_SOURCES: ReadonlySet<string> = new Set(['arrowTower']);
export const canHitAir = (source: string): boolean => AA_SOURCES.has(source);

export const MILL = { hp: 300 };

/**
 * **对建筑伤害倍率**（2026-11-07 平衡调整，见流水账 P-066）。
 *
 * 病根：100 局实测 **91 局靠加时数楼判胜负、0 局拆掉大本营**，大本营平均剩血
 * 1197/1200，双方各铺 14 栋楼；每局建筑受击 101 次共 1068 伤害，却只拆掉
 * 1.08 栋 —— 伤害摊在 28 栋楼上，每栋才掉 38 血，兵打到了也拆不动。
 * 「拆对方的建筑」这条攻防抓手等于失效，对局退化成纯铺楼竞赛。
 *
 * 用探针注入倍率做了 100 局 ×5 档 A/B（rng 序列不变，可比）：
 *
 * | 倍率 | 蓝胜/负/平 | 加时/拆家/平 | 双方拆楼合计 | 大本营剩血 |
 * | --- | --- | --- | --- | --- |
 * | 1.0 | 44/47/9 | 91/0/9 | 1.08 | 1197 / 1194 |
 * | 1.6 | 47/46/7 | 88/5/7 | 1.94 | 1130 / 1169 |
 * | 2.0 | 44/51/5 | 80/15/5 | 2.88 | 1045 / 1134 |
 * | **2.2** | **45/47/8** | **72/20/8** | **3.33** | **1039 / 1097** |
 * | 3.0 | 49/48/3 | 56/41/3 | 4.75 | 898 / 954 |
 *
 * 取 2.2：拆楼回到历史量级、两成局能靠拆家收尾，胜率仍近 5:5，
 * 且七成局仍走加时积分（用户 2026-11-06 定的「存活楼数比积分」口径没被推翻）。
 * 3.0 推得太快（41 局直接拆家），1.6 又没解决问题。
 *
 * 作用于 `hurtBuilding` 这一个入口（兵砍、塔炮、炮弹都算），**不动兵种互殴、
 * 不动建筑血量、不动金币节奏、不动判据**。且**只对 1v1 生效**：PVE 没有敌方建筑
 * 可拆，走这条路的只有怪拆玩家的楼，翻倍等于单方面削玩家（实测教学关 9/12 → 4/12）。
 */
export const BUILDING_DAMAGE_SCALE = 2.2;

/**
 * 民居：不出兵也不产金，专门给"要干活的楼"配人手 ——
 * 兵营 1 座、每座防御塔 1 座（用户 2026-10-31："防御建筑也占一处民房"）。
 *
 * 所以它是最值得打的建筑：拆掉对方两座民居，对方后配的两座塔就哑火、兵营就停产。
 * 这也是"拖他的建筑去打攻防"这条设计的具体落点，不是装饰。
 */
export const HOUSE = { hp: 220 };

/** 手牌：4 张，打出去之后进冷却再补一张新的。 */
export const HAND = { size: 4, refillSeconds: 2.2 };

/**
 * 手牌刷新（2026-11-06 用户）："除了 4 张卡牌之外，有一个刷新所有卡牌需要花 5 个金币。
 * 因为我们这边民居是必要的，所以需要刷新，一般刷新的时候默认会给一张房屋。"
 *
 * 所以刷新不是纯随机重抽 —— **保底一张民居卡**。没有这条，玩家花 5 金还可能
 * 抽到一手没有民居的牌，而民居是「建筑协调经济」里唯一的名额来源。
 */
export const REROLL = { cost: 5 };

/**
 * 对战模式里小人的显示身高（格）。
 * 比老模式（1.12）高一档：这一版兵少、镜头拉得更近，1.45 才看得清脸和动作。
 * 注意这是**等比放大**（宽度跟着高），不是把贴图拉扁。
 */
export const UNIT_HEIGHT = 1.45;

/** 兵的基础口径（秒/格沿用战斗内核那一套）。 */
export const UNIT = {
  /** 索敌半径：兵看见这个范围内的敌人就贴上去打 */
  sight: 4.2,
  /** 攻击间隔（各自的 cooldown 会在单位表里再乘一次） */
  moveStep: 0.02,
  /**
   * **守家拦截**（2026-11-06 用户："敌人已经过境了，我方的军队还在家里面，
   *  并没有保护家园，而是往对面冲"）。
   *
   * 敌兵摸进我方腹地（距我方大本营 < defendRadius）⇒ 我方所有兵的索敌视野
   * 扩到 alertSight：过境的敌人会被家里的兵转身追打，而不是眼睁睁看它拆家。
   * 敌人没入侵腹地时视野照旧 —— 全员回头追击会让"拖建筑"的推进打法消失。
   */
  defendRadius: 12,
  alertSight: 9,
  /**
   * **碰撞体积**（2026-11-06 用户："每个单位脚下会有一个看不见的小圆圈碰撞
   *  体积，不然的话它们会叠在一起"）。
   *
   * 每帧对活着的单位做两两分离：重叠就沿连线各退一半。半径 0.22 ⇒ 最小间距
   * 0.44 —— 比小队的落格间距（0.32）略大，落场即自动摊开；比近战射程（1.3）
   * 小得多，打架不受影响。看不见、也没有物理反弹，只是位置修正。
   */
  radius: 0.22,
};

export type CardKind = 'building' | 'squad' | 'siege';

export interface ArenaCard {
  id: string;
  name: string;
  blurb: string;
  kind: CardKind;
  /** 花多少金 */
  cost: number;
  /** 建筑卡：模型与规格 */
  building?: BuildingKind;
  /** 军队卡：出哪几种、各几个 */
  squad?: { unitId: string; count: number }[];
  /** 每个兵吃几份面包（默认 1）。民兵自带干粮只吃 0.5，6 人才装得进基础 3 面包 */
  breadPerMan?: number;
}

/**
 * 卡池。随机发 4 张进手牌（配卡组以后再做）。
 * 建筑贵、军队便宜 —— 这条差价就是"先立建筑"的钩子。
 *
 * 价格史（都写在字面量里，不做运行时乘）：
 * - 2026-10-27 用户要求「所有的东西的价格再贵一倍」，全池 ×2；
 * - 2026-11-06 用户："建筑的价格提高一点，军队的价格可以降一点" ——
 *   建筑再 +2、军队 −1~2，把差价进一步拉开（配合"兵营兵不占人口"，
 *   军队便宜了玩家更敢出兵，建筑涨价让每一栋楼都要想清楚再盖）。
 */
/**
 * 兽人巢穴（2026-11-07 用户新增）：只要花钱 + 有空位就能盖，不需要民居 / 磨坊 / 兵营。
 * 放在卡池**之前**，卡的 `cost` 直接读它 —— 判据只留一个数字。
 */
export const ORC_LAIR = { hp: 520, cost: 12 };

export const CARDS: ArenaCard[] = [
  {
    id: 'barracks',
    name: '兵营',
    blurb: '每 6 秒自动出一个守兵，不花金。站稳脚跟的第一步。',
    kind: 'building',
    cost: 14,
    building: 'barracks',
  },
  {
    id: 'arrowTower',
    name: '箭塔',
    // 射程从 TOWER 读，不写死数字：2026-11-08 上调到 7.8 之后，卡面不会留一个 6.8 的假读数
    blurb: `自动打靠近的敌人，射程 ${TOWER.arrow.range} 格。唯一能拦下空军的防御。`,
    kind: 'building',
    cost: 12,
    building: 'arrowTower',
  },
  {
    id: 'cannonTower',
    name: '炮塔',
    blurb: '一发 24 伤、炸一片，但很慢。放在兵营前面当闸门。',
    kind: 'building',
    cost: 16,
    building: 'cannonTower',
  },
  {
    id: 'mill',
    name: '磨坊',
    blurb: '每 5 秒多给 2 金。前期投资，回本要一会儿。',
    kind: 'building',
    cost: 10,
    building: 'mill',
  },
  {
    id: 'archers',
    name: '弓箭手小队',
    blurb: '一次三个弓箭手。便宜、脆、射得远。',
    kind: 'squad',
    cost: 5,
    squad: [{ unitId: 'archer', count: 3 }],
  },
  {
    id: 'mobileCannon',
    name: '移动火炮',
    // 2026-11-08 防御塔射程加远后：箭塔 7.8 > 火炮 7.2，"比塔都远"已经不成立。
    // 白嫖窗口只剩炮塔（6.8 + 1.5 = 8.3 < 火炮 7.2 + 1.5 = 8.7），别再对玩家许诺能白嫖箭塔。
    blurb: '两个小人推着走，射程 7.2 格。拆塔也打兵，慢、脆、贵；能白嫖炮塔，但压不住箭塔。',
    kind: 'siege',
    cost: 14,
    squad: [{ unitId: 'mobileCannon', count: 1 }],
  },
  {
    id: 'ballista',
    name: '移动弩箭',
    blurb: '一台大弩车，专点步兵：射程 6 格、一发重伤，但拆不了楼。',
    kind: 'siege',
    cost: 10,
    squad: [{ unitId: 'ballista', count: 1 }],
  },
  {
    id: 'house',
    name: '民居',
    blurb: '兵营的后勤：每座兵营要配 1 座磨坊 + 1 座民居才会出兵。',
    kind: 'building',
    cost: 8,
    building: 'house',
  },
  {
    id: 'knights',
    name: '骑士小队',
    blurb: '两个骑士：血厚、防高，顶在最前面。',
    kind: 'squad',
    cost: 8,
    squad: [{ unitId: 'knight', count: 2 }],
  },
  {
    id: 'mages',
    name: '法师小队',
    blurb: '两个法师，3.3 格外放法术弹，打兵打楼都疼。',
    kind: 'squad',
    cost: 10,
    squad: [{ unitId: 'mage', count: 2 }],
  },
  {
    id: 'priests',
    name: '牧师小队',
    blurb: '两个牧师：每 2.5 秒给身边 3 格内的自己人回 6 血，攻弱。',
    kind: 'squad',
    cost: 9,
    squad: [{ unitId: 'priest', count: 2 }],
  },
  {
    id: 'golem',
    name: '石怪',
    blurb: '一只石怪：走得慢，但血厚防高，扛线最合适。',
    kind: 'squad',
    cost: 8,
    squad: [{ unitId: 'golem', count: 1 }],
  },
  {
    id: 'mech',
    name: '机器巨人',
    blurb: '一台机器巨人：慢、笨重，但一拳能砸穿墙。',
    kind: 'squad',
    cost: 14,
    squad: [{ unitId: 'mech', count: 1 }],
  },
  {
    id: 'orcs',
    name: '兽人',
    blurb: '两个兽人，血厚、冲撞会把对面顶开。需兽人巢穴；不占人口，但吃双份面包。',
    kind: 'squad',
    cost: 7,
    squad: [{ unitId: 'orc', count: 2 }],
  },
  // ---- 大队：同一兵种的"人多版"（用户 2026-10-28："军队再丰富，比如大队还有小队"）。
  // 人数约翻倍、价不到翻倍 ⇒ 人多那一档性价比更高，但一次要掏的钱也更集中（更难凑）。
  {
    id: 'archersBig',
    name: '弓箭手大队',
    blurb: '五个弓箭手。一次铺开火力，也一次花掉大半条金。',
    kind: 'squad',
    cost: 9,
    squad: [{ unitId: 'archer', count: 5 }],
  },
  {
    id: 'knightsBig',
    name: '骑士大队',
    blurb: '四个骑士：一堵会走路的墙，推塔扛线都靠它。',
    kind: 'squad',
    cost: 13,
    squad: [{ unitId: 'knight', count: 4 }],
  },
  {
    id: 'orcsBig',
    name: '兽人大队',
    blurb: '四个兽人。冲撞能把一整排人顶散。需兽人巢穴；不占人口，但吃双份面包。',
    kind: 'squad',
    cost: 11,
    squad: [{ unitId: 'orc', count: 4 }],
  },  // ---------------------------------------------------------------- 2026-11-07 四张新军队卡（平衡见设计文档 B 节）
  {
    id: 'spearmen',
    name: '长矛兵小队',
    blurb: '三个长矛兵。便宜近战铺量，人多但血薄。',
    kind: 'squad',
    cost: 6,
    squad: [{ unitId: 'spearman', count: 3 }],
  },
  {
    id: 'crossbowmen',
    name: '弩手小队',
    blurb: '三个弩手。射程比弓手远一格，装填更慢。',
    kind: 'squad',
    cost: 8,
    squad: [{ unitId: 'crossbowman', count: 3 }],
  },
  {
    id: 'shields',
    name: '盾卫',
    blurb: '两个重盾。扛线专用，几乎打不动人。',
    kind: 'squad',
    cost: 10,
    squad: [{ unitId: 'shieldbearer', count: 2 }],
  },
  {
    id: 'balloon',
    name: '热气球',
    blurb: '悬浮投弹：越过建筑与黄区，从空中丢炸弹。',
    kind: 'squad',
    cost: 12,
    squad: [{ unitId: 'balloon', count: 1 }],
  },
  {
    id: 'airscrew',
    name: '空气螺旋机',
    blurb: '达芬奇飞行器：螺旋帆掠袭，速度快但血薄。',
    kind: 'squad',
    cost: 9,
    squad: [{ unitId: 'airscrew', count: 1 }],
  },
  {
    id: 'bomber',
    name: '扑翼轰炸机',
    blurb: '一次性冲刺：直扑敌方，下方有敌军就投弹，飞出地图即消失。',
    kind: 'squad',
    cost: 14,
    squad: [{ unitId: 'bomber', count: 1 }],
  },
  // ---------------------------------------------------------------- 2026-11-07 科技前置（设计文档 A/B/C 节）
  {
    id: 'militia',
    name: '民兵集结',
    blurb: '4 民兵 + 2 弓箭手：攻防低，但人多、便宜、自带干粮，而且不占人口。',
    kind: 'squad',
    cost: 5,
    squad: [{ unitId: 'militia', count: 4 }, { unitId: 'archer', count: 2 }],
    breadPerMan: 0.5,
  },
  {
    id: 'gearFactory',
    name: '齿轮工厂',
    blurb: '复古厂房 + 大齿轮（4×3）。建成后解锁热气球、空气螺旋机与扑翼轰炸机。',
    kind: 'building',
    cost: 16,
    building: 'gearFactory',
  },
  {
    id: 'orcLair',
    name: '兽人巢穴',
    blurb: '只要花钱就能盖。盖好解锁全部兽人军队：兽人不占人口，但每人要吃双份面包。',
    kind: 'building',
    cost: ORC_LAIR.cost,
    building: 'orcLair',
  },
];

export const cardById = (id: string): ArenaCard => {
  const c = CARDS.find((x) => x.id === id);
  if (!c) throw new Error(`未知卡牌 "${id}"`);
  return c;
};

/** 建筑卡 → 占地/血量/行为。表在这里，逻辑层只读。 */
/**
 * 占地：**所有建筑一律 3×3**（用户 2026-10-27 定的）。
 * 视觉上模型只有 1 格大，所以视图层会按 3 格再放大一次（见 ArenaApp 的 BUILDING_SCALE）。
 */
/** 齿轮工厂：第一栋 4×3 建筑（解锁空军），血厚一点、被动科技不配民居。 */
export const GEAR_FACTORY = { hp: 700 };

/** `ORC_LAIR` 定义在卡池之前（卡的 cost 要读它），这里不再重复声明。 */

/** 科技前置（2026-11-07 设计文档 A 节）：唯一默认军队卡 + 解锁者 */
export const TECH = {
  /** 无前置、永远在卡池 */
  militia: 'militia',
  /** 兵营解锁全部地面军队（除民兵） */
  barracks: 'barracks',
  /** 齿轮工厂解锁三架飞行器 + 两台攻城车 */
  gearFactory: 'gearFactory',
  /**
   * 需要齿轮工厂的卡（2026-11-07 用户："移动火炮和移动弓弩，也是需要建造工厂
   * 才能后置使用"）。原名 `flyerCards` 只装三架飞行器，名字已经不覆盖了 ——
   * 改叫 `factoryCards`，判据只留这一张表，别在别处另写一份。
   */
  factoryCards: ['balloon', 'airscrew', 'bomber', 'mobileCannon', 'ballista'] as string[],
  /** 兽人巢穴解锁全部兽人军队（2026-11-07 用户新增建筑） */
  orcLair: 'orcLair',
  orcCards: ['orcs', 'orcsBig'] as string[],
};

export const BUILDING_SPECS = {
  barracks: { cols: 3, rows: 3, hp: BARRACKS.hp },
  arrowTower: { cols: 3, rows: 3, hp: TOWER.arrow.hp },
  cannonTower: { cols: 3, rows: 3, hp: TOWER.cannon.hp },
  mill: { cols: 3, rows: 3, hp: MILL.hp },
  house: { cols: 3, rows: 3, hp: HOUSE.hp },
  gearFactory: { cols: 4, rows: 3, hp: GEAR_FACTORY.hp },
  orcLair: { cols: 3, rows: 3, hp: ORC_LAIR.hp },
} as const;

/** 模型放大倍率：占到 3×3 之后，不放大就只是格子里的一小块。 */
export const BUILDING_SCALE = 2.2;

export type BuildingKind = keyof typeof BUILDING_SPECS;

/**
 * **建筑占用人口表**（2026-11-07 用户："磨坊只需要扣一个人口，加两个面包……
 * 箭塔占用 1 个人口，炮塔占用两个人口"）。
 *
 * 这是判据的**唯一来源**：`ArenaWorld.supplyOf / supplyBlocked`、
 * `ai.canPlay`、卡面 `supplyRows` 的 SVG 图标数量全读它，
 * 谁也不许自己写一个 2。
 */
export const BUILDING_POP: Record<BuildingKind, number> = {
  house: 0,       // 自己是容器
  mill: 1,        // 加 2 面包，只扣 1 人口
  arrowTower: 1,  // 箭塔 1
  cannonTower: 2, // 炮塔 2
  barracks: 2,
  gearFactory: 2,
  orcLair: 2,
};

export const buildingPopOf = (kind: BuildingKind): number => BUILDING_POP[kind] ?? 2;

/**
 * **军队卡的人口 / 口粮**（2026-11-07 用户："兽人军队不占用人口，但是需要双倍的面包……
 * 民兵集结不占用人口"）。
 *
 * 和建筑表一样是唯一来源：落牌校验、卡面 SVG、出兵时写进单位的 `popCost / breadCost`
 * 都从这里取，避免"卡面画 1 个面包、实际吃 2 个"这种假读数。
 */
export interface ArmySupply {
  /** 每个兵占几份人口（0 = 不占） */
  popPerMan: number;
  /** 每个兵吃几份面包 */
  breadPerMan: number;
}

export function armySupplyOf(card: ArenaCard): ArmySupply {
  if (card.kind === 'building') return { popPerMan: 0, breadPerMan: 0 };
  // 民兵：不占人口，自带干粮仍只吃 0.5 份/人（6 人才装得进基础 3 面包）
  if (card.id === TECH.militia) return { popPerMan: 0, breadPerMan: card.breadPerMan ?? 0.5 };
  // 兽人：不占人口，但每人吃双份面包
  if (TECH.orcCards.includes(card.id)) return { popPerMan: 0, breadPerMan: 2 };
  return { popPerMan: SUPPLY.unitPop, breadPerMan: card.breadPerMan ?? 1 };
}

/** 扑翼轰炸机（2026-11-07 设计文档 E 节）：一次性冲刺、下方投弹、飞出界消失。 */
export const BOMBER = {
  /** 检测「下方有敌方军队」的半径 */
  detect: 2.5,
  /** 投弹溅射半径 */
  splash: 1.6,
  /** 每发炸弹的伤害 */
  damage: 22,
  /** 投弹间隔（秒） */
  interval: 1.4,
  /** 飞出这个边界就算离场 */
  exitMargin: 1,
};

/** 敌方 AI 的节奏：多久想一次、出手的随机上限。 */
export const AI = {
  thinkSeconds: 2.5,
  /** 它优先攒钱立建筑；建筑到几栋之后才开始出小队 */
  buildingsBeforeSquad: 2,
  /**
   * 刷新（2026-11-06）：AI 也会花 5 金换牌，但不能把钱刷光、也不能每 2.5 秒刷一次。
   * `minReserve` = 刷完至少还要留这么多金（够出一张便宜牌）；
   * `rerollCooldown` = 两次刷新之间的最小间隔（秒）。
   */
  minReserve: 10,
  rerollCooldown: 12,
};

/** 阵营色带：己方蓝、敌方红（像素小人的 suit 槽）。 */
export const FACTION_TINT = {
  blue: { suitBands: 'blue', label: '蓝方' },
  red: { suitBands: 'red', label: '红方' },
} as const;

/** 单位表的形状校验用：卡池里提到的兵种必须真的存在。 */
export type ArenaUnitRef = Pick<UnitDef, 'id' | 'name' | 'hp' | 'attack' | 'defense' | 'range' | 'speed'>;

/**
 * 移动火炮（用户 2026-10-27 点名要的"工程设备"）：
 * 两个小人在后面推，车上架一门 3D 火炮，**射程比炮塔还远** —— 就是拿来白嫖炮塔的。
 * 2026-11-08 防御塔加远之后，箭塔 7.8 已经反超这里的 7.2：
 * 火炮只比炮塔（6.8）远，白嫖窗口从"所有塔"收窄成"只有炮塔"，其余代价不变。
 * 代价写在这一行里：贵（16 金）、慢（0.5 格/秒）、脆（90 血）、装填很久（2.8 秒）。
 * 2026-10-27 用户修正：**它也要打兵**（之前只拆建筑，兵走到脸上它都不理）。
 * 2026-11-08：它是地面单位，和所有兵一样**不对空**。
 */
export const MOBILE = {
  hp: 90,
  speed: 0.5,
  range: 7.2,
  damage: 26,
  cooldown: 2.8,
  /** 索敌半径（兵和楼都看） */
  sight: 8,
  /** 两个推车的人：位置相对车尾，纯视觉 */
  pushers: 2,
};

/**
 * 移动弩箭（用户 2026-10-27）：和移动火炮**反过来**的攻城/反步兵单位 ——
 * 射程 6 格、一发 26 伤，专门点步兵；但它**只打兵不拆楼**。
 */
export const BALLISTA = {
  hp: 70,
  speed: 0.55,
  range: 6,
  damage: 26,
  cooldown: 2.2,
  sight: 6.5,
  pushers: 1,
};

/** 废墟：被拆掉的建筑在原地留一堆碎石，过这么久自己塌平。 */
export const RUIN = {
  seconds: 14,
  /** 最后几秒开始淡出 */
  fadeSeconds: 2.5,
};
