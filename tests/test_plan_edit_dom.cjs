const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('../work/ui-test-tools/node_modules/jsdom');
const base = 'http://127.0.0.1:8765';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function wait(check) { for (let i=0;i<150;i++) { if(check()) return; await pause(40); } throw Error('Timeout'); }
async function api(path) { return (await fetch(base+path)).json(); }
(async () => {
  const dom = new JSDOM(await (await fetch(base)).text(), {url:base,runScripts:'outside-only'});
  const w=dom.window,d=w.document;
  let fail=false,puts=0,hold=false,release;
  w.fetch = (path, options) => {
    if(options?.method==='PUT') { puts++; if(fail) return Promise.resolve(new Response('{"detail":"test failure"}',{status:500})); }
    if(options?.method==='PUT' && hold) return new Promise(resolve=>{release=()=>resolve(fetch(new URL(path,base),options));});
    return fetch(new URL(path,base),options);
  };
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.eval(fs.readFileSync('app/static/planner.js','utf8'));
  await wait(()=>d.querySelector('.plan-card'));
  const before=(await api('/plans'))[0];
  const versions=await api(`/plans/${before.id}/versions`);
  const tasks=await api(`/tasks?plan_id=${before.id}`);
  const card=()=>[...d.querySelectorAll('.plan-card')].find(c=>c.querySelector('.plan-name').textContent===before.title);
  assert(card().querySelector('.plan-edit'),'Plan edit button required');
  card().querySelector('.plan-edit').click();
  const form=d.querySelector('#plan-form');
  for(const key of ['title','description','category','start_date','end_date','priority','success_criteria','expected_minutes']) assert.equal(form.elements[key].value,String(before[key]??''));
  d.querySelector('[data-close="plan-dialog"]').click(); assert.equal(puts,0);
  card().querySelector('.plan-edit').click();
  form.elements.title.value='<script>plan edit</script>';
  fail=true; form.dispatchEvent(new w.Event('submit',{cancelable:true}));
  await wait(()=>!d.querySelector('#plan-error').hidden);
  assert.equal(form.elements.title.value,'<script>plan edit</script>');
  assert.equal((await api(`/plans/${before.id}/versions`)).length,versions.length);
  fail=false; hold=true; form.dispatchEvent(new w.Event('submit',{cancelable:true}));
  form.dispatchEvent(new w.Event('submit',{cancelable:true}));
  assert.equal(puts,2); assert(form.querySelector('[type=submit]').disabled);
  release(); hold=false;
  await wait(()=>!d.querySelector('#plan-dialog').open && d.querySelector('.plan-name').textContent==='<script>plan edit</script>');
  const after=(await api('/plans')).find(p=>p.id===before.id);
  assert.equal(after.status,before.status);
  assert.deepEqual(await api(`/tasks?plan_id=${before.id}`),tasks);
  const history=await api(`/plans/${before.id}/versions`);
  assert.equal(history.length,versions.length+1); assert.equal(history.at(-1).title,before.title);
  d.querySelector('.plan-history').click();
  await wait(()=>d.querySelector('#plan-history-list').textContent.includes(before.title));
  assert(d.querySelector('#plan-history-dialog').open);
  assert(d.querySelector('#plan-history-list').textContent.includes(before.success_criteria));
  assert.equal(d.querySelectorAll('#plan-history-list script').length,0);
  d.querySelector('[data-close="plan-history-dialog"]').click();
  d.querySelector('#add-plan').click();
  assert.equal(form.elements.title.value,'');
  console.log('PASS Plan prefill/cancel/failure/retry, old snapshot, same ID/status/Tasks, history and create reset');
  dom.window.close();
})().catch(e=>{console.error(e);process.exit(1);});
