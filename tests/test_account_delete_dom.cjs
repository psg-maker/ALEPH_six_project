/* Account deletion UI with dummy inputs and simulated HTTP responses. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function setup(fetchResponse) {
  const nodes = {};
  for (const id of ['account-delete-open', 'account-delete-dialog', 'account-delete-form',
    'account-delete-error', 'account-delete-cancel', 'account-delete-submit',
    'account-delete-password', 'account-delete-confirmation']) {
    nodes[id] = { disabled: true, hidden: true, value: '', listeners: {},
      addEventListener(event, handler) { this.listeners[event] = handler; } };
  }
  nodes['account-delete-form'].reset = () => {
    for (const id of ['account-delete-password', 'account-delete-confirmation']) {
      nodes[id].value = '';
    }
  };
  const dialog = nodes['account-delete-dialog'];
  nodes['account-delete-form'].reportValidity = () => true;
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.listeners.close?.(); };
  let requests = 0;
  const sent = [];
  const destinations = [];
  const path = 'app/static/account-delete.js';
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
    submit: () => nodes['account-delete-form'].listeners.submit({ preventDefault() {} }),
    fill() {
      nodes['account-delete-password'].value = 'test-current-password';
      nodes['account-delete-confirmation'].value = '계정 삭제';
    },
    requests: () => requests,
  };
}


test('delete button activates and successful deletion sends credentials then clears and redirects', async () => {
  const ui = setup(async () => ({ok: true, status: 200, json: async () => ({})}));
  assert.equal(ui.nodes['account-delete-submit'].disabled, false);
  ui.click('account-delete-open'); ui.fill(); await ui.submit();
  assert.equal(ui.sent[0].path, '/auth/account');
  assert.equal(ui.sent[0].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(ui.sent[0].options.body), {
    current_password: 'test-current-password', confirmation: '계정 삭제',
  });
  assert.equal(ui.nodes['account-delete-password'].value, '');
  assert.deepEqual(ui.destinations, ['/login']);
});
test('wrong confirmation sends no request', async () => {
  const ui = setup(); ui.fill();
  ui.nodes['account-delete-confirmation'].value = '다른 문구';
  await ui.submit();
  assert.equal(ui.requests(), 0);
  assert.equal(ui.nodes['account-delete-error'].hidden, false);
});
test('wrong password stays open and allows retry', async () => {
  const ui = setup(async () => ({ok: false, status: 401,
    json: async () => ({detail: '현재 비밀번호가 올바르지 않습니다.'})}));
  ui.click('account-delete-open'); ui.fill(); await ui.submit();
  assert.equal(ui.dialog.open, true);
  assert.deepEqual(ui.destinations, []);
  assert.equal(ui.nodes['account-delete-error'].hidden, false);
  assert.equal(ui.nodes['account-delete-submit'].disabled, false);
});
test('expired session redirects', async () => {
  const ui = setup(async () => ({ok: false, status: 401,
    json: async () => ({detail: '로그인이 필요합니다.'})}));
  ui.fill(); await ui.submit(); assert.deepEqual(ui.destinations, ['/login']);
});
test('pending deletion blocks duplicate submissions and Escape', async () => {
  let release;
  const ui = setup(async () => {
    await new Promise(resolve => {release = resolve;});
    return {ok: true, status: 200, json: async () => ({})};
  });
  ui.click('account-delete-open'); ui.fill(); const first = ui.submit();
  await ui.submit(); assert.equal(ui.requests(), 1);
  assert.equal(ui.nodes['account-delete-cancel'].disabled, true);
  let prevented = false;
  ui.dialog.listeners.cancel({preventDefault() {prevented = true;}});
  assert.equal(prevented, true); release(); await first;
});
test('network failure permits retry without redirect', async () => {
  const ui = setup(async () => {throw new Error('offline');});
  ui.fill(); await ui.submit();
  assert.equal(ui.nodes['account-delete-error'].hidden, false);
  assert.equal(ui.nodes['account-delete-submit'].disabled, false);
  assert.deepEqual(ui.destinations, []);
});
