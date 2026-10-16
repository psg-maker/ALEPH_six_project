/* 실행 중인 tests.ui_preview(메모리 DB)만 대상으로 실제 DOM 이벤트를 검증한다.
 * 준비: npm.cmd install --prefix work/ui-test-tools --no-save --package-lock=false jsdom
 * 실행: node tests/test_today_dom.cjs
 * dialog의 열림/닫힘은 모사하므로 브라우저 네이티브 대화상자/레이아웃 검증은 별도다.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('../work/ui-test-tools/node_modules/jsdom');
const base = 'http://127.0.0.1:8765';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(40); }
  throw new Error(`Timed out: ${label}`);
}

(async () => {
  const html = await (await fetch(base)).text();
  const dom = new JSDOM(html, { url: base, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; const d = w.document;
  let requests = 0; let failNextPatch = false;
  w.fetch = (path, options) => {
    requests++;
    if (failNextPatch && options?.method === 'PATCH') { failNextPatch = false; return Promise.reject(new Error('test network failure')); }
    return fetch(new URL(path, base), options);
  };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.eval(fs.readFileSync('app/static/planner.js', 'utf8'));
  await waitFor(() => d.querySelector('#task-list').getAttribute('aria-busy') === 'false', 'initial load');
  assert(d.querySelectorAll('.task-row').length >= 2);
  assert.equal(d.querySelector('#task-list script'), null);
  assert(d.querySelector('#task-list').textContent.includes('<script>alert(1)</script>'));
  assert(d.querySelector('.task-links a').href.startsWith('https://docs.python.org/'));
  console.log('PASS real initial API data, safe script-text rendering and linked resource');

  d.querySelector('#add-task').click();
  assert(d.querySelector('#task-dialog').open);
  const form = d.querySelector('#task-form'); const title = 'DOM test ' + Date.now();
  form.elements.title.value = title;
  form.elements.expected_minutes.value = '17';
  const before = (await (await fetch(base + '/tasks')).json()).length;
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => [...d.querySelectorAll('.task-title')].some(n => n.textContent === title), 'saved task rendered');
  const tasks = await (await fetch(base + '/tasks')).json();
  assert.equal(tasks.length, before + 1);
  const task = tasks.find(t => t.title === title); assert.equal(task.expected_minutes, 17);
  assert(!d.querySelector('#task-dialog').open);
  console.log('PASS task modal, actual API insert, visible saved task and duplicate submit lock');

  const row = () => [...d.querySelectorAll('.task-row')].find(n => n.textContent.includes(title));
  let checkbox = row().querySelector('input'); checkbox.checked = true; checkbox.dispatchEvent(new w.Event('change'));
  await waitFor(() => row()?.classList.contains('is-done'), 'complete');
  let saved = (await (await fetch(base + '/tasks')).json()).find(t => t.id === task.id); assert.equal(saved.status, 'DONE');
  checkbox = row().querySelector('input'); checkbox.checked = false; checkbox.dispatchEvent(new w.Event('change'));
  await waitFor(() => row() && !row().classList.contains('is-done'), 'reopen');
  saved = (await (await fetch(base + '/tasks')).json()).find(t => t.id === task.id); assert.equal(saved.status, 'TODO'); assert.equal(saved.completed_at, null);
  assert.deepEqual(await (await fetch(base + `/tasks/${task.id}/executions`)).json(), []);
  console.log('PASS checkbox complete/reopen persisted, no automatic execution');

  failNextPatch = true; checkbox = row().querySelector('input'); checkbox.checked = true; checkbox.dispatchEvent(new w.Event('change'));
  await waitFor(() => !d.querySelector('#load-error').hidden, 'network failure shown');
  assert.equal(checkbox.checked, false); assert.equal(checkbox.disabled, false);
  console.log('PASS request failure visible; checkbox restored and usable');

  d.querySelector('#search').value = title; d.querySelector('#search').dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('.task-row').length, 1); assert.equal(d.querySelector('#expected-minutes').textContent, '17');
  d.querySelector('#status-filter').value = 'DONE'; d.querySelector('#status-filter').dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelectorAll('.task-row').length, 0);
  d.querySelector('#status-filter').value = ''; d.querySelector('#status-filter').dispatchEvent(new w.Event('change'));
  console.log('PASS local keyword/status filters and matching summary');

  d.querySelector('#add-task').click(); form.elements.title.value = 'Invalid time'; form.elements.expected_minutes.value = '-1';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !d.querySelector('#task-error').hidden, '422 in form');
  assert(d.querySelector('#task-dialog').open); assert.equal(form.querySelector('[type=submit]').disabled, false);
  d.querySelector('[data-close="task-dialog"]').click();
  console.log('PASS validation error keeps dialog open and permits correction');

  d.querySelector('#add-plan').click(); const pf = d.querySelector('#plan-form'); const planTitle = 'DOM plan ' + Date.now();
  pf.elements.title.value = planTitle; pf.elements.success_criteria.value = 'Learn API';
  pf.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => [...d.querySelectorAll('.plan-name')].some(n => n.textContent === planTitle), 'new plan');
  assert([...d.querySelector('#task-plan').options].some(o => o.textContent === planTitle));
  [...d.querySelectorAll('.plan-name')].find(n => n.textContent === planTitle).click();
  await waitFor(() => d.querySelector('#page-title').textContent === planTitle && d.querySelector('#task-list').getAttribute('aria-busy') === 'false', 'plan navigation');
  assert.equal(d.querySelectorAll('.task-row').length, 0);
  console.log('PASS new Plan persisted, task picker updated, Plan-specific empty list');

  const refreshed = new JSDOM(await (await fetch(base)).text(), { url: base, runScripts: 'outside-only' });
  refreshed.window.fetch = (path, options) => fetch(new URL(path, base), options);
  refreshed.window.eval(fs.readFileSync('app/static/planner.js', 'utf8'));
  await waitFor(() => refreshed.window.document.querySelector('#task-list').getAttribute('aria-busy') === 'false', 'reload');
  assert(refreshed.window.document.querySelector('#task-list').textContent.includes(title));
  console.log('PASS fresh page load restores saved task from API; DOM workflow passed');
  refreshed.window.close(); dom.window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
