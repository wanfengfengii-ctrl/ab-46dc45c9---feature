/**
 * 地震预警二进制码编配求解器（纯逻辑，无 DOM 依赖，浏览器 / Node 通用）。
 *
 * 问题：为 n 类警报（5–8）各选恰一条二进制码字，满足：
 *   1. 码字两两不得互为前缀（前缀无关 ⇒ 任意连续电文可唯一拆分）；
 *   2. 每类码字长度落在其闭区间 [lo, hi] 内；
 *   3. 码字不得"落入"保留前缀的子树（保留串是码字的前缀），
 *      也不得"遮蔽"保留前缀（码字是保留串的前缀）。
 * 目标（按优先级字典序）：
 *   ① 加权码长总和 Σ freq·len 最小；
 *   ② 最大码长最小；
 *   ③ 按警报输入顺序展开码字，逐位字典序最小（'0' < '1'，前缀短者居前）。
 *
 * 算法（两阶段精确分支限界）：
 *   阶段一在"长度元组"空间搜索最优 (总成本, 最大码长)：每类仅枚举码长，
 *   用 Kraft 容量（2^-MAX_CODE_LENGTH 为单位的整数）与容量感知的代价下界
 *   剪枝；叶子元组的可行性由带记忆化的精确分配检查判定（正确处理保留
 *   前缀的落入/遮蔽约束，纯 Kraft 不等式对此不充分）。
 *   阶段二在 成本 ≤ 最优成本、码长 ≤ 最优最大码长 的硬约束下按字典序
 *   枚举码字，首个完整分配即第三级目标下的字典序最小解。
 */

export const MIN_ALERTS = 5;
export const MAX_ALERTS = 8;
export const MAX_RESERVED = 3;
export const MAX_CODE_LENGTH = 12;
export const MAX_FREQ = 1_000_000_000;

/** 以 2^-MAX_CODE_LENGTH 为单位的码空间总容量。 */
const FULL_CAPACITY = 1 << MAX_CODE_LENGTH;

/** 长度 len 的码字占用的容量单位数。 */
function weightOf(len) {
  return 1 << (MAX_CODE_LENGTH - len);
}

/**
 * 规范化保留前缀：去空白、去重，并剔除被更短保留串覆盖的冗余项
 * （若 r 是 s 的前缀，则 s 的子树本就被 r 封禁，s 冗余）。
 */
export function normalizeReserved(reserved) {
  const seen = new Set();
  const list = [];
  for (const raw of reserved ?? []) {
    const s = String(raw ?? '').trim();
    if (s === '' || seen.has(s)) continue;
    seen.add(s);
    list.push(s);
  }
  list.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const result = [];
  for (const s of list) {
    if (!result.some((r) => s.startsWith(r))) result.push(s);
  }
  return result;
}

/** 判断一组码字是否两两互不互为前缀。 */
export function isPrefixFree(codes) {
  for (let i = 0; i < codes.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      if (i !== j && codes[j].startsWith(codes[i])) return false;
    }
  }
  return true;
}

/** 判断码字是否与全部保留前缀前缀无关（既不落入也不遮蔽）。 */
export function reservedCompatible(code, reserved) {
  for (const r of reserved) {
    if (code.startsWith(r) || r.startsWith(code)) return false;
  }
  return true;
}

/** 校验录入参数，返回中文错误信息数组（空数组表示通过）。 */
export function validateInput(input) {
  const errors = [];
  const alerts = input?.alerts ?? [];
  const reserved = input?.reserved ?? [];

  if (alerts.length < MIN_ALERTS || alerts.length > MAX_ALERTS) {
    errors.push(`警报类别数量须为 ${MIN_ALERTS}–${MAX_ALERTS} 类，当前为 ${alerts.length} 类。`);
  }
  const names = new Set();
  alerts.forEach((a, i) => {
    const label = `第 ${i + 1} 类警报`;
    const name = String(a?.name ?? '').trim();
    if (name === '') {
      errors.push(`${label}：名称不能为空。`);
    } else if (name.length > 24) {
      errors.push(`${label}：名称「${name}」超过 24 个字符。`);
    } else if (names.has(name)) {
      errors.push(`${label}：名称「${name}」与其他类别重复。`);
    }
    names.add(name);

    if (!Number.isInteger(a?.freq) || a.freq < 1 || a.freq > MAX_FREQ) {
      errors.push(`${label}：预计发送频次须为 1–${MAX_FREQ} 的正整数。`);
    }
    const { lo, hi } = a ?? {};
    if (
      !Number.isInteger(lo) ||
      !Number.isInteger(hi) ||
      lo < 1 ||
      hi > MAX_CODE_LENGTH ||
      lo > hi
    ) {
      errors.push(`${label}：码长区间须满足 1 ≤ 下限 ≤ 上限 ≤ ${MAX_CODE_LENGTH}。`);
    }
  });

  if (!Array.isArray(reserved) || reserved.length > MAX_RESERVED) {
    errors.push(`保留前缀最多 ${MAX_RESERVED} 条，当前 ${Array.isArray(reserved) ? reserved.length : 0} 条。`);
  } else {
    reserved.forEach((r, i) => {
      const s = String(r ?? '').trim();
      if (!/^[01]+$/.test(s)) {
        errors.push(`保留前缀 #${i + 1} 须为由 0/1 组成的非空串。`);
      } else if (s.length > MAX_CODE_LENGTH) {
        errors.push(`保留前缀 #${i + 1} 长度不能超过 ${MAX_CODE_LENGTH} 位。`);
      }
    });
  }
  return errors;
}

/**
 * 求解最优码表。
 * 返回：
 *   { status: 'invalid', errors }
 *   { status: 'infeasible', reason, reserved } —— 没有可用的完整分配
 *   { status: 'optimal', alerts, reserved, cost, maxLength, kraft, exploredNodes }
 *   { status: 'error', reason } —— 安全上限触发（正常输入不会到达）
 */
export function solve(input) {
  const errors = validateInput(input);
  if (errors.length > 0) return { status: 'invalid', errors };
  return solveAlerts(
    input.alerts.map((a) => ({
      name: String(a.name).trim(),
      freq: a.freq,
      lo: a.lo,
      hi: a.hi,
    })),
    input.reserved,
  );
}

/** 求解核心：alerts 已清洗（名称 trim、freq/lo/hi 为整数，freq 允许为 0，供复核重解）。 */
export function solveAlerts(alerts, reservedInput, nodeLimit = 6_000_000) {
  const reserved = normalizeReserved(reservedInput);
  const n = alerts.length;

  const reservedWeight = reserved.reduce((sum, r) => sum + weightOf(r.length), 0);
  const initialCapacity = FULL_CAPACITY - reservedWeight;
  if (initialCapacity <= 0) {
    return {
      status: 'infeasible',
      reason: '保留前缀已占满全部码空间，任何码字都无处可放。',
      reserved,
    };
  }
  // Kraft 必要条件：全部取允许的最长码（占用最小）仍装不下 ⇒ 必无解。
  const minNeed = alerts.reduce((sum, a) => sum + weightOf(a.hi), 0);
  if (minNeed > initialCapacity) {
    return {
      status: 'infeasible',
      reason: 'Kraft 约束不满足：即使每类都取允许的最长码，剩余码空间仍装不下全部类别。',
      reserved,
    };
  }

  let exploredNodes = 0;
  const NODE_LIMIT = nodeLimit; // 安全上限，正常规模远低于此

  // 后缀量：剩余类别取最长码的最小容量需求。
  const sufMinWeight = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    sufMinWeight[i] = sufMinWeight[i + 1] + weightOf(alerts[i].hi);
  }

  /**
   * Kraft 松弛动态规划（合法下界，真实约束只会更强）：
   *   costDP[i][cap]  —— 位置 i..n-1 在剩余容量 cap 下、仅满足 Kraft 与码长区间的最小加权代价；
   *   maxLenDP[i][cap] —— 同一松弛下的最小可能最大码长。
   * 复杂度 O(n · 2^D · D)，一次性预计算供两个阶段剪枝。
   */
  const costDP = Array.from({ length: n + 1 }, () => new Float64Array(FULL_CAPACITY + 1));
  const maxLenDP = Array.from({ length: n + 1 }, () => new Float64Array(FULL_CAPACITY + 1));
  for (let i = n - 1; i >= 0; i--) {
    const a = alerts[i];
    for (let cap = 0; cap <= FULL_CAPACITY; cap++) {
      let bestCost = Infinity;
      let bestMax = Infinity;
      for (let len = a.lo; len <= a.hi; len++) {
        const w = weightOf(len);
        if (w > cap) continue;
        const restCost = costDP[i + 1][cap - w];
        if (restCost === Infinity) continue;
        const total = a.freq * len + restCost;
        if (total < bestCost) bestCost = total;
        const m = Math.max(len, maxLenDP[i + 1][cap - w]);
        if (m < bestMax) bestMax = m;
      }
      costDP[i][cap] = bestCost;
      maxLenDP[i][cap] = bestMax;
    }
  }

  /**
   * 精确可行性：给定每类码长（按位置），是否存在满足全部约束的分配。
   * 只与长度多重集合有关，调用方按多重集合记忆化。
   */
  function feasibleAssignment(lengths) {
    const order = lengths.map((_, idx) => idx).sort((x, y) => lengths[x] - lengths[y]);
    const placed = [];
    const sufW = new Array(n + 1).fill(0);
    for (let k = n - 1; k >= 0; k--) sufW[k] = sufW[k + 1] + weightOf(lengths[order[k]]);

    function* candidatesOf(len) {
      function* walk(prefix) {
        if (prefix.length === len) {
          const ok =
            reserved.every((r) => !(prefix.startsWith(r) || r.startsWith(prefix))) &&
            placed.every((a) => !(a.startsWith(prefix) || prefix.startsWith(a)));
          if (ok) yield prefix;
          return;
        }
        for (const bit of ['0', '1']) {
          const child = prefix + bit;
          const covered =
            placed.some((a) => child.startsWith(a)) ||
            reserved.some((r) => child.startsWith(r));
          if (!covered) yield* walk(child);
        }
      }
      yield* walk('');
    }

    function dfs(k, cap) {
      if (++exploredNodes > NODE_LIMIT) throw new Error('search_limit_exceeded');
      if (k === n) return true;
      if (sufW[k] > cap) return false;
      const len = lengths[order[k]];
      const w = weightOf(len);
      if (w > cap) return false;
      for (const code of candidatesOf(len)) {
        placed.push(code);
        if (dfs(k + 1, cap - w)) return true;
        placed.pop();
      }
      return false;
    }
    return dfs(0, initialCapacity);
  }

  /* ---------------- 阶段一：最优 (总成本, 最大码长) ---------------- */

  const feasMemo = new Map();
  let best = null;
  const lens = new Array(n);

  function dfsLengths(i, cap, cost, maxLen) {
    if (++exploredNodes > NODE_LIMIT) throw new Error('search_limit_exceeded');
    if (best && (cost > best.cost || (cost === best.cost && maxLen >= best.maxLen))) return;
    if (i === n) {
      const key = lens.slice().sort((x, y) => x - y).join(',');
      let feas = feasMemo.get(key);
      if (feas === undefined) {
        feas = feasibleAssignment(lens);
        feasMemo.set(key, feas);
      }
      if (feas && (!best || cost < best.cost || (cost === best.cost && maxLen < best.maxLen))) {
        best = { cost, maxLen };
      }
      return;
    }
    if (sufMinWeight[i] > cap) return;
    const lowerBound = cost + costDP[i][cap];
    if (
      best &&
      (lowerBound > best.cost ||
        (lowerBound === best.cost && Math.max(maxLen, maxLenDP[i][cap]) >= best.maxLen))
    ) {
      return;
    }
    const a = alerts[i];
    for (let len = a.lo; len <= a.hi; len++) {
      const w = weightOf(len);
      if (w > cap) continue;
      lens[i] = len;
      dfsLengths(i + 1, cap - w, cost + a.freq * len, Math.max(maxLen, len));
    }
  }

  /* -------- 阶段二：成本/码长硬约束下字典序最小的具体分配 -------- */

  const assigned = [];
  let found = null;

  function* codeCandidates(lo, hi) {
    function* walk(prefix) {
      const depth = prefix.length;
      if (
        depth >= lo &&
        !assigned.some((a) => a.startsWith(prefix)) &&
        !reserved.some((r) => r.startsWith(prefix))
      ) {
        yield prefix;
      }
      if (depth < hi) {
        for (const bit of ['0', '1']) {
          const child = prefix + bit;
          const covered =
            assigned.some((a) => child.startsWith(a)) ||
            reserved.some((r) => child.startsWith(r));
          if (!covered) yield* walk(child);
        }
      }
    }
    yield* walk('');
  }

  function dfsCodes(i, cap, cost) {
    if (found) return;
    if (++exploredNodes > NODE_LIMIT) throw new Error('search_limit_exceeded');
    if (cost > best.cost) return;
    if (i === n) {
      found = assigned.slice(); // 代价不可能低于最优 ⇒ 即字典序最小的最优分配
      return;
    }
    if (sufMinWeight[i] > cap) return;
    if (cost + costDP[i][cap] > best.cost) return;
    const a = alerts[i];
    const hiCap = Math.min(a.hi, best.maxLen);
    for (const code of codeCandidates(a.lo, hiCap)) {
      const w = weightOf(code.length);
      if (w > cap) continue;
      if (cost + a.freq * code.length > best.cost) continue;
      assigned.push(code);
      dfsCodes(i + 1, cap - w, cost + a.freq * code.length);
      assigned.pop();
      if (found) return;
    }
  }

  try {
    dfsLengths(0, initialCapacity, 0, 0);
    if (best) dfsCodes(0, initialCapacity, 0);
  } catch (err) {
    if (err.message === 'search_limit_exceeded') {
      return { status: 'error', reason: '搜索规模超出安全上限，请收紧码长区间后重试。' };
    }
    throw err;
  }

  if (!best || !found) {
    return {
      status: 'infeasible',
      reason: '在码长区间与保留前缀的约束下，不存在满足前缀无关条件的完整分配。',
      reserved,
    };
  }

  const resultAlerts = alerts.map((a, i) => ({
    name: a.name,
    freq: a.freq,
    code: found[i],
    length: found[i].length,
    contribution: a.freq * found[i].length,
  }));
  const kraftCodes = found.reduce((sum, c) => sum + weightOf(c.length), 0);
  return {
    status: 'optimal',
    alerts: resultAlerts,
    reserved: reserved.map((r) => ({ prefix: r, length: r.length, weight: weightOf(r.length) })),
    cost: best.cost,
    maxLength: best.maxLen,
    kraft: {
      unit: FULL_CAPACITY,
      codes: kraftCodes,
      reserved: reservedWeight,
      free: FULL_CAPACITY - reservedWeight - kraftCodes,
    },
    exploredNodes,
  };
}


/* =====================================================================
 * 稳健性复核
 *
 * 调度员为每类警报给出非负整数频次漂移幅度 δ_i（δ_i ≤ 预计频次 p_i），
 * 复核要求：在全部独立频次组合
 *     x_i ∈ [p_i−δ_i, p_i+δ_i] ∩ ℤ        （故 x_i ≥ 0）
 * 构成的整数盒的【每一个点】上，沿用原码长区间、保留前缀与三级决胜
 * （① 加权码长总和 → ② 最大码长 → ③ 按警报输入顺序的码字字典序）
 * 重新求解时，当前码字序列必须始终仍是最终解。
 *
 * 完备性（不抽样端点、不沿用页面旧结论）：码长区间与保留前缀固定 ⇒
 * 可行码长元组集合固定，每个元组可行的具体码字集合也固定。对任一可行
 * 码长元组 l（第 i 类码长 l_i），它相对当前元组 l* 的加权代价差是频次
 * 的仿射函数
 *     g_l(x) = Σ_i (l_i − l*_i)·x_i；
 * 元组在盒内严格反超只需 g_l(x) ≤ −1（整数频次 ⇒ 代价为整数），一级
 * 打平为 g_l(x) = 0，此时再依次比较最大码长与该元组的字典序最小具体
 * 分配（字典序胜者只取决于元组、顺序与保留约束，与频次无关）。
 *
 * 对码长元组空间做带剪枝的完备分支限界（不是抽样频次端点）：
 *   - 偏移只可能朝“对该元组有利”的方向取（l_i>l*_i 的类降频次、
 *     l_i<l*_i 的类升频次）；每单位偏移换得 |l_i−l*_i| 个压缩量，
 *     每类至多 δ_i 个单位。
 *   - 第一遍求严格反例的最小总偏移量 D：把 g 压到 ≤ −1 的最小单位数，
 *     允许超调，按速率降序贪心即精确；近距元组优先枚举、动态收紧上界。
 *   - 第二遍以 D 为初始上界求平局反例（盒内恰好 g=0 的有界硬币问题，
 *     速率仅 1..11、种类 ≤ 8，带 gcd/容量/枚数下界剪枝精确求解），可能
 *     得到比 D 更小的平局距离并动态收紧；不存在严格反例时无界精确搜索。
 *   - 最后一遍收集距离恰为最终值的全部见证元组，为每个见证构造其字典
 *     序最小的反例频次序列，取全局按警报输入顺序字典序最小者，并在该
 *     频次下完整重解给出替代码表与首个改变的决胜层级。
 * ===================================================================== */

/** 校验漂移幅度录入，返回中文错误信息数组（空数组表示通过）。 */
export function validateDrifts(drifts, freqList) {
  const errors = [];
  if (!Array.isArray(drifts) || drifts.length !== freqList.length) {
    errors.push('漂移幅度的数量须与警报类别数一致。');
    return errors;
  }
  drifts.forEach((d, i) => {
    if (!Number.isInteger(d) || d < 0) {
      errors.push(`第 ${i + 1} 类警报：频次漂移幅度须为非负整数。`);
    } else if (d > freqList[i]) {
      errors.push(`第 ${i + 1} 类警报：漂移幅度 ${d} 超过预计发送频次 ${freqList[i]}（实际频次不能为负）。`);
    }
  });
  return errors;
}

/**
 * 稳健性复核。
 * @param {object} input 生成当前码表所用的同一份录入（alerts/reserved）
 * @param {number[]} drifts 每类非负整数漂移幅度
 * @returns
 *   { status:'invalid', errors }
 *   { status:'notoptimal', reason }
 *   { status:'error', reason }
 *   { status:'stable', intervals, certificate, exploredNodes }
 *   { status:'counterexample', intervals, distance, freqs, level,
 *       currentCost, currentCostAtPoint, alternativeCost, currentMaxLength,
 *       alternativeMaxLength, currentCodes, result, exploredNodes }
 */
export function reviewRobustness(input, drifts) {
  const errors0 = validateInput(input);
  if (errors0.length > 0) return { status: 'invalid', errors: errors0 };

  const alerts = input.alerts.map((a) => ({
    name: String(a.name).trim(),
    freq: a.freq,
    lo: a.lo,
    hi: a.hi,
  }));
  const reservedInput = input.reserved ?? [];
  const reserved = normalizeReserved(reservedInput);
  const n = alerts.length;
  const p = alerts.map((a) => a.freq);

  const derr = validateDrifts(drifts, p);
  if (derr.length > 0) return { status: 'invalid', errors: derr };
  const delta = drifts.slice();

  // 以当前录入重解，得到“当前码表”，保证与页面结论严格同源。
  const base = solveAlerts(alerts, reservedInput);
  if (base.status === 'invalid') return { status: 'invalid', errors: ['当前录入未通过校验。'] };
  if (base.status !== 'optimal') {
    return { status: base.status === 'error' ? 'error' : 'notoptimal', reason: base.reason };
  }

  const curLens = base.alerts.map((a) => a.code.length);
  const curCodes = base.alerts.map((a) => a.code);
  const m0 = base.maxLength;
  const lo = alerts.map((a) => a.lo);
  const hi = alerts.map((a) => a.hi);

  const reservedWeight = reserved.reduce((sum, r) => sum + weightOf(r.length), 0);
  const initialCapacity = FULL_CAPACITY - reservedWeight;

  let exploredNodes = 0;
  const NODE_LIMIT = 30_000_000;
  const feasMemo = new Map(); // 长度多重集 -> 是否存在精确分配
  const lexMemo = new Map(); // 按类别长度元组 -> 字典序最小分配
  const leafCache = new Map(); // 按类别长度元组 -> 叶子评估（null 表示无反例）
  const lens = new Array(n);
  let feasibleTupleCount = 0;

  const failLimit = () => ({
    status: 'error',
    reason: '稳健性复核搜索规模超出安全上限，请收紧漂移幅度或码长区间后重试。',
  });

  /** 精确可行性（只与长度多重集有关）：带保留前缀约束的分配存在性。 */
  function feasibleAssignment(lengths) {
    const order = lengths.map((_, idx) => idx).sort((x, y) => lengths[x] - lengths[y]);
    const placed = [];
    const sufW = new Array(n + 1).fill(0);
    for (let k = n - 1; k >= 0; k--) sufW[k] = sufW[k + 1] + weightOf(lengths[order[k]]);

    function* candidatesOf(len) {
      function* walk(prefix) {
        if (prefix.length === len) {
          const ok =
            reserved.every((r) => !(prefix.startsWith(r) || r.startsWith(prefix))) &&
            placed.every((a) => !(a.startsWith(prefix) || prefix.startsWith(a)));
          if (ok) yield prefix;
          return;
        }
        for (const bit of ['0', '1']) {
          const child = prefix + bit;
          const covered =
            placed.some((a) => child.startsWith(a)) ||
            reserved.some((r) => child.startsWith(r));
          if (!covered) yield* walk(child);
        }
      }
      yield* walk('');
    }

    function dfs(k, cap) {
      if (++exploredNodes > NODE_LIMIT) throw new Error('search_limit_exceeded');
      if (k === n) return true;
      if (sufW[k] > cap) return false;
      const len = lengths[order[k]];
      const w = weightOf(len);
      if (w > cap) return false;
      for (const code of candidatesOf(len)) {
        placed.push(code);
        if (dfs(k + 1, cap - w)) return true;
        placed.pop();
      }
      return false;
    }
    return dfs(0, initialCapacity);
  }

  /** 给定按类别长度元组，求字典序最小具体分配（三级决胜用）；不存在返回 null。 */
  function lexMinAssignment(lengths) {
    const key = 'L' + lengths.join(',');
    if (lexMemo.has(key)) return lexMemo.get(key);
    const assigned = [];
    // 后缀容量需求：已按输入顺序确定前 i 类后，剩余类至少要占的 Kraft 重量。
    const sufW = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) sufW[i] = sufW[i + 1] + weightOf(lengths[i]);

    /**
     * 前向检查：在当前 assigned（前缀无关、避开保留）已占位的前提下，剩余
     * 位置 start..n-1 的码长多重集能否完整放入。按码长升序放置（最易失败的
     * 短码先占），并带后缀 Kraft 重量剪枝；这与按警报顺序的字典序主搜索
     * 正交，用于尽早否决“靠前贪心码字导致后面无处可放”的分支。
     */
    function suffixCanFit(start) {
      const remIdx = [];
      for (let k = start; k < n; k++) remIdx.push(k);
      remIdx.sort((a, b) => lengths[a] - lengths[b]);
      const extra = [];

      function* cands(len) {
        function* walk(prefix) {
          if (prefix.length === len) {
            const blocked =
              reserved.some((r) => prefix.startsWith(r) || r.startsWith(prefix)) ||
              [...assigned, ...extra].some((c) => prefix.startsWith(c) || c.startsWith(prefix));
            if (!blocked) yield prefix;
            return;
          }
          for (const bit of ['0', '1']) {
            const child = prefix + bit;
            const covered =
              [...assigned, ...extra].some((c) => child.startsWith(c)) ||
              reserved.some((r) => child.startsWith(r));
            if (!covered) yield* walk(child);
          }
        }
        yield* walk('');
      }
      const suf = new Array(remIdx.length + 1).fill(0);
      for (let k = remIdx.length - 1; k >= 0; k--) suf[k] = suf[k + 1] + weightOf(lengths[remIdx[k]]);

      function dfs(k, cap) {
        if (k === remIdx.length) return true;
        if (suf[k] > cap) return false;
        const len = lengths[remIdx[k]];
        const w = weightOf(len);
        if (w > cap) return false;
        for (const code of cands(len)) {
          extra.push(code);
          if (dfs(k + 1, cap - w)) return true;
          extra.pop();
        }
        return false;
      }
      // 可用容量：总容量减去保留与已放置前缀的重量（必要条件口径，同可行性检查）。
      const used =
        reserved.reduce((s, r) => s + weightOf(r.length), 0) +
        assigned.reduce((s, c) => s + weightOf(c.length), 0);
      return dfs(0, FULL_CAPACITY - used);
    }

    function* codesExact(targetLen) {
      function* walk(prefix) {
        if (prefix.length === targetLen) {
          const ok =
            reserved.every((r) => !(prefix.startsWith(r) || r.startsWith(prefix))) &&
            assigned.every((a) => !(a.startsWith(prefix) || prefix.startsWith(a)));
          if (ok) yield prefix;
          return;
        }
        for (const bit of ['0', '1']) {
          const child = prefix + bit;
          const covered =
            assigned.some((a) => child.startsWith(a)) ||
            reserved.some((r) => child.startsWith(r));
          if (!covered) yield* walk(child);
        }
      }
      yield* walk('');
    }

    function dfs(i, cap) {
      if (++exploredNodes > NODE_LIMIT) throw new Error('search_limit_exceeded');
      if (i === n) return assigned.slice();
      if (sufW[i] > cap) return null; // Kraft 必要条件：剩余类放不下
      const w = weightOf(lengths[i]);
      if (w > cap) return null;
      for (const code of codesExact(lengths[i])) {
        assigned.push(code);
        if (suffixCanFit(i + 1)) {
          const got = dfs(i + 1, cap - w);
          if (got) return got;
        }
        assigned.pop();
      }
      return null;
    }
    const result = dfs(0, initialCapacity);
    lexMemo.set(key, result);
    return result;
  }

  /* 后缀剪枝量。 */
  const sufMaxRate = new Array(n + 1).fill(0); // 最大单位压缩速率
  const sufMaxCap = new Array(n + 1).fill(0); // 盒内最大压缩量
  const sufMinWeight = new Array(n + 1).fill(0); // 取最长码的容量需求
  for (let i = n - 1; i >= 0; i--) {
    let mr = 0;
    for (let l = lo[i]; l <= hi[i]; l++) {
      mr = Math.max(mr, Math.abs(l - curLens[i]));
    }
    sufMaxRate[i] = Math.max(sufMaxRate[i + 1], mr);
    sufMaxCap[i] = sufMaxCap[i + 1] + delta[i] * mr;
    sufMinWeight[i] = sufMinWeight[i + 1] + weightOf(hi[i]);
  }

  /**
   * 容量感知的代价差松弛 DP（合法下界，真实保留/前缀约束只会更强）：
   *   minG[i][cap] = 后缀 i..n-1 在剩余 Kraft 容量 cap 下，仅受码长区间与
   *   容量约束时的最小 Σ (l−l*)·p。DFS 中 fixedG + minG[i][cap] 是比“各
   *   类独立最小”紧得多的“压到 g=0 至少需消除的代价差”。
   * 复杂度 O(n·2^D·D)，一次性预计算。
   */
  const minG = Array.from({ length: n + 1 }, () => new Float64Array(FULL_CAPACITY + 1).fill(Infinity));
  minG[n].fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const row = minG[i];
    const next = minG[i + 1];
    for (let cap = 0; cap <= FULL_CAPACITY; cap++) {
      let best = Infinity;
      for (let l = lo[i]; l <= hi[i]; l++) {
        const w = weightOf(l);
        if (w > cap) continue;
        const v = (l - curLens[i]) * p[i] + next[cap - w];
        if (v < best) best = v;
      }
      row[cap] = best;
    }
  }

  function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a;
  }

  /**
   * 严格反例最小单位数：选 s_i ∈ [0,δ_i] 使 Σ rate_i·s_i ≥ target，
   * 最小化 Σ s_i。允许超调，速率降序贪心即精确最优；不可达返回 ∞。
   */
  function minUnitsOvershoot(rates, caps, target) {
    if (target <= 0) return 0;
    const order = rates.map((r, i) => i).sort((a, b) => rates[b] - rates[a]);
    let need = target;
    let cnt = 0;
    for (const i of order) {
      if (need <= 0) break;
      const take = Math.min(caps[i], Math.ceil(need / rates[i]));
      cnt += take;
      need -= take * rates[i];
    }
    return need <= 0 ? cnt : Infinity;
  }

  /**
   * 有界硬币：选 s_i ∈ [0,cap_i] 使 Σ rate_i·s_i 恰为 target，最小化
   * Σ s_i；不存在返回 null。速率 ∈ 1..11、种类 ≤ 8。limit 为枚数上界
   * （只接受严格小于 limit 的答案，limit=∞ 表示无界）。
   */
  function minCoinsExact(rates, caps, target, limit, guard0) {
    const k = rates.length;
    if (target === 0) return 0;
    if (target < 0) return null;
    const sufSum = new Array(k + 1).fill(0);
    const sufMaxRate = new Array(k + 1).fill(0);
    const sufGcd = new Array(k + 1).fill(0);
    for (let i = k - 1; i >= 0; i--) {
      sufSum[i] = sufSum[i + 1] + rates[i] * caps[i];
      sufMaxRate[i] = Math.max(sufMaxRate[i + 1], rates[i]);
      sufGcd[i] = gcd(rates[i], sufGcd[i + 1]);
    }
    if (target > sufSum[0] || target % sufGcd[0] !== 0) return null;
    if (limit < Infinity && Math.ceil(target / sufMaxRate[0]) >= limit) return null;

    let best = limit;
    let guard = 0;
    const failed = new Map();

    function dfs(i, amount, units) {
      if (amount === 0) {
        if (units < best) best = units;
        return;
      }
      if (++guard > guard0) throw new Error('coin_limit');
      if (i === k || units >= best) return;
      if (amount > sufSum[i] || amount < 0) return;
      if (units + Math.ceil(amount / sufMaxRate[i]) >= best) return;
      if (amount % sufGcd[i] !== 0) return;
      const key = i * (target + 1) + amount;
      const prev = failed.get(key);
      if (prev !== undefined && units >= prev) return;
      failed.set(key, units);

      const r = rates[i];
      const maxS = Math.min(caps[i], Math.floor(amount / r));
      const loS = Math.max(0, Math.ceil((amount - sufSum[i + 1]) / r));
      for (let s = maxS; s >= loS; s--) {
        if (units + s >= best) continue;
        dfs(i + 1, amount - s * r, units + s);
      }
    }
    try {
      dfs(0, target, 0);
    } catch (err) {
      if (err.message !== 'coin_limit') throw err;
      throw new Error('robustness_search_limit');
    }
    return best === limit ? null : best;
  }

  /** 叶子评估：mode 'strict' 只算严格距离；'tie' 补算平局距离（以 bound 为枚数界）。 */
  function evaluateLeaf(mode, bound) {
    const key = lens.join('|');
    const cached = leafCache.get(key);
    if (cached !== undefined) {
      if (mode === 'tie' && cached && (cached.tie === undefined || cached.tieBound < bound)) {
        return finishTie(cached, bound);
      }
      return cached;
    }

    let same = true;
    for (let k = 0; k < n; k++) {
      if (lens[k] !== curLens[k]) {
        same = false;
        break;
      }
    }
    if (same) {
      leafCache.set(key, null);
      return null;
    }
    const d = lens.map((l, k) => l - curLens[k]);
    const g = d.reduce((sum, di, k) => sum + di * p[k], 0); // 预计频次处代价差，恒 ≥ 0
    const m = Math.max(...lens);

    const mkey = lens.slice().sort((x, y) => x - y).join(',');
    let feas = feasMemo.get(mkey);
    if (feas === undefined) {
      feas = feasibleAssignment(lens);
      feasMemo.set(mkey, feas);
    }
    if (!feas) {
      leafCache.set(key, null);
      return null;
    }
    feasibleTupleCount++;

    const rates = [];
    const caps = [];
    for (let i = 0; i < n; i++) {
      if (d[i] !== 0 && delta[i] > 0) {
        rates.push(Math.abs(d[i]));
        caps.push(delta[i]);
      }
    }
    const strict = minUnitsOvershoot(rates, caps, g + 1);
    const info = { lens: lens.slice(), d, g, m, rates, caps, strict, tie: undefined, tieLevel: 0 };
    leafCache.set(key, info);
    if (mode === 'tie') finishTie(info, bound);
    return info;
  }

  /** 补算 info 的平局距离（只在 m≤m0 且盒内能恰好归零时为有限值）。 */
  function finishTie(info, bound) {
    if (info.tie !== undefined && info.tieBound >= bound) return info;
    let tie = Infinity;
    let tieLevel = 0;
    if (info.m <= m0 && info.rates.length > 0) {
      // 平局距离下界 ceil(g/最大速率)；等距平局也必须纳入（其反例点可能
      // 字典序更小），故用 ≤ bound；minCoinsExact 只接受 < bound+1 即 ≤bound。
      const maxRate = info.rates.reduce((mx, r) => Math.max(mx, r), 0);
      if (Math.ceil(info.g / maxRate) <= bound) {
        const exact = minCoinsExact(info.rates, info.caps, info.g, bound + 1, 500_000);
        if (exact !== null) {
          if (info.m < m0) {
            tie = exact;
            tieLevel = 2;
          } else {
            const alt = lexMinAssignment(info.lens);
            if (alt && compareCodes(alt, curCodes) < 0) {
              tie = exact;
              tieLevel = 3;
            }
          }
        }
      }
    }
    info.tie = tie;
    info.tieLevel = tieLevel;
    info.tieBound = bound;
    return info;
  }

  /** 码字序列字典序（0<1，前缀短者居前），与求解器枚举顺序一致。 */
  function compareCodes(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  /**
   * 元组空间分支限界。
   *   mode 'find'：只求严格反例距离（每叶仅做速率降序贪心，便宜），近距
   *               元组优先枚举、动态收紧；
   *   mode 'collect'：以严格距离 D（或 ∞）为剪枝界，对每叶补算平局距离，
   *               收集 best=min(严格,平局) ≤ D 的全部候选见证。
   */
  function walk(mode, candidates, bound) {
    function dfs(i, cap, fixedG, fixedRate, fixedCap, prefixMax) {
      if (++exploredNodes > NODE_LIMIT) throw new Error('search_limit_exceeded');
      if (sufMinWeight[i] > cap) return;

      const gLB = minG[i][cap]; // 容量感知的后缀最小代价差（松弛下界）
      if (gLB === Infinity) return;
      const needTie = fixedG + gLB; // 压到 g=0 至少需消除的代价差
      if (needTie > fixedCap + sufMaxCap[i]) return;

      // 平局只可能在整元组最大码长 ≤ m0 时成立；已选前缀超过 m0 直接整枝。
      if (mode === 'collectTie' && prefixMax > m0) return;

      if (mode === 'find') {
        // 用 lb > incumbent（而非 ≥）保留距离恰为 incumbent 的薄层，使叶子
        // 可直接收集等距严格见证；发现更小距离时清空旧见证即可。
        if (incumbent < Infinity) {
          const rateUB = Math.max(fixedRate, sufMaxRate[i]);
          if (rateUB > 0 && Math.ceil((needTie + 1) / rateUB) > incumbent) return;
        }
      } else if (bound < Infinity) {
        const rateUB = Math.max(fixedRate, sufMaxRate[i]);
        if (rateUB > 0) {
          // collectStrict 收集严格距离恰为 bound；collectTie 收集平局距离 ≤ bound。
          const need = mode === 'collectStrict' ? needTie + 1 : needTie;
          if (Math.ceil(need / rateUB) > bound) return;
        }
      }

      if (i === n) {
        if (mode === 'find') {
          const info = evaluateLeaf('strict', Infinity);
          if (info && info.strict < incumbent) incumbent = info.strict;
          return;
        }
        // collectTie：收集平局距离 ≤ bound（m≤m0、盒内恰能归零），遍历后取最小。
        const info = evaluateLeaf('strict', Infinity);
        if (!info) return;
        if (info.m <= m0 && info.rates.length > 0) {
          const maxRate = info.rates.reduce((mx, r) => Math.max(mx, r), 0);
          if (Math.ceil(info.g / maxRate) <= bound) {
            let g0 = 0;
            for (const r of info.rates) g0 = gcd(g0, r);
            if (info.g % g0 === 0) {
              finishTie(info, bound);
              if (info.tie <= bound) {
                candidates.push({ info, best: info.tie, kind: 'tie' });
              }
            } else {
              info.tie = Infinity;
              info.tieLevel = 0;
            }
          } else {
            info.tie = Infinity;
            info.tieLevel = 0;
          }
        }
        return;
      }

      const order = [];
      for (let l = lo[i]; l <= hi[i]; l++) order.push(l);
      order.sort((a, b) => Math.abs(a - curLens[i]) - Math.abs(b - curLens[i]) || a - b);
      for (const l of order) {
        const w = weightOf(l);
        if (w > cap) continue;
        lens[i] = l;
        const d = l - curLens[i];
        dfs(
          i + 1,
          cap - w,
          fixedG + d * p[i],
          Math.max(fixedRate, Math.abs(d)),
          fixedCap + (d !== 0 ? delta[i] * Math.abs(d) : 0),
          Math.max(prefixMax, l),
        );
      }
    }
    dfs(0, initialCapacity, 0, 0, 0, 0);
  }

  // 第一遍：求严格反例的最小距离 D（动态收紧，叶子只做廉价贪心）。
  let incumbent = Infinity;
  try {
    walk('find', null, Infinity);
  } catch (err) {
    if (err.message === 'search_limit_exceeded' || err.message === 'robustness_search_limit') {
      return failLimit();
    }
    throw err;
  }
  const strictDistance = incumbent;

  const intervals = alerts.map((a, i) => ({
    name: a.name,
    expected: p[i],
    drift: delta[i],
    low: p[i] - delta[i],
    high: p[i] + delta[i],
  }));

  // 严格见证取自叶子缓存：find 剪枝为下界 > incumbent，任何严格距离恰为
  // 最终 D 的元组都不会被剪掉（被访问时 incumbent ≥ D），故缓存中该集合完备。
  const strictWitnesses = [];
  for (const info of leafCache.values()) {
    if (info && info.strict === strictDistance) {
      strictWitnesses.push({ info, best: info.strict, kind: 'strict' });
    }
  }

  // 平局见证。
  const tieCandidates = [];
  let tieDistance = Infinity;
  try {
    if (strictDistance < Infinity) {
      // 单趟以 D 为界收集 tie ≤ D，再取最小（下界剪枝不漏 tie≤D 的元组）。
      walk('collectTie', tieCandidates, strictDistance);
      for (const cand of tieCandidates) tieDistance = Math.min(tieDistance, cand.best);
    } else if (delta.some((d) => d > 0)) {
      // 无严格反例：find 已遍历全部可达元组，直接对缓存中可能平局者做
      // 无界恰好归零求解，取最小距离。
      for (const info of leafCache.values()) {
        if (!info || info.m > m0 || info.rates.length === 0) continue;
        finishTie(info, Infinity);
        if (info.tie < tieDistance) tieDistance = info.tie;
      }
      if (tieDistance < Infinity) {
        for (const info of leafCache.values()) {
          if (info && info.tie === tieDistance) {
            tieCandidates.push({ info, best: info.tie, kind: 'tie' });
          }
        }
      }
    }
  } catch (err) {
    if (err.message === 'search_limit_exceeded' || err.message === 'robustness_search_limit') {
      return failLimit();
    }
    throw err;
  }

  // 最终最小距离 = min(最小严格距离, 最小平局距离)。
  incumbent = Math.min(strictDistance, tieDistance);

  if (incumbent === Infinity) {
    return {
      status: 'stable',
      intervals,
      certificate: {
        feasibleTuples: [...leafCache.values()].filter((v) => v).length,
        prunedByBounds: exploredNodes,
        exploredNodes,
        rule:
          '完备分支限界已覆盖整数盒：每个通过容量/保留约束的可行码长元组均已解析求极（其余元组由容量、Kraft 松弛 DP 与速率下界充分剪枝，不可能在盒内反超或打平占优）；' +
          '显式核查的可行元组中，任一元组在盒内的最小加权代价差恒为正，或虽可恰好归零打平但在第二、三级决胜中均不占优。',
      },
      exploredNodes,
    };
  }

  // 距离恰为最终值的全部见证。
  const witnesses =
    incumbent === strictDistance && incumbent === tieDistance
      ? [...strictWitnesses, ...tieCandidates.filter((c) => c.best === tieDistance)]
      : incumbent === strictDistance
        ? strictWitnesses
        : tieCandidates.filter((c) => c.best === tieDistance);

  /* ---- 见证元组 -> 字典序最小反例频次序列 ---- */

  /** 后缀（按 moverIdx 顺序）恰用 units 个单位可取得的最大压缩量。 */
  function makeSuffixEnvelope(moverIdx, dvec) {
    const kTot = moverIdx.length;
    const sufUnits = new Array(kTot + 1).fill(0);
    const buckets = []; // buckets[k]：后缀各速率的总份数（降序数组 [rate, cap]）
    const breakpoints = []; // breakpoints[k]：后缀贪心斜率断点处的累计份数
    for (let i = 0; i <= kTot; i++) {
      buckets.push([]);
      breakpoints.push([]);
    }
    for (let k = kTot - 1; k >= 0; k--) {
      sufUnits[k] = sufUnits[k + 1] + delta[moverIdx[k]];
      const map = new Map(buckets[k + 1]);
      const r = Math.abs(dvec[moverIdx[k]]);
      map.set(r, (map.get(r) ?? 0) + delta[moverIdx[k]]);
      buckets[k] = [...map.entries()].sort((a, b) => b[0] - a[0]);
      let cum = 0;
      const bps = [];
      for (const [, c] of buckets[k]) {
        cum += c;
        bps.push(cum);
      }
      breakpoints[k] = bps;
    }
    const f = (k, units) => {
      if (units < 0 || units > sufUnits[k]) return -1;
      let remain = units;
      let sum = 0;
      for (const [r, c] of buckets[k]) {
        const take = Math.min(remain, c);
        sum += take * r;
        remain -= take;
        if (remain === 0) break;
      }
      return remain === 0 ? sum : -1;
    };
    return { f, sufUnits, breakpoints };
  }

  /**
   * 严格见证：Σ rate·s ≥ g+1 且恰用 D 单位。逐类取频次序列最有利的极值。
   * h(s)=r·s+f(U−s) 中 f 为后缀贪心最大压缩量（斜率随单位数递增而非增），
   * 故 h 是 [loS,hiS] 上的离散凹函数（单峰）：{h≥rem} 为连续区间。在
   * 端点与斜率断点（≤ 12 个）处定位峰值，再在峰两侧二分可行边界。
   */
  function buildStrictPoint(info) {
    const D = incumbent;
    const { d, g } = info;
    const moverIdx = [];
    for (let i = 0; i < n; i++) if (d[i] !== 0 && delta[i] > 0) moverIdx.push(i);
    const { f, sufUnits, breakpoints } = makeSuffixEnvelope(moverIdx, d);

    const s = new Array(n).fill(0);
    let used = 0;
    let acc = 0;
    for (let mk = 0; mk < moverIdx.length; mk++) {
      const i = moverIdx[mk];
      const r = Math.abs(d[i]);
      const U = D - used;
      const loS = Math.max(0, U - sufUnits[mk + 1]);
      const hiS = Math.min(delta[i], U);
      const rem = g + 1 - acc;
      const h = (sv) => {
        if (sv < loS || sv > hiS) return -1;
        const tail = f(mk + 1, U - sv);
        return tail < 0 ? -1 : r * sv + tail;
      };
      // 候选断点：端点 + s = U − cum（后缀桶容量累计处）±1
      const cand = new Set([loS, hiS]);
      for (const cum of breakpoints[mk + 1]) {
        for (const t of [U - cum - 1, U - cum, U - cum + 1]) {
          if (t >= loS && t <= hiS) cand.add(t);
        }
      }
      let peak = loS;
      for (const t of cand) {
        if (h(t) > h(peak)) peak = t;
      }
      let pick = null;
      if (h(peak) >= rem) {
        const preferHigh = d[i] > 0; // 元组中该类更长 ⇒ 降频次使频次序列更小
        if (preferHigh) {
          // 右边界位于 [peak, hiS]，h 在峰右侧非增，二分最右可行点
          let a = peak;
          let b = hiS;
          while (a < b) {
            const mid = Math.ceil((a + b) / 2);
            if (h(mid) >= rem) a = mid;
            else b = mid - 1;
          }
          pick = a;
        } else {
          // 左边界位于 [loS, peak]，h 在峰左侧非减，二分最左可行点
          let a = loS;
          let b = peak;
          while (a < b) {
            const mid = Math.floor((a + b) / 2);
            if (h(mid) >= rem) b = mid;
            else a = mid + 1;
          }
          pick = a;
        }
      }
      if (pick === null || h(pick) < rem) return null;
      s[i] = pick;
      used += pick;
      acc += pick * r;
    }
    if (used !== D || acc < g + 1) return null;
    return pointFromShifts(d, s);
  }

  /**
   * 平局见证：Σ rate·s 恰为 g 且恰用 D 单位。逐类按频次序列字典序最小的
   * 方向优先尝试极值 s，后缀可行性用记忆化有界硬币判定（gcd/容量剪枝）。
   */
  function buildTiePoint(info) {
    const D = incumbent;
    const { d, g } = info;
    const moverIdx = [];
    for (let i = 0; i < n; i++) if (d[i] !== 0 && delta[i] > 0) moverIdx.push(i);
    const kTot = moverIdx.length;
    const rates = moverIdx.map((i) => Math.abs(d[i]));
    const caps = moverIdx.map((i) => delta[i]);
    const sufSum = new Array(kTot + 1).fill(0);
    const sufUnits = new Array(kTot + 1).fill(0);
    const sufGcd = new Array(kTot + 1).fill(0);
    for (let k = kTot - 1; k >= 0; k--) {
      sufSum[k] = sufSum[k + 1] + rates[k] * caps[k];
      sufUnits[k] = sufUnits[k + 1] + caps[k];
      sufGcd[k] = gcd(rates[k], sufGcd[k + 1]);
    }
    const failed = new Set();
    let guard = 0;

    function feasible(k, units, amount) {
      if (units === 0) return amount === 0; // 剩余各类全部取 0 份总是允许
      if (k === kTot || amount < 0 || units < 0 || units > sufUnits[k]) return false;
      if (amount > sufSum[k] || amount % sufGcd[k] !== 0) return false;
      const key = k + ':' + amount + ':' + units;
      if (failed.has(key)) return false;
      if (++guard > 2_000_000) throw new Error('coin_limit');
      const r = rates[k];
      const loS = Math.max(0, Math.ceil((amount - sufSum[k + 1]) / r), units - sufUnits[k + 1]);
      const hiS = Math.min(caps[k], units, Math.floor(amount / r));
      if (loS > hiS) {
        failed.add(key);
        return false;
      }
      // 存在性：区间内任取。先试两端，再向内扫描（种类 ≤ 8，通常立即命中）。
      const tries = [];
      if (loS !== hiS) tries.push(loS, hiS);
      else tries.push(loS);
      for (const s of tries) {
        if (feasible(k + 1, units - s, amount - s * r)) return true;
      }
      for (let s = loS + 1; s < hiS; s++) {
        if (feasible(k + 1, units - s, amount - s * r)) return true;
      }
      failed.add(key);
      return false;
    }

    const s = new Array(n).fill(0);
    let used = 0;
    let acc = 0;
    try {
      for (let mk = 0; mk < kTot; mk++) {
        const i = moverIdx[mk];
        const r = rates[mk];
        const U = D - used;
        const loS = Math.max(0, U - sufUnits[mk + 1]);
        const hiS = Math.min(caps[mk], U);
        const preferHigh = d[i] > 0;
        let pick = null;
        const ok = (sv) => {
          const restAmount = g - acc - sv * r;
          const restUnits = U - sv;
          if (restAmount === 0) return restUnits === 0;
          return feasible(mk + 1, restUnits, restAmount);
        };
        if (preferHigh) {
          for (let sv = hiS; sv >= loS; sv--) {
            if (ok(sv)) {
              pick = sv;
              break;
            }
          }
        } else {
          for (let sv = loS; sv <= hiS; sv++) {
            if (ok(sv)) {
              pick = sv;
              break;
            }
          }
        }
        if (pick === null) return null;
        s[i] = pick;
        used += pick;
        acc += pick * r;
      }
    } catch (err) {
      if (err.message !== 'coin_limit') throw err;
      return null;
    }
    if (used !== D || acc !== g) return null;
    return pointFromShifts(d, s);
  }

  /** 差长 d 与各类有利方向偏移份数 s -> 实际频次序列。 */
  function pointFromShifts(d, s) {
    const x = p.slice();
    for (let i = 0; i < n; i++) {
      if (d[i] > 0) x[i] = p[i] - s[i];
      else if (d[i] < 0) x[i] = p[i] + s[i];
    }
    return x;
  }

  let bestPoint = null;
  let bestInfo = null;
  let bestKind = null;
  for (const cand of witnesses) {
    const info = cand.info;
    let x = null;
    if (cand.kind === 'strict') x = buildStrictPoint(info);
    else x = buildTiePoint(info);
    if (x && (!bestPoint || lexCompareFreqs(x, bestPoint) < 0)) {
      bestPoint = x;
      bestInfo = info;
      bestKind = cand.kind;
    }
  }

  if (!bestPoint) {
    return {
      status: 'error',
      reason: '复核发现更近的反例距离但反例频次构造失败，请缩小漂移幅度后重试。',
    };
  }

  // 替代码表直接取该见证元组在固定顺序/保留约束下的字典序最小具体分配
  // （决胜层级在见证评估时已严格判定，无需在含 0 频次点上再跑一遍会退化
  // 的完整求解；当前码表与替代表在该频次点的成本均可直接核算）。
  const altCodes = lexMinAssignment(bestInfo.lens);
  if (!altCodes) {
    return { status: 'error', reason: '替代码表构造失败，请缩小漂移幅度后重试。' };
  }
  const currentCostAtPoint = curLens.reduce((sum, l, k) => sum + l * bestPoint[k], 0);
  const alternativeCost = bestInfo.lens.reduce((sum, l, k) => sum + l * bestPoint[k], 0);
  let level;
  if (bestKind === 'strict') {
    level = 1;
    if (!(alternativeCost < currentCostAtPoint)) {
      return { status: 'error', reason: '复核内部校验未通过：严格反例的代价差不为负。' };
    }
  } else if (bestInfo.m < m0) {
    level = 2;
  } else {
    level = 3;
  }
  const altResult = {
    status: 'optimal',
    alerts: alerts.map((a, k) => ({
      name: a.name,
      freq: bestPoint[k],
      code: altCodes[k],
      length: altCodes[k].length,
      contribution: bestPoint[k] * altCodes[k].length,
    })),
    reserved: base.reserved,
    cost: alternativeCost,
    maxLength: bestInfo.m,
  };

  return {
    status: 'counterexample',
    intervals,
    distance: incumbent,
    freqs: alerts.map((a, i) => ({
      name: a.name,
      expected: p[i],
      actual: bestPoint[i],
      offset: bestPoint[i] - p[i],
    })),
    level,
    currentCost: base.cost,
    currentCostAtPoint,
    alternativeCost,
    currentMaxLength: m0,
    alternativeMaxLength: bestInfo.m,
    currentCodes: base.alerts.map((a) => ({ name: a.name, code: a.code, length: a.code.length })),
    result: altResult,
    exploredNodes,
  };
}

/** 实际频次序列按警报输入顺序的字典序。 */
function lexCompareFreqs(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
