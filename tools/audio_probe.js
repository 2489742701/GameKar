/**
 * 注入脚本（给 tools/arena_shot.mjs 用）：**验证音效真的出声**，而不是"代码跑了但静音"。
 *
 * 做法：在 `Sfx` 的 master 后面并一个 AnalyserNode，逐个音效播一遍，
 * 每次读 300ms 的时域峰值。RMS 全 0 就说明链路断了（或 AudioContext 还挂着）。
 *
 * 用法：node tools/arena_shot.mjs "<url>?play=1" 1 out.png @tools/audio_probe.js
 */
(async () => {
  const waitFor = (fn) =>
    new Promise((res) => {
      const t = setInterval(() => {
        if (fn()) {
          clearInterval(t);
          res('ok');
        }
      }, 100);
    });
  await waitFor(() => window.arena);
  const app = window.arena;
  const sfx = app.sfx;

  sfx.unlock();
  const ctx = sfx.ctx;
  if (!ctx) return { error: 'AudioContext 没建起来' };
  await ctx.resume();

  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  sfx.master.connect(an);
  const buf = new Float32Array(an.fftSize);

  const measure = async (name) => {
    sfx.play(name);
    let peak = 0;
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 24));
      an.getFloatTimeDomainData(buf);
      for (let k = 0; k < buf.length; k++) {
        const v = Math.abs(buf[k]);
        if (v > peak) peak = v;
      }
    }
    return Math.round(peak * 1000) / 1000;
  };

  const names = ['place', 'build', 'arrow', 'cannon', 'melee', 'impact', 'kill', 'collapse', 'win', 'lose'];
  const peaks = {};
  for (const n of names) peaks[n] = await measure(n);

  const silent = names.filter((n) => peaks[n] < 0.01);
  return {
    state: ctx.state,
    sampleRate: ctx.sampleRate,
    peaks,
    silent,
  };
})();
