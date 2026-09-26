import {
  solve,
  reviewRobustness,
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
  drifts: SAMPLE.alerts.map(() => '0'), // 每类频次漂移幅度（字符串草稿）
  lastInput: null, // 生成当前码表所用的有效录入（数字）
  lastResult: null, // 当前码表求解结果
  review: null, // 最近一次稳健性复核结果
};

const $ = (sel) => document.querySelector(sel);
const alertRowsEl = $('#alert-rows');
const reservedRowsEl = $('#reserved-rows');
const errorsEl = $('#errors');
const resultsEl = $('#results');

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
        <td><input type="number" class="drift-input" data-drift-idx="${i}" value="${esc(state.drifts[i] ?? '0')}"
             min="0" step="1" title="该类实际频次相对预计值允许的独立波动幅度（0–预计频次）"></td>
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
          <th>码长下限</th><th>码长上限</th><th>频次漂移幅度</th><th></th>
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
  state.lastInput = null;
  state.lastResult = null;
  state.review = null;
  resultsEl.innerHTML = `<p class="placeholder stale">${esc(message)}</p>`;
}

/** 仅使稳健性结论失效（频次漂移幅度调整不影响已生成的码表本身）。 */
function invalidateReview(message = '漂移幅度已变更，稳健性结论已失效，请重新发起复核。') {
  state.review = null;
  if (state.lastResult) renderResult(state.lastResult, null, message);
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

function renderReviewPanel(review, note) {
  const body = renderReviewResult(review, note);
  return `
    <h3>③ 稳健性复核</h3>
    <p class="hint">
      为每类警报在左侧填写非负整数“频次漂移幅度”（不超过其预计频次），发起复核后将穷举
      各类实际频次独立落入 <code class="code">预计−幅度 … 预计+幅度</code> 闭区间的
      <b>全部整数组合</b>，沿用原码长区间、保留前缀与三级决胜规则重新判定当前码表是否始终为最终解
      （逐元组解析求极，非端点抽样）。
    </p>
    <div class="row-actions">
      <button type="button" id="review" class="btn primary review-btn">发起稳健性复核</button>
    </div>
    <div id="review-result">${body}</div>`;
}

function renderReviewResult(review, note = '') {
  if (review?.status === 'invalid') {
    return `<div class="banner fail">复核参数无效：<ul>${
      review.errors.map((e) => `<li>${esc(e)}</li>`).join('')
    }</ul></div>`;
  }
  if (review?.status === 'notoptimal') {
    return `<div class="banner fail">当前参数下没有可用的最优码表，无法复核。${
      review.reason ? `<p>${esc(review.reason)}</p>` : ''
    }</div>`;
  }
  if (review?.status === 'error') {
    return `<div class="banner fail">复核未能完成。<p>${esc(review.reason ?? '')}</p></div>`;
  }
  if (review?.status === 'stable') {
    const rows = review.intervals
      .map(
        (it) => `
        <tr>
          <td>${esc(it.name)}</td>
          <td>${it.expected}</td>
          <td>±${it.drift}</td>
          <td><code class="code">[${it.low}, ${it.high}]</code></td>
        </tr>`,
      )
      .join('');
    return `
      <div class="banner ok">✓ 稳健：在全部 ${review.intervals.length} 类频次独立波动的整数盒内，
        当前码字序列<b>始终</b>是三级决胜下的最终解，现场频率波动不会动摇其最优地位。</div>
      <h4>各类允许的实际频次区间</h4>
      <table class="grid detail">
        <thead><tr><th>警报</th><th>预计频次</th><th>漂移幅度</th><th>允许闭区间</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="hint">稳健证书：已解析核查全部可达的可行码长元组
        （${review.certificate.feasibleTuples} 个通过容量/保留约束的元组，搜索判定节点
        ${review.exploredNodes} 个）；任一元组在盒内的最小加权代价差恒为正，或打平但在后两级决胜中落败。</p>`;
  }
  if (review?.status === 'counterexample') {
    const levelText = {
      1: '一级决胜：加权码长总和',
      2: '二级决胜：最大码长',
      3: '三级决胜：按输入顺序的码字字典序',
    }[review.level];
    const freqRows = review.freqs
      .map(
        (f) => `
        <tr>
          <td>${esc(f.name)}</td>
          <td>${f.expected}</td>
          <td>${f.actual}</td>
          <td class="${f.offset === 0 ? '' : f.offset > 0 ? 'offset-up' : 'offset-down'}">${
            f.offset > 0 ? '+' : ''
          }${f.offset}</td>
        </tr>`,
      )
      .join('');
    const altRows = review.result.alerts
      .map(
        (a, i) => `
        <tr>
          <td class="idx">${i + 1}</td>
          <td>${esc(a.name)}</td>
          <td><code class="code alt">${esc(a.code)}</code></td>
          <td>${a.length}</td>
          <td>${a.freq}</td>
          <td>${a.freq} × ${a.length} = <b>${a.contribution}</b></td>
        </tr>`,
      )
      .join('');
    const curCodes = review.currentCodes
      .map((c) => `<code class="code">${esc(c.code)}</code>`)
      .join(' ');
    return `
      <div class="banner fail">✗ 不稳健：存在推翻当前结论的实际频次组合。按<b>总偏移量最小</b>
        （${review.distance} 个单位）、再按警报输入顺序的实际频次序列字典序稳定返回的首个反例如下；
        首个改变的决胜层级为 <b>${levelText}</b>。</div>
      <h4>最小反例的实际频次序列（总偏移量 ${review.distance}）</h4>
      <table class="grid detail">
        <thead><tr><th>警报</th><th>预计频次</th><th>反例实际频次</th><th>偏移</th></tr></thead>
        <tbody>${freqRows}</tbody>
      </table>
      <div class="stats">
        <div class="stat"><span class="stat-label">当前码表在该频次的总成本</span><span class="stat-value">${review.currentCostAtPoint}</span></div>
        <div class="stat"><span class="stat-label">替代码表总成本</span><span class="stat-value">${review.alternativeCost}</span></div>
        <div class="stat"><span class="stat-label">当前 / 替代 最大码长</span><span class="stat-value">${review.currentMaxLength} / ${review.alternativeMaxLength}</span></div>
      </div>
      <h4>替代码表（${levelText} 决胜下的最终解）</h4>
      <table class="grid detail">
        <thead><tr><th>#</th><th>警报</th><th>替代码字</th><th>码长</th><th>反例频次</th><th>加权贡献</th></tr></thead>
        <tbody>${altRows}</tbody>
        <tfoot><tr><td colspan="5">替代码表总成本</td><td><b>${review.alternativeCost}</b></td></tr></tfoot>
      </table>
      <p class="hint">当前码表码字：${curCodes}。可据此反例重新编配后再发起复核。搜索判定节点 ${review.exploredNodes} 个。</p>`;
  }
  return note
    ? `<p class="placeholder stale">${esc(note)}</p>`
    : '<p class="hint">码表生成后可在此发起稳健性复核。</p>';
}

function renderResult(result, review = null, reviewNote = '') {
  if (result.status === 'optimal') {
    resultsEl.innerHTML = `
      ${renderBanner(result)}
      ${renderStats(result)}
      ${renderTree(result)}
      ${renderDetailTable(result)}
      ${renderReserved(result)}
      ${renderReviewPanel(review, reviewNote)}
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
  const input = collectInput();
  const result = solve(input);
  if (result.status === 'invalid') {
    showErrors(result.errors);
    invalidateResults('参数未通过校验，旧结论已清除。');
    return;
  }
  clearErrors();
  state.lastInput = input;
  state.lastResult = result;
  state.review = null;
  renderResult(result, null, '新码表已生成，请重新发起稳健性复核。');
}

/* ---------------- 稳健性复核 ---------------- */

function collectDrifts() {
  return state.alerts.map((_, i) => parseIntStrict(state.drifts[i] ?? '0'));
}

function onReview() {
  if (!state.lastInput || state.lastResult?.status !== 'optimal') {
    invalidateResults('请先生成有效的最优码表，再发起稳健性复核。');
    return;
  }
  const review = reviewRobustness(state.lastInput, collectDrifts());
  state.review = review;
  renderResult(state.lastResult, review);
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#solve').addEventListener('click', onSolve);

  $('#add-alert').addEventListener('click', () => {
    if (state.alerts.length >= MAX_ALERTS) return;
    state.alerts.push(EMPTY_ALERT());
    state.drifts.push('0');
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
    state.drifts = SAMPLE.alerts.map(() => '0');
    renderForm();
    clearErrors();
    invalidateResults('已载入示例参数，请点击「生成码表」。');
  });
  $('#reset').addEventListener('click', () => {
    state.alerts = Array.from({ length: MIN_ALERTS }, EMPTY_ALERT);
    state.reserved = [];
    state.drifts = Array.from({ length: MIN_ALERTS }, () => '0');
    renderForm();
    clearErrors();
    invalidateResults('已清空，请录入参数后生成码表。');
  });

  // 任何输入变动都会使旧结论失效
  $('#input-panel').addEventListener('input', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.dataset.driftIdx !== undefined) {
      // 漂移幅度只影响稳健性结论，不影响已生成码表
      state.drifts[Number(t.dataset.driftIdx)] = t.value;
      invalidateReview();
    } else if (t.dataset.idx !== undefined && t.dataset.field) {
      state.alerts[Number(t.dataset.idx)][t.dataset.field] = t.value;
      invalidateResults();
    } else if (t.dataset.reservedIdx !== undefined) {
      state.reserved[Number(t.dataset.reservedIdx)] = t.value;
      invalidateResults();
    }
  });

  $('#input-panel').addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.removeAlert !== undefined) {
      const idx = Number(t.dataset.removeAlert);
      state.alerts.splice(idx, 1);
      state.drifts.splice(idx, 1);
      renderAlertRows();
      invalidateResults();
    } else if (t.dataset.removeReserved !== undefined) {
      state.reserved.splice(Number(t.dataset.removeReserved), 1);
      renderReservedRows();
      invalidateResults();
    }
  });

  // 复核按钮位于结果区内，用事件委托绑定
  resultsEl.addEventListener('click', (ev) => {
    if (ev.target.closest('#review')) onReview();
  });
}

renderForm();
bindEvents();
invalidateResults('配置左侧参数后，点击「生成码表」。');
