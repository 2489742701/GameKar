/**
 * 大地图 3D 场景的天光层（2026-11-09）—— 四个时段 + 云朵面片小模型。
 *
 * 注意：主游戏是**正交俯视**相机，抬头看不到天，所以天空盒不是给"看天"用的：
 *  · 天空球（BackSide 渐变）负责视野边缘与整体底色；
 *  · 云朵是水平铺在战场上空的**面片小模型**，俯视能看到它们飘过并随时间改色；
 *  · 四时段真正被玩家感知的是 AmbientLight / DirectionalLight 的颜色与强度
 *    （对应以后 10 分钟大局「从早打到晚」的 setDim 那条线）。
 *
 * 纯资产层，只依赖 host 注入的 three 具名子集；不是独立预览模组。
 */
/** tint = 全屏色调覆盖（DOM 层）：俯视战场全是 Basic 材质，不吃光照，靠它统一压暗/染色。 */
export const PERIODS = [
  { key: 'morning', label: '白天', top: '#7ab4e8', horizon: '#ffe1ad', light: '#fff0cc', ambient: '#8fa9c8', intensity: 1.10, cloud: '#ffffff', cloudOpacity: 0.60, tint: 'rgba(255,228,178,0.06)' },
  { key: 'noon', label: '中午', top: '#2f7fd4', horizon: '#c7e6ff', light: '#ffffff', ambient: '#b9d2ee', intensity: 1.35, cloud: '#ffffff', cloudOpacity: 0.68, tint: 'rgba(255,255,255,0)' },
  { key: 'dusk', label: '黄昏', top: '#3a2b64', horizon: '#ff8a4c', light: '#ffab63', ambient: '#7b6a8c', intensity: 0.90, cloud: '#ffcfaa', cloudOpacity: 0.58, tint: 'rgba(255,116,52,0.28)' },
  { key: 'night', label: '晚上', top: '#050a1c', horizon: '#1b2c4d', light: '#93aee0', ambient: '#3a4a6b', intensity: 0.42, cloud: '#7f94b8', cloudOpacity: 0.36, tint: 'rgba(8,16,42,0.66)' },
];

const hex = (s) => {
  const n = parseInt(s.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const lcg = (seed) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
};

const VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = `
uniform vec3 topColor;
uniform vec3 horizonColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  gl_FragColor = vec4(mix(horizonColor, topColor, smoothstep(-0.1, 0.7, d.y)), 1.0);
}`;

/** 一朵云 = 4 个圆面片 + 1 个扁平面片，水平铺在高空，俯视可见。 */
function makeCloud(T) {
  const g = new T.Group();
  const mat = () => new T.MeshBasicMaterial({
    color: new T.Color('#ffffff'), transparent: true, opacity: 0.9,
    side: T.DoubleSide, depthWrite: false,
  });
  for (const [x, y, r] of [[-2.5, 0, 1.5], [-0.9, 0.7, 2.0], [0.9, 0.5, 1.8], [2.4, -0.1, 1.35]]) {
    const m = new T.Mesh(new T.CircleGeometry(r, 18), mat());
    m.position.set(x, y, 0);
    g.add(m);
  }
  const base = new T.Mesh(new T.PlaneGeometry(7.2, 1.5), mat());
  base.position.set(0, -0.35, -0.01);
  g.add(base);
  // 水平躺着：正交俯视看到的是面片正面
  g.rotation.x = -Math.PI / 2;
  return g;
}

export function createSky(T, scene) {
  const uniforms = {
    topColor: { value: new T.Vector3(...hex(PERIODS[0].top)) },
    horizonColor: { value: new T.Vector3(...hex(PERIODS[0].horizon)) },
  };
  const dome = new T.Mesh(
    new T.SphereGeometry(600, 24, 16),
    new T.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: T.BackSide, depthWrite: false }),
  );
  scene.add(dome);

  const ambient = new T.AmbientLight(new T.Color(PERIODS[0].ambient), 0.9);
  const sun = new T.DirectionalLight(new T.Color(PERIODS[0].light), PERIODS[0].intensity);
  sun.position.set(18, 40, 22);
  scene.add(ambient, sun);

  // 云是**小面片**，摆在四角外圈，别盖住中心 9×9 格子
  const clouds = [];
  const rnd = lcg(20261109);
  for (let i = 0; i < 6; i++) {
    const c = makeCloud(T);
    c.scale.setScalar(0.34 + rnd() * 0.34);
    const sx = rnd() < 0.5 ? -1 : 1;
    const sz = rnd() < 0.5 ? -1 : 1;
    c.position.set(sx * (17 + rnd() * 15), 26 + rnd() * 8, sz * (14 + rnd() * 14));
    c.userData.baseX = c.position.x;
    c.userData.speed = 0.35 + rnd() * 0.5;
    scene.add(c);
    clouds.push(c);
  }

  const target = { top: new T.Vector3(), horizon: new T.Vector3(), light: new T.Color(), ambient: new T.Color(), intensity: 0, cloud: new T.Color(), opacity: 0 };
  let index = 0;

  function setPeriod(i) {
    index = ((i % PERIODS.length) + PERIODS.length) % PERIODS.length;
    const p = PERIODS[index];
    target.top.set(...hex(p.top));
    target.horizon.set(...hex(p.horizon));
    target.light.set(p.light);
    target.ambient.set(p.ambient);
    target.intensity = p.intensity;
    target.cloud.set(p.cloud);
    target.opacity = p.cloudOpacity;
    // 即时生效：手动切时段要立刻看到，不能等逐帧 lerp（无头 rAF 还会被节流）
    uniforms.topColor.value.copy(target.top);
    uniforms.horizonColor.value.copy(target.horizon);
    sun.color.copy(target.light);
    ambient.color.copy(target.ambient);
    sun.intensity = p.intensity;
    for (const c of clouds) {
      for (const m of c.children) {
        m.material.color.copy(target.cloud);
        m.material.opacity = p.cloudOpacity;
      }
    }
    return p;
  }

  function update(time) {
    uniforms.topColor.value.lerp(target.top, 0.05);
    uniforms.horizonColor.value.lerp(target.horizon, 0.05);
    sun.color.lerp(target.light, 0.05);
    ambient.color.lerp(target.ambient, 0.05);
    sun.intensity += (target.intensity - sun.intensity) * 0.05;
    for (const c of clouds) {
      c.position.x = c.userData.baseX + Math.sin(time * 0.05 * c.userData.speed) * 12;
      for (const m of c.children) {
        m.material.color.lerp(target.cloud, 0.05);
        m.material.opacity += (target.opacity - m.material.opacity) * 0.05;
      }
    }
  }

  setPeriod(0);
  return { setPeriod, update, get periodIndex() { return index; } };
}
