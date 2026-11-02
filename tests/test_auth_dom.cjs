/* Login form behavior without a server or real credentials. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function setup(fetch) {
  const nodes = Object.fromEntries([
    'auth-form', 'auth-username', 'auth-password', 'auth-submit', 'auth-error',
    'auth-title', 'auth-status', 'auth-toggle',
  ].map(id => [id, { value: '', disabled: false, hidden: true, textContent: '' }]));
  nodes['auth-username'].value = '  test_user  ';
  nodes['auth-password'].value = 'test-only-password';
  nodes['auth-submit'].disabled = true;
  nodes['auth-form'].reportValidity = () => true;
  let submit;
  nodes['auth-form'].addEventListener = (event, handler) => {
    if (event === 'submit') submit = handler;
  };
  let toggle;
  nodes['auth-toggle'].addEventListener = (event, handler) => {
    if (event === 'click') toggle = handler;
  };
  const destinations = [];
  const context = {
    document: { getElementById: id => nodes[id] },
    window: { location: { assign: url => destinations.push(url) } },
    fetch,
  };
  const path = 'app/static/auth.js';
  vm.runInNewContext(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '', context);
  return { nodes, destinations, toggle: () => {
    assert.equal(typeof toggle, 'function', 'Mode toggle must be connected');
    toggle();
  }, submit: () => {
    assert.equal(typeof submit, 'function', 'Login submit handler must be connected');
    return submit({ preventDefault() {} });
  } };
}

test('login posts credentials as JSON and redirects after success', async () => {
  let request;
  const ui = setup(async (path, options) => {
    request = { path, options };
    return { ok: true, json: async () => ({ user: { id: 1 } }) };
  });
  assert.equal(ui.nodes['auth-submit'].disabled, false);
  await ui.submit();
  assert.equal(request.path, '/auth/login');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), {
    username: 'test_user', password: 'test-only-password',
  });
  assert.deepEqual(ui.destinations, ['/']);
  assert.equal(ui.nodes['auth-password'].value, '');
});

test('rejected login shows a literal message without navigating', async () => {
  const message = '<b>Invalid credentials</b>';
  const ui = setup(async () => ({ ok: false, json: async () => ({ detail: message }) }));
  await ui.submit();
  assert.equal(ui.nodes['auth-error'].textContent, message);
  assert.equal(ui.nodes['auth-error'].hidden, false);
  assert.deepEqual(ui.destinations, []);
  assert.equal(ui.nodes['auth-submit'].disabled, false);
});

test('pending login blocks duplicate requests', async () => {
  let release;
  let calls = 0;
  const ui = setup(async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({}) };
  });
  const first = ui.submit();
  assert.equal(ui.nodes['auth-submit'].disabled, true);
  assert.equal(ui.nodes['auth-password'].disabled, true);
  await ui.submit();
  assert.equal(calls, 1);
  release();
  await first;
});

test('network failure enables retry without navigating', async () => {
  const ui = setup(async () => { throw new Error('offline'); });
  await ui.submit();
  assert.equal(ui.nodes['auth-error'].hidden, false);
  assert.equal(ui.nodes['auth-submit'].disabled, false);
  assert.equal(ui.nodes['auth-username'].disabled, false);
  assert.deepEqual(ui.destinations, []);
});

test('mode switch clears password and changes autocomplete', () => {
  const ui = setup(async () => { throw new Error('Should not submit'); });
  ui.toggle();
  assert.equal(ui.nodes['auth-title'].textContent, '회원가입');
  assert.equal(ui.nodes['auth-password'].value, '');
  assert.equal(ui.nodes['auth-password'].autocomplete, 'new-password');
  ui.nodes['auth-password'].value = 'test-only-password';
  ui.toggle();
  assert.equal(ui.nodes['auth-title'].textContent, '로그인');
  assert.equal(ui.nodes['auth-password'].value, '');
  assert.equal(ui.nodes['auth-password'].autocomplete, 'current-password');
});

test('successful registration returns to login without auto-login', async () => {
  const calls = [];
  const ui = setup(async path => {
    calls.push(path);
    return { ok: true, json: async () => ({ id: 3 }) };
  });
  ui.toggle();
  ui.nodes['auth-password'].value = 'test-only-password';
  await ui.submit();
  assert.deepEqual(calls, ['/auth/register']);
  assert.equal(ui.nodes['auth-title'].textContent, '로그인');
  assert.equal(ui.nodes['auth-username'].value.trim(), 'test_user');
  assert.equal(ui.nodes['auth-password'].value, '');
  assert.equal(ui.nodes['auth-status'].hidden, false);
  assert.deepEqual(ui.destinations, []);
});
