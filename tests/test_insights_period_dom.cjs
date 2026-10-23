/* Uses only tests.ui_preview's memory DB, never the personal or deployed DB. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('../work/ui-test-tools/node_modules/jsdom');
const base = 'http://127.0.0.1:8765';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 180; i++) { if (check()) return; await sleep(40); }
  throw new Error('Timed out: ' + label);
}
async function api(path, method = 'GET', payload) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  assert(response.ok, path); return response.json();
}
(async () => {
  const body = { title: 'Period ' + Date.now(), category: 'study', priority: 'HIGH', start_date: '2026-01-01', end_date: '2026-01-31', success_criteria: 'test', expected_minutes: 999 };
  const plan = await api('/plans', 'POST', body);
  const other = await api('/plans', 'POST', { ...body, title: 'Other period' });
  const tasks = [];
  for (const [day, minutes] of [[9, 100], [10, 10], [20, 20], [21, 200]]) {
    tasks.push(await api('/tasks', 'POST', { plan_id: plan.id, title: 'day ' + day, scheduled_date: `2026-01-${String(day).padStart(2, '0')}`, due_date: '2020-01-01', priority: 'HIGH', expected_minutes: minutes }));
  }
  await api(`/tasks/${tasks[1].id}/complete`, 'PATCH');
  for (const [index, minutes, reason] of [[0, 100, 'outside'], [1, 7, 'first'], [1, 8, 'second'], [2, null, '   '], [3, 200, 'outside']]) {
    await api(`/tasks/${tasks[index].id}/executions`, 'POST', { actual_minutes: minutes, blocked_reason: reason, started_at: '2025-12-01T10:00:00', ended_at: '2025-12-01T11:00:00' });
  }
  const before = await api('/export');
  const dom = new JSDOM(await (await fetch(base)).text(), { url: base, runScripts: 'outside-only' });
  const w = dom.window, d = w.document, $ = id => d.getElementById(id);
  const requests = [];
  let fail = false, hold = null, release = null, held = false;
  w.fetch = async (path, options) => {
    requests.push(String(path));
    if (fail && String(path).includes('/summary')) return new Response(JSON.stringify({ detail: 'Read failed' }), { status: 500 });
    const response = await fetch(new URL(path, base), options);
    if (hold && String(path).includes(hold)) { hold = null; held = true; await new Promise(resolve => { release = resolve; }); }
    return response;
  };
  w.eval(fs.readFileSync('app/static/insights.js', 'utf8'));
  assert($('insight-start-date'), 'Start date control is required');
  assert($('insight-end-date'), 'End date control is required');
  $('insights-view').hidden = false;
  const plans = (await api('/plans')).filter(p => [plan.id, other.id].includes(p.id));
  d.dispatchEvent(new w.CustomEvent('aleph:data', { detail: { view: 'insights', plans } }));
  const number = key => Number(d.querySelector(`[data-metric="${key}"] .insight-number`).textContent);
  const ready = count => $('insight-evidence').getAttribute('aria-busy') === 'false' && number('task_count') === count && $('insight-evidence').dataset.metric !== '';
  await waitFor(() => ready(4), 'all period');
  function apply(start, end) {
    $('insight-start-date').value = start; $('insight-end-date').value = end;
    $('insight-period-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  }
  apply('2026-01-10', '2026-01-20');
  await waitFor(() => ready(2), 'inclusive date range');
  for (const [key, value] of Object.entries({ task_count: 2, completed_task_count: 1, overdue_task_count: 1, blocked_task_count: 1, expected_minutes: 30, actual_minutes: 15, difference_minutes: -15 })) assert.equal(number(key), value, key);
  assert($('insight-rate').textContent.includes('50'));
  assert($('insight-scope').textContent.includes('2026-01-10'));
  assert($('insight-scope').textContent.includes('예정일'));
  assert($('insight-scope').textContent.includes('실행'));
  for (const [metric, rows] of [['task_count', 2], ['completed_task_count', 1], ['overdue_task_count', 1], ['blocked_task_count', 1], ['expected_minutes', 2], ['actual_minutes', 3], ['difference_minutes', 5]]) {
    d.querySelector(`[data-metric="${metric}"]`).click();
    await waitFor(() => $('insight-evidence').dataset.metric === metric && $('insight-evidence').getAttribute('aria-busy') === 'false', metric);
    assert.equal(d.querySelectorAll('.evidence-task,.evidence-execution').length, rows, metric);
    assert.equal($('insight-evidence-error').hidden, true);
  }
  console.log('PASS inclusive Task period, outside-date executions, summary/evidence equality for every metric');
  // Editing a draft does not change the already-applied period.
  $('insight-start-date').value = '2026-01-20';
  d.querySelector('[data-metric="task_count"]').click();
  await waitFor(() => $('insight-evidence').dataset.metric === 'task_count' && $('insight-evidence').getAttribute('aria-busy') === 'false', 'draft scope');
  assert.equal(d.querySelectorAll('.evidence-task').length, 2);
  const countBeforeInvalid = requests.length;
  apply('2026-01-20', '2026-01-10');
  assert.equal($('insight-period-error').hidden, false);
  assert.equal(requests.length, countBeforeInvalid);
  assert.equal(number('task_count'), 2);
  apply('2026-01-10', '2026-01-10'); await waitFor(() => ready(1), 'same day');
  assert.equal(number('actual_minutes'), 15);
  apply('2027-01-01', ''); await waitFor(() => ready(0), 'open start empty');
  assert.equal(number('actual_minutes'), 0);
  $('insight-all-period').click(); await waitFor(() => ready(4), 'reset all');
  assert.equal($('insight-start-date').value, ''); assert.equal($('insight-end-date').value, '');
  console.log('PASS draft isolation, reversed dates rejected, same day, empty/open bounds, all-period reset');
  // A slow old summary must not overwrite the next applied period.
  hold = '/summary?'; held = false;
  apply('2026-01-09', '2026-01-09'); await waitFor(() => held, 'held summary');
  apply('2026-01-20', '2026-01-20'); await waitFor(() => ready(1), 'latest summary');
  assert.equal(number('expected_minutes'), 20);
  release(); await sleep(100); assert.equal(number('expected_minutes'), 20);
  // Likewise for a slow old evidence response.
  hold = '/tasks?'; held = false;
  d.querySelector('[data-metric="task_count"]').click(); await waitFor(() => held, 'held evidence');
  apply('2026-01-10', '2026-01-10'); await waitFor(() => ready(1), 'latest evidence');
  release(); await sleep(100);
  assert.equal(Number(d.querySelector('.evidence-task').dataset.taskId), tasks[1].id);
  console.log('PASS late summary/evidence from earlier periods cannot overwrite current results');
  fail = true; $('insight-refresh').click();
  await waitFor(() => !$('insight-error').hidden, 'failure');
  assert.equal(d.querySelector('[data-metric="task_count"] .insight-number').textContent, '—');
  fail = false; $('insight-refresh').click(); await waitFor(() => ready(1), 'retry applied dates');
  $('insight-plan').value = other.id; $('insight-plan').dispatchEvent(new w.Event('change'));
  await waitFor(() => ready(0), 'other plan');
  $('insight-plan').value = plan.id; $('insight-plan').dispatchEvent(new w.Event('change'));
  await waitFor(() => ready(1), 'restore plan period');
  assert.deepEqual(await api('/export'), before);
  console.log('PASS failed load clears stale values, retry/Plan switching retain applied dates, read-only flow preserves DB');
  dom.window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
