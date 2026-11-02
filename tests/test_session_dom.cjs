/* Session controls with mocked requests; no real account or server is used. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function setup(fetch) {
  let click;
  const button = {
    disabled: true, textContent: '로그아웃',
    addEventListener(event, handler) { if (event === 'click') click = handler; },
  };
  const error = { hidden: true, textContent: '' };
  const destinations = [];
  const path = 'app/static/session.js';
  const context = {
    document: { getElementById: id => ({
      'logout-button': button, 'session-error': error,
    })[id] },
    window: { location: { replace: url => destinations.push(url) } },
    fetch,
  };
  vm.runInNewContext(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '', context);
  return { button, error, destinations, checkResponse(response) {
    assert.equal(typeof context.window.alephSession?.checkResponse, 'function',
      'Shared session response handler must be available');
    return context.window.alephSession.checkResponse(response);
  }, click() {
    assert.equal(typeof click, 'function', 'Logout handler must be connected');
    return click();
  } };
}

test('successful logout posts once then replaces the page with login', async () => {
  const calls = [];
  const ui = setup(async (path, options) => {
    calls.push([path, options.method]);
    return { ok: true };
  });
  assert.equal(ui.button.disabled, false);
  await ui.click();
  assert.deepEqual(calls, [['/auth/logout', 'POST']]);
  assert.deepEqual(ui.destinations, ['/login']);
});

test('rejected logout stays on page and shows literal error', async () => {
  const ui = setup(async () => ({
    ok: false, json: async () => ({ detail: '<b>Rejected</b>' }),
  }));
  await ui.click();
  assert.deepEqual(ui.destinations, []);
  assert.equal(ui.error.hidden, false);
  assert.equal(ui.error.textContent, '<b>Rejected</b>');
  assert.equal(ui.button.disabled, false);
});

test('network failure allows logout retry', async () => {
  const ui = setup(async () => { throw new Error('offline'); });
  await ui.click();
  assert.deepEqual(ui.destinations, []);
  assert.equal(ui.error.hidden, false);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.button.textContent, '로그아웃');
});

test('pending logout blocks duplicate requests and does not navigate early', async () => {
  let release;
  let calls = 0;
  const ui = setup(async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return { ok: true };
  });
  const first = ui.click();
  assert.equal(ui.button.disabled, true);
  await ui.click();
  assert.equal(calls, 1);
  assert.deepEqual(ui.destinations, []);
  release();
  await first;
  assert.deepEqual(ui.destinations, ['/login']);
});

test('unauthorized responses stop processing and redirect only once', () => {
  const ui = setup(async () => { throw new Error('Should not request'); });
  assert.throws(() => ui.checkResponse({ status: 401 }), /로그인이 만료됐습니다/);
  assert.throws(() => ui.checkResponse({ status: 401 }), /로그인이 만료됐습니다/);
  assert.deepEqual(ui.destinations, ['/login']);
});

test('other response statuses do not trigger a login redirect', () => {
  const ui = setup(async () => { throw new Error('Should not request'); });
  for (const status of [200, 403, 404, 422, 500]) {
    const response = { status };
    assert.equal(ui.checkResponse(response), response);
  }
  assert.deepEqual(ui.destinations, []);
});
