/**
 * 玩家可调的那套材质参数 —— 参数 ↔ 独有 ID 的双向编码，加上本地偏好读写。
 *
 * ID 不是随机串号：**同一套参数永远同一个 ID**，所以它能当"分享码"用 ——
 * 别人把 `mk-1q7x3fa` 贴回输入框，看到的木头就和这边一模一样。
 * 也因此它必须可逆：解码不出来就返回 null，绝不"猜一个差不多的"，
 * 否则一个错字会把玩家的界面悄悄换成另一套长相。
 *
 * 八个字段量化后共 28 bit，base36 六位装得下（36⁶ ≈ 2.17e9 > 2²⁸ ≈ 2.68e8）。
 * 前缀里那一位是**版本号**：以后要加字段必须升版本，否则老 ID 会被解成新含义。
 */

import type { Prefs } from '@game/prefs';
import { DEFAULT_GILT, DEFAULT_WOOD, type GiltSpec, type WoodSpec } from './theme';

export interface Tuning {
  /** 木纹整体明度 0.20–0.70 */
  brightness: number;
  /** 亮度量化成几档（3–8）：越少越像旧手绘 */
  steps: number;
  /** 横纹密度（y 方向格点，6–20） */
  grainY: number;
  /** 几像素一块板（4–24，步进 2） */
  plankRows: number;
  /** 板缝压暗多深（0–0.30） */
  seam: number;
  /** 小图放大几倍（1–5）：这一维就是"像素块多大" */
  scale: number;
  /** 种子变体（0–7）：同一套参数换一张木纹 */
  seedVariant: number;
  /** 镀金强度（不透明度 0–200，0 = 按键不上金） */
  gilt: number;
}

interface Field {
  key: keyof Tuning;
  min: number;
  max: number;
  step: number;
  bits: number;
}

/** 顺序就是编码里的位序 —— 只能往后加，不许重排。 */
const FIELDS: readonly Field[] = [
  { key: 'brightness', min: 0.2, max: 0.7, step: 0.02, bits: 5 },
  { key: 'steps', min: 3, max: 8, step: 1, bits: 3 },
  { key: 'grainY', min: 6, max: 20, step: 1, bits: 4 },
  { key: 'plankRows', min: 4, max: 24, step: 2, bits: 4 },
  { key: 'seam', min: 0, max: 0.3, step: 0.05, bits: 3 },
  { key: 'scale', min: 1, max: 5, step: 1, bits: 3 },
  { key: 'seedVariant', min: 0, max: 7, step: 1, bits: 3 },
  { key: 'gilt', min: 0, max: 200, step: 40, bits: 3 },
];

export const VERSION = '1';
const PREFIX = 'mk-';
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const PAYLOAD = 6;

export const DEFAULT_TUNING: Tuning = {
  brightness: 0.34,
  steps: 5,
  grainY: 10,
  plankRows: 16,
  seam: 0.1,
  scale: 2,
  seedVariant: 0,
  gilt: DEFAULT_GILT.alpha,
};

/** 三档预设：淡（=默认，最亮） / 中 / 重。参数取自对比页量过的那三组。 */
export const PRESETS: { name: string; tuning: Tuning }[] = [
  { name: '淡', tuning: { ...DEFAULT_TUNING } },
  { name: '中', tuning: { ...DEFAULT_TUNING, brightness: 0.44, steps: 6, grainY: 13, plankRows: 12, seam: 0.2 } },
  { name: '重', tuning: { ...DEFAULT_TUNING, steps: 4, brightness: 0.5, plankRows: 8, seam: 0.3, grainY: 20 } },
];

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 某个字段一共有几档合法值。 */
const levels = (field: Field) => Math.round((field.max - field.min) / field.step) + 1;

/** 浮点参数 → 档位序号。 */
function slot(field: Field, value: number): number {
  return clampInt(Math.round((value - field.min) / field.step), 0, levels(field) - 1);
}

function valueOf(field: Field, index: number): number {
  const v = field.min + index * field.step;
  // 步进 1 的字段是整数，别让它带着 .0 出去
  return field.step >= 1 ? Math.round(v) : Math.round(v * 100) / 100;
}

/** 参数字段依次拼成一个 28 bit 整数（高位在前，顺序就是 FIELDS 的顺序）。 */
function packBits(t: Tuning): number {
  let bits = 0;
  for (const field of FIELDS) bits = bits * 2 ** field.bits + slot(field, t[field.key]);
  return bits;
}

export function encodeTuning(t: Tuning): string {
  let n = packBits(t);
  let out = '';
  for (let i = 0; i < PAYLOAD; i++) {
    out = ALPHABET[n % 36] + out;
    n = Math.floor(n / 36);
  }
  // 28 bit 装进 6 个 base36 位（容量 36⁶ ≈ 2.18e9），理论上不可能溢出；溢出说明位宽算错了
  if (n !== 0) throw new Error('ID 位宽不够，编码会截断');
  return `${PREFIX}${VERSION}${out}`;
}

/** ID → 参数。格式不对、版本不认识、字符不在表里 —— 一律 null，不猜。 */
export function decodeTuning(id: string): Tuning | null {
  const raw = (id ?? '').trim().toLowerCase();
  if (!raw.startsWith(PREFIX)) return null;
  const body = raw.slice(PREFIX.length);
  if (body.length !== VERSION.length + PAYLOAD) return null;
  if (body[0] !== VERSION) return null;

  let n = 0;
  for (const ch of body.slice(1)) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) return null;
    n = n * 36 + index;
  }

  const out = {} as Tuning;
  for (let i = FIELDS.length - 1; i >= 0; i--) {
    const field = FIELDS[i]!;
    const span = 2 ** field.bits;
    const index = n % span;
    n = Math.floor(n / span);
    if (index >= levels(field)) return null; // 这一档不是合法值：号是拼出来的
    out[field.key] = valueOf(field, index);
  }
  return n === 0 ? out : null;
}

/** 参数 → 两份纹理规格。 */
export function woodOf(t: Tuning): WoodSpec {
  return {
    ...DEFAULT_WOOD,
    steps: t.steps,
    grainY: t.grainY,
    plankRows: t.plankRows,
    seam: t.seam,
    brightness: t.brightness,
    seed: DEFAULT_WOOD.seed + t.seedVariant * 7919,
  };
}

export function giltOf(t: Tuning): GiltSpec {
  return { ...DEFAULT_GILT, alpha: t.gilt };
}

/** 把参数里的浮点值贴回它真正落在的档位，避免滑杆显示 0.35 而 ID 里是 0.34。 */
export function snapTuning(t: Tuning): Tuning {
  const out = {} as Tuning;
  for (const field of FIELDS) out[field.key] = valueOf(field, slot(field, t[field.key]));
  return out;
}

// ---------------------------------------------------------------- 本地偏好

/** 存的就是那个可分享的 ID：一份真相，不会参数与码对不上。 */
export function loadTuning(prefs: Prefs): Tuning {
  const id = prefs.themeId;
  return (id ? decodeTuning(id) : null) ?? { ...DEFAULT_TUNING };
}

export function saveTuning(prefs: Prefs, t: Tuning): string {
  const id = encodeTuning(snapTuning(t));
  prefs.setThemeId(id);
  return id;
}
