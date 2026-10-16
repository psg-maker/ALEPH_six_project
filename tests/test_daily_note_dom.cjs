/* 날짜별 메모 화면의 저장/수정/초안/오류 처리를 테스트 전용 DB로 검증한다. */
const assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('../work/ui-test-tools/node_modules/jsdom');const base='http://127.0.0.1:8765';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function waitFor(check,name){for(let i=0;i<180;i++){if(check())return;await sleep(40);}throw new Error('Timed out: '+name);}
async function api(path){const r=await fetch(base+path);assert(r.ok);return r.json();}
(async()=>{
 const html=await(await fetch(base)).text(),dom=new JSDOM(html,{url:base,runScripts:'outside-only'}),w=dom.window,d=w.document;
 const first='2099-06-17',second='2099-06-18';let puts=0,failSave=false,failRead=false,hold=false,release;
 w.fetch=async(path,options)=>{
  if(path.startsWith('/daily-notes/')){
   if(options?.method==='PUT'){puts++;if(failSave)return new Response(JSON.stringify({detail:'Test save failure'}),{status:500});if(hold)await new Promise(r=>{release=r;});}
   else if(failRead)return new Response(JSON.stringify({detail:'Test read failure'}),{status:500});
  }
  return fetch(new URL(path,base),options);
 };
 if(fs.existsSync('app/static/notes.js'))w.eval(fs.readFileSync('app/static/notes.js','utf8'));
 w.eval(fs.readFileSync('app/static/planner.js','utf8'));
 await waitFor(()=>d.querySelector('#task-list').getAttribute('aria-busy')==='false','load');
 const nav=d.querySelector('[data-view="notes"]');assert(nav,'Daily note navigation must exist');nav.click();
 const form=d.querySelector('#daily-note-form'),date=d.querySelector('#daily-note-date');
 await waitFor(()=>!form.querySelector('[type=submit]').disabled,'initial note');
 async function select(day){date.value=day;date.dispatchEvent(new w.Event('change'));await waitFor(()=>d.querySelector('#daily-notes-view').dataset.date===day&&!form.querySelector('[type=submit]').disabled,'date '+day);}
 await select(first);assert.equal(form.elements.content.value,'');assert.equal(await api('/daily-notes/'+first),null);
 form.elements.content.value='draft for first';form.elements.content.dispatchEvent(new w.Event('input',{bubbles:true}));await select(second);
 form.elements.content.value='draft for second';form.elements.content.dispatchEvent(new w.Event('input',{bubbles:true}));await select(first);assert.equal(form.elements.content.value,'draft for first');assert.equal(puts,0);
 console.log('PASS unwritten date, isolated date drafts, switching does not save automatically');
 const text='<script>alert(1)</script>\nsecond line';form.elements.content.value=text;form.elements.content.dispatchEvent(new w.Event('input',{bubbles:true}));
 hold=true;form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>typeof release==='function','pending note');assert.equal(puts,1);assert(date.disabled);release();hold=false;
 await waitFor(()=>!form.querySelector('[type=submit]').disabled&&!d.querySelector('#daily-note-status').hidden,'saved note');
 const saved=await api('/daily-notes/'+first);assert.equal(saved.content,text);assert.equal(d.querySelector('#daily-notes-view script'),null);assert.equal(form.elements.content.value,text);
 await select(second);assert.equal(form.elements.content.value,'draft for second');await select(first);assert.equal(form.elements.content.value,text);
 console.log('PASS single PUT, Unicode-safe literal/multiline value, saved date reload and other draft preserved');
 failSave=true;form.elements.content.value='retry draft';form.elements.content.dispatchEvent(new w.Event('input',{bubbles:true}));form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 await waitFor(()=>!d.querySelector('#daily-note-error').hidden&&!form.querySelector('[type=submit]').disabled,'save failure');assert.equal(form.elements.content.value,'retry draft');assert.equal((await api('/daily-notes/'+first)).content,text);
 failSave=false;form.elements.content.value='';form.elements.content.dispatchEvent(new w.Event('input',{bubbles:true}));form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 await waitFor(()=>!form.querySelector('[type=submit]').disabled&&!d.querySelector('#daily-note-status').hidden,'clear note');
 const cleared=await api('/daily-notes/'+first);assert.equal(cleared.id,saved.id);assert.equal(cleared.content,'');
 console.log('PASS failed save retains draft/database; empty string clears same note instead of creating another');
 failRead=true;date.value='2099-06-19';date.dispatchEvent(new w.Event('change'));
 await waitFor(()=>!d.querySelector('#daily-note-error').hidden,'read failure');assert(form.querySelector('[type=submit]').disabled);
 failRead=false;d.querySelector('#daily-note-retry').click();await waitFor(()=>!form.querySelector('[type=submit]').disabled,'read retry');assert.equal(form.elements.content.value,'');
 d.querySelector('[data-view="today"]').click();await waitFor(()=>d.querySelector('#daily-notes-view').hidden&&d.querySelector('#task-list').getAttribute('aria-busy')==='false','return today');
 assert(d.querySelectorAll('.task-row').length>0);console.log('PASS read failure blocks overwrite, retry recovers, existing Task screen still works');dom.window.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
