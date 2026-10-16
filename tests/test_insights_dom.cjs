/* 집계 숫자와 클릭한 근거 기록의 일치를 테스트 전용 DB에서 확인한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('../work/ui-test-tools/node_modules/jsdom');
const base = 'http://127.0.0.1:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(check, name) { for (let i=0;i<180;i++){if(check())return;await sleep(40);}throw new Error('Timed out: '+name); }
async function api(path, method='GET', payload) { const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined});assert(r.ok);return r.json(); }
(async()=>{
  const html=await(await fetch(base)).text();const dom=new JSDOM(html,{url:base,runScripts:'outside-only'});const w=dom.window,d=w.document;
  const today=d.body.dataset.today;const yesterday=new Date(today+'T12:00:00');yesterday.setDate(yesterday.getDate()-1);const past=[yesterday.getFullYear(),String(yesterday.getMonth()+1).padStart(2,'0'),String(yesterday.getDate()).padStart(2,'0')].join('-');
  const planBody={title:'Insights '+Date.now(),category:'study',start_date:past,end_date:today,priority:'HIGH',success_criteria:'test',expected_minutes:999};
  const plan=await api('/plans','POST',planBody);const empty=await api('/plans','POST',{...planBody,title:'Empty '+Date.now()});const tasks=[];
  for(let i=0;i<4;i++){const t=await api('/tasks','POST',{plan_id:plan.id,title:'Evidence '+i,scheduled_date:today,due_date:i<2?past:today,priority:'HIGH',expected_minutes:(i+1)*10});tasks.push(t);}
  await api(`/tasks/${tasks[1].id}/complete`,'PATCH');await api(`/tasks/${tasks[2].id}/complete`,'PATCH');
  for(const [index,minutes,reason]of [[0,5,'reason A'],[0,7,'reason B'],[1,20,'DONE reason'],[2,null,'   ']])await api(`/tasks/${tasks[index].id}/executions`,'POST',{actual_minutes:minutes,blocked_reason:reason});
  let failSummary=false,failEvidence=false;
  w.fetch=(path,options)=>{
    if((failSummary&&/\/summary$/.test(path))||(failEvidence&&path.startsWith('/tasks?')))return Promise.resolve(new Response(JSON.stringify({detail:'Test read failure'}),{status:500}));
    return fetch(new URL(path,base),options);
  };w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  if(fs.existsSync('app/static/insights.js'))w.eval(fs.readFileSync('app/static/insights.js','utf8'));
  w.eval(fs.readFileSync('app/static/planner.js','utf8'));
  await waitFor(()=>d.querySelector('#task-list').getAttribute('aria-busy')==='false','initial load');
  const nav=d.querySelector('[data-view="insights"]');assert(nav,'Insights navigation must exist');nav.click();
  await waitFor(()=>d.querySelector('#insight-plan')?.options.length>0,'plan choices');
  const select=d.querySelector('#insight-plan');select.value=plan.id;select.dispatchEvent(new w.Event('change'));
  await waitFor(()=>d.querySelector('[data-metric="task_count"] .insight-number')?.textContent==='4','summary');
  const expected={task_count:4,completed_task_count:2,overdue_task_count:1,blocked_task_count:2,expected_minutes:100,actual_minutes:32,difference_minutes:-68};
  for(const [key,value]of Object.entries(expected))assert.equal(Number(d.querySelector(`[data-metric="${key}"] .insight-number`).textContent),value);
  assert(d.querySelector('#insight-rate').textContent.includes('50'));
  console.log('PASS Plan summary cards and completion rate match server, including time units/difference');
  d.querySelector('#insight-rate-open').click();
  await waitFor(()=>d.querySelector('#insight-evidence').dataset.metric==='completed_task_count'&&d.querySelector('#insight-evidence').getAttribute('aria-busy')==='false','completion rate evidence');
  assert.equal(d.querySelectorAll('.evidence-task').length,2);
  for(const [metric,count]of [['task_count',4],['completed_task_count',2],['overdue_task_count',1],['blocked_task_count',2]]){
    d.querySelector(`[data-metric="${metric}"]`).click();
    await waitFor(()=>d.querySelector('#insight-evidence').getAttribute('aria-busy')==='false'&&d.querySelector('#insight-evidence').dataset.metric===metric,'task evidence '+metric);
    assert.equal(d.querySelectorAll('.evidence-task').length,count);
    const listed=[...d.querySelectorAll('.evidence-task')].map(n=>Number(n.dataset.taskId));assert.equal(new Set(listed).size,count);assert(listed.every(id=>tasks.some(t=>t.id===id)));
  }
  assert(d.querySelector('#insight-evidence').textContent.includes('DONE reason'));
  d.querySelector('.evidence-open-record').click();await waitFor(()=>d.querySelector('#execution-dialog').open&&d.querySelector('#execution-history').getAttribute('aria-busy')==='false','underlying executions');
  assert(d.querySelectorAll('.execution-item').length>0);d.querySelector('[data-close="execution-dialog"]').click();
  console.log('PASS all/completed/overdue/blocked evidence, deduplication, reasons and record drill-down');
  for(const metric of ['expected_minutes','actual_minutes','difference_minutes']){
    d.querySelector(`[data-metric="${metric}"]`).click();
    await waitFor(()=>d.querySelector('#insight-evidence').getAttribute('aria-busy')==='false'&&d.querySelector('#insight-evidence').dataset.metric===metric,'time evidence '+metric);
    assert.equal(Number(d.querySelector('#insight-evidence-total').dataset.total),expected[metric]);
    if(metric==='actual_minutes')assert.equal(d.querySelectorAll('.evidence-execution').length,4);
  }
  console.log('PASS expected/actual/difference links show exact underlying sums; NULL retained');
  select.value=empty.id;select.dispatchEvent(new w.Event('change'));
  await waitFor(()=>d.querySelector('[data-metric="task_count"] .insight-number').textContent==='0'&&d.querySelector('#insight-evidence').getAttribute('aria-busy')==='false','empty plan');
  assert.equal(d.querySelectorAll('.evidence-task').length,0);assert.equal(d.querySelector('[data-metric="actual_minutes"] .insight-number').textContent,'0');
  failSummary=true;d.querySelector('#insight-refresh').click();
  await waitFor(()=>!d.querySelector('#insight-error').hidden,'summary error');
  assert.equal(d.querySelector('[data-metric="task_count"] .insight-number').textContent,'—');assert(d.querySelector('[data-metric="task_count"]').disabled);
  failSummary=false;d.querySelector('#insight-refresh').click();
  await waitFor(()=>d.querySelector('[data-metric="task_count"] .insight-number').textContent==='0','summary retry');
  failEvidence=true;d.querySelector('[data-metric="task_count"]').click();
  await waitFor(()=>!d.querySelector('#insight-evidence-error').hidden&&d.querySelector('#insight-evidence').getAttribute('aria-busy')==='false','evidence error');
  assert.equal(d.querySelector('[data-metric="task_count"] .insight-number').textContent,'0');
  failEvidence=false;d.querySelector('[data-metric="task_count"]').click();
  await waitFor(()=>d.querySelector('#insight-evidence-error').hidden&&d.querySelector('#insight-evidence').dataset.metric==='task_count','evidence retry');
  console.log('PASS summary failure clears stale numbers; evidence failure visible; both retry successfully');
  d.querySelector('[data-view="today"]').click();await waitFor(()=>d.querySelector('#task-list').getAttribute('aria-busy')==='false'&&d.querySelector('#insights-view').hidden,'return today');
  assert(d.querySelectorAll('.task-row').length>0);
  console.log('PASS empty Plan and navigation back to existing Task UI');dom.window.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
