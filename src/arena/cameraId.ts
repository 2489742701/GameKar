/**
 * 机位 ID —— 把"朝向 / 俯仰 / 缩放"三个数打包成一个短码，用户记下来发我，我照着复现。
 *
 * 和界面材质那套 ID 同一个思路：**同一组参数永远同一个码**，可逆、不猜。
 * 量化口径写死在 FIELD 里，改了口径必须升版本号（现在 1），否则老码会被解成新含义。
 */

export interface CameraShot {
  /** 朝向，0–359 度 */
  yaw: number;
  /** 俯仰，20–80 度 */
  pitch: number;
  /** 相对"整幅场地入画"的缩放倍率，0.50–1.20 */
  zoom: number;
}

const VERSION = '1';
const PREFIX = 'cam-';
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const PAYLOAD = 5;

/** [字段, 最小, 最大, 步长] —— 顺序就是编码位序，只能往后加。 */
const FIELDS: readonly [keyof CameraShot, number, number, number][] = [
  ['yaw', 0, 359, 1],
  ['pitch', 20, 80, 1],
  ['zoom', 0.5, 1.2, 0.01],
];

export const DEFAULT_SHOT: CameraShot = { yaw: 24, pitch: 50, zoom: 1 };

function snap(value: number, lo: number, hi: number, step: number): number {
  const n = Math.round((value - lo) / step);
  const span = Math.round((hi - lo) / step) + 1;
  return lo + Math.min(span - 1, Math.max(0, n)) * step;
}

/** 参数 → 槽位号（0 起）。 */
function slotOf(index: number, shot: CameraShot): number {
  const [key, lo, hi, step] = FIELDS[index]!;
  return Math.round((snap(shot[key], lo, hi, step) - lo) / step);
}

function valueOf(index: number, slot: number): number {
  const [key, lo, hi, step] = FIELDS[index]!;
  const span = Math.round((hi - lo) / step) + 1;
  const v = lo + Math.min(span - 1, Math.max(0, slot)) * step;
  // zoom 保留两位，别让 0.9000000000000001 这种数跑出去
  return key === 'zoom' ? Math.round(v * 100) / 100 : v;
}

/** 各字段占几位：yaw 360 档要 9 位，pitch 61 档要 6 位，zoom 71 档要 7 位。 */
const BITS = [9, 6, 7] as const;

export function encodeCamera(shot: CameraShot): string {
  let bits = 0;
  for (let i = 0; i < FIELDS.length; i++) bits = bits * 2 ** BITS[i]! + slotOf(i, shot);
  let out = '';
  let n = bits;
  for (let i = 0; i < PAYLOAD; i++) {
    out = ALPHABET[n % 36] + out;
    n = Math.floor(n / 36);
  }
  return `${PREFIX}${VERSION}${out}`;
}

export function decodeCamera(id: string): CameraShot | null {
  const raw = (id ?? '').trim().toLowerCase();
  if (!raw.startsWith(PREFIX)) return null;
  const body = raw.slice(PREFIX.length);
  if (body.length !== VERSION.length + PAYLOAD) return null;
  if (body[0] !== VERSION) return null;

  let n = 0;
  for (const ch of body.slice(1)) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    n = n * 36 + idx;
  }

  const out = {} as CameraShot;
  for (let i = FIELDS.length - 1; i >= 0; i--) {
    const span = 2 ** BITS[i]!;
    const slot = n % span;
    n = Math.floor(n / span);
    const [, lo, hi, step] = FIELDS[i]!;
    const levels = Math.round((hi - lo) / step) + 1;
    if (slot >= levels) return null; // 这一档不合法：码是拼出来的
    out[FIELDS[i]![0]] = valueOf(i, slot);
  }
  return n === 0 ? out : null;
}

/** 贴回量化档位，保证"读数"和"码"永远是同一组数。 */
export function snapShot(shot: CameraShot): CameraShot {
  const out = {} as CameraShot;
  for (let i = 0; i < FIELDS.length; i++) out[FIELDS[i]![0]] = valueOf(i, slotOf(i, shot));
  return out;
}
