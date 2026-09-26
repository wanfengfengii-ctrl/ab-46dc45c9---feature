/**
 * UI 无头冒烟：用最小 DOM 桩加载 app.js，验证加载、求解渲染、
 * 结论失效、校验提示与增删行等交互逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeInputElement {
  constructor(dataset = {}, value = '') {
    this.dataset = dataset;
    this.value = value;
  }
}
globalThis.HTMLInputElement = FakeInputElement;

class StubElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  closest() {
    return null;
  }
}

const registry = new Map();
globalThis.document = {
  querySelector(sel) {
    if (!registry.has(sel)) registry.set(sel, new StubElement(sel));
    return registry.get(sel);
  },
};
const $ = (sel) => document.querySelector(sel);
const type = (idx, field, value) =>
  $('#input-panel').fire('input', { target: new FakeInputElement({ idx: String(idx), field }, value) });
const typeDrift = (idx, value) =>
  $('#input-panel').fire('input', { target: new FakeInputElement({ driftIdx: String(idx) }, value) });

await import('../src/app.js');

test('初始载入示例参数，结果区为占位提示', () => {
  assert.ok($('#alert-rows').innerHTML.includes('特大地震预警'));
  assert.ok($('#results').innerHTML.includes('生成码表'));
});

test('生成码表：展示码树、明细、加权贡献、保留分支与总成本', () => {
  $('#solve').fire('click');
  const html = $('#results').innerHTML;
  assert.ok(html.includes('已找到最优码表'));
  assert.ok(html.includes('二叉码树') && html.includes('<svg'));
  assert.ok(html.includes('码字明细') && html.includes('加权贡献'));
  assert.ok(html.includes('保留分支') && html.includes('1110'));
  assert.ok(html.includes('总成本'));
});

test('输入变动后旧结论失效，重新生成可恢复', () => {
  type(0, 'freq', '4');
  assert.ok($('#results').innerHTML.includes('失效'));
  type(0, 'freq', '3');
  $('#solve').fire('click');
  assert.ok($('#results').innerHTML.includes('已找到最优码表'));
});

test('无解时明确说明没有可用的完整分配', () => {
  for (let i = 0; i < 5; i++) {
    type(i, 'lo', '1');
    type(i, 'hi', '1');
  }
  $('#solve').fire('click');
  assert.ok($('#results').innerHTML.includes('没有可用的完整分配'));
});

test('非法参数给出校验错误且不保留旧结论', () => {
  type(0, 'freq', '0');
  type(0, 'hi', '3');
  $('#solve').fire('click');
  assert.equal($('#errors').hidden, false);
  assert.ok($('#errors').innerHTML.includes('频次'));
  assert.ok($('#results').innerHTML.includes('清除'));
});

test('警报类别与保留前缀的增删及数量上限', () => {
  $('#load-sample').fire('click');
  $('#add-alert').fire('click');
  assert.ok($('#alert-rows').innerHTML.includes('data-idx="6"'));
  $('#add-alert').fire('click');
  $('#add-alert').fire('click');
  assert.equal($('#add-alert').disabled, true); // 8 类封顶
  $('#add-reserved').fire('click');
  assert.ok($('#reserved-rows').innerHTML.includes('data-reserved-idx="1"'));
  $('#add-reserved').fire('click');
  $('#add-reserved').fire('click');
  assert.equal($('#add-reserved').disabled, true); // 3 条封顶
});

const reviewBtnEvent = {
  target: { id: 'review', closest: (sel) => (sel === '#review' ? { id: 'review' } : null) },
};

test('稳健性复核：默认零漂移稳定，展示允许区间与稳健证书', () => {
  $('#load-sample').fire('click');
  assert.ok($('#alert-rows').innerHTML.includes('频次漂移幅度'));
  $('#solve').fire('click');
  let html = $('#results').innerHTML;
  assert.ok(html.includes('发起稳健性复核'));
  // 默认漂移幅度全为 0：点击复核按钮（事件委托）
  $('#results').fire('click', reviewBtnEvent);
  html = $('#results').innerHTML;
  assert.ok(html.includes('稳健'));
  assert.ok(html.includes('允许闭区间') || html.includes('实际频次区间'));
  assert.ok(html.includes('稳健证书'));
});

test('稳健性复核：改漂移幅度使旧稳健结论失效，加大漂移得到最小反例', () => {
  // 示例 6 类全部漂移 2：存在总偏移 1 的三级决胜反例
  for (let i = 0; i < 6; i++) typeDrift(i, '2');
  let html = $('#results').innerHTML;
  assert.ok(html.includes('失效')); // 稳健结论失效提示
  $('#results').fire('click', reviewBtnEvent);
  html = $('#results').innerHTML;
  assert.ok(html.includes('不稳健'));
  assert.ok(html.includes('总偏移量'));
  assert.ok(html.includes('替代码表'));
  assert.ok(html.includes('决胜'));
});

test('频次/码长/保留/警报顺序变动后码表与稳健结论同时失效', () => {
  // 当前已有反例复核结果；改动频次应使整个结果区失效
  type(0, 'freq', '4');
  assert.ok($('#results').innerHTML.includes('失效'));
  assert.ok(!$('#results').innerHTML.includes('替代码表'));
  type(0, 'freq', '3');
  $('#solve').fire('click');
  $('#results').fire('click', reviewBtnEvent);
  assert.ok($('#results').innerHTML.includes('稳健') || $('#results').innerHTML.includes('不稳健'));
});
