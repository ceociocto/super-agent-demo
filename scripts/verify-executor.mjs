import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ColimaExecutor, dockerRunArgs } from '../server/executor.js';
const executor = new ColimaExecutor();
const host=await executor.status();
assert.equal(host.available,true,host.error);
const probe='inspect-'+randomUUID();
try {
 const args=dockerRunArgs({runId:probe}).slice(2).filter(x=>x!=='--rm');args[0]='create';
 const container=await executor.command(args);
 const [info]=JSON.parse(await executor.command(['inspect',container]));
 assert.equal(info.Config.User,'1000:1000');assert.equal(info.HostConfig.NetworkMode,'none');
 assert.equal(info.HostConfig.ReadonlyRootfs,true);assert.deepEqual(info.HostConfig.CapDrop,['ALL']);
 assert.ok(!info.HostConfig.Binds?.length);assert.equal(info.HostConfig.Memory,256*1024*1024);
 assert.equal(info.HostConfig.PidsLimit,64);assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges'));
 console.log('PASS real Docker isolation settings');
} finally {await executor.cleanup(probe);}
const knowledge=[{id:'VERIFY-001',title:'Atlas 发布规范',content:'发布前必须完成回归测试、负责人审阅、回滚方案。Atlas 发布观察窗口为 30 分钟。\n本周完成订单修复；搜索索引待验收。'}];
for(const scenario of ['bugfix','docs','analysis']){
 const result=await executor.run({id:'verify-'+scenario,runId:randomUUID(),revision:1,scenario,messages:[{role:'user',text:'Atlas 发布规范和本周进展'}],knowledge});
 assert.equal(result.execution.exitCode,0);assert.match(result.execution.platform,/^linux\//);
 if(scenario==='bugfix'){assert.equal(result.execution.tests.before.failed,1);assert.equal(result.execution.tests.after.passed,3);assert.equal(result.execution.tests.after.failed,0);}
 else {assert.ok(result.artifact.content.includes('30 分钟'));assert.equal(result.artifact.citations[0].id,'VERIFY-001');}
 console.log(JSON.stringify({scenario,platform:result.execution.platform,exitCode:result.execution.exitCode,tests:scenario==='bugfix'?{before:result.execution.tests.before.failed,after:result.execution.tests.after.passed}:undefined,sources:result.artifact.citations.length}));
}
const followup=await executor.run({id:'verify-followup',runId:randomUUID(),revision:2,scenario:'docs',messages:[{role:'user',text:'Atlas发布规范有哪些检查？'},{role:'user',text:'再展开一点'}],knowledge});
assert.equal(followup.artifact.citations.length,1);
const missing=await executor.run({id:'verify-missing',runId:randomUUID(),revision:1,scenario:'docs',messages:[{role:'user',text:'月球玄武岩的密度'}],knowledge});
assert.equal(missing.artifact.citations.length,0);assert.ok(missing.artifact.content.includes('证据不足'));
const controller=new AbortController();
const aborted=executor.run({id:'verify-cancel',runId:randomUUID(),revision:1,scenario:'bugfix',messages:[],knowledge:[],signal:controller.signal,onStart:()=>controller.abort()});
await assert.rejects(aborted,{code:'ABORTED',cleanupPending:false});
console.log('PASS actual Linux followup, no-evidence response and create-stage cancellation');
