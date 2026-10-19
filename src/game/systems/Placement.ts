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
import { TINT_NO, TINT_OK, type MarkerLayer } from '@game/world/Markers';
import type { Building, GameWorld } from '@game/world/GameWorld';

export class PlacementController {
  private ghost: THREE.Group | null = null;
  private buildingId: string | null = null;
  private valid = false;

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
      this.valid = false;
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
    this.valid = false;
    this.disposeGhost();
    this.markers.hideFootprint();
    if (wasActive) this.onActiveChange?.(null);
  }

  /** 悬停格变了：幽灵跟着走，颜色跟着判定走。 */
  preview(cell: GridPos | null): void {
    if (!this.buildingId || !this.ghost || !cell) return;
    const def = buildingDef(this.buildingId);
    const { cols, rows } = def.footprint;

    const nowValid = this.world.inspectPlacement(def, cell) === null;
    const center = footprintCenter({ origin: cell, cols, rows });
    const surfaceY = this.world.map.footprintSurfaceY(cell, cols, rows);

    this.ghost.visible = true;
    this.ghost.position.set(center.x, surfaceY, center.z);
    this.markers.showFootprint(cell, cols, rows, surfaceY, nowValid);

    if (nowValid !== this.valid) {
      this.valid = nowValid;
      this.paintTint();
    }
  }

  previewHidden(): void {
    if (this.ghost) this.ghost.visible = false;
    this.markers.hideFootprint();
  }

  /** 确认落位。成功返回建筑；许可还有剩就留在放置模式，方便连续盖。 */
  commit(cell: GridPos): Building | null {
    if (!this.buildingId) return null;
    const id = this.buildingId;
    const building = this.world.build(id, cell);
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
    const material = ghostMaterialFor(this.valid ? TINT_OK : TINT_NO);
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
