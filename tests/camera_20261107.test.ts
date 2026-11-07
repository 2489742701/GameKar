/**
 * 手机端相机改造的锁（2026-11-07）：
 * 俯仰范围、"斜视/正视/俯视"机位表、PGVE 与 1v1 两套机位不串味。
 *
 * 用户原话："双指缩放、转视角，还有上下转……最大可以转到平行的那种感觉，
 * 往下俯视，最大可以再往下来一点" + "手机端额外设置一个视角，给一个斜着的，
 * 还有一个正视角、斜视角，这些都可以设置"。
 */
import { describe, expect, it } from 'vitest';
import { ArenaDirector, PVE_VIEW_PRESETS, VIEW_PRESETS } from '@arena/Camera';
import { CameraRig, PITCH_MAX, PITCH_MIN } from '@engine/render/CameraRig';

describe('俯仰范围（双指上下推能推到哪）', () => {
  it('下限贴近平行、上限贴近正上方', () => {
    // 「平行的那种感觉」：十几度还是明显俯视，必须压到 10 度以内
    expect(PITCH_MIN).toBeLessThanOrEqual(10);
    expect(PITCH_MIN).toBeGreaterThan(0); // 0° 时射线与地面平行，点不了地
    // 「再往下来一点」：82 差一口气，得往 90 靠
    expect(PITCH_MAX).toBeGreaterThanOrEqual(86);
    expect(PITCH_MAX).toBeLessThan(90); // 90° 时 lookAt 的上方向退化，镜头会翻面
  });

  it('setPitch 两头都夹在范围内（不会出现 0° 或 90° 的退化姿态）', () => {
    const rig = new CameraRig({ tilesAcross: 20 });
    rig.setPitch(-40);
    expect(rig.pitch).toBe(PITCH_MIN);
    rig.setPitch(120);
    expect(rig.pitch).toBe(PITCH_MAX);
    rig.setPitch(50);
    expect(rig.pitch).toBe(50);
  });

  it('压到最低俯角仍然能点地（`screenToGround` 不解散）', () => {
    const rig = new CameraRig({ tilesAcross: 20, pitchDeg: PITCH_MIN });
    rig.resize(430, 932);
    rig.update(1 / 60);
    expect(rig.screenToGround(215, 466)).not.toBeNull();
  });
});

describe('机位表（斜视 / 正对 / 我方 / 俯视）', () => {
  it('PVE 四档，1v1 仍是三档（两套表互不覆盖）', () => {
    expect(PVE_VIEW_PRESETS.map((v) => v.name)).toEqual(['正对', '斜视', '我方', '俯视']);
    expect(VIEW_PRESETS).toHaveLength(3);
  });

  it('只有「斜视」明显歪，其余三档仍钉在 270° 附近（长边不能横过来）', () => {
    for (const preset of PVE_VIEW_PRESETS) {
      const off = Math.abs(preset.yaw - 270);
      if (preset.name === '斜视') continue;
      expect(off, `${preset.name} 的 yaw 离 270 太远`).toBeLessThanOrEqual(12);
    }
    // 默认档必须正对：60 格长边严格竖直，竖屏才铺得满
    expect(PVE_VIEW_PRESETS[0]!.yaw).toBe(270);
  });

  /**
   * 用户发回真机截图定稿："就是这个角度，把斜视改成这个角度就是斜视嘛，斜图嘛"。
   * 图上量出来：场地边/黄区带在屏幕上斜约 25°、低俯角、上下留大块场外、只露一角。
   * 这一档的定位**不是**"稍微歪一点的全景"，而是斜着切开画面的构图。
   */
  it('「斜视」按参考图定稿：拧掉约 30°、低俯角、拉近（不是拉远补裁切）', () => {
    const upright = PVE_VIEW_PRESETS[0]!;
    const slanted = PVE_VIEW_PRESETS[1]!;
    const off = Math.abs(slanted.yaw - 270);
    expect(off).toBeGreaterThanOrEqual(25);
    expect(off).toBeLessThanOrEqual(45);
    expect(slanted.pitch).toBeLessThan(upright.pitch);
    // 歪了不靠拉远把全场塞回来 —— 那是"正对"该干的事
    expect(slanted.zoomFactor).toBeLessThan(upright.zoomFactor);
  });

  it('「俯视」是真的往下压：俯角比「正对」高一大截', () => {
    const upright = PVE_VIEW_PRESETS[0]!;
    const top = PVE_VIEW_PRESETS[3]!;
    expect(top.pitch).toBeGreaterThanOrEqual(upright.pitch + 28);
  });
});

describe('导演换表与选档', () => {
  it('usePresets 换掉整张表，current / next 都跟着走', () => {
    const d = new ArenaDirector();
    expect(d.current.name).toBe('斜视'); // 1v1 默认档
    d.usePresets(PVE_VIEW_PRESETS, 0);
    expect(d.current.name).toBe('正对');
    expect(d.next().name).toBe('斜视');
    // 反证：循环回的是 PVE 表里的第 4 档，不是 1v1 表里的第 3 档
    d.select(PVE_VIEW_PRESETS.length - 1);
    expect(d.next().name).toBe('正对');
  });

  it('select 越界夹回范围，不抛错', () => {
    const d = new ArenaDirector();
    d.usePresets(PVE_VIEW_PRESETS, 0);
    expect(d.select(99).name).toBe('俯视');
    expect(d.select(-3).name).toBe('正对');
  });

  it('选档必须解锁 —— 锁着的时候 update 一帧都不碰相机', () => {
    const d = new ArenaDirector();
    d.usePresets(PVE_VIEW_PRESETS, 0);
    d.userTouched();
    expect(d.locked).toBe(true);
    const rig = new CameraRig({ tilesAcross: 20, yawDeg: 270, pitchDeg: 44 });
    d.update(1 / 60, rig, 32, { x: 16, z: 16 });
    const frozen = rig.pitch;
    d.select(3); // 俯视 76°
    expect(d.locked).toBe(false);
    for (let i = 0; i < 240; i++) d.update(1 / 60, rig, 32, { x: 16, z: 16 });
    expect(rig.pitch).toBeGreaterThan(frozen + 20);
    expect(rig.pitch).toBeCloseTo(PVE_VIEW_PRESETS[3]!.pitch, 0); // 导演没设 pitchBias，直接落到 76°
  });
});
