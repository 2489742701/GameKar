/**
 * 标记层 —— 悬停格、占地预览、选中框。
 *
 * 用 LineSegments 画框（WebGL 里线宽恒为 1px，所以再叠一层半透明地面片，
 * 手机上细线看不清时靠色块表达"我选中了这里"）。
 */

import * as THREE from 'three';
import type { GridPos } from '@engine/math/Grid';
import { TILE_SIZE, cellToWorld } from '@engine/math/Grid';

const HOVER = 0xf3e2a9;
export const TINT_OK = 0x63d98a;
export const TINT_NO = 0xff6b6b;
/** 能盖、但会毁掉晶脉：既不是放行也不是拒绝，得单独一个颜色，否则玩家以为直接就能盖 */
export const TINT_WARN = 0xd9b25c;
const SELECTED = 0xd9b25c;

export interface SelectionShape {
  origin: GridPos;
  cols: number;
  rows: number;
  /** 选中框的高度（世界单位），等于建筑实际高度 */
  height: number;
  surfaceY: number;
}

function unitBoxEdges(): THREE.LineSegments {
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  // transparent 必须开，否则 update() 里调 opacity 是空操作
  const line = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: SELECTED, transparent: true }),
  );
  line.frustumCulled = false;
  return line;
}

function groundQuad(color: number, opacity: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
  mesh.frustumCulled = false;
  return mesh;
}

export type FootprintState = 'ok' | 'warn' | 'no';

const FOOTPRINT_TINT: Record<FootprintState, number> = {
  ok: TINT_OK,
  warn: TINT_WARN,
  no: TINT_NO,
};

export class MarkerLayer {
  readonly group = new THREE.Group();

  private readonly hoverFrame = unitBoxEdges();
  private readonly hoverFill = groundQuad(HOVER, 0.16);
  private readonly footprintFill = groundQuad(TINT_OK, 0.3);
  private readonly footprintFrame = unitBoxEdges();
  private readonly selection = unitBoxEdges();

  constructor() {
    this.group.name = 'markers';
    this.group.add(this.hoverFrame, this.hoverFill, this.footprintFill, this.footprintFrame, this.selection);
    for (const o of [this.hoverFrame, this.hoverFill, this.footprintFill, this.footprintFrame, this.selection]) {
      o.visible = false;
    }
    (this.footprintFrame.material as THREE.LineBasicMaterial).color.setHex(SELECTED);
  }

  /** 参数为 null 表示取消悬停。 */
  showHover(cell: GridPos | null, surfaceY: number): void {
    if (!cell) {
      this.hoverFrame.visible = false;
      this.hoverFill.visible = false;
      return;
    }
    const { x, z } = cellToWorld(cell);
    const h = 0.34;
    this.hoverFill.position.set(x, surfaceY + 0.012, z);
    this.hoverFill.scale.set(TILE_SIZE * 0.98, 1, TILE_SIZE * 0.98);
    this.hoverFrame.scale.set(TILE_SIZE * 0.98, h, TILE_SIZE * 0.98);
    this.hoverFrame.position.set(x, surfaceY + h / 2, z);
    this.hoverFrame.visible = this.hoverFill.visible = true;
  }

  /** 放置预览：占地色块 + 外框，state 同时表达"能不能盖"和"会不会毁矿"。 */
  showFootprint(origin: GridPos, cols: number, rows: number, surfaceY: number, state: FootprintState): void {
    const cx = (origin.col + cols / 2) * TILE_SIZE;
    const cz = (origin.row + rows / 2) * TILE_SIZE;

    const color = FOOTPRINT_TINT[state];
    (this.footprintFill.material as THREE.MeshBasicMaterial).color.setHex(color);

    this.footprintFill.position.set(cx, surfaceY + 0.02, cz);
    this.footprintFill.scale.set(cols * TILE_SIZE * 0.98, 1, rows * TILE_SIZE * 0.98);

    const h = 0.5;
    this.footprintFrame.scale.set(cols * TILE_SIZE, h, rows * TILE_SIZE);
    this.footprintFrame.position.set(cx, surfaceY + h / 2, cz);
    (this.footprintFrame.material as THREE.LineBasicMaterial).color.setHex(color);

    this.footprintFill.visible = this.footprintFrame.visible = true;
  }

  hideFootprint(): void {
    this.footprintFill.visible = false;
    this.footprintFrame.visible = false;
  }

  select(shape: SelectionShape | null): void {
    if (!shape) {
      this.selection.visible = false;
      return;
    }
    const cx = (shape.origin.col + shape.cols / 2) * TILE_SIZE;
    const cz = (shape.origin.row + shape.rows / 2) * TILE_SIZE;
    this.selection.scale.set(shape.cols * TILE_SIZE, shape.height, shape.rows * TILE_SIZE);
    this.selection.position.set(cx, shape.surfaceY + shape.height / 2, cz);
    this.selection.visible = true;
  }

  /** 选中框轻微呼吸：静止的框在俯视角里容易被当成地图装饰。 */
  update(time: number): void {
    if (!this.selection.visible) return;
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(time * 3.4));
    (this.selection.material as THREE.LineBasicMaterial).opacity = pulse;
  }
}
