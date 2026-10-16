/* tests.ui_preview의 개인 DB와 분리된 데이터로 수정 폼과 API를 검증한다. */
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
  const plans = await api('/plans'); const title = 'Edit test ' + Date.now();
  const task = await api('/tasks', 'POST', { plan_id: plans[0].id, title, description: 'original description', scheduled_date: today, due_date: today, priority: 'LOW', tag: 'original', expected_minutes: 16 });
  await api(`/tasks/${task.id}/complete`, 'PATCH');
  const execution = await api(`/tasks/${task.id}/executions`, 'POST', { actual_minutes: 12 });
  const link = await api(`/tasks/${task.id}/links`, 'POST', { label: 'keep', url: 'https://example.com/' });
  const savedTask = async () => (await api('/tasks')).find(t => t.id === task.id);
  const before = await savedTask();
  let puts = 0; let failPut = false; let hold = false; let release;
  w.fetch = async (path, options) => {
    if (options?.method === 'PUT') {
      puts++;
      if (failPut) return new Response(JSON.stringify({ detail: 'Test update failure' }), { status: 500 });
      if (hold) await new Promise(resolve => { release = resolve; });
    }
    return fetch(new URL(path, base), options);
  };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.eval(fs.readFileSync('app/static/planner.js', 'utf8'));
  await waitFor(() => d.querySelector('#task-list').getAttribute('aria-busy') === 'false', 'load');
  const row = () => [...d.querySelectorAll('.task-row')].find(r => r.querySelector('.task-title')?.textContent === currentTitle);
  let currentTitle = title;
  assert(row().querySelector('.task-edit'), 'Each Task needs an edit button');
  row().querySelector('.task-edit').click();
  const form = d.querySelector('#task-form');
  assert(d.querySelector('#task-dialog').open);
  for (const name of ['title', 'description', 'scheduled_date', 'due_date', 'priority', 'tag', 'expected_minutes']) assert.equal(form.elements[name].value, String(before[name]));
  assert(d.querySelector('#task-plan').disabled);
  assert(d.querySelector('#task-new-plan').hidden);
  form.elements.title.value = 'cancelled draft';
  d.querySelector('[data-close="task-dialog"]').click();
  assert.equal(puts, 0); assert.deepEqual(await savedTask(), before);
  console.log('PASS prefilled fields; Plan locked; cancellation makes no request/data change');

  row().querySelector('.task-edit').click();
  const updatedTitle = '<script>edit-' + Date.now() + '</script>';
  form.elements.title.value = updatedTitle; form.elements.description.value = 'changed description';
  form.elements.expected_minutes.value = '45'; form.elements.priority.value = 'HIGH'; form.elements.tag.value = 'updated'; form.elements.due_date.value = '';
  hold = true;
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => typeof release === 'function', 'pending PUT'); assert.equal(puts, 1); assert(form.querySelector('[type=submit]').disabled);
  currentTitle = updatedTitle; release(); hold = false;
  await waitFor(() => row() && d.querySelector('#task-list').getAttribute('aria-busy') === 'false', 'edited row');
  const after = await savedTask();
  assert.equal(after.id, task.id); assert.equal(after.title, updatedTitle); assert.equal(after.expected_minutes, 45); assert.equal(after.due_date, null); assert.equal(after.priority, 'HIGH'); assert.equal(after.tag, 'updated');
  for (const name of ['plan_id', 'status', 'completed_at', 'created_at']) assert.equal(after[name], before[name]);
  assert.equal(d.querySelector('#task-list script'), null);
  assert((await api(`/tasks/${task.id}/executions`)).some(r => r.id === execution.id));
  assert((await api(`/tasks/${task.id}/links`)).some(r => r.id === link.id));
  const renderedTasks = await api('/tasks/today');
  assert.equal(Number(d.querySelector('#expected-minutes').textContent), renderedTasks.reduce((sum, r) => sum + r.expected_minutes, 0));
  console.log('PASS single PUT updates same Task and summary, safe text; status/time/Plan/children preserved');

  row().querySelector('.task-edit').click(); form.elements.description.value = 'retry draft'; failPut = true;
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !d.querySelector('#task-error').hidden && !form.querySelector('[type=submit]').disabled, 'error');
  assert(d.querySelector('#task-dialog').open); assert.equal(form.elements.description.value, 'retry draft'); assert.deepEqual(await savedTask(), after);
  console.log('PASS server error retains data/draft and permits retry');
  failPut = false; form.elements.expected_minutes.value = '-1';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !d.querySelector('#task-error').hidden && !form.querySelector('[type=submit]').disabled, 'validation');
  assert.deepEqual(await savedTask(), after); d.querySelector('[data-close="task-dialog"]').click();
  d.querySelector('#add-task').click();
  assert.equal(form.elements.title.value, ''); assert.equal(d.querySelector('#task-plan').disabled, false); assert.equal(d.querySelector('#task-new-plan').hidden, false);
  console.log('PASS invalid input rejected; create mode resets edit fields and unlocks Plan');
  dom.window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
