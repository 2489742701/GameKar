/**
 * 测试用尺子：在 node 里直接解 PNG，数出素材表里"哪几列有画"。
 *
 * 为什么要自己写：产品侧的 `scanFilledColumns()` 走的是浏览器 canvas，
 * 测试环境（environment: 'node'）拿不到像素。两边各写一份、结果必须一致，
 * 才是真的把"空列"这件事钉住 —— 单靠一份实现，错了也没人知道。
 *
 * 只支持本项目这几张贴图的形状：8 位深、colorType 6（RGBA）、非交错、单 filter/行。
 * 别的形状直接抛，不猜。
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export interface DecodedRgba {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(path: string): DecodedRgba {
  const buf = readFileSync(path);
  if (buf.toString('binary', 1, 4) !== 'PNG') throw new Error(`${path} 不是 PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) {
    throw new Error(`${path} 不是 8bit RGBA 非交错（depth=${buf[24]} colorType=${buf[25]} interlace=${buf[28]}）`);
  }

  const parts: Buffer[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') parts.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));

  const stride = width * 4;
  const out = new Uint8Array(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= 4 ? prev[x - 4]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`${path} 第 ${y} 行用了不支持的 filter ${filter}`);
      cur[x] = v & 255;
    }
  }
  return { width, height, rgba: out };
}

export interface ColumnScan {
  cols: number;
  /** 有画（alpha > 8）的列号 */
  filled: Set<number>;
  /** 全空的列号，排序好便于直接和实测值对表 */
  blanks: number[];
}

/** 和 `pack.ts` 里那份 canvas 实现同一个判据：alpha > 8 算有画。 */
export function scanColumns(img: DecodedRgba, cell: number): ColumnScan {
  if (img.width % cell !== 0) throw new Error(`宽 ${img.width} 不能被单格 ${cell} 整除`);
  const cols = img.width / cell;
  const filled = new Set<number>();
  for (let k = 0; k < cols; k++) {
    for (let x = k * cell; x < (k + 1) * cell && !filled.has(k); x++) {
      for (let y = 0; y < img.height; y++) {
        if (img.rgba[(y * img.width + x) * 4 + 3]! > 8) {
          filled.add(k);
          break;
        }
      }
    }
  }
  const blanks: number[] = [];
  for (let k = 0; k < cols; k++) if (!filled.has(k)) blanks.push(k);
  return { cols, filled, blanks };
}
