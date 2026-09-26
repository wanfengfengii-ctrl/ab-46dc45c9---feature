import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solve,
  checkRobustness,
  validateDrifts,
  validateInput,
  normalizeReserved,
  isPrefixFree,
  reservedCompatible,
  MAX_CODE_LENGTH,
} from '../src/solver.js';
import { buildTreeLayout } from '../src/tree.js';

const alert = (name, freq, lo, hi) => ({ name, freq, lo, hi });

/** 与求解器独立的暴力枚举：直接比较 (代价, 最大码长, 码字元组) 字典序。 */
function bruteSolve(input) {
  const alerts = input.alerts;
  const reserved = normalizeReserved(input.reserved);
  const assigned = [];
  let best = null;

  function compat(c) {
    return (
      assigned.every((a) => !(a.startsWith(c) || c.startsWith(a))) &&
      reserved.every((r) => !(c.startsWith(r) || r.startsWith(c)))
    );
  }
  function* codesOf(lo, hi) {
    function* rec(p) {
      if (p.length >= lo && compat(p)) yield p;
      if (p.length < hi) {
        yield* rec(p + '0');
        yield* rec(p + '1');
      }
    }
    yield* rec('');
  }
  function cmp(a, b) {
    if (a.cost !== b.cost) return a.cost - b.cost;
    if (a.maxLen !== b.maxLen) return a.maxLen - b.maxLen;
    for (let i = 0; i < a.codes.length; i++) {
      if (a.codes[i] !== b.codes[i]) return a.codes[i] < b.codes[i] ? -1 : 1;
    }
    return 0;
  }
  function dfs(i, cost, maxLen) {
    if (i === alerts.length) {
      const sol = { cost, maxLen, codes: assigned.slice() };
      if (!best || cmp(sol, best) < 0) best = sol;
      return;
    }
    for (const c of codesOf(alerts[i].lo, alerts[i].hi)) {
      assigned.push(c);
      dfs(i + 1, cost + alerts[i].freq * c.length, Math.max(maxLen, c.length));
      assigned.pop();
    }
  }
  dfs(0, 0, 0);
  return best;
}

function mulberry32(seed) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 基础工具 ---------------- */

test('normalizeReserved：去重并剔除被更短前缀覆盖的冗余项', () => {
  assert.deepEqual(normalizeReserved(['00', '0', '10', '0', ' 10 ']), ['0', '10']);
  assert.deepEqual(normalizeReserved([]), []);
  assert.deepEqual(normalizeReserved(['', '  ']), []);
});

test('isPrefixFree / reservedCompatible', () => {
  assert.equal(isPrefixFree(['0', '10', '11']), true);
  assert.equal(isPrefixFree(['0', '01']), false);
  assert.equal(reservedCompatible('10', ['0']), true);
  assert.equal(reservedCompatible('010', ['0']), false); // 落入保留子树
  assert.equal(reservedCompatible('0', ['010']), false); // 遮蔽保留前缀
});

test('validateInput：逐项校验录入参数', () => {
  const good = {
    alerts: [
      alert('a', 1, 1, 3), alert('b', 2, 1, 3), alert('c', 3, 1, 3),
      alert('d', 4, 1, 3), alert('e', 5, 1, 3),
    ],
    reserved: ['01'],
  };
  assert.deepEqual(validateInput(good), []);
  assert.ok(validateInput({ alerts: good.alerts.slice(0, 4), reserved: [] }).length > 0); // 少于 5 类
  assert.ok(validateInput({ alerts: [...good.alerts, alert('f', 1, 1, 2), alert('g', 1, 1, 2), alert('h', 1, 1, 2), alert('i', 1, 1, 2)], reserved: [] }).length > 0); // 多于 8 类
  assert.ok(validateInput({ alerts: [alert('a', 0, 1, 2), ...good.alerts.slice(1)], reserved: [] }).some((e) => e.includes('频次')));
  assert.ok(validateInput({ alerts: [alert('a', 1.5, 1, 2), ...good.alerts.slice(1)], reserved: [] }).some((e) => e.includes('频次')));
  assert.ok(validateInput({ alerts: [alert('a', 1, 3, 2), ...good.alerts.slice(1)], reserved: [] }).some((e) => e.includes('码长区间')));
  assert.ok(validateInput({ alerts: [alert('a', 1, 1, MAX_CODE_LENGTH + 1), ...good.alerts.slice(1)], reserved: [] }).some((e) => e.includes('码长区间')));
  assert.ok(validateInput({ ...good, reserved: ['012'] }).some((e) => e.includes('保留前缀')));
  assert.ok(validateInput({ ...good, reserved: ['0', '1', '00', '11'] }).some((e) => e.includes('最多')));
  assert.ok(validateInput({ alerts: [alert('a', 1, 1, 2), alert('a', 1, 1, 2), ...good.alerts.slice(2)], reserved: [] }).some((e) => e.includes('重复')));
  assert.ok(validateInput({ alerts: [alert('', 1, 1, 2), ...good.alerts.slice(1)], reserved: [] }).some((e) => e.includes('不能为空')));
  assert.equal(solve({ alerts: [], reserved: [] }).status, 'invalid');
});

/* ---------------- 手工核算的最优解 ---------------- */

test('等长约束：5 类全部取 3 位码，按字典序取前五', () => {
  const r = solve({
    alerts: [alert('a', 1, 3, 3), alert('b', 1, 3, 3), alert('c', 1, 3, 3), alert('d', 1, 3, 3), alert('e', 1, 3, 3)],
    reserved: [],
  });
  assert.equal(r.status, 'optimal');
  assert.deepEqual(r.alerts.map((a) => a.code), ['000', '001', '010', '011', '100']);
  assert.equal(r.cost, 15);
  assert.equal(r.maxLength, 3);
});

test('加权最优：高频类别获得更短码字', () => {
  const r = solve({
    alerts: [alert('a', 10, 1, 12), alert('b', 10, 1, 12), alert('c', 10, 1, 12), alert('d', 10, 1, 12), alert('e', 1, 1, 12)],
    reserved: [],
  });
  assert.equal(r.status, 'optimal');
  assert.equal(r.cost, 93); // 长度组合 {2,2,2,3,3}（Kraft 和恰为 1），低频者取 3
  assert.equal(r.maxLength, 3);
  assert.deepEqual(r.alerts.map((a) => a.code), ['00', '01', '10', '110', '111']);
  assert.equal(r.alerts[4].length, 3);
});

test('第二级目标：代价相同时取最大码长更小者', () => {
  // {3,3,3,3}+E 长 1 与 {2,3,4,4}+E 长 1 代价同为 23，前者最大码长 3 胜出
  const r = solve({
    alerts: [alert('a', 1, 1, 12), alert('b', 1, 1, 12), alert('c', 2, 1, 12), alert('d', 2, 1, 12), alert('e', 5, 1, 1)],
    reserved: [],
  });
  assert.equal(r.status, 'optimal');
  assert.equal(r.cost, 23);
  assert.equal(r.maxLength, 3);
  assert.deepEqual(r.alerts.map((a) => a.code), ['000', '001', '010', '011', '1']);
});

test('保留前缀封禁半侧码空间', () => {
  const r = solve({
    alerts: [alert('a', 1, 3, 4), alert('b', 1, 3, 4), alert('c', 1, 3, 4), alert('d', 1, 3, 4), alert('e', 1, 3, 4)],
    reserved: ['0'],
  });
  assert.equal(r.status, 'optimal');
  assert.equal(r.cost, 17); // 长度 {3,3,3,4,4}
  assert.deepEqual(r.alerts.map((a) => a.code), ['100', '101', '110', '1110', '1111']);
  for (const a of r.alerts) assert.ok(a.code.startsWith('1'));
});

test('保留前缀的"遮蔽"约束：不得选用保留串的祖先前缀', () => {
  // 保留 00：码字 "0" 虽不在其子树内，但遮蔽了保留分支，同样禁用
  const r = solve({
    alerts: [alert('a', 1, 1, 3), alert('b', 1, 1, 3), alert('c', 1, 1, 3), alert('d', 1, 1, 3), alert('e', 1, 1, 3)],
    reserved: ['00'],
  });
  assert.equal(r.status, 'optimal');
  assert.equal(r.cost, 14); // {01, 100, 101, 110, 111}
  assert.equal(r.maxLength, 3);
  assert.deepEqual(r.alerts.map((a) => a.code), ['01', '100', '101', '110', '111']);
  for (const a of r.alerts) {
    assert.notEqual(a.code, '0');
    assert.ok(reservedCompatible(a.code, ['00']));
  }
});

/* ---------------- 无解情形 ---------------- */

test('无解：Kraft 必要条件不满足', () => {
  const r = solve({
    alerts: [alert('a', 1, 1, 2), alert('b', 1, 1, 2), alert('c', 1, 1, 2), alert('d', 1, 1, 2), alert('e', 1, 1, 2)],
    reserved: [],
  });
  assert.equal(r.status, 'infeasible');
  assert.ok(r.reason.length > 0);
});

test('无解：码位槽不足（5 类抢 4 个 2 位码）', () => {
  const r = solve({
    alerts: [alert('a', 1, 2, 2), alert('b', 1, 2, 2), alert('c', 1, 2, 2), alert('d', 1, 2, 2), alert('e', 1, 2, 2)],
    reserved: [],
  });
  assert.equal(r.status, 'infeasible');
});

test('无解：保留前缀占满全部码空间', () => {
  const r = solve({
    alerts: [alert('a', 1, 1, 3), alert('b', 1, 1, 3), alert('c', 1, 1, 3), alert('d', 1, 1, 3), alert('e', 1, 1, 3)],
    reserved: ['0', '1'],
  });
  assert.equal(r.status, 'infeasible');
});

test('无解：保留后剩余槽位不足', () => {
  const r = solve({
    alerts: [alert('a', 1, 3, 3), alert('b', 1, 3, 3), alert('c', 1, 3, 3), alert('d', 1, 3, 3), alert('e', 1, 3, 3)],
    reserved: ['0'],
  });
  assert.equal(r.status, 'infeasible'); // 仅剩 100/101/110/111 四个槽
});

/* ---------------- 性质与对拍 ---------------- */

test('最优解性质：前缀无关、避开保留、长度落在区间内、成本一致', () => {
  const rand = mulberry32(20260925);
  for (let t = 0; t < 30; t++) {
    const n = 5 + Math.floor(rand() * 4);
    const alerts = Array.from({ length: n }, (_, i) => {
      const lo = 1 + Math.floor(rand() * 3);
      return alert(`a${i}`, 1 + Math.floor(rand() * 20), lo, Math.min(MAX_CODE_LENGTH, lo + 1 + Math.floor(rand() * 4)));
    });
    const pool = ['0', '1', '00', '01', '10', '11', '010', '101'];
    const reserved = pool.filter(() => rand() < 0.15).slice(0, 3);
    const r = solve({ alerts, reserved });
    if (r.status !== 'optimal') continue;
    const codes = r.alerts.map((a) => a.code);
    assert.ok(isPrefixFree(codes), `前缀无关: ${codes}`);
    const norm = normalizeReserved(reserved);
    for (const c of codes) assert.ok(reservedCompatible(c, norm), `避开保留: ${c}`);
    r.alerts.forEach((a, i) => {
      assert.ok(a.length >= alerts[i].lo && a.length <= alerts[i].hi);
      assert.equal(a.contribution, a.freq * a.length);
    });
    assert.equal(r.cost, r.alerts.reduce((s, a) => s + a.contribution, 0));
    assert.equal(r.maxLength, Math.max(...r.alerts.map((a) => a.length)));
  }
});

test('与暴力枚举对拍：小规模随机用例结论完全一致', () => {
  const rand = mulberry32(1234567);
  const pool = ['0', '1', '00', '01', '10', '11'];
  for (let t = 0; t < 25; t++) {
    const alerts = Array.from({ length: 5 }, (_, i) => {
      const lo = 1 + Math.floor(rand() * 2);
      return alert(`a${i}`, 1 + Math.floor(rand() * 5), lo, 3);
    });
    const reserved = pool.filter(() => rand() < 0.2).slice(0, 2);
    const input = { alerts, reserved };
    const mine = solve(input);
    const brute = bruteSolve(input);
    if (!brute) {
      assert.equal(mine.status, 'infeasible', `用例 ${t}: 暴力无解但求解器给出 ${JSON.stringify(mine)}`);
      continue;
    }
    assert.equal(mine.status, 'optimal', `用例 ${t}: 暴力有解但求解器 ${mine.status}`);
    assert.equal(mine.cost, brute.cost, `用例 ${t} 代价`);
    assert.equal(mine.maxLength, brute.maxLen, `用例 ${t} 最大码长`);
    assert.deepEqual(mine.alerts.map((a) => a.code), brute.codes, `用例 ${t} 码字`);
  }
});

test('前缀码可唯一拆分：随机电文编码后可无歧义解码', () => {
  const r = solve({
    alerts: [
      alert('a', 3, 2, 6), alert('b', 8, 2, 5), alert('c', 5, 2, 5),
      alert('d', 12, 1, 4), alert('e', 20, 1, 3), alert('f', 15, 1, 4),
    ],
    reserved: ['1110'],
  });
  assert.equal(r.status, 'optimal');
  const codes = r.alerts.map((a) => a.code);
  const rand = mulberry32(42);
  const seq = Array.from({ length: 200 }, () => Math.floor(rand() * codes.length));
  const wire = seq.map((i) => codes[i]).join('');
  // 贪心前缀匹配即可唯一解码（前缀无关保证）
  const decoded = [];
  let pos = 0;
  while (pos < wire.length) {
    const idx = codes.findIndex((c) => wire.startsWith(c, pos));
    assert.notEqual(idx, -1, `位置 ${pos} 无法解码`);
    decoded.push(idx);
    pos += codes[idx].length;
  }
  assert.deepEqual(decoded, seq);
});

test('性能：8 类宽区间在可接受时间内完成', () => {
  const alerts = Array.from({ length: 8 }, (_, i) => alert(`a${i}`, 1 + i * 7, 1, MAX_CODE_LENGTH));
  const start = performance.now();
  const r = solve({ alerts, reserved: ['1010'] });
  const elapsed = performance.now() - start;
  assert.equal(r.status, 'optimal');
  assert.ok(elapsed < 3000, `耗时 ${elapsed.toFixed(0)}ms 超出预期`);
});

/* ---------------- 码树布局 ---------------- */

test('码树布局：节点类型与坐标完整', () => {
  const { nodes, edges, width, height } = buildTreeLayout(
    [{ code: '00', name: '甲' }, { code: '01', name: '乙' }, { code: '1', name: '丙' }],
    [{ prefix: '001' }].filter(() => false), // 无保留
  );
  const codes = nodes.filter((n) => n.type === 'code');
  assert.equal(codes.length, 3);
  assert.ok(nodes.some((n) => n.type === 'root'));
  assert.equal(edges.length, nodes.length - 1); // 树：边数 = 节点数 - 1
  assert.ok(width > 0 && height > 0);
  for (const n of nodes) {
    assert.ok(Number.isFinite(n.cx) && Number.isFinite(n.cy));
  }
});

test('码树布局：保留前缀渲染为保留节点', () => {
  const { nodes } = buildTreeLayout(
    [{ code: '10', name: '甲' }, { code: '11', name: '乙' }],
    [{ prefix: '0' }],
  );
  const reserved = nodes.filter((n) => n.type === 'reserved');
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].prefix, '0');
});

/* ---------------- 稳健性复核 ---------------- */

const robustAlert = (name, freq, lo, hi) => ({ name, freq, lo, hi });

test('validateDrifts：非负整数且不超过预计频次', () => {
  const alerts = [robustAlert('a', 3, 1, 3), robustAlert('b', 1, 1, 3)];
  assert.deepEqual(validateDrifts({ alerts, drifts: [0, 1] }), []);
  assert.deepEqual(validateDrifts({ alerts, drifts: [3, 0] }), []); // 恰为频次 ⇒ 区间下界 0
  assert.ok(validateDrifts({ alerts, drifts: [4, 0] }).some((e) => e.includes('超过')));
  assert.ok(validateDrifts({ alerts, drifts: [-1, 0] }).some((e) => e.includes('非负整数')));
  assert.ok(validateDrifts({ alerts, drifts: [1] }).length > 0); // 数量不符
  assert.ok(validateDrifts({ alerts, drifts: ['x', 0] }).some((e) => e.includes('非负整数')));
});

test('零漂移：唯一退化盒，当前码表必然稳健并给出稳健证书', () => {
  const input = {
    alerts: [
      robustAlert('a', 3, 2, 6), robustAlert('b', 8, 2, 5), robustAlert('c', 5, 2, 5),
      robustAlert('d', 12, 1, 4), robustAlert('e', 20, 1, 3), robustAlert('f', 15, 1, 4),
    ],
    reserved: ['1110'],
    drifts: [0, 0, 0, 0, 0, 0],
  };
  const r = checkRobustness(input);
  assert.equal(r.status, 'robust');
  assert.equal(r.combos, '1');
  assert.ok(r.tuplesEnumerated >= 1);
  // 零漂移时任何改变码长的分支都被压力剪枝排除（无可行性候选），故可能为 0
  assert.ok(r.feasibilityChecks >= 0);
  assert.equal(r.strictCandidates, 0);
  assert.equal(r.tieCandidates, 0);
  assert.deepEqual(r.baseline.codes, solve(input).alerts.map((x) => x.code));
  assert.deepEqual(r.intervals.map((x) => [x.lo, x.hi]), input.alerts.map((a) => [a.freq, a.freq]));
});

test('固定码长元组唯一：任意漂移下都稳健', () => {
  const input = {
    alerts: [
      robustAlert('a', 5, 3, 3), robustAlert('b', 7, 3, 3), robustAlert('c', 2, 3, 3),
      robustAlert('d', 9, 3, 3), robustAlert('e', 4, 3, 3),
    ],
    reserved: [],
    drifts: [2, 3, 2, 4, 1],
  };
  const r = checkRobustness(input);
  assert.equal(r.status, 'robust');
  assert.equal(r.combos, String(5 * 7 * 5 * 9 * 3));
  assert.equal(r.strictCandidates, 0);
  assert.equal(r.tieCandidates, 0);
});

test('层级一反例：等频码表在单类频次下移 1 时被更便宜的分配推翻', () => {
  const input = {
    alerts: [
      robustAlert('a', 5, 2, 3), robustAlert('b', 5, 2, 3), robustAlert('c', 5, 2, 3),
      robustAlert('d', 5, 2, 3), robustAlert('e', 5, 2, 3),
    ],
    reserved: [],
    drifts: [2, 0, 0, 0, 0],
  };
  const r = checkRobustness(input);
  assert.equal(r.status, 'counterexample');
  const w = r.witness;
  assert.equal(w.firstChangedLevel, 1);
  // 最小反例是盒"内部点" a:5→4（偏移 1），而非端点 a→3（偏移 2）——不能只抽样端点
  assert.equal(w.totalOffset, 1);
  assert.deepEqual(w.freqs, [4, 5, 5, 5, 5]);
  assert.deepEqual(w.offsets, [1, 0, 0, 0, 0]);
  // 见证频点：替代码表严格更便宜
  assert.ok(w.replacement.cost < w.baseline.costAtWitness);
  assert.equal(w.baseline.costAtWitness, 58);
  assert.equal(w.replacement.cost, 57);
  // 替代码表前缀无关且码长合法
  assert.ok(isPrefixFree(w.replacement.codes));
  w.replacement.alerts.forEach((x, i) => assert.ok(x.length >= 2 && x.length <= 3));
  // 频次序列确实在盒内
  w.freqs.forEach((f, i) => assert.ok(f >= 5 - input.drifts[i] && f <= 5 + input.drifts[i]));
});

test('层级三反例：等成本点上字典序更小的码字序列（手工固定输入）', () => {
  const input = {
    alerts: [
      robustAlert('a0', 6, 1, 2), robustAlert('a1', 11, 2, 6), robustAlert('a2', 15, 3, 4),
      robustAlert('a3', 5, 2, 5), robustAlert('a4', 4, 2, 3),
    ],
    reserved: [],
    drifts: [0, 1, 0, 0, 1],
  };
  const r = checkRobustness(input);
  assert.equal(r.status, 'counterexample');
  const w = r.witness;
  assert.equal(w.firstChangedLevel, 3);
  assert.equal(w.totalOffset, 1);
  assert.deepEqual(w.freqs, [6, 11, 15, 5, 5]);
  // 层级三：成本与最大码长不变，仅码字序列字典序改变
  assert.equal(w.replacement.cost, w.baseline.costAtWitness);
  assert.equal(w.replacement.maxLength, w.baseline.maxLength);
  assert.notDeepEqual(w.replacement.codes, w.baseline.codes);
});

test('全盒暴力对拍：小规模随机用例的稳健结论与逐点重解完全一致', () => {
  function rnd(seed) {
    let t = seed;
    return () => {
      t += 0x6d2b79f5;
      let x = Math.imul(t ^ (t >>> 15), t | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  // 允许 0 频点的内部重解（复核盒下界可为 0）
  const solvePoint = (alerts, reserved) => {
    // 直接走公开 solve：测试频点经夹紧后均 ≥1，故可用
    return solve({ alerts, reserved });
  };
  const rand = rnd(20260926);
  for (let tc = 0; tc < 18; tc++) {
    const n = 5;
    const alerts = Array.from({ length: n }, (_, i) => {
      const lo = 1 + Math.floor(rand() * 2);
      return robustAlert(`s${i}`, 2 + Math.floor(rand() * 8), lo, Math.min(4, lo + 1 + Math.floor(rand() * 2)));
    });
    const pool = ['0', '1', '00', '11'];
    const reserved = pool.filter(() => rand() < 0.15).slice(0, 2);
    if (solve({ alerts, reserved }).status !== 'optimal') continue;
    const drifts = alerts.map(() => Math.floor(rand() * 2)); // 0..1，盒 ≤ 32
    const r = checkRobustness({ alerts, reserved, drifts });
    assert.ok(['robust', 'counterexample'].includes(r.status));

    // 枚举盒内每一个频点
    const base = solve({ alerts, reserved });
    const c0 = base.alerts.map((x) => x.code).join('|');
    const l0 = base.alerts.map((x) => x.length);
    const f0 = alerts.map((a) => a.freq);
    const first = [];
    const cur = f0.slice();
    (function rec(i) {
      if (i === n) {
        const rr = solvePoint(alerts.map((a, k) => ({ ...a, freq: cur[k] })), reserved);
        if (rr.status === 'optimal' && rr.alerts.map((x) => x.code).join('|') !== c0) {
          const cost0 = cur.reduce((s, f, k) => s + f * l0[k], 0);
          const lv = rr.cost < cost0 ? 1 : rr.maxLength !== base.maxLength ? 2 : 3;
          first.push({ f: cur.slice(), off: cur.reduce((s, f, k) => s + Math.abs(f - f0[k]), 0), lv });
        }
        return;
      }
      for (let f = f0[i] - drifts[i]; f <= f0[i] + drifts[i]; f++) {
        cur[i] = f;
        rec(i + 1);
      }
    })(0);
    first.sort((p, q) => p.off - q.off || (p.f < q.f ? -1 : p.f > q.f ? 1 : 0));

    if (first.length === 0) {
      assert.equal(r.status, 'robust', `用例 ${tc} 应为稳健`);
    } else {
      assert.equal(r.status, 'counterexample', `用例 ${tc} 应有反例`);
      const e = first[0];
      assert.equal(r.witness.totalOffset, e.off, `用例 ${tc} 总偏移`);
      assert.deepEqual(r.witness.freqs, e.f, `用例 ${tc} 频次序列`);
      assert.equal(r.witness.firstChangedLevel, e.lv, `用例 ${tc} 决胜层级`);
    }
  }
});

test('大漂移大频次：复核可完成且见证/证书结构自洽', () => {
  const input = {
    alerts: [
      robustAlert('a', 500, 1, 12), robustAlert('b', 300, 1, 12), robustAlert('c', 200, 1, 12),
      robustAlert('d', 100, 1, 12), robustAlert('e', 50, 1, 12),
    ],
    reserved: ['1010'],
    drifts: [40, 30, 20, 15, 10],
  };
  const r = checkRobustness(input);
  assert.ok(['robust', 'counterexample'].includes(r.status));
  assert.ok(BigInt(r.combos) > 0n);
  if (r.status === 'counterexample') {
    const w = r.witness;
    assert.ok(w.totalOffset >= 1);
    assert.equal(w.offsets.reduce((s, x) => s + x, 0), w.totalOffset);
    w.freqs.forEach((f, i) => {
      const a = input.alerts[i];
      assert.ok(f >= a.freq - input.drifts[i] && f <= a.freq + input.drifts[i]);
    });
    assert.ok([1, 2, 3].includes(w.firstChangedLevel));
    assert.ok(w.levelName.length > 0);
    assert.equal(w.replacement.alerts.length, 5);
  } else {
    assert.ok(r.tuplesEnumerated > 0);
  }
});
