const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('../work/ui-test-tools/node_modules/jsdom');
const base='http://127.0.0.1:8765';
async function wait(check){for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,40));}throw Error('Timeout');}
(async()=>{
 const dom=new JSDOM(await(await fetch(base)).text(),{url:base,runScripts:'outside-only'});
 const w=dom.window,d=w.document;
 w.fetch=(path,options)=>fetch(new URL(path,base),options);
 w.eval(fs.readFileSync('app/static/planner.js','utf8'));
 await wait(()=>d.querySelector('#task-list').getAttribute('aria-busy')==='false');
 assert(d.querySelector('#public-access-notice'),'Public access notice required');
 assert(d.querySelector('#sort-by'),'Sort selection required');
 const plan=(await(await fetch(base+'/plans')).json())[0];
 const today=d.body.dataset.today;
 const prefix='Sort-'+Date.now();const ids=[];
 for(const [i,minutes,due] of [[0,30,null],[1,10,today],[2,10,today]]){
  const r=await fetch(base+'/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan_id:plan.id,title:prefix+i,scheduled_date:today,due_date:due,priority:'LOW',expected_minutes:minutes})});
  assert(r.ok);ids.push((await r.json()).id);
 }
 d.querySelector('#refresh').click();
 await wait(()=>d.querySelector('#task-list').textContent.includes(prefix+'2'));
 const search=d.querySelector('#search');search.value=prefix;search.dispatchEvent(new w.Event('input'));
 const sort=d.querySelector('#sort-by'),order=d.querySelector('#sort-order');
 const titles=()=>[...d.querySelectorAll('.task-title')].map(n=>n.textContent);
 sort.value='expected_minutes';sort.dispatchEvent(new w.Event('change'));
 assert.deepEqual(titles(),[prefix+'1',prefix+'2',prefix+'0']);
 order.value='desc';order.dispatchEvent(new w.Event('change'));
 assert.deepEqual(titles(),[prefix+'0',prefix+'1',prefix+'2']);
 sort.value='due_date';sort.dispatchEvent(new w.Event('change'));
 assert.deepEqual(titles(),[prefix+'1',prefix+'2',prefix+'0']);
 assert(d.querySelector('#sort-help').textContent.includes('ID'));
 assert(d.querySelector('#sort-help').textContent.includes('마지막'));
 console.log('PASS notice, numeric asc/desc, ID tie order, missing dates last and search retained');
 dom.window.close();
})().catch(e=>{console.error(e);process.exit(1);});
