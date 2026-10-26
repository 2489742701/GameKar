/**
 * 图标 —— 像素画出来的 SVG，跟画面里那套小人与木头是同一口吻（8×8 网格、硬边、不模糊）。
 *
 * 为什么不用字体符号或 emoji：符号在不同系统与浏览器会换字形，
 * 而资源栏、建造托盘、信息卡上这几个图形要**跟数字对得上**，换字形就等于换个说法。
 * 每张图就是一串字符画，改形状只改那串，不动绘制代码。
 */

export type IconName = 'gold' | 'crystal' | 'bread' | 'pop' | 'sword' | 'shield' | 'heart';

const GRID = 8;

/** 每张图的调色板：字符 → 颜色；'.' 是空。 */
const LEGEND: Record<IconName, Record<string, string>> = {
  gold: { '4': '#8a6a1f', '3': '#ffd36b', '2': '#fff2c2' },
  crystal: { C: '#5fb8e8', W: '#7cd8ff', L: '#e9fbff' },
  bread: { C: '#8a5a2b', B: '#e8c07a', W: '#fbe6bd' },
  pop: { H: '#f2c79a', D: '#c99a6e', P: '#4f74c8' },
  sword: { b: '#9aa8b8', B: '#e6eef7', S: '#ffffff', G: '#ffd36b', W: '#8a5a2b' },
  shield: { R: '#6f86a8', L: '#a9c0dd' },
  heart: { R: '#ff5b5b', W: '#ffb3b3' },
};

/** 8×8 字符画。 */
const PIXELS: Record<IconName, string[]> = {
  gold: ['..4444..', '.433334.', '43323334', '43333334', '43333334', '43333334', '.433334.', '..4444..'],
  crystal: ['...CC...', '..CCCC..', '.CLCCCC.', 'CCCCCCCC', '.CCCCCC.', '..CCCC..', '..CCCC..', '...CC...'],
  bread: ['..CCCC..', '.CBBBB.C', 'CBWBBWBC', 'CBBBBBBC', 'CBBWBBBC', 'CBBBBBBC', '.CBBBB.C', '..CCCC..'],
  pop: ['..HHH...', '.HHHHHH.', '.HHHHHH.', '..HDDH..', '.PPPPPP.', 'PPPPPPPP', 'PPP..PPP', 'PP....PP'],
  sword: ['...bBb..', '...bBb..', '...bBb..', '...bSb..', '...bBb..', '.GGGGGG.', '...WW...', '...WW...'],
  shield: ['.RRRRRR.', 'RLLLLLLR', 'RLLLLLLR', 'RLLLLLLR', '.RRRRRR.', '..RRRR..', '...RR...', '........'],
  heart: ['.RR..RR.', 'RWRRRRRR', 'RRRRRRRR', 'RRRRRRRR', '.RRRRRR.', '..RRRR..', '...RR...', '........'],
  // 锤子：横着的铁锤头 + 斜下来的木柄。修理中的楼头顶挂它，CSS 里绕着柄尾抡
};

/**
 * 一行里同色的连续格合成一个矩形：顶栏四张图若一格一个节点，一次重画就上百个节点。
 * 形状不对（不是 8×8、或用了没定义的颜色字符）直接抛 —— 图标画歪了要在开发期就叫，
 * 不能等它变成一个看不出问题的圆点。
 */
export function iconRects(name: IconName): { x: number; y: number; w: number; fill: string }[] {
  const legend = LEGEND[name];
  const rows = PIXELS[name];
  if (rows.length !== GRID) throw new Error(`图标 "${name}" 的行数是 ${rows.length}，应为 ${GRID}`);
  const out: { x: number; y: number; w: number; fill: string }[] = [];
  rows.forEach((row, y) => {
    if (row.length !== GRID) throw new Error(`图标 "${name}" 第 ${y} 行是 ${row.length} 格，应为 ${GRID}`);
    let x = 0;
    while (x < GRID) {
      const ch = row[x]!;
      if (ch === '.') {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < GRID && row[x + w] === ch) w++;
      const fill = legend[ch];
      if (!fill) throw new Error(`图标 "${name}" 用了没定义的颜色字符 "${ch}"`);
      out.push({ x, y, w, fill });
      x += w;
    }
  });
  return out;
}

/** 画一张图。size 是显示边长。 */
export function iconEl(name: IconName, size = 14): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${GRID} ${GRID}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ico', `ico--${name}`);
  for (const r of iconRects(name)) {
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(r.x));
    rect.setAttribute('y', String(r.y));
    rect.setAttribute('width', String(r.w));
    rect.setAttribute('height', '1');
    rect.setAttribute('fill', r.fill);
    svg.append(rect);
  }
  return svg;
}

/** 资源 → 图标。判据只这一处：资源栏、建造托盘、卡池面板都读它，不会各画各的。 */
export const resourceIcon: Record<string, IconName> = { gold: 'gold', crystal: 'crystal', bread: 'bread' };
