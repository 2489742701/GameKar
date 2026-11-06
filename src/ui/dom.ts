/**
 * DOM 微工具 —— 够用就停，不引框架。
 *
 * UI 的全部状态都来自 GameWorld 的读数，DOM 只是它的一面镜子：
 * 所以这里只有"建元素/改文本/换 class"，没有虚拟 DOM，也没有双向绑定。
 */

export interface MakeOptions {
  class?: string;
  text?: string;
  dataset?: Record<string, string | number | boolean>;
  attrs?: Record<string, string>;
  onClick?: (event: MouseEvent) => void;
  hidden?: boolean;
}

type Tag = keyof HTMLElementTagNameMap;

export function make<K extends Tag>(
  tag: K,
  options: MakeOptions = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.hidden) node.hidden = true;
  for (const [k, v] of Object.entries(options.dataset ?? {})) node.dataset[k] = String(v);
  for (const [k, v] of Object.entries(options.attrs ?? {})) node.setAttribute(k, v);
  // 泛型 K 会让 addEventListener 退化成 string 事件名，这里按最具体的 HTML 元素登记
  if (options.onClick) (node as HTMLElement).addEventListener('click', options.onClick);
  for (const child of children) node.append(child);
  return node;
}

/** 只在值真的变了的时候写 DOM：一帧几十次 setText 会白白触发重排。 */
export function setText(node: Text | HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

export function setFlag(node: HTMLElement, key: string, value: string | number | boolean): void {
  const next = String(value);
  if (node.dataset[key] !== next) node.dataset[key] = next;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

/** 十六进制颜色写成 CSS 串。 */
export const cssColor = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;

/** 数字读数：大数缩写，小数保留一位，避免"1.3333333"这种脸。 */
export function formatNumber(value: number, decimals = 1): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (abs >= 1000) return `${Math.round(value).toLocaleString('en-US')}`;
  return value.toFixed(decimals).replace(/\.0$/, '');
}

export function formatRate(value: number): string {
  if (value === 0) return '';
  const sign = value > 0 ? '+' : '−';
  return `${sign}${Math.abs(value).toFixed(1)}/s`;
}

/** HUD 部件的统一形状：挂上 DOM 节点，可选地接受每帧刷新。 */
export interface HudWidget {
  readonly el: HTMLElement;
  refresh?(now: number): void;
}

/**
 * 造一个带类名的元素（`el('div', 'panel', '文字')`）。
 *
 * 和上面那个 `make(tag, options, children)` 是两套口味：那个适合"一次配一堆属性"，
 * 这个适合"就地拼几行 DOM"。`ArenaHud` 与 `StartMenu` 用的是后者 ——
 * 以前两边各抄了一份一模一样的 8 行实现。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
