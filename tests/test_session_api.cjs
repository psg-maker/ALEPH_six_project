/* Exercise each existing request wrapper without initializing its whole screen. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

for (const [file, name] of [
  ['planner.js', 'api'], ['notes.js', 'api'],
  ['review.js', 'api'], ['insights.js', 'get'],
]) {
  function setup(status) {
    const source = fs.readFileSync('app/static/' + file, 'utf8');
    const start = source.indexOf('  async function ' + name + '(');
    assert.notEqual(start, -1);
    const end = source.indexOf('\n  }', start) + '\n  }'.length;
    let checked = 0;
    let parsed = 0;
    const value = status === 200 ? [{ id: 1 }] : { detail: 'ordinary error' };
    const response = { status, ok: status === 200, json: async () => {
      parsed++;
      return value;
    } };
    const context = {
      fetch: async () => response,
      window: { alephSession: { checkResponse(r) {
        checked++;
        if (r.status === 401) throw new Error('Session expired');
        return r;
      } } },
    };
    vm.runInNewContext(source.slice(start, end) + '\nglobalThis.run = ' + name, context);
    return { run: context.run, value, checks: () => checked, parses: () => parsed };
  }

  test(file + ': 401 is handled before parsing response data', async () => {
    const ui = setup(401);
    await assert.rejects(() => ui.run('/test'), /Session expired/);
    assert.equal(ui.checks(), 1);
    assert.equal(ui.parses(), 0);
  });

  test(file + ': successful data and ordinary errors keep existing behavior', async () => {
    const ok = setup(200);
    assert.equal(await ok.run('/test'), ok.value);
    assert.equal(ok.checks(), 1);
    const error = setup(404);
    await assert.rejects(() => error.run('/test'), /ordinary error/);
    assert.equal(error.checks(), 1);
  });
}
