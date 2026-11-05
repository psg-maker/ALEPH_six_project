/* Password dialog controls with dummy inputs, no server or real credentials. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function setup(fetchResponse) {
  const nodes = {};
  for (const id of ['password-open', 'password-dialog', 'password-form',
    'password-error', 'password-cancel', 'password-save',
    'current-password', 'new-password', 'confirm-password']) {
    nodes[id] = { disabled: true, hidden: true, value: '', listeners: {},
      addEventListener(event, handler) { this.listeners[event] = handler; } };
  }
  nodes['password-form'].reset = () => {
    for (const id of ['current-password', 'new-password', 'confirm-password']) {
      nodes[id].value = '';
    }
  };
  const dialog = nodes['password-dialog'];
  nodes['password-form'].reportValidity = () => true;
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.listeners.close?.(); };
  let requests = 0;
  const sent = [];
  const destinations = [];
  const path = 'app/static/password.js';
  vm.runInNewContext(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '', {
    document: { getElementById: id => nodes[id] },
    fetch: async (path, options) => {
      requests++;
      sent.push({ path, options });
      if (!fetchResponse) throw new Error('No API expected in this step');
      return fetchResponse(path, options);
    },
    window: {
      location: { replace: path => destinations.push(path) },
      alephSession: { checkResponse(response) {
        if (response.status === 401) {
          destinations.push('/login');
          throw new Error('로그인이 만료됐습니다. 다시 로그인해주세요.');
        }
        return response;
      } },
    },
  });
  function click(id) {
    assert.equal(typeof nodes[id].listeners.click, 'function');
    return nodes[id].listeners.click();
  }
  return { nodes, dialog, click, sent, destinations,
    submit: () => nodes['password-form'].listeners.submit({ preventDefault() {} }),
    fill() {
      nodes['current-password'].value = 'test-current-password';
      nodes['new-password'].value = 'test-new-password';
      nodes['confirm-password'].value = 'test-new-password';
    },
    requests: () => requests,
  };
}

test('opening dialog clears previous password inputs and makes no request', () => {
  const ui = setup();
  assert.equal(ui.nodes['password-open'].disabled, false);
  ui.nodes['current-password'].value = 'dummy';
  ui.nodes['new-password'].value = 'dummy';
  ui.click('password-open');
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.nodes['current-password'].value, '');
  assert.equal(ui.nodes['new-password'].value, '');
  assert.equal(ui.requests(), 0);
});

test('cancel and dialog close clear passwords and old error', () => {
  const ui = setup();
  ui.click('password-open');
  ui.nodes['new-password'].value = 'dummy';
  ui.nodes['confirm-password'].value = 'dummy';
  ui.nodes['password-error'].hidden = false;
  ui.click('password-cancel');
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.nodes['new-password'].value, '');
  assert.equal(ui.nodes['confirm-password'].value, '');
  assert.equal(ui.nodes['password-error'].hidden, true);
  ui.click('password-open');
  ui.nodes['current-password'].value = 'dummy';
  ui.dialog.close();
  assert.equal(ui.nodes['current-password'].value, '');
  assert.equal(ui.requests(), 0);
});

test('password mismatch makes no request', async () => {
  const ui = setup();
  ui.click('password-open');
  ui.fill();
  ui.nodes['confirm-password'].value = 'different-test-password';
  await ui.submit();
  assert.equal(ui.requests(), 0);
  assert.equal(ui.nodes['password-error'].hidden, false);
});

test('successful change sends only API fields, clears passwords and redirects', async () => {
  const ui = setup(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  assert.equal(ui.nodes['password-save'].disabled, false);
  ui.click('password-open');
  ui.fill();
  await ui.submit();
  assert.equal(ui.sent[0].path, '/auth/change-password');
  assert.equal(ui.sent[0].options.method, 'POST');
  assert.equal(ui.sent[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(ui.sent[0].options.body), {
    current_password: 'test-current-password', new_password: 'test-new-password',
  });
  assert.deepEqual(ui.destinations, ['/login']);
  assert.equal(ui.nodes['current-password'].value, '');
  assert.equal(ui.nodes['new-password'].value, '');
  assert.equal(ui.nodes['confirm-password'].value, '');
});

test('wrong current password returns 401 but stays in dialog', async () => {
  const detail = '현재 비밀번호가 올바르지 않습니다.';
  const ui = setup(async () => ({ ok: false, status: 401, json: async () => ({ detail }) }));
  ui.click('password-open'); ui.fill(); await ui.submit();
  assert.deepEqual(ui.destinations, []);
  assert.equal(ui.nodes['password-error'].textContent, detail);
  assert.equal(ui.nodes['password-save'].disabled, false);
});

test('expired session redirects to login', async () => {
  const ui = setup(async () => ({ ok: false, status: 401,
    json: async () => ({ detail: '로그인이 필요합니다.' }) }));
  ui.click('password-open'); ui.fill(); await ui.submit();
  assert.deepEqual(ui.destinations, ['/login']);
});

test('pending change prevents duplicate submit and Escape close', async () => {
  let release;
  const ui = setup(async () => {
    await new Promise(resolve => { release = resolve; });
    return { ok: true, status: 200, json: async () => ({}) };
  });
  ui.click('password-open'); ui.fill();
  const first = ui.submit();
  await ui.submit();
  assert.equal(ui.requests(), 1);
  assert.equal(ui.nodes['password-cancel'].disabled, true);
  let prevented = false;
  assert.equal(typeof ui.dialog.listeners.cancel, 'function');
  ui.dialog.listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  release(); await first;
});

test('network error permits retry without claiming success', async () => {
  const ui = setup(async () => { throw new Error('offline'); });
  ui.click('password-open'); ui.fill(); await ui.submit();
  assert.equal(ui.nodes['password-error'].hidden, false);
  assert.equal(ui.nodes['password-save'].disabled, false);
  assert.deepEqual(ui.destinations, []);
});
