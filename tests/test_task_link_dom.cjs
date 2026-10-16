/* tests.ui_preview의 일회용 DB로 자료 링크 폼을 검증한다. */
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
  const w = dom.window; const d = w.document;
  const plan = (await api('/plans'))[0]; const title = 'Link UI ' + Date.now();
  const task = await api('/tasks', 'POST', { plan_id: plan.id, title, scheduled_date: d.body.dataset.today, priority: 'HIGH', expected_minutes: 30 });
  await api(`/tasks/${task.id}/complete`, 'PATCH');
  const savedTask = async () => (await api('/tasks')).find(t => t.id === task.id);
  const original = await savedTask();
  let posts = 0; let fail = false; let hold = false; let release;
  w.fetch = async (path, options) => {
    if (options?.method === 'POST' && /\/links$/.test(path)) {
      posts++;
      if (fail) return new Response(JSON.stringify({ detail: 'test link save error' }), { status: 500 });
      if (hold) await new Promise(resolve => { release = resolve; });
    }
    return fetch(new URL(path, base), options);
  };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.eval(fs.readFileSync('app/static/planner.js', 'utf8'));
  await waitFor(() => d.querySelector('#task-list').getAttribute('aria-busy') === 'false', 'load');
  const row = () => [...d.querySelectorAll('.task-row')].find(r => r.querySelector('.task-title')?.textContent === title);
  assert(row().querySelector('.task-add-link'), 'Task needs an add-link button');
  row().querySelector('.task-add-link').click();
  const form = d.querySelector('#link-form');
  assert(d.querySelector('#link-dialog').open);
  form.elements.label.value = 'cancelled';
  d.querySelector('[data-close="link-dialog"]').click();
  assert.equal(posts, 0); assert.deepEqual(await api(`/tasks/${task.id}/links`), []);
  console.log('PASS per-Task link dialog, cancellation makes no request');
  row().querySelector('.task-add-link').click();
  const label = '<script>docs</script>'; const url = 'https://example.com/docs?q=test#part';
  form.elements.label.value = label; form.elements.url.value = url;
  hold = true; form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => typeof release === 'function', 'pending link'); assert.equal(posts, 1); release(); hold = false;
  await waitFor(() => row().querySelectorAll('.task-links a').length === 1 && !form.querySelector('[type=submit]').disabled, 'saved link');
  const anchor = row().querySelector('.task-links a');
  assert.equal(anchor.textContent, '\u2197 ' + label); assert.equal(anchor.href, url); assert.equal(anchor.target, '_blank'); assert.equal(anchor.rel, 'noopener noreferrer');
  assert.equal(row().querySelector('script'), null);
  let links = await api(`/tasks/${task.id}/links`); assert.equal(links.length, 1); assert.equal(links[0].label, label); assert.equal(links[0].link_type, 'web');
  assert.deepEqual(await savedTask(), original);
  console.log('PASS single save, safe label rendering, correct URL/new-tab attributes, Task unchanged');
  row().querySelector('.task-add-link').click();
  for (const badUrl of ['javascript:alert(1)', 'file:///test', 'not a url']) {
    form.elements.label.value = 'bad'; form.elements.url.value = badUrl;
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !d.querySelector('#link-error').hidden && !form.querySelector('[type=submit]').disabled, 'invalid URL');
    assert.equal(posts, 1);
  }
  console.log('PASS invalid/unsafe URLs rejected before API request');
  form.elements.label.value = 'retry draft'; form.elements.url.value = 'http://example.org/'; fail = true;
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !d.querySelector('#link-error').hidden && !form.querySelector('[type=submit]').disabled, 'server error');
  assert(d.querySelector('#link-dialog').open); assert.equal(form.elements.label.value, 'retry draft'); assert.equal((await api(`/tasks/${task.id}/links`)).length, 1);
  fail = false; form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => row().querySelectorAll('.task-links a').length === 2, 'second link');
  links = await api(`/tasks/${task.id}/links`); assert.equal(links.length, 2); assert.notEqual(links[0].id, links[1].id); assert.deepEqual(await savedTask(), original);
  assert.deepEqual(await api(`/tasks/${task.id}/executions`), []);
  console.log('PASS failure preserves draft/first link; retry adds second link, no Task or execution mutation');
  dom.window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
