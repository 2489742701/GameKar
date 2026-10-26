/**
 * 离线等轴预览器（开发期用，不进产品包）。
 *
 * 为什么需要它：应用内浏览器截图长期拿不到；只靠"改代码→让用户看"就是盲改，
 * 结果越改越丑（用户 2026-10-27 的原话）。这个脚本把 `src/arena/models.ts` 里的模型
 * 按**和游戏完全相同的比例**（BUILDING_SCALE = 2.2）投成 PNG 排版图，改完先自己看。
 *
 * 它只是"假渲染"：平行光 + 平面着色、没有阴影和抗锯齿 ——
 * 够判断剪影、比例和配色，不等于最终观感。
 *
 * 排版：5 列（五栋楼）× 2 行（斜视 24° / 正对 0°），每格画 3×3 的占地格，
 * 右边立一个 1.45 格高的"小人"参照物 —— 比例对不对，一眼能量。
 *
 * 用法：node tools/preview_models.mjs [输出路径]
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { ARENA_MODELS } from '../src/arena/models.ts';

const SIDE_BLUE = 0x3f7fe0;
/** 和 config.ts 的 BUILDING_SCALE 一致：模型单位 → 格 */
const BUILDING_SCALE = 2.2;
/** 和 config.ts 的 UNIT_HEIGHT 一致：小人参照物高度（格） */
const UNIT_HEIGHT = 1.45;

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 画布

const COLS = Object.keys(ARENA_MODELS).length;
const ROWS = 2;
const CELL_W = 280;
const CELL_H = 420;
const W = CELL_W * COLS;
const H = CELL_H * ROWS;
const buf = new Uint8ClampedArray(W * H * 4);

const fill = (rgb) => {
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
    buf[i + 3] = 255;
  }
};
fill([18, 22, 28]);

/**
 * 深度缓冲：画家算法在"大平面 vs 小立面"上排不准（第一版就吃过一次，
 * 整块底面盖住了立面）。这里改成逐像素比较深度，顺序就无所谓了。
 */
const depthBuf = new Float32Array(W * H).fill(-Infinity);

/** 三角形光栅化（屏幕坐标 + 每顶点深度）。 */
function rasterTri(p0, p1, p2, d0, d1, d2, rgb) {
  const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
  const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  if (Math.abs(area) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((p1[0] - px) * (p2[1] - py) - (p2[0] - px) * (p1[1] - py)) / area;
      const w1 = ((p2[0] - px) * (p0[1] - py) - (p0[0] - px) * (p2[1] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const d = w0 * d0 + w1 * d1 + w2 * d2;
      const i = y * W + x;
      if (d <= depthBuf[i]) continue;
      depthBuf[i] = d;
      const o = i * 4;
      buf[o] = rgb[0];
      buf[o + 1] = rgb[1];
      buf[o + 2] = rgb[2];
      buf[o + 3] = 255;
    }
  }
}

/** 一个凸多边形 → 扇形三角化后光栅化。 */
function drawPoly(worldPts, rgb) {
  const viewPts = worldPts.map(view);
  const screen = viewPts.map((p) => [px(p), py(p)]);
  const depths = viewPts.map(depthOf);
  for (let i = 1; i + 1 < screen.length; i++) {
    rasterTri(screen[0], screen[i], screen[i + 1], depths[0], depths[i], depths[i + 1], rgb);
  }
}

// ---------------------------------------------------------------- 投影

/** 俯角：第三个命令行参数可改（测试用它证明"换机位图会变"） */
const PITCH = ((Number(process.argv[3]) || 50) * Math.PI) / 180;
const COS = Math.cos(PITCH);
const SIN = Math.sin(PITCH);
/** 光从左上前方来（和 Lighting.ts 的 SUN_DIR 一致） */
const LIGHT = (() => {
  const v = [-0.62, 1.0, 0.46];
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
})();

const rotXYZ = (p, rot) => {
  let [x, y, z] = p;
  if (rot) {
    const [rx, ry, rz] = rot;
    if (rz) {
      const c = Math.cos(rz);
      const s = Math.sin(rz);
      [x, y] = [x * c - y * s, x * s + y * c];
    }
    if (ry) {
      const c = Math.cos(ry);
      const s = Math.sin(ry);
      [x, z] = [x * c + z * s, -x * s + z * c];
    }
    if (rx) {
      const c = Math.cos(rx);
      const s = Math.sin(rx);
      [y, z] = [y * c - z * s, y * s + z * c];
    }
  }
  return [x, y, z];
};

/** 当前这一格的机位：yaw 绕 Y 转，模拟游戏里斜着看的机位 */
const CAM = { cx: 0, gy: 0, scale: 46, yaw: 0 };
const view = (p) => {
  const [x, y, z] = p;
  const c = Math.cos(CAM.yaw);
  const s = Math.sin(CAM.yaw);
  return [x * c + z * s, y, -x * s + z * c];
};
const px = (v) => CAM.cx + v[0] * CAM.scale;
const py = (v) => CAM.gy + (-v[1] * COS + v[2] * SIN) * CAM.scale;
const depthOf = (v) => v[1] * SIN + v[2] * COS;

const shade = (color, normal) => {
  const n = Math.hypot(...normal) || 1;
  const d = (normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]) / n;
  // 环境光抬到 0.62：预览器没有环境光遮蔽，打太暗就只剩一团黑，看不出模型
  const k = 0.62 + 0.55 * Math.max(0, d);
  return [((color >> 16) & 255) * k, ((color >> 8) & 255) * k, (color & 255) * k];
};

const normalOf = (a, b, c) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};

/**
 * 一个原语 → 若干四边形（局部坐标，已经按套件的锚点约定挪好）。
 *
 * 套件约定：box / cyl / cone / sphere / crystal 的 at 是**中心**，prism / plinth 是**底面**。
 * 下面统一先生成"底面在 0、向上 h"的本地几何，中心锚点的件再往下挪 h/2。
 */
function facesOf(node) {
  const at = node.at ?? [0, 0, 0];
  const rot = node.rot;
  const p = node.part;
  const centered = p.kind === 'box' || p.kind === 'cyl' || p.kind === 'cone' || p.kind === 'sphere' || p.kind === 'crystal';
  const lift = centered ? (p.kind === 'cyl' || p.kind === 'cone' ? p.height : p.kind === 'box' ? p.size[1] : p.kind === 'sphere' ? p.radius * 2 : p.height) : 0;
  const baseY = centered ? -lift / 2 : 0;
  const out = [];
  const pushQuad = (quad, color) => {
    const world = quad.map((q) => {
      const local = [q[0] * BUILDING_SCALE, (q[1] + baseY) * BUILDING_SCALE, q[2] * BUILDING_SCALE];
      // three 的变换顺序是"先转几何体、再平移"：把 at 加在旋转**之后**，
      // 否则带 rot 的件（炮管、轮毂）会被转到地底下去
      const turned = rotXYZ(local, rot);
      return [
        turned[0] + at[0] * BUILDING_SCALE,
        turned[1] + at[1] * BUILDING_SCALE,
        turned[2] + at[2] * BUILDING_SCALE,
      ];
    });
    const nrm = normalOf(world[0], world[1], world[2]);
    const toCamera = view([0, SIN, COS]);
    if (nrm[0] * toCamera[0] + nrm[1] * toCamera[1] + nrm[2] * toCamera[2] <= 0) return;
    out.push({ pts: world, color, normal: nrm });
  };

  if (p.kind === 'box' || p.kind === 'prism' || p.kind === 'plinth') {
    const [w, h, d] = p.size;
    const hw = w / 2;
    const hd = d / 2;
    const v = [
      [-hw, 0, -hd],
      [hw, 0, -hd],
      [hw, 0, hd],
      [-hw, 0, hd],
      [-hw, h, -hd],
      [hw, h, -hd],
      [hw, h, hd],
      [-hw, h, hd],
    ];
    // 六个面都按"从外面看是逆时针"绕序：绕反了会被当成背面剔掉，
    // 于是看到的是内壁（第一版就是这样，整个模型下半截全黑）
    const quads = [
      [v[7], v[6], v[5], v[4]], // 顶 +y
      [v[0], v[1], v[2], v[3]], // 底 -y
      [v[3], v[2], v[6], v[7]], // 前 +z（朝向镜头）
      [v[1], v[0], v[4], v[5]], // 后 -z
      [v[2], v[1], v[5], v[6]], // 右 +x
      [v[0], v[3], v[7], v[4]], // 左 -x
    ];
    if (p.kind === 'prism') {
      // 双坡顶：两个坡面 + 两个山墙（三角形，别拿退化四边形凑）
      const ridge0 = [-hw, h, 0];
      const ridge1 = [hw, h, 0];
      quads.length = 0;
      quads.push([v[3], v[2], ridge1, ridge0]); // 前坡
      quads.push([v[0], v[1], ridge1, ridge0]); // 后坡
      for (const q of quads) pushQuad(q, node.color);
      pushQuad([v[3], v[0], ridge0, ridge0], node.color); // 左山墙（-x 朝外）
      pushQuad([v[1], v[2], ridge1, ridge1], node.color); // 右山墙（+x 朝外）
      return out;
    }
    for (const q of quads) pushQuad(q, node.color);
    return out;
  }

  if (p.kind === 'cyl' || p.kind === 'cone') {
    const seg = p.seg ?? 8;
    const rTop = p.kind === 'cyl' ? p.rTop : 0;
    const rBottom = p.kind === 'cyl' ? p.rBottom : p.radius;
    const h = p.height;
    const apex = [0, h, 0];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const b0 = [Math.cos(a0) * rBottom, 0, Math.sin(a0) * rBottom];
      const b1 = [Math.cos(a1) * rBottom, 0, Math.sin(a1) * rBottom];
      const t0 = [Math.cos(a0) * rTop, h, Math.sin(a0) * rTop];
      const t1 = [Math.cos(a1) * rTop, h, Math.sin(a1) * rTop];
      // 绕序必须"从外面看逆时针"：反了会被背面剔除，看到的是内壁（塔会显得空心）
      if (rTop > 0.0001) {
        pushQuad([b1, b0, t0, t1], node.color); // 侧面
        pushQuad([apex, t1, t0, apex], node.color); // 顶盖
      } else {
        pushQuad([b1, b0, apex, apex], node.color); // 圆锥侧面
      }
    }
    return out;
  }

  if (p.kind === 'crystal') {
    const r = p.radius;
    const h = p.height;
    const midY = h * 0.45;
    const top = [0, h, 0];
    const bottom = [0, 0, 0];
    const ring = [
      [r, midY, 0],
      [0, midY, r],
      [-r, midY, 0],
      [0, midY, -r],
    ];
    for (let i = 0; i < 4; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % 4];
      pushQuad([top, b, a, top], node.color);
      pushQuad([bottom, a, b, bottom], node.color);
    }
    return out;
  }

  // 球：给个二十面体的近似（预览器里只用来当旗杆顶的宝珠）
  if (p.kind === 'sphere') {
    const r = p.radius;
    const h = r * 2;
    const seg = 6;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const y0 = h * 0.5;
      const b0 = [Math.cos(a0) * r, y0 - r * 0.55, Math.sin(a0) * r];
      const b1 = [Math.cos(a1) * r, y0 - r * 0.55, Math.sin(a1) * r];
      const t0 = [Math.cos(a0) * r, y0 + r * 0.55, Math.sin(a0) * r];
      const t1 = [Math.cos(a1) * r, y0 + r * 0.55, Math.sin(a1) * r];
      pushQuad([b0, b1, t1, t0], node.color);
      pushQuad([[0, h, 0], t1, t0, [0, h, 0]], node.color);
      pushQuad([[0, 0, 0], b0, b1, [0, 0, 0]], node.color);
    }
    return out;
  }

  return out;
}

// ---------------------------------------------------------------- 排版

const names = Object.keys(ARENA_MODELS);
const accents = { core: SIDE_BLUE, barracks: 0, arrowTower: 0, cannonTower: SIDE_BLUE, mill: SIDE_BLUE };
const ANGLES = [24, 0];

function drawGround() {
  // 3×3 占地格（格 = 世界单位，模型已经按 BUILDING_SCALE 放大过）
  for (let gx = -1.5; gx < 1.5; gx++) {
    for (let gz = -1.5; gz < 1.5; gz++) {
      const quad = [
        [gx, 0, gz],
        [gx + 1, 0, gz],
        [gx + 1, 0, gz + 1],
        [gx, 0, gz + 1],
      ];
      const tint = (gx + gz) % 2 === 0 ? [52, 70, 48] : [58, 78, 52];
      drawPoly(quad, tint);
    }
  }
  // 1.45 格高的小人参照物（放在左前角，别挡住模型）
  const ux = -1.15;
  const uz = 1.15;
  const w = 0.22;
  const box3 = (x0, y0, z0, x1, y1, z1, rgb) => {
    drawPoly([[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]], rgb);
    drawPoly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], rgb);
    drawPoly([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], rgb);
    drawPoly([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], rgb);
    drawPoly([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], rgb);
    drawPoly([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], rgb);
  };
  box3(ux - w / 2, 0, uz - w / 2, ux + w / 2, UNIT_HEIGHT, uz + w / 2, [150, 170, 210]);
}

names.forEach((name, index) => {
  ANGLES.forEach((yawDeg, row) => {
    CAM.cx = CELL_W * (index + 0.5);
    CAM.gy = CELL_H * row + CELL_H - 60;
    CAM.scale = 46;
    CAM.yaw = (yawDeg * Math.PI) / 180;
    // 清掉这一格的深度，免得上一格的深度挡住这一格
    const x0 = index * CELL_W;
    const y0 = row * CELL_H;
    for (let y = y0; y < y0 + CELL_H; y++) {
      for (let x = x0; x < x0 + CELL_W; x++) depthBuf[y * W + x] = -Infinity;
    }

    drawGround();
    const nodes = ARENA_MODELS[name](accents[name] ?? 0);
    for (const node of nodes) {
      for (const face of facesOf(node)) {
        drawPoly(face.pts, shade(face.color, face.normal));
      }
    }
  });
});

// 每栋楼的实测尺寸（格）：判断"是不是又超出占地了"就看这行
const summary = names.map((name) => {
  const nodes = ARENA_MODELS[name](accents[name] ?? 0);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    for (const face of facesOf(node)) {
      for (const p of face.pts) {
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[2]);
        maxZ = Math.max(maxZ, p[2]);
        maxY = Math.max(maxY, p[1]);
      }
    }
  }
  return `${name}: ${nodes.length} 件 · ${(maxX - minX).toFixed(1)}×${(maxZ - minZ).toFixed(1)} 格 · 高 ${maxY.toFixed(1)} 格`;
});

const out = process.argv[2] ?? '.scratch/models.png';
writeFileSync(out, encodePng(W, H, buf));
console.log(`wrote ${out}  ${W}x${H}  机位：斜视 ${ANGLES[0]}° / 正对 ${ANGLES[1]}°`);
console.log(summary.join('\n'));
