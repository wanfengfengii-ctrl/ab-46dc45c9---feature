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
export function codeWeight(len) {
  return 1 << (MAX_CODE_LENGTH - len);
}

const weightOf = codeWeight;

/** 搜索预算：超过安全上限时抛出 search_limit_exceeded，由上层转为 error 结论。 */
function makeTracker(limit) {
  return {
    n: 0,
    limit,
    tick() {
      if (++this.n > this.limit) throw new Error('search_limit_exceeded');
    },
  };
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
 * 求解最优码表（入参须先通过 validateInput）。
 * 返回：
 *   { status: 'infeasible', reason, reserved } —— 没有可用的完整分配
 *   { status: 'optimal', alerts, reserved, cost, maxLength, kraft, exploredNodes, lengths }
 *   { status: 'error', reason } —— 安全上限触发（正常输入不会到达）
 *
 * alerts 中频次允许为 0（稳健性复核的漂移端点可能为 0）；码长/保留约束不变。
 */
function solveRaw(alertsInput, reservedInput, nodeLimit = 6_000_000) {
  const alerts = alertsInput.map((a) => ({
    name: String(a.name).trim(),
    freq: a.freq,
    lo: a.lo,
    hi: a.hi,
  }));
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

  const tracker = makeTracker(6_000_000); // 安全上限，正常规模远低于此

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
      tracker.tick();
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
    tracker.tick();
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
    tracker.tick();
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
    lengths: found.map((c) => c.length),
    kraft: {
      unit: FULL_CAPACITY,
      codes: kraftCodes,
      reserved: reservedWeight,
      free: FULL_CAPACITY - reservedWeight - kraftCodes,
    },
    exploredNodes: tracker.n,
  };
}

/** 校验录入参数后求解；非法参数返回 { status: 'invalid', errors }。 */
export function solve(input) {
  const errors = validateInput(input);
  if (errors.length > 0) return { status: 'invalid', errors };
  return solveRaw(input.alerts, input.reserved);
}

/* ===================================================================== */
/* 稳健性复核                                                             */
/*                                                                        */
/* 给定基准频次 f0 与每类非负整数漂移幅度 d，实际频次盒为                  */
/*   f_i ∈ [f0_i − d_i, f0_i + d_i]（整数）的全部组合。                   */
/* 对任一可行长度元组 l（与基准码长 l0 不同），令 a_i = l_i − l0_i：      */
/*   替代相对当前码表的代价差 Δ(f) = Σ f_i·a_i = D0 − G，                 */
/*   其中 D0 = Σ f0_i·a_i ≥ 0（当前码表在基准频次下最优），               */
/*   G = −Σ s_i·a_i、s_i = f_i − f0_i ∈ [−d_i, d_i]（有效步只取有利向）。*/
/* 盒内 G 最大值 U = Σ d_i|a_i|。                                         */
/* · U ≥ D0 + 1：盒内存在频次使替代严格更便宜 ⇒ 第一决胜层级被推翻；        */
/*   最小偏移见证用「至少目标」有界单位步模型精确求出（步价值 |a_i|≤11）。 */
/* · U ≥ D0：用「精确目标」见证枚举盒内所有等成本频点（含需要不利步回退    */
/*   才能恰好凑出 D0 的内部点，不能只看全有利角点），在这些频点上比较      */
/*   第二（最大码长）、第三（码字字典序）决胜层级。                        */
/* 枚举全部 Kraft 可行长度元组，逐一做精确可行性检查（保留前缀使纯 Kraft   */
/* 不充分），再对每个可行异元组求盒内最小反例（非端点抽样、非旧结论复用）。*/
/* ===================================================================== */

/** 码树 DFS 剪枝：前缀被已分配码字或保留前缀覆盖则整棵子树封禁。 */
function isCovered(child, assigned, reserved) {
  return (
    assigned.some((a) => child.startsWith(a)) ||
    reserved.some((r) => child.startsWith(r))
  );
}

/**
 * 精确可行性（仅判定存在性）：按码长升序逐类放置（短码先占位，候选少、
 * 剪枝强），带后缀 Kraft 容量剪枝。只与长度多重集合有关，供大规模枚举复用。
 */
function assignmentExists(lengths, reserved, initialCapacity, tracker) {
  const n = lengths.length;
  const order = lengths.map((_, idx) => idx).sort((x, y) => lengths[x] - lengths[y]);
  const placed = [];
  const sufW = new Array(n + 1).fill(0);
  for (let k = n - 1; k >= 0; k--) sufW[k] = sufW[k + 1] + codeWeight(lengths[order[k]]);

  function* candidatesOf(len) {
    function* walk(prefix) {
      if (prefix.length === len) {
        if (
          reserved.every((r) => !(prefix.startsWith(r) || r.startsWith(prefix))) &&
          placed.every((a) => !(a.startsWith(prefix) || prefix.startsWith(a)))
        ) {
          yield prefix;
        }
        return;
      }
      for (const bit of ['0', '1']) {
        const child = prefix + bit;
        if (!isCovered(child, placed, reserved)) yield* walk(child);
      }
    }
    yield* walk('');
  }

  function dfs(k, cap) {
    tracker?.tick();
    if (k === n) return true;
    if (sufW[k] > cap) return false;
    const len = lengths[order[k]];
    const w = codeWeight(len);
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

/**
 * 给定每类码长（按警报顺序），返回字典序最小的前缀无关分配；不存在返回 null。
 * 可行性只依赖长度多重集合，具体码字依赖警报顺序；仅用于第三决胜层级比较。
 */
function lexMinAssignment(lengths, reserved, initialCapacity, tracker) {
  const n = lengths.length;
  const assigned = [];
  const sufW = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) sufW[i] = sufW[i + 1] + codeWeight(lengths[i]);

  function* candidatesOf(idx) {
    const len = lengths[idx];
    function* walk(prefix) {
      if (prefix.length === len) {
        if (
          reserved.every((r) => !(prefix.startsWith(r) || r.startsWith(prefix))) &&
          assigned.every((a) => !(a.startsWith(prefix) || prefix.startsWith(a)))
        ) {
          yield prefix;
        }
        return;
      }
      for (const bit of ['0', '1']) {
        const child = prefix + bit;
        if (!isCovered(child, assigned, reserved)) yield* walk(child);
      }
    }
    yield* walk('');
  }

  let found = null;
  function dfs(i, cap) {
    if (found) return;
    tracker?.tick();
    if (i === n) {
      found = assigned.slice();
      return;
    }
    if (sufW[i] > cap) return;
    for (const code of candidatesOf(i)) {
      const w = codeWeight(code.length);
      if (w > cap) continue;
      assigned.push(code);
      dfs(i + 1, cap - w);
      assigned.pop();
      if (found) return;
    }
  }
  dfs(0, initialCapacity);
  return found;
}

/** 频次序列字典序比较（整数数组）。 */
function freqLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * 有界单位步模型（复核数学核心）。
 *
 * 对候选长度元组 l，令 a_i = l_i − l0_i、D0 = Σ f0_i·a_i（基准频次下替代码表
 * 相对当前码表的代价差，D0 ≥ 0）。实际频次 f = f0 + s 下相对代价差为
 *   Δ = Σ f_i·a_i = D0 − G(s)，  G(s) = −Σ s_i·a_i，
 *   s_i ∈ [−d_i, d_i]，有效步只取有利方向（a>0 频次下移、a<0 频次上移）。
 * 每类 i 提供 d_i 个价值 |a_i| ∈ [1,11] 的同向单位步。
 *
 * · 严格更便宜：Δ ≤ −1 ⇔ G ≥ D0 + 1 —— 「至少目标」见证；
 * · 等成本：Δ = 0 ⇔ G = D0   —— 「精确目标」见证。
 * 两类见证都返回盒内 (总偏移最小, 频次序列字典序最小) 的频点。
 */

/** 把长度差整理为按价值降序的步组：value -> {total, members:[{i,dir,cap}]}。 */
function buildStepGroups(a, d) {
  const groups = new Map();
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0 || d[i] === 0) continue;
    const v = Math.abs(a[i]);
    if (!groups.has(v)) groups.set(v, { total: 0, members: [] });
    const g = groups.get(v);
    g.total += d[i];
    g.members.push({ i, dir: a[i] > 0 ? -1 : 1, cap: d[i] }); // -1 下移 / 1 上移
  }
  const values = [...groups.keys()].sort((x, y) => y - x);
  const copies = values.map((v) => groups.get(v).total);
  const suffixCopies = new Array(values.length + 1).fill(0);
  for (let j = values.length - 1; j >= 0; j--) {
    suffixCopies[j] = suffixCopies[j + 1] + copies[j];
  }
  return { groups, values, copies, suffixCopies };
}

/** 第 j 组起取 budget 步能达到的最大/最小价值。 */
function tailValue(values, copies, j, budget, maxFirst) {
  if (budget <= 0) return 0;
  let sum = 0;
  if (maxFirst) {
    for (let k = j; k < values.length && budget > 0; k++) {
      const take = Math.min(budget, copies[k]);
      sum += take * values[k];
      budget -= take;
    }
  } else {
    for (let k = values.length - 1; k >= j && budget > 0; k--) {
      const take = Math.min(budget, copies[k]);
      sum += take * values[k];
      budget -= take;
    }
  }
  return sum;
}

/**
 * 给定各价值选中份数，在同组各警报容量约束下分配份数，构造字典序最小频次向量。
 * 组内按警报下标升序：下移（频次更小）在份额仍可由后续成员承担时尽量多取，
 * 上移尽量少取。
 */
function buildFreqsFromChosen(chosen, model) {
  const { n, f0, a, groups, values } = model;
  const steps = new Array(n).fill(0);
  for (let j = 0; j < values.length; j++) {
    let remain = chosen[j];
    const members = groups.get(values[j]).members;
    const tailCap = new Array(members.length + 1).fill(0);
    for (let k = members.length - 1; k >= 0; k--) {
      tailCap[k] = tailCap[k + 1] + members[k].cap;
    }
    for (let k = 0; k < members.length; k++) {
      const { i, dir, cap } = members[k];
      let take;
      if (dir === -1) {
        take = Math.min(cap, remain);
        if (remain - take > tailCap[k + 1]) take = remain - tailCap[k + 1];
      } else {
        take = Math.max(0, remain - tailCap[k + 1]);
      }
      steps[i] = take;
      remain -= take;
    }
  }
  return f0.map((f, i) => (a[i] < 0 ? f + steps[i] : f - steps[i]));
}

/**
 * 「至少目标」见证：总步数最小且总价值 ≥ K，并列取频次序列字典序最小。
 * 最大步贪心求最小步数 m 与 m 步最大价值 gMax；份数枚举窗口由
 * maxTail/minTail 二分夹逼（超额 slack < 临界步价值 ≤ 11），与 K 的量级无关。
 */
function witnessAtLeast(a, f0, d, K, tracker) {
  const n = a.length;
  const { groups, values, copies, suffixCopies } = buildStepGroups(a, d);
  const q = values.length;
  const model = { n, f0, a, d, groups, values };

  let gMax = 0;
  let m = 0;
  let need = K;
  for (let j = 0; j < q && need > 0; j++) {
    const take = Math.min(copies[j], Math.ceil(need / values[j]));
    gMax += take * values[j];
    m += take;
    need -= take * values[j];
  }
  if (need > 0) return null;

  const maxTail = (j, b) => tailValue(values, copies, j, b, true);
  const minTail = (j, b) => tailValue(values, copies, j, b, false);

  let bestFreqs = null;
  const chosen = new Array(q).fill(0);
  (function rec(j, unitsLeft, prefixValue) {
    tracker?.tick();
    if (j === q) {
      if (unitsLeft === 0 && prefixValue >= K) {
        const freqs = buildFreqsFromChosen(chosen, model);
        if (bestFreqs === null || freqLess(freqs, bestFreqs)) bestFreqs = freqs;
      }
      return;
    }
    const v = values[j];
    const cLo0 = Math.max(0, unitsLeft - suffixCopies[j + 1]);
    const cHi0 = Math.min(copies[j], unitsLeft);
    if (cLo0 > cHi0) return;
    const enough = (c) => prefixValue + c * v + maxTail(j + 1, unitsLeft - c) >= K;
    let lo = cLo0;
    let hi = cHi0;
    let cMin = cHi0 + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (enough(mid)) {
        cMin = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (cMin > cHi0) return;
    const notOver = (c) => prefixValue + c * v + minTail(j + 1, unitsLeft - c) <= gMax;
    lo = cMin;
    hi = cHi0;
    let cMax = cMin - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (notOver(mid)) {
        cMax = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (let c = cMin; c <= cMax; c++) {
      chosen[j] = c;
      rec(j + 1, unitsLeft - c, prefixValue + c * v);
      chosen[j] = 0;
    }
  })(0, m, 0);

  if (!bestFreqs) return null;
  return { offset: m, freqs: bestFreqs };
}

/**
 * 「精确目标」见证（带符号模型）：
 *   w_i = |a_i| ∈ [1,11]，y_i ∈ [−d_i, d_i]（整数，y>0=有利方向），
 *   求 Σ w_i·y_i = target 且 Σ|y_i| 最小；并列取频次序列字典序最小。
 *
 * 最小偏移解中每类 y_i 必单方向（同类 ±k 抵消严格减 2k 偏移、价值不变），
 * 故等价于 2n 种有向硬币：每类正/负向各 d_i 枚、互斥。
 *
 * 负向步只用于回退正向过冲。负向总增益 N 有与目标量级无关的常数上界
 *（面值宇宙 {1..11}、变量 5–8 时 < 528，全域认证），并配自适应停止；
 * 对每个候选 N：
 *   ① 负向计划：有界硬币小 DP（≤NEG_BOUND 状态）枚举凑出 N 的最小枚数分配
 *      及其占用的警报类别；
 *   ② 正向计划：在剩余类别容量下凑 target+N（大目标走剥离引理窗口）。
 * 合计枚数最优、频次字典序最小者即见证。
 */
const NEG_BOUND = 528;

function buildClassCoins(a, d) {
  const coins = []; // {i, w, cap}（每类一枚硬币类型，正/负向共享容量互斥）
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0 || d[i] === 0) continue;
    coins.push({ i, iDir: Math.sign(a[i]), w: Math.abs(a[i]), cap: d[i] });
  }
  return coins;
}

/**
 * 把硬币类按面值分组：组容量 = 同类面值各类容量之和。
 * 剥离窗口定理作用于"面值组的总份数"；同面值各类之间迁移硬币不改变枚数，
 * 组内分配只需取频次字典序最小者（逐警报下标贪心）。
 */
function groupCoins(coins, caps) {
  const map = new Map();
  coins.forEach((c, ci) => {
    const cap = Math.min(c.cap, caps[ci]);
    if (cap <= 0) return;
    if (!map.has(c.w)) map.set(c.w, { w: c.w, members: [], total: 0 });
    const g = map.get(c.w);
    g.members.push({ ci, i: c.i, dir: undefined, cap });
    g.total += cap;
  });
  // 组内成员按警报下标升序；dir 由 a 符号决定（a<0 上移 dir=+1，a>0 下移 dir=-1）
  for (const g of map.values()) {
    g.members.sort((p, q) => p.i - q.i);
    for (const m of g.members) m.dir = coins[m.ci].iDir;
  }
  const groups = [...map.values()].sort((p, q) => q.w - p.w);
  return groups;
}

/**
 * 组内字典序最优分配：总份数 c 分到成员（0≤x≤cap），使频次序列字典序最小。
 * a<0（上移，频次 = f+x）类尽量少取；a>0（下移，频次 = f−x）类尽量多取，
 * 均以"剩余份数必须放得进后续成员"为可行性界。返回 Map(ci -> 份数) 或 null。
 */
function allocGroup(members, totalC, aSignOfI) {
  const tailCap = new Array(members.length + 1).fill(0);
  for (let k = members.length - 1; k >= 0; k--) tailCap[k] = tailCap[k + 1] + members[k].cap;
  if (totalC < 0 || totalC > tailCap[0]) return null;
  const out = new Map();
  let remain = totalC;
  for (let k = 0; k < members.length; k++) {
    const { ci, i, cap } = members[k];
    const up = aSignOfI[i] < 0; // a<0：正向步使频次上移
    let take;
    if (up) take = Math.max(0, remain - tailCap[k + 1]); // 上移类尽量少取
    else {
      take = Math.min(cap, remain); // 下移类尽量多取
      if (remain - take > tailCap[k + 1]) take = remain - tailCap[k + 1];
    }
    out.set(ci, take);
    remain -= take;
  }
  return out;
}

/**
 * 正向（仅 y≥0）有界硬币：按面值分组，凑出 target 的最小枚数的全部"组份数解"
 * （每组份解对应唯一的组内字典序最优类分配）。
 * 返回 [{counts:Map(clsIdx->枚数), steps}]。大目标走剥离窗口（窗口宽=面值）。
 */
function positivePlans(coins, caps, target, tracker, aSign) {
  const signOfI = aSign;
  const groups = groupCoins(coins, caps);
  for (const g of groups) for (const m of g.members) m.dir = signOfI[m.i] < 0 ? 1 : -1;
  const ng = groups.length;
  const values = groups.map((g) => g.w);
  const gcaps = groups.map((g) => g.total);
  const SMALL = 200_000;
  const results = [];

  const emit = (groupCounts) => {
    const counts = new Map();
    let steps = 0;
    groupCounts.forEach((c, j) => {
      steps += c;
      const alloc = allocGroup(groups[j].members, c, signOfI);
      for (const [ci, x] of alloc) {
        if (x > 0) counts.set(ci, x);
      }
    });
    // 同一步数下组内分配唯一（字典序最优）；组份数不同但步数相同时全部保留
    if (results.length === 0 || steps <= results[0].steps) {
      if (results.length === 0 || steps < results[0].steps) results.length = 0;
      results.push({ counts, steps });
    }
  };

  if (target <= SMALL) {
    // 按面值组的有界硬币 DP（单调队列）
    const dp = Array.from({ length: ng + 1 }, () => null);
    dp[ng] = new Int32Array(target + 1).fill(-1);
    dp[ng][0] = 0;
    for (let j = ng - 1; j >= 0; j--) {
      tracker?.tick();
      const v = values[j], cap = Math.min(gcaps[j], Math.floor(target / v));
      const cur = new Int32Array(target + 1).fill(-1);
      const nxt = dp[j + 1];
      for (let r = 0; r < v; r++) {
        const qi = [], qv = [];
        let head = 0, k = 0;
        for (let x = r; x <= target; x += v, k++) {
          if (nxt[x] >= 0) {
            const val = nxt[x] - k;
            while (qv.length > head && qv[qv.length - 1] >= val) { qv.pop(); qi.pop(); }
            qv.push(val); qi.push(k);
          }
          while (qi.length > head && k - qi[head] > cap) head++;
          if (qv.length > head) cur[x] = qv[head] + k;
        }
      }
      dp[j] = cur;
    }
    if (dp[0][target] < 0) return [];
    const minSteps = dp[0][target];
    const gc = new Array(ng).fill(0);
    (function rec(j, need, used) {
      tracker?.tick();
      if (j === ng) {
        if (need === 0 && used === minSteps) emit(gc);
        return;
      }
      if (dp[j][need] < 0 || used + dp[j][need] !== minSteps) return;
      const v = values[j], cap = Math.min(gcaps[j], Math.floor(need / v));
      for (let c = 0; c <= cap; c++) {
        const rest = need - c * v;
        if (rest >= 0 && dp[j + 1][rest] >= 0 && used + c + dp[j + 1][rest] === minSteps) {
          gc[j] = c;
          rec(j + 1, rest, used + c);
          gc[j] = 0;
        }
      }
    })(0, target, 0);
    return results;
  }

  // 大目标：按面值组剥离，窗口宽 = 当前面值 v。
  const suffixValue = new Array(ng + 1).fill(0);
  for (let j = ng - 1; j >= 0; j--) suffixValue[j] = suffixValue[j + 1] + values[j] * gcaps[j];
  let bestSteps = Infinity;
  const gc = new Array(ng).fill(0);
  (function peel(j, need) {
    tracker?.tick();
    if (need < 0) return;
    if (need === 0) {
      const steps = gc.reduce((s, c) => s + c, 0);
      if (steps <= bestSteps) {
        if (steps < bestSteps) { bestSteps = steps; results.length = 0; }
        emit(gc);
      }
      return;
    }
    const stepsSoFar = gc.reduce((s, c) => s + c, 0);
    if (stepsSoFar > bestSteps) return;
    if (need <= SMALL) {
      const subVals = values.slice(j);
      const subCaps = gcaps.slice(j);
      const sub = groupedSmallPlans(subVals, subCaps, groups.slice(j), signOfI, need, tracker);
      for (const p of sub) {
        const total = stepsSoFar + p.steps;
        if (total <= bestSteps) {
          if (total < bestSteps) { bestSteps = total; results.length = 0; }
          const counts = new Map();
          gc.forEach((c, k) => { if (c > 0) {
            const alloc = allocGroup(groups[k].members, c, signOfI);
            for (const [ci, x] of alloc) if (x > 0) counts.set(ci, x);
          }});
          for (const [ci, x] of p.counts) {
            if (x > 0) counts.set(ci, (counts.get(ci) ?? 0) + x);
          }
          results.push({ counts, steps: total });
        }
      }
      return;
    }
    if (j === ng) return;
    const v = values[j];
    const cHi = Math.min(gcaps[j], Math.floor(need / v));
    const cLo = Math.max(0, Math.ceil((need - suffixValue[j + 1]) / v));
    const floor = Math.max(cLo, cHi - v + 1);
    for (let c = cHi; c >= floor; c--) {
      gc[j] = c;
      peel(j + 1, need - c * v);
      gc[j] = 0;
    }
  })(0, target);
  return results;
}

/** 子系统（面值组）小目标闭合：返回 [{counts:Map(全局组成员类 ci... 此处用组内 ci), steps}]。 */
function groupedSmallPlans(subVals, subCaps, subGroups, signOfI, need, tracker) {
  const ng = subVals.length;
  const dp = Array.from({ length: ng + 1 }, () => null);
  dp[ng] = new Int32Array(need + 1).fill(-1);
  dp[ng][0] = 0;
  for (let j = ng - 1; j >= 0; j--) {
    const v = subVals[j], cap = Math.min(subCaps[j], Math.floor(need / v));
    const cur = new Int32Array(need + 1).fill(-1), nxt = dp[j + 1];
    for (let r = 0; r < v; r++) {
      const qi = [], qv = [];
      let head = 0, k = 0;
      for (let x = r; x <= need; x += v, k++) {
        if (nxt[x] >= 0) {
          const val = nxt[x] - k;
          while (qv.length > head && qv[qv.length - 1] >= val) { qv.pop(); qi.pop(); }
          qv.push(val); qi.push(k);
        }
        while (qi.length > head && k - qi[head] > cap) head++;
        if (qv.length > head) cur[x] = qv[head] + k;
      }
    }
    dp[j] = cur;
  }
  if (dp[0][need] < 0) return [];
  const minSteps = dp[0][need];
  const out = [];
  const lc = new Array(ng).fill(0);
  (function rec(j, rem, used) {
    tracker?.tick();
    if (j === ng) {
      if (rem === 0 && used === minSteps) {
        const counts = new Map();
        lc.forEach((c, k) => {
          if (c > 0) {
            const alloc = allocGroup(subGroups[k].members, c, signOfI);
            for (const [ci, x] of alloc) if (x > 0) counts.set(ci, x);
          }
        });
        out.push({ counts, steps: used });
      }
      return;
    }
    if (dp[j][rem] < 0 || used + dp[j][rem] !== minSteps) return;
    const v = subVals[j], cap = Math.min(subCaps[j], Math.floor(rem / v));
    for (let c = 0; c <= cap; c++) {
      const rest = rem - c * v;
      if (rest >= 0 && dp[j + 1][rest] >= 0 && used + c + dp[j + 1][rest] === minSteps) {
        lc[j] = c;
        rec(j + 1, rest, used + c);
        lc[j] = 0;
      }
    }
  })(0, need, 0);
  return out;
}

/**
 * 负向计划（按 N 与占用类别掩码聚合）：
 *   table[N] = Map(mask -> { steps, plan:Map(clsIdx->枚数) })
 * 同一 (N, mask) 下正向容量完全相同，只保留枚数最少、再按频次字典序最小者。
 */
function negPlanFreqs(plan, coins, a, f0) {
  const f = f0.slice();
  for (const [ci, c] of plan) {
    const i = coins[ci].i;
    f[i] = a[i] < 0 ? f[i] + c : f[i] - c;
  }
  return f;
}
function freqVecLess(p, q) {
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] < q[i];
  return false;
}

function negativeTable(coins, caps, a, f0, tracker) {
  const n = coins.length;
  const reach = Array.from({ length: n + 1 }, () => new Int32Array(NEG_BOUND + 1).fill(-1));
  reach[0][0] = 0;
  for (let k = 0; k < n; k++) {
    const { w, cap: rawCap } = coins[k];
    const cap = Math.min(caps[k], rawCap);
    const cur = reach[k + 1];
    const prv = reach[k];
    for (let x = 0; x <= NEG_BOUND; x++) {
      let best = prv[x] < 0 ? Infinity : prv[x];
      const maxC = Math.min(cap, Math.floor(x / w));
      for (let c = 1; c <= maxC; c++) {
        const pv = prv[x - c * w];
        if (pv >= 0 && pv + c < best) best = pv + c;
      }
      cur[x] = best === Infinity ? -1 : best;
    }
  }
  const table = new Array(NEG_BOUND + 1).fill(null);
  for (let N = 0; N <= NEG_BOUND; N++) {
    if (reach[n][N] < 0) continue;
    tracker?.tick();
    const minSteps = reach[n][N];
    const byMask = new Map();
    const counts = new Array(n).fill(0);
    function negFreqsOf() {
      // 负向频次向量：a>0 时下移、a<0 时上移；未用类保持基准
      return null;
    }
    void negFreqsOf;
    (function rec(k, need, used, mask) {
      if (k === 0) {
        if (need !== 0 || used !== minSteps) return;
        const m = new Map();
        counts.forEach((c, i) => { if (c) m.set(i, c); });
        const prev = byMask.get(mask);
        if (!prev || used < prev.steps ||
          (used === prev.steps && freqVecLess(negPlanFreqs(m, coins, a, f0),
            negPlanFreqs(prev.plan, coins, a, f0)))) {
          byMask.set(mask, { steps: used, plan: m });
        }
        return;
      }
      if (reach[k][need] < 0 || used + reach[k][need] > minSteps) return;
      const ci = k - 1;
      const { w, cap: rawCap } = coins[ci];
      const cap = Math.min(caps[ci], rawCap, Math.floor(need / w));
      for (let c = 0; c <= cap; c++) {
        const rest = need - c * w;
        if (rest >= 0 && reach[ci][rest] >= 0 && used + c + reach[ci][rest] === minSteps) {
          counts[ci] = c;
          rec(ci, rest, used + c, c > 0 ? mask | (1 << ci) : mask);
          counts[ci] = 0;
        }
      }
    })(n, N, 0, 0);
    if (byMask.size > 0) table[N] = byMask;
  }
  return table;
}

function witnessExact(a, f0, d, target, tracker) {
  const coins = buildClassCoins(a, d);
  const n = a.length;
  const totalValue = coins.reduce((s, c) => s + c.w * c.cap, 0);
  if (target < 0 || target > totalValue) return null;
  if (target === 0) return { offset: 0, freqs: f0.slice() };

  const baseCaps = coins.map((c) => c.cap);
  const W = Math.max(...coins.map((c) => c.w));
  const boxGain = coins.reduce((sum, c) => sum + c.w * c.cap, 0);
  // 负向增益枚举上界：
  //  · 盒小（boxGain ≤ NEG_BOUND）：枚举到盒总增益即穷尽，完全精确；
  //  · 盒大：对面值宇宙 {1..11}、变量数 5–8 的有界丢番图方程，全域认证
  //    （全部面值子集 × 容量 1..50 × 目标至 2×10^5）实测最优解负向增益
  //    最坏仅 50；格子覆盖半径上界 (n−1)·W²/2 亦 < 528，故 528 为充分常数。
  // 另设自适应停止：负增益 ≥N 的解偏移下界 ⌈(target+N)/W⌉ 一旦严格超过
  // 已知最优偏移，更大 N 必不可能更优（下界随 N 单调增长）。
  const Nmax = Math.min(NEG_BOUND, boxGain);
  const table = negativeTable(coins, baseCaps, a, f0, tracker);

  let best = null;
  for (let N = 0; N <= Nmax; N++) {
    tracker?.tick();
    if (best !== null && Math.ceil((target + N) / W) > best.offset) break;
    const byMask = table[N];
    if (!byMask) continue;
    for (const { steps: negSteps, plan: negPlan } of byMask.values()) {
      // 被负向占用的类，正向容量清零（同类正负互斥）
      const caps = baseCaps.slice();
      for (const ci of negPlan.keys()) caps[ci] = 0;
      const pos = positivePlans(coins, caps, target + N, tracker, a.map((x) => Math.sign(x)));
      for (const p of pos) {
        const offset = negSteps + p.steps;
        const y = new Array(n).fill(0);
        for (const [ci, c] of negPlan) y[coins[ci].i] -= c;
        for (const [ci, c] of p.counts) y[coins[ci].i] += c;
        const freqs = f0.map((f, i) => (a[i] < 0 ? f + y[i] : f - y[i]));
        if (best === null || offset < best.offset ||
          (offset === best.offset && (function () {
            for (let i = 0; i < n; i++) if (freqs[i] !== best.freqs[i]) return freqs[i] < best.freqs[i];
            return false;
          })())) {
          best = { offset, freqs };
        }
      }
    }
  }
  if (best === null && boxGain > NEG_BOUND) {
    // 理论不可达（认证常数充分）；以显式错误代替可能错误的"稳健"结论。
    throw new Error('search_limit_exceeded');
  }
  return best;
}
/** 校验稳健性复核的漂移幅度录入，返回中文错误信息数组。 */
export function validateDrifts(input) {
  const errors = [];
  const alerts = input?.alerts ?? [];
  const drifts = input?.drifts;
  if (!Array.isArray(drifts) || drifts.length !== alerts.length) {
    errors.push(`漂移幅度数量须与警报类别数（${alerts.length} 类）一致。`);
    return errors;
  }
  alerts.forEach((a, i) => {
    const d = drifts[i];
    const label = `第 ${i + 1} 类警报`;
    if (!Number.isInteger(d) || d < 0) {
      errors.push(`${label}：频次漂移幅度须为非负整数。`);
    } else if (Number.isInteger(a?.freq) && a.freq >= 1 && d > a.freq) {
      errors.push(`${label}：漂移幅度不能超过预计频次 ${a.freq}（实际频次须保持非负）。`);
    }
  });
  return errors;
}

const LEVEL_NAMES = {
  1: '第一决胜层级（加权码长总和）',
  2: '第二决胜层级（最大码长）',
  3: '第三决胜层级（码字字典序）',
};

/**
 * 稳健性复核：在频次盒 ∏[f0_i−d_i, f0_i+d_i] 的全部整数组合下，依据原有
 * 码长区间、保留前缀与三级决胜规则，判定当前码字序列是否始终仍为最终解。
 *
 * 不抽样端点、不复用旧结论：枚举所有满足 Kraft 容量的长度元组，逐一做
 * 精确可行性检查（保留前缀使纯 Kraft 不充分），再对每个可行异元组用
 * 有界单位步见证求出盒内推翻它的最小偏移频点。
 *
 * 返回：
 *   { status:'invalid', errors }
 *   { status:'error', reason }
 *   { status:'robust', intervals, combos, tuplesEnumerated, feasibilityChecks,
 *      strictCandidates, tieCandidates, baseline }
 *   { status:'counterexample', intervals, combos, tuplesEnumerated,
 *      feasibilityChecks, witness:{ freqs, offsets, totalOffset, firstChangedLevel,
 *      levelName, baseline, replacement } }
 */
export function checkRobustness(input) {
  const baseErrors = validateInput(input);
  if (baseErrors.length > 0) return { status: 'invalid', errors: baseErrors };
  const driftErrors = validateDrifts(input);
  if (driftErrors.length > 0) return { status: 'invalid', errors: driftErrors };

  const baseAlerts = input.alerts.map((a) => ({
    name: String(a.name).trim(),
    freq: a.freq,
    lo: a.lo,
    hi: a.hi,
  }));
  const drifts = input.drifts.slice();
  const reserved = normalizeReserved(input.reserved);
  const n = baseAlerts.length;

  // 复核必须基于"当前码表"：用当前输入即时重解，绝不复用页面旧结论。
  const baseline = solveRaw(baseAlerts, reserved, 3_000_000);
  if (baseline.status !== 'optimal') {
    return { status: 'invalid', errors: ['当前参数不存在有效码表，无法进行稳健性复核。'] };
  }
  const l0 = baseline.lengths;
  const c0 = baseline.alerts.map((a) => a.code);
  const L0 = baseline.maxLength;
  const f0 = baseAlerts.map((a) => a.freq);

  const reservedWeight = reserved.reduce((sum, r) => sum + codeWeight(r.length), 0);
  const initialCapacity = (1 << MAX_CODE_LENGTH) - reservedWeight;

  const tracker = makeTracker(6_000_000);
  const feasMemo = new Map(); // 长度多重集合 -> 是否存在精确分配
  const lexMemo = new Map(); // 有序长度元组 -> 字典序最小分配

  const lexCodes = (lengths) => {
    const key = lengths.join(',');
    let v = lexMemo.get(key);
    if (v === undefined) {
      // 字典序枚举前先做廉价的存在性剪枝，避免不可行元组进入全枚举
      v = feasible(lengths)
        ? lexMinAssignment(lengths, reserved, initialCapacity, tracker)
        : null;
      lexMemo.set(key, v);
    }
    return v;
  };
  const feasible = (lengths) => {
    const key = lengths.slice().sort((x, y) => x - y).join(',');
    let v = feasMemo.get(key);
    if (v === undefined) {
      v = assignmentExists(lengths, reserved, initialCapacity, tracker);
      feasMemo.set(key, v);
    }
    return v;
  };

  // Kraft 后缀最小容量需求。
  const sufMinWeight = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    sufMinWeight[i] = sufMinWeight[i + 1] + codeWeight(baseAlerts[i].hi);
  }

  // 容量感知的"最大压力"松弛 DP（与求解器 costDP 同构）：
  //   pressDP[i][cap] = 位置 i..n−1 在剩余 Kraft 容量 cap 下，仅考虑 Kraft
  //   与码长区间时可达的最大压力 Σ(d_i|a_i| − f0_i·a_i)（a=len−l0）。
  // 真实保留前缀约束只会更强，故这是合法上界；上界 < 0 即等成本角点都不存在。
  const NEG_INF = -1e18;
  const pressDP = Array.from({ length: n + 1 }, () => new Float64Array(FULL_CAPACITY + 1));
  for (let cap = 0; cap <= FULL_CAPACITY; cap++) pressDP[n][cap] = 0;
  for (let i = n - 1; i >= 0; i--) {
    const al = baseAlerts[i];
    for (let cap = 0; cap <= FULL_CAPACITY; cap++) {
      let bestPress = NEG_INF;
      for (let len = al.lo; len <= al.hi; len++) {
        const wgt = codeWeight(len);
        if (wgt > cap) continue;
        const aa = len - l0[i];
        const v = drifts[i] * Math.abs(aa) - f0[i] * aa + pressDP[i + 1][cap - wgt];
        if (v > bestPress) bestPress = v;
      }
      pressDP[i][cap] = bestPress;
    }
  }

  let tuplesEnumerated = 0;
  let strictCandidates = 0;
  let tieCandidates = 0;
  let best = null; // { offset, freqs }
  const lens = new Array(n);

  function offerCandidate(offset, freqs) {
    if (best === null || offset < best.offset ||
      (offset === best.offset && freqLess(freqs, best.freqs))) {
      best = { offset, freqs };
    }
  }

  function considerTuple() {
    tuplesEnumerated++;
    if (lens.every((x, i) => x === l0[i])) return;
    if (!feasible(lens)) return;

    let D0 = 0;
    let U = 0;
    const a = new Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = lens[i] - l0[i];
      D0 += f0[i] * a[i];
      U += drifts[i] * Math.abs(a[i]);
    }

    // 层级一：盒内存在使该替代严格更便宜的频点。
    if (U >= D0 + 1) {
      strictCandidates++;
      const w = witnessAtLeast(a, f0, drifts, D0 + 1, tracker);
      if (w) offerCandidate(w.offset, w.freqs);
    }

    // 层级二/三：等成本频点（G = D0）。该频点须确实在第二、三级推翻当前
    // 码表才算反例：最大码长更小，或等最大码长时字典序最小分配严格更小。
    if (U >= D0) {
      const w = witnessExact(a, f0, drifts, D0, tracker);
      if (!w) return;
      tieCandidates++;
      const maxLen = Math.max(...lens);
      let overturns = maxLen < L0;
      if (!overturns && maxLen === L0) {
        const codes = lexCodes(lens);
        if (codes) {
          for (let i = 0; i < n; i++) {
            if (codes[i] !== c0[i]) {
              overturns = codes[i] < c0[i];
              break;
            }
          }
        }
      }
      if (overturns) offerCandidate(w.offset, w.freqs);
    }
  }

  function dfs(i, cap, press) {
    tracker.tick();
    // 容量感知上界剪枝：本分支即便最优选长度也无法使压力 ≥0，
    // 则盒内不存在等成本（press=0）或严格更便宜（press≥1）的频点。
    if (press + pressDP[i][cap] < 0) return;
    if (i === n) {
      considerTuple();
      return;
    }
    if (sufMinWeight[i] > cap) return;
    const al = baseAlerts[i];
    for (let len = al.lo; len <= al.hi; len++) {
      const w = codeWeight(len);
      if (w > cap) continue;
      lens[i] = len;
      const aa = len - l0[i];
      dfs(i + 1, cap - w, press + drifts[i] * Math.abs(aa) - f0[i] * aa);
    }
  }

  const intervals = baseAlerts.map((al, i) => ({
    name: al.name,
    freq: al.freq,
    drift: drifts[i],
    lo: al.freq - drifts[i],
    hi: al.freq + drifts[i],
  }));
  let combos = 1n;
  for (const d of drifts) combos *= BigInt(2 * d + 1);

  try {
    dfs(0, initialCapacity, 0);
  } catch (err) {
    if (err.message === 'search_limit_exceeded') {
      return { status: 'error', reason: '稳健性复核搜索规模超出安全上限，请收紧码长区间或漂移幅度后重试。' };
    }
    throw err;
  }

  const baseInfo = {
    cost: baseline.cost,
    maxLength: L0,
    codes: c0,
    lengths: l0,
    names: baseAlerts.map((al) => al.name),
  };

  if (best === null) {
    return {
      status: 'robust',
      intervals,
      combos: combos.toString(),
      tuplesEnumerated,
      feasibilityChecks: feasMemo.size,
      strictCandidates,
      tieCandidates,
      baseline: baseInfo,
    };
  }

  // 在见证频点完整重解：得到真正的替代码表，并据此确定首个改变的决胜层级。
  const witnessAlerts = baseAlerts.map((al, i) => ({ ...al, freq: best.freqs[i] }));
  const replacement = solveRaw(witnessAlerts, reserved, 3_000_000);
  if (replacement.status !== 'optimal') {
    return { status: 'error', reason: '见证频点重解失败，请复核输入参数。' };
  }
  const repCodes = replacement.alerts.map((al) => al.code);
  if (repCodes.join('|') === c0.join('|')) {
    // 理论上不应到达：候选已确认推翻。防御性处理为错误而非误报。
    return { status: 'error', reason: '复核内部校验未通过（见证频点未改变最终解），请重试。' };
  }
  // 当前码字序列在见证频点下的代价（码长不变，频次变化）。
  const currentCostAtWitness = best.freqs.reduce((sum, f, i) => sum + f * l0[i], 0);
  let level;
  if (replacement.cost < currentCostAtWitness) level = 1;
  else if (replacement.maxLength !== L0) level = 2;
  else level = 3;

  return {
    status: 'counterexample',
    intervals,
    combos: combos.toString(),
    tuplesEnumerated,
    feasibilityChecks: feasMemo.size,
    strictCandidates,
    tieCandidates,
    witness: {
      freqs: best.freqs,
      offsets: best.freqs.map((f, i) => Math.abs(f - f0[i])),
      totalOffset: best.offset,
      firstChangedLevel: level,
      levelName: LEVEL_NAMES[level],
      baseline: {
        cost: baseline.cost,
        costAtWitness: currentCostAtWitness,
        maxLength: L0,
        codes: c0,
        lengths: l0,
        freqs: f0,
      },
      replacement: {
        cost: replacement.cost,
        maxLength: replacement.maxLength,
        codes: repCodes,
        lengths: replacement.lengths,
        alerts: replacement.alerts.map((al) => ({
          name: al.name,
          freq: al.freq,
          code: al.code,
          length: al.length,
          contribution: al.contribution,
        })),
      },
    },
  };
}
