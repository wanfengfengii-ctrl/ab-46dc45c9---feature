import {
  solve,
  checkRobustness,
  MIN_ALERTS,
  MAX_ALERTS,
  MAX_RESERVED,
  MAX_CODE_LENGTH,
} from './solver.js';
import { buildTreeLayout } from './tree.js';

const SAMPLE = {
  alerts: [
    { name: '特大地震预警', freq: '3', lo: '2', hi: '6' },
    { name: '强余震警报', freq: '8', lo: '2', hi: '5' },
    { name: '海啸警报', freq: '5', lo: '2', hi: '5' },
    { name: '滑坡泥石流警报', freq: '12', lo: '1', hi: '4' },
    { name: '应急演练通知', freq: '20', lo: '1', hi: '3' },
    { name: '解除警报', freq: '15', lo: '1', hi: '4' },
  ],
  reserved: ['1110'],
};

const EMPTY_ALERT = () => ({ name: '', freq: '', lo: '', hi: '' });

const state = {
  alerts: structuredClone(SAMPLE.alerts),
  reserved: [...SAMPLE.reserved],
};

// 当前有效码表（生成码表成功后写入）及其稳健性复核结论。
// 频次/码长/保留前缀/警报顺序任何变动都会立即清空二者。
let currentSolution = null;
let robustness = null; // checkRobustness 的原始返回

const $ = (sel) => document.querySelector(sel);
const alertRowsEl = $('#alert-rows');
const reservedRowsEl = $('#reserved-rows');
const errorsEl = $('#errors');
const resultsEl = $('#results');
const robustnessPanelEl = $('#robustness-panel');
const driftRowsEl = $('#drift-rows');
const robustResultEl = $('#robust-result');

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ---------------- 输入区渲染 ---------------- */

function renderAlertRows() {
  const canRemove = state.alerts.length > MIN_ALERTS;
  const rows = state.alerts
    .map(
      (a, i) => `
      <tr>
        <td class="idx">${i + 1}</td>
        <td><input type="text" data-idx="${i}" data-field="name" value="${esc(a.name)}"
             placeholder="警报名称" maxlength="24"></td>
        <td><input type="number" data-idx="${i}" data-field="freq" value="${esc(a.freq)}"
             min="1" step="1" placeholder="正整数"></td>
        <td><input type="number" data-idx="${i}" data-field="lo" value="${esc(a.lo)}"
             min="1" max="${MAX_CODE_LENGTH}" step="1"></td>
        <td><input type="number" data-idx="${i}" data-field="hi" value="${esc(a.hi)}"
             min="1" max="${MAX_CODE_LENGTH}" step="1"></td>
        <td><button type="button" class="btn small danger" data-remove-alert="${i}"
             ${canRemove ? '' : 'disabled'} title="删除此类别">删除</button></td>
      </tr>`,
    )
    .join('');
  alertRowsEl.innerHTML = `
    <table class="grid">
      <thead>
        <tr>
          <th>#</th><th>警报名称</th><th>预计发送频次</th>
          <th>码长下限</th><th>码长上限</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  $('#add-alert').disabled = state.alerts.length >= MAX_ALERTS;
  $('#alert-count').textContent = `${state.alerts.length} / ${MAX_ALERTS} 类（至少 ${MIN_ALERTS} 类）`;
}

function renderReservedRows() {
  reservedRowsEl.innerHTML =
    state.reserved.length === 0
      ? '<p class="hint">暂无保留前缀，可添加 0–3 条。</p>'
      : state.reserved
          .map(
            (r, i) => `
        <div class="reserved-row">
          <span class="idx">#${i + 1}</span>
          <input type="text" data-reserved-idx="${i}" value="${esc(r)}"
                 placeholder="如 0110（1–${MAX_CODE_LENGTH} 位 0/1）" pattern="[01]+" spellcheck="false">
          <button type="button" class="btn small danger" data-remove-reserved="${i}">删除</button>
        </div>`,
          )
          .join('');
  $('#add-reserved').disabled = state.reserved.length >= MAX_RESERVED;
}

function renderForm() {
  renderAlertRows();
  renderReservedRows();
}

/* ---------------- 结论失效 ---------------- */

function invalidateResults(message = '输入已变更，旧结论已失效，请重新生成码表。') {
  resultsEl.innerHTML = `<p class="placeholder stale">${esc(message)}</p>`;
  // 码表失效时，漂移录入与稳健性结论一并失效
  currentSolution = null;
  robustness = null;
  robustnessPanelEl.hidden = true;
  robustResultEl.innerHTML = '';
}

/** 仅使稳健性结论失效（码表仍然有效，例如修改漂移幅度时）。 */
function invalidateRobustness(message = '漂移幅度已变更，请重新发起稳健性复核。') {
  robustness = null;
  robustResultEl.innerHTML = `<p class="placeholder stale">${esc(message)}</p>`;
}

function clearErrors() {
  errorsEl.hidden = true;
  errorsEl.innerHTML = '';
}

function showErrors(errors) {
  errorsEl.hidden = false;
  errorsEl.innerHTML = `<strong>参数未通过校验：</strong><ul>${
    errors.map((e) => `<li>${esc(e)}</li>`).join('')
  }</ul>`;
}

/* ---------------- 结果区渲染 ---------------- */

function renderBanner(result) {
  if (result.status === 'optimal') {
    return `<div class="banner ok">✓ 已找到最优码表：总加权码长 <b>${result.cost}</b>，最大码长 <b>${result.maxLength}</b>。</div>`;
  }
  if (result.status === 'error') {
    return `<div class="banner fail">✗ 求解中断。<p>${esc(result.reason ?? '')}</p></div>`;
  }
  const reason = result.reason ? `<p>${esc(result.reason)}</p>` : '';
  return `<div class="banner fail">✗ 没有可用的完整分配。${reason}</div>`;
}

function renderStats(result) {
  const { kraft } = result;
  return `
    <div class="stats">
      <div class="stat"><span class="stat-label">总加权码长（总成本）</span><span class="stat-value">${result.cost}</span></div>
      <div class="stat"><span class="stat-label">最大码长</span><span class="stat-value">${result.maxLength}</span></div>
      <div class="stat"><span class="stat-label">码字占用码空间</span><span class="stat-value">${kraft.codes} / ${kraft.unit}</span></div>
      <div class="stat"><span class="stat-label">保留分支占用</span><span class="stat-value">${kraft.reserved} / ${kraft.unit}</span></div>
      <div class="stat"><span class="stat-label">剩余空闲</span><span class="stat-value">${kraft.free} / ${kraft.unit}</span></div>
    </div>`;
}

function renderDetailTable(result) {
  const rows = result.alerts
    .map(
      (a, i) => `
      <tr>
        <td class="idx">${i + 1}</td>
        <td>${esc(a.name)}</td>
        <td><code class="code">${esc(a.code)}</code></td>
        <td>${a.length}</td>
        <td>${a.freq}</td>
        <td>${a.freq} × ${a.length} = <b>${a.contribution}</b></td>
      </tr>`,
    )
    .join('');
  return `
    <h3>码字明细</h3>
    <table class="grid detail">
      <thead>
        <tr><th>#</th><th>警报</th><th>码字</th><th>码长</th><th>频次</th><th>加权贡献</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="5">总成本（加权码长总和）</td><td><b>${result.cost}</b></td></tr>
      </tfoot>
    </table>`;
}

function renderReserved(result) {
  if (!result.reserved || result.reserved.length === 0) {
    return '<h3>保留分支</h3><p class="hint">未设置保留前缀。</p>';
  }
  const rows = result.reserved
    .map(
      (r) => `
      <tr>
        <td><code class="code reserved">${esc(r.prefix)}</code></td>
        <td>${r.length}</td>
        <td>2<sup>-${r.length}</sup> = ${r.weight} / ${result.kraft.unit}</td>
        <td>该前缀的子树整体封禁，码字既不落入也不遮蔽</td>
      </tr>`,
    )
    .join('');
  return `
    <h3>保留分支</h3>
    <table class="grid detail">
      <thead><tr><th>保留前缀</th><th>长度</th><th>占用码空间</th><th>约束</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function truncate(s, n = 6) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function renderTree(result) {
  const { nodes, edges, width, height } = buildTreeLayout(
    result.alerts.map((a) => ({ code: a.code, name: a.name })),
    result.reserved ?? [],
  );

  const edgeSvg = edges
    .map((e) => {
      const mx = (e.from.cx + e.to.cx) / 2;
      const my = (e.from.cy + e.to.cy) / 2;
      return `
        <line x1="${e.from.cx}" y1="${e.from.cy}" x2="${e.to.cx}" y2="${e.to.cy}" class="edge"/>
        <text x="${mx}" y="${my - 3}" class="edge-bit">${e.bit}</text>`;
    })
    .join('');

  const nodeSvg = nodes
    .map((n) => {
      if (n.type === 'dot') {
        return `<circle cx="${n.cx}" cy="${n.cy}" r="2.6" class="dot"><title>未使用的子树</title></circle>`;
      }
      if (n.type === 'code') {
        return `
          <g class="node code-node">
            <circle cx="${n.cx}" cy="${n.cy}" r="11"><title>${esc(n.label)}：${esc(n.prefix)}</title></circle>
            <text x="${n.cx}" y="${n.cy + 26}" class="node-label">${esc(truncate(n.label))}</text>
            <text x="${n.cx}" y="${n.cy + 40}" class="node-code">${esc(n.prefix)}</text>
          </g>`;
      }
      if (n.type === 'reserved') {
        return `
          <g class="node reserved-node">
            <circle cx="${n.cx}" cy="${n.cy}" r="11"><title>保留前缀：${esc(n.prefix)}</title></circle>
            <text x="${n.cx}" y="${n.cy + 26}" class="node-label">保留</text>
            <text x="${n.cx}" y="${n.cy + 40}" class="node-code">${esc(n.prefix)}</text>
          </g>`;
      }
      const label = n.type === 'root' ? '根' : '';
      return `
        <g class="node internal-node">
          <circle cx="${n.cx}" cy="${n.cy}" r="8"><title>前缀 ${n.prefix === '' ? 'ε（空）' : esc(n.prefix)}</title></circle>
          ${label ? `<text x="${n.cx}" y="${n.cy - 14}" class="node-label">${label}</text>` : ''}
        </g>`;
    })
    .join('');

  return `
    <h3>二叉码树</h3>
    <p class="hint">绿节点为已分配码字，红节点为保留分支，灰点为未使用的子树；边标注 0/1。</p>
    <div class="tree-wrap">
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
           role="img" aria-label="二叉码树">
        ${edgeSvg}${nodeSvg}
      </svg>
    </div>`;
}

function renderResult(result) {
  if (result.status === 'optimal') {
    resultsEl.innerHTML = `
      ${renderBanner(result)}
      ${renderStats(result)}
      ${renderTree(result)}
      ${renderDetailTable(result)}
      ${renderReserved(result)}
      <p class="hint">搜索节点数：${result.exploredNodes}。码字两两前缀无关，任意连续电文均可按前缀码唯一拆分。</p>`;
  } else {
    // infeasible / error：明确说明没有可用的完整分配
    const reservedInfo =
      result.reserved && result.reserved.length > 0
        ? `<p class="hint">当前保留前缀：${result.reserved
            .map((r) => `<code class="code reserved">${esc(typeof r === 'string' ? r : r.prefix)}</code>`)
            .join('、')}</p>`
        : '';
    resultsEl.innerHTML = `${renderBanner(result)}${reservedInfo}`;
  }
}

/* ---------------- 收集与求解 ---------------- */

function parseIntStrict(s) {
  const t = String(s).trim();
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

function collectInput() {
  return {
    alerts: state.alerts.map((a) => ({
      name: a.name.trim(),
      freq: parseIntStrict(a.freq),
      lo: parseIntStrict(a.lo),
      hi: parseIntStrict(a.hi),
    })),
    // 空白的保留前缀行视为未填写
    reserved: state.reserved.map((r) => r.trim()).filter((r) => r !== ''),
  };
}

function onSolve() {
  const collected = collectInput();
  const result = solve(collected);
  if (result.status === 'invalid') {
    showErrors(result.errors);
    invalidateResults('参数未通过校验，旧结论已清除。');
    return;
  }
  clearErrors();
  if (result.status === 'optimal') {
    renderResult(result);
    // 新有效码表：启用稳健性复核面板，并把码表与录入参数快照保存
    currentSolution = { result, input: collected };
    robustness = null;
    renderDriftRows(collected.alerts);
    robustnessPanelEl.hidden = false;
    robustResultEl.innerHTML = '<p class="hint">请填写每类的频次漂移幅度（0 表示不容许波动），然后发起复核。</p>';
  } else {
    // infeasible / error：没有有效码表，复核面板必须关闭
    renderResult(result);
    currentSolution = null;
    robustness = null;
    robustnessPanelEl.hidden = true;
    robustResultEl.innerHTML = '';
  }
}

/* ---------------- 稳健性复核 ---------------- */

function renderDriftRows(alerts) {
  driftRowsEl.innerHTML = `
    <table class="grid">
      <thead>
        <tr><th>#</th><th>警报</th><th>预计频次</th><th>允许区间</th><th>漂移幅度</th></tr>
      </thead>
      <tbody>
        ${alerts
          .map((a, i) => `
          <tr>
            <td class="idx">${i + 1}</td>
            <td>${esc(a.name)}</td>
            <td>${a.freq}</td>
            <td class="interval-cell" data-interval="${i}">
              <code class="code">[${a.freq}, ${a.freq}]</code>
            </td>
            <td><input type="number" data-drift-idx="${i}" value="0"
                 min="0" max="${a.freq}" step="1" class="drift-input"></td>
          </tr>`)
          .join('')}
      </tbody>
    </table>`;
}

function onRobustCheck() {
  if (!currentSolution) return;
  const inputs = driftRowsEl.querySelectorAll('input[data-drift-idx]');
  const drifts = [];
  const driftErrors = [];
  inputs.forEach((el) => {
    const i = Number(el.dataset.driftIdx);
    const t = String(el.value ?? '').trim();
    const d = /^\d+$/.test(t) ? Number(t) : NaN;
    const f = currentSolution.input.alerts[i].freq;
    if (!Number.isInteger(d) || d < 0) {
      driftErrors.push(`第 ${i + 1} 类警报：漂移幅度须为非负整数。`);
    } else if (d > f) {
      driftErrors.push(`第 ${i + 1} 类警报：漂移幅度不能超过预计频次 ${f}。`);
    }
    drifts[i] = d;
  });
  if (driftErrors.length > 0) {
    robustResultEl.innerHTML =
      `<div class="banner fail">✗ 漂移幅度未通过校验<ul>${driftErrors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    return;
  }
  const rr = checkRobustness({ ...currentSolution.input, drifts });
  robustness = rr;
  renderRobustness(rr);
}

function renderRobustness(r) {
  if (r.status === 'invalid') {
    robustResultEl.innerHTML =
      `<div class="banner fail">✗ 无法发起复核<ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    return;
  }
  if (r.status === 'error') {
    robustResultEl.innerHTML = `<div class="banner fail">✗ 复核中断。<p>${esc(r.reason)}</p></div>`;
    return;
  }
  const intervalRows = r.intervals
    .map((it, i) => `
      <tr>
        <td class="idx">${i + 1}</td>
        <td>${esc(it.name)}</td>
        <td>${it.freq}</td>
        <td><code class="code">[${it.lo}, ${it.hi}]</code></td>
        <td>±${it.drift}</td>
      </tr>`)
    .join('');
  const intervalTable = `
    <table class="grid detail">
      <thead><tr><th>#</th><th>警报</th><th>预计</th><th>允许频次闭区间</th><th>幅度</th></tr></thead>
      <tbody>${intervalRows}</tbody>
    </table>`;

  if (r.status === 'robust') {
    robustResultEl.innerHTML = `
      <div class="banner ok">
        ✓ 稳健证书：在 <b>${r.combos}</b> 个整数频次组合下，当前码表始终为最终解。
      </div>
      ${intervalTable}
      <ul class="cert">
        <li>逐一枚举满足 Kraft 容量的长度元组 <b>${r.tuplesEnumerated}</b> 个，
            其中精确可行性检查 <b>${r.feasibilityChecks}</b> 个不同长度多重集合；</li>
        <li>可能在第一层级（加权码长）推翻当前码表的候选 <b>${r.strictCandidates}</b> 个，
            需在等成本点比较第二、三级决胜的候选 <b>${r.tieCandidates}</b> 个；</li>
        <li>全部候选在盒内均无法推翻当前码字序列——现场频率在上述各闭区间内独立波动时，
            码表保持既有最优地位，无需重新编配。</li>
      </ul>`;
    return;
  }

  // counterexample：最小反例 + 替代码表 + 首个改变的决胜层级
  const w = r.witness;
  const witnessRows = w.replacement.alerts
    .map((a, i) => `
      <tr>
        <td class="idx">${i + 1}</td>
        <td>${esc(a.name)}</td>
        <td class="freq-cell">
          ${r.intervals[i].freq}
          <span class="${w.offsets[i] > 0 ? 'drift-badge' : ''}">
            ${w.offsets[i] > 0 ? `→ <b>${a.freq}</b>（偏移 ${a.freq - r.intervals[i].freq >= 0 ? '+' : ''}${a.freq - r.intervals[i].freq}）` : ''}
          </span>
        </td>
        <td><code class="code">${esc(w.baseline.codes[i])}</code></td>
        <td><code class="code alt">${esc(a.code)}</code></td>
        <td>${a.length}</td>
        <td>${a.freq} × ${a.length} = <b>${a.contribution}</b></td>
      </tr>`)
    .join('');
  robustResultEl.innerHTML = `
    <div class="banner fail">
      ✗ 找到足以推翻当前码表的最小反例：总偏移量 <b>${w.totalOffset}</b>，
      首个改变的决胜层级为 <b>${esc(w.levelName)}</b>。
    </div>
    ${intervalTable}
    <p class="hint">反例频次序列（总偏移最小，并列时按警报输入顺序取字典序最小）：
      <code class="code alt">[${w.freqs.join(', ')}]</code></p>
    <h3>替代码表（在反例频次下重新求解）</h3>
    <table class="grid detail">
      <thead>
        <tr><th>#</th><th>警报</th><th>实际频次</th><th>当前码字</th><th>替代码字</th><th>码长</th><th>加权贡献</th></tr>
      </thead>
      <tbody>${witnessRows}</tbody>
      <tfoot>
        <tr><td colspan="6">反例频次下替代码表总成本 / 当前码表成本</td>
        <td><b>${w.replacement.cost}</b> / ${w.baseline.costAtWitness ?? '—'}</td></tr>
      </tfoot>
    </table>
    <p class="hint">
      共枚举长度元组 ${r.tuplesEnumerated} 个（精确可行性检查 ${r.feasibilityChecks} 个）；
      按此反例频次重新编配即可得到该频点下的最优码表。
    </p>`;
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#solve').addEventListener('click', onSolve);
  $('#robust-check').addEventListener('click', onRobustCheck);

  // 漂移幅度输入：仅使稳健性结论失效（码表仍然有效），并联动更新允许区间
  robustnessPanelEl.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || t.dataset.driftIdx === undefined) return;
    invalidateRobustness();
    if (currentSolution) {
      const i = Number(t.dataset.driftIdx);
      const f = currentSolution.input.alerts[i].freq;
      const d = /^\d+$/.test(String(t.value).trim()) ? Number(t.value) : NaN;
      const cell = driftRowsEl.querySelector?.(`[data-interval="${i}"] code`);
      if (cell && Number.isInteger(d) && d >= 0 && d <= f) {
        cell.textContent = `[${f - d}, ${f + d}]`;
      }
    }
  });

  $('#add-alert').addEventListener('click', () => {
    if (state.alerts.length >= MAX_ALERTS) return;
    state.alerts.push(EMPTY_ALERT());
    renderAlertRows();
    invalidateResults();
  });
  $('#add-reserved').addEventListener('click', () => {
    if (state.reserved.length >= MAX_RESERVED) return;
    state.reserved.push('');
    renderReservedRows();
    invalidateResults();
  });
  $('#load-sample').addEventListener('click', () => {
    state.alerts = structuredClone(SAMPLE.alerts);
    state.reserved = [...SAMPLE.reserved];
    renderForm();
    clearErrors();
    invalidateResults('已载入示例参数，请点击「生成码表」。');
  });
  $('#reset').addEventListener('click', () => {
    state.alerts = Array.from({ length: MIN_ALERTS }, EMPTY_ALERT);
    state.reserved = [];
    renderForm();
    clearErrors();
    invalidateResults('已清空，请录入参数后生成码表。');
  });

  // 任何输入变动都会使旧结论失效
  $('#input-panel').addEventListener('input', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.dataset.idx !== undefined && t.dataset.field) {
      state.alerts[Number(t.dataset.idx)][t.dataset.field] = t.value;
    } else if (t.dataset.reservedIdx !== undefined) {
      state.reserved[Number(t.dataset.reservedIdx)] = t.value;
    }
    invalidateResults();
  });

  $('#input-panel').addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.removeAlert !== undefined) {
      state.alerts.splice(Number(t.dataset.removeAlert), 1);
      renderAlertRows();
      invalidateResults();
    } else if (t.dataset.removeReserved !== undefined) {
      state.reserved.splice(Number(t.dataset.removeReserved), 1);
      renderReservedRows();
      invalidateResults();
    }
  });
}

renderForm();
bindEvents();
invalidateResults('配置左侧参数后，点击「生成码表」。');
