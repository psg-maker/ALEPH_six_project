/* tests.ui_preview의 일회용 DB에서 삭제 UI와 실제 API를 함께 검증한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('../work/ui-test-tools/node_modules/jsdom');
const base = 'http://127.0.0.1:8765';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, name) {
  for (let i = 0; i < 150; i++) { if (check()) return; await sleep(40); }
  throw new Error('Timed out: ' + name);
}
async function api(path, method = 'GET', payload) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  assert(r.ok, 'fixture API ' + path); return r.json();
}
(async () => {
  const plans = await api('/plans');
  const html = await (await fetch(base)).text();
  const dom = new JSDOM(html, { url: base, runScripts: 'outside-only' });
  const w = dom.window; const d = w.document;
  const today = d.body.dataset.today;
  const task = await api('/tasks', 'POST', { plan_id: plans[0].id, title: 'Delete UI ' + Date.now(), scheduled_date: today, priority: 'HIGH', expected_minutes: 13 });
  const other = await api('/tasks', 'POST', { plan_id: plans[0].id, title: 'Keep UI ' + Date.now(), scheduled_date: today, priority: 'LOW', expected_minutes: 7 });
  const execution = await api(`/tasks/${task.id}/executions`, 'POST', { actual_minutes: 9, blocked_reason: 'test reason' });
  const link = await api(`/tasks/${task.id}/links`, 'POST', { label: 'docs', url: 'https://example.com/' });
  const otherLink = await api(`/tasks/${other.id}/links`, 'POST', { label: 'keep', url: 'https://example.org/' });
  let confirmation = false; let confirmationText = ''; let deletes = 0; let failDelete = false; let release;
  w.confirm = text => { confirmationText = text; return confirmation; };
  w.fetch = async (path, options) => {
    if (options?.method === 'DELETE') {
      deletes++;
      if (failDelete) return new Response(JSON.stringify({ detail: 'Test server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      await new Promise(resolve => { release = resolve; });
    }
    return fetch(new URL(path, base), options);
  };
  w.eval(fs.readFileSync('app/static/planner.js', 'utf8'));
  await waitFor(() => d.querySelector('#task-list').getAttribute('aria-busy') === 'false', 'initial load');
  const row = () => [...d.querySelectorAll('.task-row')].find(r => r.querySelector('.task-title')?.textContent === task.title);
  const deleteButton = () => row()?.querySelector('.task-delete');
  assert(deleteButton(), 'Each Task needs a delete button');
  const initialExpected = Number(d.querySelector('#expected-minutes').textContent);
  const initialActual = Number(d.querySelector('#actual-minutes').textContent);
  const initialCount = Number(d.querySelector('#task-count').textContent);
  deleteButton().click();
  assert.equal(deletes, 0); assert(row());
  assert(confirmationText.includes(task.title));
  const unchanged = await api('/export');
  assert(unchanged.executions.some(r => r.id === execution.id));
  assert(unchanged.task_links.some(r => r.id === link.id));
  console.log('PASS cancellation: no DELETE request; Task and child records preserved');

  confirmation = true; failDelete = true; deleteButton().click();
  await waitFor(() => !d.querySelector('#load-error').hidden && !deleteButton().disabled, 'server error');
  assert(row()); assert.equal(row().querySelector('input').disabled, false);
  assert((await api('/tasks')).some(r => r.id === task.id));
  assert.equal(Number(d.querySelector('#task-count').textContent), initialCount);
  console.log('PASS server failure: visible error, row/count preserved, controls enabled');

  failDelete = false; const before = deletes; const button = deleteButton();
  button.click(); button.dispatchEvent(new w.Event('click'));
  await waitFor(() => typeof release === 'function', 'pending delete');
  assert.equal(deletes, before + 1); assert(button.disabled); assert(row().querySelector('input').disabled);
  assert(row(), 'Do not remove the row before server success');
  release();
  await waitFor(() => !row(), 'successful removal');
  await waitFor(() => [...d.querySelectorAll('.plan-progress-label')].some(n => n.textContent.includes('전체')), 'plan summaries');
  assert.equal(Number(d.querySelector('#task-count').textContent), initialCount - 1);
  assert.equal(Number(d.querySelector('#expected-minutes').textContent), initialExpected - 13);
  assert.equal(Number(d.querySelector('#actual-minutes').textContent), initialActual - 9);
  const exported = await api('/export');
  assert(!exported.tasks.some(r => r.id === task.id));
  assert(!exported.executions.some(r => r.id === execution.id));
  assert(!exported.task_links.some(r => r.id === link.id));
  assert(exported.tasks.some(r => r.id === other.id));
  assert(exported.task_links.some(r => r.id === otherLink.id));
  const summary = await api(`/plans/${plans[0].id}/summary`);
  await waitFor(() => [...d.querySelectorAll('.plan-progress-label')].some(n => n.textContent.includes(`전체 ${summary.task_count}`)), 'updated plan count');
  console.log('PASS confirmed delete: single request, row removed after success, counts/time/Plan summary updated');
  console.log('PASS own child records removed; other Task/link retained');
  dom.window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
