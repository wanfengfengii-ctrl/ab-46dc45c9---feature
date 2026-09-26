/**
 * 稳健性复核测试：手工用例 + 与“逐点全枚举频次盒 + 独立求解”暴力参照对拍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solve,
  solveAlerts,
  reviewRobustness,
  validateDrifts,
  isPrefixFree,
  normalizeReserved,
  reservedCompatible,
} from '../src/solver.js';

const A = (name, freq, lo, hi) => ({ name, freq, lo, hi });

/** 暴力参照：枚举整数盒内每一个频次点，逐点重解，找最小偏移反例。 */
function bruteReview(input, drifts) {
  const base = solve(input);
  if (base.status !== 'optimal') return null;
  const n = input.alerts.length;
  const p = input.alerts.map((a) => a.freq);
  const curCodes = base.alerts.map((a) => a.code);
  const curLens = curCodes.map((c) => c.length);
  let best = null;
  const x = p.slice();

  const cmp = (a, b) => {
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  function* pts(i) {
    if (i === n) {
      yield x.slice();
      return;
    }
    for (let v = p[i] - drifts[i]; v <= p[i] + drifts[i]; v++) {
      x[i] = v;
      yield* pts(i + 1);
    }
  }
  for (const q of pts(0)) {
    const dist = q.reduce((s, v, k) => s + Math.abs(v - p[k]), 0);
    if (best && dist > best.dist) continue;
    const al = input.alerts.map((a, k) => ({ ...a, freq: q[k] }));
    const r = solveAlerts(al, input.reserved);
    if (r.status !== 'optimal') continue;
    const curCost = curLens.reduce((s, l, k) => s + l * q[k], 0);
    let level = 0;
    if (r.cost < curCost) level = 1;
    else if (r.cost === curCost) {
      if (r.maxLength < base.maxLength) level = 2;
      else if (r.maxLength === base.maxLength) {
        const ac = r.alerts.map((a) => a.code);
        if (ac.some((c, k) => c !== curCodes[k])) level = 3;
      }
    }
    if (level > 0 && (!best || dist < best.dist || (dist === best.dist && cmp(q, best.x) < 0))) {
      best = { dist, x: q.slice(), level, cost: r.cost, maxLen: r.maxLength };
    }
  }
  return best;
}

/* ---------------- 录入校验 ---------------- */

test('validateDrifts：非负整数且不超过预计频次', () => {
  assert.deepEqual(validateDrifts([0, 1, 5], [3, 8, 5]), []);
  assert.ok(validateDrifts([], [1]).length > 0);
  assert.ok(validateDrifts([-1], [3]).some((e) => e.includes('非负整数')));
  assert.ok(validateDrifts([1.5], [3]).some((e) => e.includes('非负整数')));
  assert.ok(validateDrifts([4], [3]).some((e) => e.includes('超过预计发送频次')));
  assert.ok(validateDrifts([1, 2], [3]).some((e) => e.includes('数量')));
  assert.ok(reviewRobustness({ alerts: [], reserved: [] }, []).status === 'invalid');
});

/* ---------------- 稳定情形 ---------------- */

test('漂移全为 0 时必然稳定（盒内只有预计频次一点）', () => {
  const input = {
    alerts: [A('a', 3, 2, 6), A('b', 8, 2, 5), A('c', 5, 2, 5), A('d', 12, 1, 4), A('e', 20, 1, 3)],
    reserved: [],
  };
  const r = reviewRobustness(input, [0, 0, 0, 0, 0]);
  assert.equal(r.status, 'stable');
  assert.deepEqual(r.intervals.map((i) => [i.low, i.high]), [
    [3, 3], [8, 8], [5, 5], [12, 12], [20, 20],
  ]);
  assert.ok(r.certificate.feasibleTuples >= 0);
});

test('固定等长码表在小幅漂移下稳定（码长无法改变）', () => {
  const input = {
    alerts: [A('a', 10, 3, 3), A('b', 10, 3, 3), A('c', 10, 3, 3), A('d', 10, 3, 3), A('e', 10, 3, 3)],
    reserved: [],
  };
  const r = reviewRobustness(input, [1, 2, 0, 3, 1]);
  assert.equal(r.status, 'stable');
});

/* ---------------- 反例情形 ---------------- */

test('一级决胜反例：高频类降频后短码易主', () => {
  const input = {
    alerts: [A('a', 3, 1, 5), A('b', 7, 1, 5), A('c', 5, 1, 5), A('d', 2, 1, 5), A('e', 9, 1, 5)],
    reserved: [],
  };
  const r = reviewRobustness(input, [2, 2, 2, 2, 2]);
  assert.equal(r.status, 'counterexample');
  assert.equal(r.level, 1);
  assert.ok(r.distance >= 1);
  // 反例频次落在允许区间内
  r.freqs.forEach((f, i) => {
    assert.ok(f.actual >= f.expected - 2 && f.actual <= f.expected + 2);
    assert.equal(Math.abs(f.offset), Math.abs(f.actual - f.expected));
  });
  assert.equal(r.distance, r.freqs.reduce((s, f) => s + Math.abs(f.offset), 0));
  assert.ok(r.alternativeCost < r.currentCostAtPoint);
  // 替代码表合法
  const codes = r.result.alerts.map((a) => a.code);
  assert.ok(isPrefixFree(codes));
  for (const c of codes) assert.ok(reservedCompatible(c, normalizeReserved([])));
});

test('三级决胜反例：示例参数漂移 2 时平局且码字字典序改变', () => {
  const input = {
    alerts: [
      A('特大地震预警', 3, 2, 6), A('强余震警报', 8, 2, 5), A('海啸警报', 5, 2, 5),
      A('滑坡泥石流警报', 12, 1, 4), A('应急演练通知', 20, 1, 3), A('解除警报', 15, 1, 4),
    ],
    reserved: ['1110'],
  };
  const r = reviewRobustness(input, [2, 2, 2, 2, 2, 2]);
  assert.equal(r.status, 'counterexample');
  assert.equal(r.level, 3);
  assert.equal(r.distance, 1);
  assert.equal(r.currentCostAtPoint, r.alternativeCost);
  assert.equal(r.alternativeMaxLength, r.currentMaxLength);
});

test('非法漂移幅度返回 invalid 而非崩溃', () => {
  const input = {
    alerts: [A('a', 3, 1, 5), A('b', 7, 1, 5), A('c', 5, 1, 5), A('d', 2, 1, 5), A('e', 9, 1, 5)],
    reserved: [],
  };
  assert.equal(reviewRobustness(input, [5, 0, 0, 0, 0]).status, 'invalid');
  assert.equal(reviewRobustness(input, [-1, 0, 0, 0, 0]).status, 'invalid');
});

/* ---------------- 与暴力逐点枚举对拍 ---------------- */

function mulberry32(seed) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

test('对拍：随机小盒用例的稳健结论与暴力逐点枚举完全一致', () => {
  const rand = mulberry32(20260926);
  for (let t = 0; t < 30; t++) {
    const alerts = Array.from({ length: 5 }, (_, i) => {
      const lo = 1 + Math.floor(rand() * 2);
      return A(`a${i}`, 1 + Math.floor(rand() * 8), lo, 4 + Math.floor(rand() * 2));
    });
    const pool = ['0', '1', '00', '11'];
    const reserved = pool.filter(() => rand() < 0.18).slice(0, 2);
    const input = { alerts, reserved };
    if (solve(input).status !== 'optimal') continue;
    const drifts = alerts.map((a) => Math.min(a.freq, 1 + Math.floor(rand() * 2)));
    const r = reviewRobustness(input, drifts);
    const brute = bruteReview(input, drifts);
    if (!brute) {
      assert.equal(r.status, 'stable', `用例 ${t} 应为稳定`);
    } else {
      assert.equal(r.status, 'counterexample', `用例 ${t} 应有反例`);
      assert.equal(r.distance, brute.dist, `用例 ${t} 距离`);
      assert.deepEqual(r.freqs.map((f) => f.actual), brute.x, `用例 ${t} 字典序最小反例点`);
      assert.equal(r.level, brute.level, `用例 ${t} 决胜层级`);
      assert.equal(r.alternativeCost, brute.cost, `用例 ${t} 替代代价`);
    }
  }
});

test('对拍：含保留前缀与较紧区间的 5 类用例', () => {
  const cases = [
    {
      input: {
        alerts: [A('a', 4, 2, 5), A('b', 6, 2, 5), A('c', 3, 2, 5), A('d', 8, 2, 5), A('e', 2, 2, 5)],
        reserved: ['00'],
      },
      drifts: [2, 2, 2, 2, 2],
    },
    {
      input: {
        alerts: [A('a', 5, 1, 4), A('b', 5, 1, 4), A('c', 5, 1, 4), A('d', 5, 1, 4), A('e', 5, 1, 4)],
        reserved: ['1'],
      },
      drifts: [2, 1, 3, 0, 2],
    },
  ];
  for (const { input, drifts } of cases) {
    const r = reviewRobustness(input, drifts);
    const brute = bruteReview(input, drifts);
    if (!brute) {
      assert.equal(r.status, 'stable');
    } else {
      assert.equal(r.status, 'counterexample');
      assert.equal(r.distance, brute.dist);
      assert.deepEqual(r.freqs.map((f) => f.actual), brute.x);
      assert.equal(r.level, brute.level);
    }
  }
});

/* ---------------- 稳健证书与结果结构 ---------------- */

test('稳定结果给出各类允许区间与证书', () => {
  const input = {
    alerts: [A('a', 3, 3, 4), A('b', 8, 2, 4), A('c', 5, 2, 4), A('d', 12, 2, 4), A('e', 20, 2, 3)],
    reserved: [],
  };
  const drifts = [0, 0, 0, 0, 0];
  const r = reviewRobustness(input, drifts);
  assert.equal(r.status, 'stable');
  assert.equal(r.intervals.length, 5);
  assert.ok(r.certificate.rule.length > 0);
  assert.ok(Number.isInteger(r.exploredNodes));
});

test('反例结果包含当前/替代码表、成本、最大码长与频次明细', () => {
  const input = {
    alerts: [A('a', 3, 1, 5), A('b', 7, 1, 5), A('c', 5, 1, 5), A('d', 2, 1, 5), A('e', 9, 1, 5)],
    reserved: [],
  };
  const r = reviewRobustness(input, [2, 2, 2, 2, 2]);
  assert.equal(r.status, 'counterexample');
  assert.equal(r.freqs.length, 5);
  assert.equal(r.currentCodes.length, 5);
  assert.equal(r.result.alerts.length, 5);
  assert.ok(r.currentCostAtPoint > r.alternativeCost);
  assert.ok([1, 2, 3].includes(r.level));
});

/* ---------------- 性能 ---------------- */

test('性能：8 类宽区间满漂移复核在可接受时间内完成', () => {
  const alerts = Array.from({ length: 8 }, (_, i) => A(`a${i}`, 1 + i * 7, 1, 12));
  const start = performance.now();
  const r = reviewRobustness({ alerts, reserved: ['1010'] }, alerts.map((a) => a.freq));
  const elapsed = performance.now() - start;
  assert.equal(r.status, 'counterexample');
  assert.ok(elapsed < 3000, `耗时 ${elapsed.toFixed(0)}ms 超出预期`);
});

test('性能：8 类零漂移稳定复核快速完成', () => {
  const alerts = Array.from({ length: 8 }, (_, i) => A(`a${i}`, 1 + i * 7, 1, 12));
  const start = performance.now();
  const r = reviewRobustness({ alerts, reserved: ['1010'] }, alerts.map(() => 0));
  const elapsed = performance.now() - start;
  assert.equal(r.status, 'stable');
  assert.ok(elapsed < 1000, `耗时 ${elapsed.toFixed(0)}ms 超出预期`);
});
