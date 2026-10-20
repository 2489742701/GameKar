/**
 * 放置控制器 —— "选卡 → 拖预览 → 点地确认"的那段交互。
 *
 * 能不能盖完全由 GameWorld.inspectPlacement 判定（无副作用），控制器只负责把结论画成
 * 绿/红幽灵。所以"UI 显示能盖"和"真能盖"永远同源，不会出现点了才报错。
 */

import * as THREE from 'three';
import type { GridPos } from '@engine/math/Grid';
import { footprintCenter } from '@engine/math/Grid';
import { buildingDef } from '@game/data/buildings';
import { ghostMaterialFor, type ModelLibrary } from '@game/models/registry';
import { TINT_NO, TINT_OK, TINT_WARN, type FootprintState, type MarkerLayer } from '@game/world/Markers';
import type { Building, GameWorld } from '@game/world/GameWorld';

const GHOST_TINT: Record<FootprintState, number> = {
  ok: TINT_OK,
  warn: TINT_WARN,
  no: TINT_NO,
};

export class PlacementController {
  private ghost: THREE.Group | null = null;
  private buildingId: string | null = null;
  private state: FootprintState = 'no';

  /**
   * 模式变化的唯一出口。自动取消（许可用完那一刻）也走这里，
   * 否则建造槽会停在"取消 · 田庄"的亮着状态，而实际上手里已经没东西可放了。
   */
  onActiveChange?: (buildingId: string | null) => void;

  constructor(
    private readonly world: GameWorld,
    private readonly library: ModelLibrary,
    private readonly markers: MarkerLayer,
    private readonly scene: THREE.Object3D,
  ) {}

  get activeBuildingId(): string | null {
    return this.buildingId;
  }

  get isActive(): boolean {
    return this.buildingId !== null;
  }

  /** 进入放置模式。没有许可直接返回 false，UI 据此提示"先去抽"。 */
  begin(buildingId: string): boolean {
    if (this.world.permitCount(buildingId) <= 0) {
      this.cancel();
      return false;
    }
    if (this.buildingId !== buildingId) {
      this.disposeGhost();
      this.ghost = this.library.create(buildingDef(buildingId).model);
      this.ghost.name = 'ghost';
      this.scene.add(this.ghost);
      this.state = 'no';
      this.paintTint();
    }
    this.buildingId = buildingId;
    if (this.ghost) this.ghost.visible = false;
    this.markers.hideFootprint();
    this.onActiveChange?.(buildingId);
    return true;
  }

  cancel(): void {
    const wasActive = this.buildingId !== null;
    this.buildingId = null;
    this.state = 'no';
    this.disposeGhost();
    this.markers.hideFootprint();
    if (wasActive) this.onActiveChange?.(null);
  }

  /** 这一格当前的三种脸色：不能盖 / 能盖但要毁晶脉 / 随便盖。 */
  stateOf(cell: GridPos): FootprintState {
    if (!this.buildingId) return 'no';
    const def = buildingDef(this.buildingId);
    if (this.world.inspectPlacement(def, cell) !== null) return 'no';
    return this.veinsAtRisk(cell).length > 0 ? 'warn' : 'ok';
  }

  /** 盖在这一格会被压掉的晶脉格子。 */
  veinsAtRisk(cell: GridPos): GridPos[] {
    if (!this.buildingId) return [];
    const { cols, rows } = buildingDef(this.buildingId).footprint;
    return this.world.veinsUnder(cell, cols, rows);
  }

  /** 悬停格变了：幽灵跟着走，颜色跟着判定走。 */
  preview(cell: GridPos | null): void {
    if (!this.buildingId || !this.ghost || !cell) return;
    const def = buildingDef(this.buildingId);
    const { cols, rows } = def.footprint;

    const next = this.stateOf(cell);
    const center = footprintCenter({ origin: cell, cols, rows });
    const surfaceY = this.world.map.footprintSurfaceY(cell, cols, rows);

    this.ghost.visible = true;
    this.ghost.position.set(center.x, surfaceY, center.z);
    this.markers.showFootprint(cell, cols, rows, surfaceY, next);

    if (next !== this.state) {
      this.state = next;
      this.paintTint();
    }
  }

  previewHidden(): void {
    if (this.ghost) this.ghost.visible = false;
    this.markers.hideFootprint();
  }

  /**
   * 确认落位。压着晶脉时必须是明确同意过的（allowDestroy），
   * 否则世界层会原样退回来 —— 这条闸门放在世界而不是放在点击里，
   * 脚本和回放也绕不过去。
   */
  commit(cell: GridPos, allowDestroy = false): Building | null {
    if (!this.buildingId) return null;
    const id = this.buildingId;
    const building = this.world.build(id, cell, allowDestroy);
    if (!building) {
      this.preview(cell);
      return null;
    }
    if (this.world.permitCount(id) <= 0) this.cancel();
    else this.begin(id);
    return building;
  }

  /** 材质走全局缓存：换颜色只是换个引用，不产生新的着色器程序。 */
  private paintTint(): void {
    if (!this.ghost) return;
    const material = ghostMaterialFor(GHOST_TINT[this.state]);
    this.ghost.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.material = material;
        child.castShadow = false;
        child.receiveShadow = false;
      }
    });
  }

  private disposeGhost(): void {
    this.ghost?.removeFromParent();
    this.ghost = null;
  }
}
