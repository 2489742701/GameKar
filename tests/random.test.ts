import { describe, expect, it } from 'vitest';
import { Random, hashString } from '@engine/math/Random';

describe('确定性随机', () => {
  it('同 seed 的序列逐位相同 —— 抽卡可复现的地基', () => {
    const a = new Random(12345);
    const b = new Random(12345);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('不同 seed 不该撞上同一条序列', () => {
    const first = new Random(1).next();
    const other = new Random(2).next();
    expect(first).not.toBe(other);
  });

  it('seed 为 0 不退化成常数', () => {
    const r = new Random(0);
    const values = new Set([r.next(), r.next(), r.next()]);
    expect(values.size).toBe(3);
  });

  it('int 落在闭开区间，pick 不会越界', () => {
    const r = new Random('seed-string');
    for (let i = 0; i < 2000; i++) {
      const n = r.int(0, 5);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(5);
    }
    const list = [3, 7, 11];
    for (let i = 0; i < 500; i++) expect(list).toContain(r.pick(list));
  });

  it('weighted 的长期命中率贴住权重比', () => {
    const r = new Random(777);
    const items = [
      { item: 'a', weight: 70 },
      { item: 'b', weight: 20 },
      { item: 'c', weight: 10 },
    ];
    const hits = { a: 0, b: 0, c: 0 } as Record<string, number>;
    for (let i = 0; i < 50_000; i++) hits[r.weighted({ items })]++;

    expect(hits.a! / 50_000).toBeGreaterThan(0.685);
    expect(hits.a! / 50_000).toBeLessThan(0.715);
    expect(hits.c! / 50_000).toBeGreaterThan(0.085);
    expect(hits.c! / 50_000).toBeLessThan(0.115);
  });

  it('权重全 0 时退化成等概率，而不是抛异常', () => {
    const r = new Random(9);
    const items = [
      { item: 'x', weight: 0 },
      { item: 'y', weight: 0 },
    ];
    const hits = new Set<string>();
    for (let i = 0; i < 200; i++) hits.add(r.weighted({ items }));
    expect([...hits].sort()).toEqual(['x', 'y']);
  });

  it('fork 出的子流彼此独立，改地形不影响抽卡', () => {
    const root = new Random(4242);
    const a = root.fork('terrain');
    const b = root.fork('gacha');
    expect(a.next()).not.toBe(b.next());
  });

  it('hashString 稳定且区分大小写', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('ABC'));
  });
});
