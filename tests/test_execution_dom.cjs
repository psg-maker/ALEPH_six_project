/* tests.ui_preview의 일회용 DB에서 실행 기록 입력 UI를 검증한다. */
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
  assert(r.ok); return r.json();
}
(async () => {
  const html = await (await fetch(base)).text();
  const dom = new JSDOM(html, { url: base, runScripts: 'outside-only' });
  const w = dom.window; const d = w.document; const today = d.body.dataset.today;
  const plan = (await api('/plans'))[0]; const title = 'Execution UI ' + Date.now();
  const task = await api('/tasks', 'POST', { plan_id: plan.id, title, scheduled_date: today, priority: 'HIGH', expected_minutes: 90 });
  const savedTask = async () => (await api('/tasks')).find(t => t.id === task.id);
  const original = await savedTask();
  let posts = 0; let failPost = false; let hold = false; let release;
  w.fetch = async (path, options) => {
    if (options?.method === 'POST' && /\/executions$/.test(path)) {
      posts++;
      if (failPost) return new Response(JSON.stringify({ detail: 'test save failure' }), { status: 500 });
      if (hold) await new Promise(resolve => { release = resolve; });
    }
    return fetch(new URL(path, base), options);
  };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.eval(fs.readFileSync('app/static/planner.js', 'utf8'));
  await waitFor(() => d.querySelector('#task-list').getAttribute('aria-busy') === 'false', 'load');
  const row = () => [...d.querySelectorAll('.task-row')].find(r => r.querySelector('.task-title')?.textContent === title);
  assert(row().querySelector('.task-record'), 'Task needs an execution record button');
  row().querySelector('.task-record').click();
  const form = d.querySelector('#execution-form');
  await waitFor(() => d.querySelector('#execution-history').getAttribute('aria-busy') === 'false', 'history');
  assert(d.querySelector('#execution-dialog').open);
  assert.equal(form.elements.actual_minutes.value, '');
  assert.equal(d.querySelectorAll('.execution-item').length, 0);
  form.elements.memo.value = 'cancelled'; d.querySelector('[data-close="execution-dialog"]').click();
  assert.equal(posts, 0); assert.deepEqual(await api(`/tasks/${task.id}/executions`), []);
  console.log('PASS per-task record dialog, empty history, optional time blank; cancellation has no write');

  row().querySelector('.task-record').click();
  form.elements.actual_minutes.value = '25';
  form.elements.started_at.value = today + 'T14:00'; form.elements.ended_at.value = today + 'T15:00';
  const text = '<script>alert(1)</script>';
  form.elements.memo.value = text; form.elements.blocked_reason.value = 'Need more examples';
  const beforeActual = Number(d.querySelector('#actual-minutes').textContent);
  hold = true; form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => typeof release === 'function', 'pending save'); assert.equal(posts, 1); release(); hold = false;
  await waitFor(() => d.querySelectorAll('.execution-item').length === 1 && !form.querySelector('[type=submit]').disabled, 'saved record');
  const records = await api(`/tasks/${task.id}/executions`);
  assert.equal(records.length, 1); assert.equal(records[0].actual_minutes, 25); assert.equal(records[0].memo, text); assert.equal(records[0].blocked_reason, 'Need more examples');
  assert.deepEqual(await savedTask(), original);
  assert.equal(d.querySelector('#execution-history script'), null);
  assert(d.querySelector('#execution-history').textContent.includes(text));
  assert.equal(Number(d.querySelector('#actual-minutes').textContent), beforeActual + 25);
  assert(d.querySelector('#execution-dialog').open);
  console.log('PASS single save/manual 25 minutes despite one-hour interval; Task unchanged, safe history text and summary updated');

  failPost = true; form.elements.memo.value = 'retry draft';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !d.querySelector('#execution-error').hidden && !form.querySelector('[type=submit]').disabled, 'save error');
  assert.equal(form.elements.memo.value, 'retry draft'); assert.equal((await api(`/tasks/${task.id}/executions`)).length, 1);
  console.log('PASS server failure preserves draft and saved history');
  failPost = false;
  for (const [minutes, start, end] of [['-1', '', ''], ['1.5', '', ''], ['2', today + 'T15:00', today + 'T14:00']]) {
    form.elements.actual_minutes.value = minutes; form.elements.started_at.value = start; form.elements.ended_at.value = end;
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !d.querySelector('#execution-error').hidden && !form.querySelector('[type=submit]').disabled, 'invalid input');
    assert.equal((await api(`/tasks/${task.id}/executions`)).length, 1);
  }
  console.log('PASS negative/fractional minutes and reversed times rejected without extra records');
  form.reset(); form.elements.actual_minutes.value = '0';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => d.querySelectorAll('.execution-item').length === 2 && !form.querySelector('[type=submit]').disabled, 'zero minutes');
  form.elements.blocked_reason.value = 'reason only';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => d.querySelectorAll('.execution-item').length === 3 && !form.querySelector('[type=submit]').disabled, 'reason only');
  const all = await api(`/tasks/${task.id}/executions`); assert.equal(all[1].actual_minutes, 0); assert.equal(all[2].actual_minutes, null);
  assert.deepEqual(await savedTask(), original);
  d.querySelector('[data-close="execution-dialog"]').click(); row().querySelector('.task-record').click();
  await waitFor(() => d.querySelectorAll('.execution-item').length === 3 && d.querySelector('#execution-history').getAttribute('aria-busy') === 'false', 'reopen history');
  console.log('PASS zero and reason-only records saved distinctly; reopen restores history, Task still unchanged');
  d.querySelector('[data-close="execution-dialog"]').click();
  await api(`/tasks/${task.id}/complete`, 'PATCH');
  const completed = await savedTask();
  d.querySelector('#refresh').click();
  await waitFor(() => row()?.classList.contains('is-done') && d.querySelector('#task-list').getAttribute('aria-busy') === 'false', 'completed Task reload');
  row().querySelector('.task-record').click();
  form.elements.memo.value = 'Additional note for completed task';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => d.querySelectorAll('.execution-item').length === 4 && !form.querySelector('[type=submit]').disabled, 'completed Task record');
  assert.deepEqual(await savedTask(), completed);
  console.log('PASS recording for DONE Task preserves completion status and timestamp');
  dom.window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
