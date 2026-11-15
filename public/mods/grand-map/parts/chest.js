/**
 * 宝箱模型（2026-11-15 从 view.js 抽出）—— **给参数就出 Object3D**，不读类状态。
 *
 * 抽出的判据和老项目 `arena/visuals/` 一致：**只要它不读 `this.xxx`**，
 * 就该是纯函数；留在 800 行的 view.js 里只会让人以为它是装配逻辑的一部分。
 *
 * 只依赖注入进来的 three 具名子集，不 import three。
 */

/**
 * 一只宝箱：木箱 + 金盖 + 锁扣 + 地上一圈金光。
 *
 * 全用注入的具名 three 类（`BoxGeometry` / `CircleGeometry` / `Mesh` /
 * `MeshStandardMaterial` / `MeshBasicMaterial` / `Group` / `DoubleSide`），
 * 所以这些类必须都在 `modDeps.modThree` 白名单里。
 *
 * @param T host.three —— 模组只能拿到具名子集，不是完整命名空间
 */
export function makeChest(T) {
  const g = new T.Group();
  // 俯视 50° 下模型本体只有 1 格大，放大一点才看得出是箱子而不是一枚金币
  g.scale.setScalar(1.35);

  const body = new T.Mesh(
    new T.BoxGeometry(0.8, 0.5, 0.6),
    new T.MeshStandardMaterial({ color: 0x8a5a28, roughness: 0.9, flatShading: true }),
  );
  body.position.y = 0.25;

  const lid = new T.Mesh(
    new T.BoxGeometry(0.86, 0.18, 0.66),
    new T.MeshStandardMaterial({ color: 0xfac775, roughness: 0.55, metalness: 0.35, flatShading: true }),
  );
  lid.position.y = 0.57;

  const lock = new T.Mesh(
    new T.BoxGeometry(0.16, 0.2, 0.08),
    new T.MeshBasicMaterial({ color: 0xfff0b8 }),
  );
  lock.position.set(0, 0.5, 0.33);

  const halo = new T.Mesh(
    new T.CircleGeometry(0.75, 20),
    new T.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.2, side: T.DoubleSide, depthWrite: false }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.02;

  g.add(halo, body, lid, lock);
  return g;
}

/**
 * 宝箱的上下浮动量。独立成函数是为了让"摆位"和"建模型"分开可测：
 * 纯算术，不碰 three，node 里能直接断言。
 *
 * @param time 累计秒
 * @param id   箱子 id（错开相位，免得一排箱子整齐地跳）
 */
export function chestBob(time, id) {
  return Math.sin(time * 2 + id) * 0.08;
}
