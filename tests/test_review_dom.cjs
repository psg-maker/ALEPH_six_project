/* 회고 저장 → 다음 계획 미리보기 → 생성·이동의 실제 API 연결을 검증한다. */
const assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('../work/ui-test-tools/node_modules/jsdom');const base='http://127.0.0.1:8765';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function waitFor(check,name){for(let i=0;i<200;i++){if(check())return;await sleep(40);}throw new Error('Timed out: '+name);}
async function api(path,method='GET',payload){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined});assert(r.ok);return r.json();}
(async()=>{
 const html=await(await fetch(base)).text(),dom=new JSDOM(html,{url:base,runScripts:'outside-only'}),w=dom.window,d=w.document;
 const today=d.body.dataset.today;const source=await api('/plans','POST',{title:'Review UI '+Date.now(),category:'study',start_date:today,end_date:today,priority:'HIGH',success_criteria:'learn',expected_minutes:60});
 const original=(await api('/plans')).find(p=>p.id===source.id);
 let puts=0,nextPosts=0,failSave=false,failNext=false,hold=false,release;
 w.fetch=async(path,options)=>{
  if(options?.method==='PUT'&&/\/review$/.test(path)){puts++;if(failSave)return new Response(JSON.stringify({detail:'Test save error'}),{status:500});}
  if(options?.method==='POST'&&/\/next-plan$/.test(path)){nextPosts++;if(failNext)return new Response(JSON.stringify({detail:'Test create error'}),{status:500});if(hold)await new Promise(r=>{release=r;});}
  return fetch(new URL(path,base),options);
 };
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 if(fs.existsSync('app/static/review.js'))w.eval(fs.readFileSync('app/static/review.js','utf8'));
 w.eval(fs.readFileSync('app/static/insights.js','utf8'));w.eval(fs.readFileSync('app/static/planner.js','utf8'));
 await waitFor(()=>d.querySelector('#task-list').getAttribute('aria-busy')==='false','load');d.querySelector('[data-view="insights"]').click();
 await waitFor(()=>d.querySelector('#insight-plan').options.length>0,'plans');const select=d.querySelector('#insight-plan');select.value=source.id;select.dispatchEvent(new w.Event('change'));
 const form=d.querySelector('#review-form');assert(form,'Review form must exist in insights');
 await waitFor(()=>!form.querySelector('[type=submit]').disabled&&d.querySelector('#review-panel').dataset.planId===String(source.id),'unwritten review');
 assert.equal(form.elements.reflection.value,'');assert.equal(await api(`/plans/${source.id}/review`),null);
 d.querySelector('#next-plan-open').click();assert.equal(d.querySelector('#next-plan-dialog').open,false);
 const reflection='<script>review</script>';form.elements.reflection.value=reflection;form.elements.improvement.value='Split work into small tasks';form.elements.next_action.value='Practice 20 minutes daily';form.dispatchEvent(new w.Event('input',{bubbles:true}));
 failSave=true;form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 await waitFor(()=>!d.querySelector('#review-error').hidden&&!form.querySelector('[type=submit]').disabled,'save error');assert.equal(form.elements.reflection.value,reflection);assert.equal(await api(`/plans/${source.id}/review`),null);
 failSave=false;form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 await waitFor(()=>!d.querySelector('#review-status').hidden&&!form.querySelector('[type=submit]').disabled,'saved review');
 const saved=await api(`/plans/${source.id}/review`);assert.equal(saved.reflection,reflection);assert.equal(saved.next_plan_id,null);
 console.log('PASS unwritten review, missing improvement guard, failed save preserves draft, successful PUT persists fields');
 d.querySelector('#next-plan-open').click();assert(d.querySelector('#next-plan-dialog').open);const nf=d.querySelector('#next-plan-form');
 assert(d.querySelector('#next-plan-preview').textContent.includes(saved.improvement));assert(d.querySelector('#next-plan-preview').textContent.includes(saved.next_action));
 const nextTitle='Next plan '+Date.now();nf.elements.title.value=nextTitle;nf.elements.description.value='My own note';nf.elements.description.dispatchEvent(new w.Event('input',{bubbles:true}));
 assert(d.querySelector('#next-plan-preview').textContent.includes('My own note'));
 d.querySelector('[data-close="next-plan-dialog"]').click();assert.equal(nextPosts,0);assert.equal((await api(`/plans/${source.id}/review`)).next_plan_id,null);
 console.log('PASS preview combines editable description and saved improvement/action; cancellation creates nothing');
 d.querySelector('#next-plan-open').click();nf.elements.title.value=nextTitle;nf.elements.description.value='My own note';failNext=true;
 const countBefore=(await api('/plans')).length;nf.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 await waitFor(()=>!d.querySelector('#next-plan-error').hidden&&!nf.querySelector('[type=submit]').disabled,'failed creation');
 assert(d.querySelector('#next-plan-dialog').open);assert.equal(nf.elements.title.value,nextTitle);assert.equal((await api('/plans')).length,countBefore);
 failNext=false;hold=true;const beforePosts=nextPosts;
 nf.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));nf.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>typeof release==='function','pending next Plan');assert.equal(nextPosts,beforePosts+1);release();hold=false;
 await waitFor(()=>!d.querySelector('#next-plan-dialog').open&&!d.querySelector('#review-next-link').hidden,'created linked Plan');
 const linked=await api(`/plans/${source.id}/review`);assert(linked.next_plan_id);const plans=await api('/plans'),next=plans.find(p=>p.id===linked.next_plan_id);
 assert.equal(next.title,nextTitle);assert(next.description.includes('My own note'));assert(next.description.includes(saved.improvement));assert(next.description.includes(saved.next_action));assert.deepEqual(plans.find(p=>p.id===source.id),original);
 assert(d.querySelector('#next-plan-open').hidden);assert(d.querySelector('#review-next-link').textContent.includes(nextTitle));
 console.log('PASS single next-Plan POST, carryover saved once and linked, original Plan unchanged, duplicate creation hidden');
 form.elements.reflection.value='Updated later';form.dispatchEvent(new w.Event('input',{bubbles:true}));form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 await waitFor(()=>!form.querySelector('[type=submit]').disabled,'edit linked review');assert.equal((await api(`/plans/${source.id}/review`)).next_plan_id,next.id);
 d.querySelector('#review-next-link').click();await waitFor(()=>d.querySelector('#page-title').textContent===nextTitle&&d.querySelector('#insights-view').hidden&&d.querySelector('#task-list').getAttribute('aria-busy')==='false','go next Plan');
 assert(d.querySelector('#page-caption').textContent.includes(saved.improvement));
 console.log('PASS later review edits retain link; open next Plan shows transferred description');dom.window.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
