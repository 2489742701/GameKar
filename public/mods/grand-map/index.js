/**
 * 大地图模组 —— **占位骨架，不是玩法实现**（2026-11-08）。
 *
 * 这一版只证明三件事：
 *   ① 模组能经 manifest + 动态 import 挂上，主程序没为它改任何业务文件；
 *   ② three / GameLoop 是 host 注入的，本文件**没有任何 import 语句**；
 *   ③ 能退出回主程序（清 ?mod= + reload）。
 *
 * 六方 / 外交 / 商路 / 集市那套规则仍是 `docs/工作笔记/大地图原型设计_20261108.md`
 * 里的草案，等规则拍板后在**这个目录内部**长出来，不碰主程序。
 *
 * 屏幕上的六芒星线框只是"我挂上了"的凭据，别当成地图成品。
 */

let cleanup = null;

export function mount(host) {
  if (!host || host.api !== 1 || !host.three) {
    throw new Error('host 契约不匹配（需要 api=1 + three）');
  }
  const T = host.three;

  const renderer = new T.WebGLRenderer({ canvas: host.canvas, antialias: true });
  renderer.setClearColor(0x0b1220, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(-4, 4, 4, -4, 0.1, 100);
  camera.position.set(0, 0, 10);

  // 六个顶点：呼应六芒星阵，纯占位
  const verts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    verts.push(new T.Vector3(Math.cos(a) * 2.6, Math.sin(a) * 2.6, 0));
  }
  // 全部塞进同一个 Group：一起转，线端才始终对准顶点
  const group = new T.Group();
  scene.add(group);

  const hexPts = [...verts, verts[0]];
  const hex = new T.Line(
    new T.BufferGeometry().setFromPoints(hexPts),
    new T.LineBasicMaterial({ color: 0x85b7eb }),
  );
  group.add(hex);

  const chords = [];
  for (let i = 0; i < 3; i++) chords.push(verts[i], verts[i + 3]);
  const star = new T.LineSegments(
    new T.BufferGeometry().setFromPoints(chords),
    new T.LineBasicMaterial({ color: 0xba7517 }),
  );
  group.add(star);

  const nodeGeo = new T.BoxGeometry(0.34, 0.34, 0.34);
  const nodeMat = new T.MeshBasicMaterial({ color: 0xe6f1fb });
  for (const v of verts) {
    const m = new T.Mesh(nodeGeo, nodeMat);
    m.position.copy(v);
    group.add(m);
  }
  const core = new T.Mesh(
    new T.CircleGeometry(0.55, 24),
    new T.MeshBasicMaterial({ color: 0xfac775 }),
  );
  group.add(core);

  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:absolute', 'left:50%', 'top:24px', 'transform:translateX(-50%)',
    'display:flex', 'flex-direction:column', 'align-items:center', 'gap:10px',
    'pointer-events:auto', 'color:#e8edf7', 'text-align:center',
    'font:500 14px/1.6 system-ui,sans-serif',
  ].join(';');
  const title = document.createElement('div');
  title.textContent = '大地图模组 · 占位骨架';
  title.style.cssText = 'font-size:18px';
  const hint = document.createElement('div');
  hint.textContent = '六方外交 / 商路规则仍在草案，这里只验证热插拔链路';
  hint.style.cssText = 'opacity:.7;font-size:12px';
  const exit = document.createElement('button');
  exit.textContent = '退出模组';
  exit.style.cssText = [
    'padding:8px 18px', 'border-radius:8px', 'border:1px solid #4a5a72',
    'background:#16202f', 'color:#e8edf7', 'font:inherit', 'cursor:pointer',
  ].join(';');
  exit.addEventListener('click', () => host.exit());
  panel.append(title, hint, exit);
  host.uiRoot.append(panel);

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    camera.left = -4 * aspect;
    camera.right = 4 * aspect;
    camera.top = 4;
    camera.bottom = -4;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  const loop = host.makeLoop({
    onFrame: (info) => {
      group.rotation.z = info.time * 0.05;
      renderer.render(scene, camera);
    },
  });

  // 无头探针靠这个判断"模组真的挂上了"
  window.__modActive = 'grand-map';

  cleanup = () => {
    loop.stop();
    window.removeEventListener('resize', resize);
    panel.remove();
    hex.geometry.dispose();
    hex.material.dispose();
    star.geometry.dispose();
    star.material.dispose();
    nodeGeo.dispose();
    nodeMat.dispose();
    core.geometry.dispose();
    core.material.dispose();
    renderer.dispose();
    delete window.__modActive;
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
