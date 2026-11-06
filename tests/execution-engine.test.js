import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine.js';

const request = (extra={}) => ({eventId:'a',source:'github',sourceThreadId:'thread-a',actor:'alice',text:'修复订单查询',scenario:'bugfix',executionTarget:'colima',...extra});
const result = content => ({artifact:{name:'result.md',content,kind:'real_execution',mimeType:'text/markdown',citations:[]},execution:{platform:'linux/arm64',exitCode:0,tests:{after:{passed:3,failed:0}}}});
function executor() {
  const jobs=[];
  return {jobs,cleanup:async()=>({removed:false}),run(input){return new Promise((resolve,reject)=>{jobs.push({...input,resolve,reject});input.onStart({containerId:'container-'+input.runId,runId:input.runId});input.onLog('Linux worker started');});}};
}
const flush = () => new Promise(r=>setImmediate(r));

test('Colima task has durable independent runs, logs and actual evidence; explicit review is required',async()=>{
 const ex=executor(), e=new Engine({executor:ex});
 try{const task=e.ingest(request()).task;e.tick();await flush();assert.equal(e.task(task.id).status,'executing');
 assert.equal(ex.jobs[0].knowledge.length,3);assert.equal(e.task(task.id).runs.length,1);assert.match(e.task(task.id).logs[0].text,/Linux/);
 ex.jobs[0].resolve(result('tested result'));await flush();let current=e.task(task.id);assert.equal(current.status,'awaiting_approval');assert.equal(current.execution.tests.after.passed,3);assert.equal(current.runs[0].status,'completed');
 assert.throws(()=>e.action(task.id,{action:'approve'}),/expectedRevision/);e.action(task.id,{action:'approve',expectedRevision:1});
 e.followup(task.id,{text:'补充测试说明'});e.tick();await flush();assert.notEqual(ex.jobs[0].runId,ex.jobs[1].runId);assert.equal(e.task(task.id).runs.length,2);
 assert.ok(ex.jobs[1].messages.some(m=>m.text==='tested result'));ex.jobs[1].resolve(result('v2'));await flush();assert.equal(e.task(task.id).artifact.content,'v2');assert.equal(e.task(task.id).runs[0].artifact.content,'tested result');
 }finally{e.close();}
});
test('pause/cancel/followup invalidate in-flight executor result and preserve histories',async()=>{
 for(const action of ['pause','cancel','followup']){const ex=executor(),e=new Engine({executor:ex});try{const t=e.ingest(request()).task;e.tick();await flush();
 if(action==='followup')e.followup(t.id,{text:'new revision'});else e.action(t.id,{action});assert.equal(ex.jobs[0].signal.aborted,true);
 ex.jobs[0].resolve(result('stale'));await flush();assert.equal(e.task(t.id).artifact,null);assert.notEqual(e.task(t.id).status,'awaiting_approval');assert.equal(e.task(t.id).runs[0].status,'discarded');
 }finally{e.close();}}
});
test('executor failure is explicit, retry preserves task ID and creates new run',async()=>{
 const ex=executor(),e=new Engine({executor:ex});try{const t=e.ingest(request()).task;e.tick();await flush();ex.jobs[0].reject(new Error('VM unavailable'));await flush();assert.equal(e.task(t.id).status,'failed');assert.equal(e.task(t.id).runs[0].status,'failed');
 e.action(t.id,{action:'retry'});e.tick();await flush();assert.equal(ex.jobs[1].id,t.id);ex.jobs[1].resolve(result('recovered'));await flush();assert.equal(e.task(t.id).status,'awaiting_approval');assert.equal(e.task(t.id).runs.length,2);
 }finally{e.close();}
});
test('queued tasks respect bounded executor slots including cancelling jobs',async()=>{
 const ex=executor(),e=new Engine({executor:ex,maxWorkers:1});try{const a=e.ingest(request()).task;const b=e.ingest(request({eventId:'b',sourceThreadId:'b'})).task;e.tick();await flush();assert.equal(ex.jobs.length,1);e.action(a.id,{action:'cancel'});e.tick();await flush();assert.equal(ex.jobs.length,1);
 ex.jobs[0].resolve(result('late'));await flush();e.tick();await flush();assert.equal(ex.jobs.length,2);assert.equal(ex.jobs[1].id,b.id);ex.jobs[1].resolve(result('B'));await flush();
 }finally{e.close();}
});
test('knowledge selection is snapshotted, no cross-task sources; deleted sources do not reseed on restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sa-kb-')),path=join(dir,'db.sqlite'),ex=executor();let e=new Engine({dbPath:path,executor:ex});
 try{const doc=e.putKnowledge({title:'测试资料',content:'只允许当前任务使用的原文'});const t=e.ingest(request({scenario:'docs',knowledgeIds:[doc.id]})).task;e.deleteKnowledge(doc.id);e.tick();await flush();assert.deepEqual(ex.jobs[0].knowledge.map(d=>d.id),[doc.id]);assert.equal(ex.jobs[0].knowledge[0].content,doc.content);
 ex.jobs[0].resolve(result('source answer'));await flush();for(const d of e.knowledge().documents)e.deleteKnowledge(d.id);e.close();e=new Engine({dbPath:path,executor:ex});assert.equal(e.knowledge().documents.length,0);assert.equal(e.task(t.id).knowledgeSnapshot[0].id,doc.id);
 assert.throws(()=>e.ingest(request({eventId:'b',sourceThreadId:'b',knowledgeIds:['missing']})),/不存在/);
 }finally{e.close();rmSync(dir,{recursive:true,force:true});}
});
test('restart marks running attempt interrupted and requires explicit retry after cleanup',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sa-recovery-')),path=join(dir,'db.sqlite'),ex=executor();let e=new Engine({dbPath:path,executor:ex});
 try{const t=e.ingest(request()).task;e.tick();await flush();const runId=ex.jobs[0].runId;e.close();e=new Engine({dbPath:path,executor:ex});assert.equal(e.task(t.id).status,'failed');assert.equal(e.task(t.id).runs[0].status,'interrupted');
 const cleaned=[];ex.cleanup=async id=>{cleaned.push(id);return{removed:true};};await e.recoverExecutions();assert.deepEqual(cleaned,[runId]);assert.equal(e.task(t.id).runs[0].cleanupComplete,true);e.tick();await flush();assert.equal(ex.jobs.length,1);
 }finally{e.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed container cleanup survives cancellation and blocks fresh dispatch until cleanup succeeds',async()=>{
 const ex=executor(),e=new Engine({executor:ex});
 try{
  const task=e.ingest(request()).task;e.tick();await flush();e.action(task.id,{action:'pause'});
  ex.jobs[0].reject(Object.assign(new Error('Cancelled with uncertain cleanup'),{cleanupPending:true,cleanupError:'Docker unreachable'}));await flush();
  assert.equal(e.task(task.id).runs[0].cleanupPending,true);
  ex.cleanup=async()=>{throw new Error('offline');};
  e.action(task.id,{action:'resume'});e.tick();await flush();assert.equal(ex.jobs.length,1);assert.equal(e.task(task.id).status,'failed');assert.match(e.task(task.id).error,/清理尚未确认/);
  ex.cleanup=async()=>({removed:true});e.action(task.id,{action:'retry'});e.tick();await flush();assert.equal(ex.jobs.length,2);assert.equal(e.task(task.id).runs[0].cleanupPending,false);
  ex.jobs[1].resolve(result('safe retry'));await flush();assert.equal(e.task(task.id).status,'awaiting_approval');
 }finally{e.close();}
});

test('an absent container does not clear an uncertain creation request',async()=>{
 const ex=executor(),e=new Engine({executor:ex});
 try{
 const t=e.ingest(request()).task;e.tick();await flush();
 ex.jobs[0].reject(Object.assign(new Error('create timed out'),{cleanupPending:true,creationUncertain:true}));await flush();
 await e.recoverExecutions();assert.equal(e.task(t.id).runs[0].cleanupPending,true);
 e.action(t.id,{action:'retry'});e.tick();await flush();assert.equal(ex.jobs.length,1);
 ex.cleanup=async()=>({removed:true});await e.recoverExecutions();
 assert.equal(e.task(t.id).runs[0].cleanupPending,false);
 }finally{e.close();}
});

test('restart during create preserves uncertainty until an actual container is removed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sa-create-recovery-')),path=join(dir,'db.sqlite');
 const ex={cleanup:async()=>({removed:false}),run:()=>new Promise(()=>{})};let e=new Engine({dbPath:path,executor:ex});
 try{
 const task=e.ingest(request()).task;e.tick();await flush();
 assert.equal(e.task(task.id).runs[0].creationUncertain,true);e.close();
 e=new Engine({dbPath:path,executor:ex});await e.recoverExecutions();
 assert.equal(e.task(task.id).runs[0].cleanupPending,true);
 ex.cleanup=async()=>({removed:true});await e.recoverExecutions();
 assert.equal(e.task(task.id).runs[0].cleanupPending,false);
 }finally{e.close();rmSync(dir,{recursive:true,force:true});}
});
