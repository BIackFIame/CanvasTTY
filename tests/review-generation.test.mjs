import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {realpathSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentControlService} from '../src/main/services/AgentControlService.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {availableRegistry, fakeSpawner} from './helpers/terminal.mjs';

const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; };
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function until(predicate) {
 for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
 throw new Error('Expected review lifecycle transition did not occur');
}
async function fixture(t, {account=false} = {}) {
 const root=realpathSync(await mkdtemp(join(tmpdir(),'ctty-review-generation-')));
 const prompts=[],reviews=[],calls=[]; let terminals;
 terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner(calls,{onWrite(data){
  if(data.includes('Review only the supplied answer')){
   const reviewer=terminals.listMetadata().findLast(row=>row.title.startsWith('Review:'));
   prompts.push({id:reviewer.id,text:data});
   terminals.applyProviderSignal(reviewer.id,{state:'working'},'hook');
  }else{
   const worker=terminals.listMetadata().find(row=>row.role==='subagent'&&!row.title.startsWith('Review:'));
   if(worker)terminals.applyProviderSignal(worker.id,{state:'working'},'hook');
  }
 }}));
 terminals.configureIsolation({containment:()=>true,
  decide:({profile})=>profile==='plan'?{apply:true,profile,isolation:{state:'on',layer:'seatbelt'}}:{apply:false,profile},
  wrap:launch=>({command:launch.command,args:[...launch.args],env:launch.env,cleanup(){}})});
 const accounts=[];
 if(account){
  const {LaunchPipeline}=await import('../src/main/services/LaunchPipeline.ts');
  terminals.configureLaunchPipeline(new LaunchPipeline({
   contributors:()=>[{pluginId:'canvastty-accounts',pluginName:'Accounts',serviceId:'accounts',secrets:false,
    launch:{fields:[{key:'account',label:'Model account',kind:'text'}],delegable:true}}],
   call:async()=>({env:{FIXTURE_RUN_FILE:'{launchFiles}/fixture.txt'},files:[{relPath:'fixture.txt',content:'fixture account data'}]}),
   secret:async()=>null,runsRoot:join(root,'runs'),timeoutMs:2000
  }));
  const prepare=terminals.prepareReviewerAccount.bind(terminals);
  terminals.prepareReviewerAccount=async input=>{
   const prepared=await prepare(input),row={id:prepared.id,file:prepared.contribution.env.FIXTURE_RUN_FILE,cleanupCalls:0};
   accounts.push(row);const cleanup=prepared.contribution.cleanup;
   prepared.contribution.cleanup=async()=>{row.cleanupCalls++;await cleanup();};return prepared;
  };
 }
 const control=new AgentControlService(terminals,{reviewModel:()=> 'fixture-reviewer',reviewDiff:async()=>'+worker scoped fixture',
  waitTiming:{checkMs:1,settleMs:0,quietMs:10_000},onReview:(_id,review)=>reviews.push(review)});
 t.after(async()=>{for(const row of terminals.listMetadata())control.forgetSession(row.id);terminals.disposeAll();await rm(root,{recursive:true,force:true});});
 const parent=terminals.create({provider:'codex',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
 const worker=await control.spawn({parentSessionId:parent.id,provider:'codex',cwd:root,review:true,initialPrompt:'first task',...(account?{launchOptions:{'canvastty-accounts':{account:'fixture-model'}}}:{})});
 const finish=(id,text)=>{terminals.recordAnswer(id,{text,truncated:false});terminals.applyProviderSignal(id,{state:'idle',event:'Stop'},'hook');};
 return {control,terminals,worker,prompts,reviews,finish,calls,accounts};
}

test('new worker input cancels obsolete review, ignores delayed old verdicts for all waiters, and replaces the automatic watcher',async t=>{
 const f=await fixture(t),oldWaitReached=deferred(),releaseOld=deferred();
 t.after(()=>releaseOld.resolve());
 const wait=f.control.waitFor.bind(f.control);let oldReviewerId;
 // Pause the old provider result at the return boundary; cancellation must remain effective even after it produced a verdict.
 f.control.waitFor=async(id,request)=>{
  const isReviewer=f.terminals.getMetadata(id)?.title.startsWith('Review:');
  if(isReviewer&&!oldReviewerId){
   oldReviewerId=id;const result=await wait(id,request);oldWaitReached.resolve();await releaseOld.promise;return result;
  }
  return wait(id,request);
 };
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":"old approval"}');await oldWaitReached.promise;
 const oldPoll1=f.control.resultWithReview(f.worker.id),oldPoll2=f.control.resultWithReview(f.worker.id);
 const oldWait=f.control.waitFor(f.worker.id,{timeoutMs:1000});
 await f.control.send(f.worker.id,'second task');
 assert.equal(f.terminals.getMetadata(oldReviewerId),null,'obsolete active reviewer is disposed');
 f.finish(f.worker.id,'second answer');await until(()=>f.prompts.length===2);
 assert.match(f.prompts[1].text,/second answer/u);assert.ok(!f.prompts[1].text.includes('first answer'));
 releaseOld.resolve();
 for(const result of await Promise.all([oldPoll1,oldPoll2,oldWait])){
  assert.equal(result.review.status,'unavailable');assert.equal(result.review.verdict,undefined);
  assert.match(result.review.reason,/prompt changed|removed/u);
 }
 assert.equal(f.reviews.length,0,'old verdict must not be cached or published');
 const pending=await f.control.resultWithReview(f.worker.id,{deferReview:true});
 assert.equal(pending.review.status,'pending');await tick();assert.equal(f.prompts.length,2,'old finally/watcher must not erase or restart the replacement');
 f.finish(f.prompts[1].id,'{"verdict":"reject","findings":"second task needs repair"}');
 await until(()=>f.reviews.length===1);
 const current=await f.control.resultWithReview(f.worker.id);
 assert.equal(current.answer.text,'second answer');assert.equal(current.review.status,'rejected');
 assert.match(current.review.notes,/second task needs repair/u);assert.equal(f.reviews[0].verdict,'reject');
 assert.equal(f.terminals.listMetadata().filter(row=>row.title.startsWith('Review:')).length,1);
});

test('a prompt sent while a cached review is returning cannot attach its old verdict to the latest answer',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const oldPoll=f.control.resultWithReview(f.worker.id);
 const sending=f.control.send(f.worker.id,'second task');
 f.finish(f.worker.id,'second answer');
 const result=await oldPoll;await sending;
 assert.equal(result.review.status,'unavailable');assert.equal(result.review.verdict,undefined);
 assert.equal(result.answer.text,'second answer');
});

test('an already-aborted send leaves the active review intact',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 const controller=new AbortController();controller.abort();
 await assert.rejects(f.control.send(f.worker.id,'never delivered',true,controller.signal),{name:'PromptNotDeliveredError'});
 assert.ok(f.terminals.getMetadata(f.prompts[0].id));
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 assert.equal((await f.control.resultWithReview(f.worker.id)).review.status,'accepted');
 assert.equal(f.prompts.length,1);
});


test('unsubmitted input invalidates the old verdict without reviewing the previous answer again',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 await f.control.send(f.worker.id,'draft input',false);
 // A partial input does not start a worker turn or complete an answer.
 f.terminals.applyProviderSignal(f.worker.id,{state:'idle'},'hook');
 const current=await f.control.resultWithReview(f.worker.id);
 assert.equal(current.review.status,'unavailable');assert.match(current.review.reason,/not been submitted/u);
 await tick();assert.equal(f.prompts.length,1);
});


test('successive successful account reviews release the previous reviewer, private workspace and account files exactly once',async t=>{
 const f=await fixture(t,{account:true});
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 const first=f.prompts[0].id,firstWorkspace=f.terminals.getMetadata(first).cwd;
 f.finish(first,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 assert.equal(f.accounts[0].cleanupCalls,0);assert.ok(existsSync(f.accounts[0].file));
 await f.control.send(f.worker.id,'second task');
 await until(()=>!existsSync(f.accounts[0].file));
 assert.equal(f.terminals.getMetadata(first),null);assert.equal(existsSync(firstWorkspace),false);
 assert.equal(f.control.isReadOnlyReviewer(first),false);assert.equal(f.accounts[0].cleanupCalls,1);
 f.finish(f.worker.id,'second answer');await until(()=>f.prompts.length===2);
 const second=f.prompts[1].id,secondWorkspace=f.terminals.getMetadata(second).cwd;
 f.finish(second,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===2);
 assert.equal(f.terminals.listMetadata().filter(row=>row.title.startsWith('Review:')).length,1);
 f.control.forgetSession(f.worker.id);
 await until(()=>!existsSync(f.accounts[1].file));
 assert.equal(f.terminals.getMetadata(second),null);assert.equal(existsSync(secondWorkspace),false);
 assert.equal(f.control.isReadOnlyReviewer(second),false);
 assert.deepEqual(f.accounts.map(row=>row.cleanupCalls),[1,1]);
});

for(const state of ['active','cached'])for(const failure of ['queued cancellation','readiness timeout','input gate rejection']){
 test(`${failure} before writing preserves the ${state} review`,async t=>{
  const f=await fixture(t);
  f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
  const reviewer=f.prompts[0].id;
  if(state==='cached'){f.finish(reviewer,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);}
  const session=f.terminals.sessions.get(f.worker.id),write=session.process.write;
  let writes=0;session.process.write=data=>{writes++;write(data);};
  const deliver=f.terminals.deliverInput.bind(f.terminals);
  f.terminals.deliverInput=(id,data,_wait,signal,beforeWrite)=>deliver(id,data,25,signal,beforeWrite);
  if(failure==='queued cancellation'){
   const gate=deferred();session.inputQueue=gate.promise;
   const controller=new AbortController();const sending=f.control.send(f.worker.id,'must not be delivered',true,controller.signal);
   controller.abort();gate.resolve();await assert.rejects(sending,/cancelled/u);
  }else if(failure==='readiness timeout'){
   session.agentRuntime={cleanup(){}};session.hookSignals=0;session.titleState=null;session.cliInputReady=false;
   await assert.rejects(f.control.send(f.worker.id,'must not be delivered'),/did not become ready/u);
   session.agentRuntime=null;
  }else{
   f.terminals.configureInputGate(()=>{throw new Error('fixture gate closed');});
   await assert.rejects(f.control.send(f.worker.id,'must not be delivered'),/no longer accepts/u);
   f.terminals.configureInputGate(()=>{});
  }
  assert.equal(writes,0);assert.ok(f.terminals.getMetadata(reviewer));assert.equal(f.control.isReadOnlyReviewer(reviewer),true);
  const observed=await f.control.resultWithReview(f.worker.id,{deferReview:true});
  assert.equal(observed.review.status,state==='cached'?'accepted':'pending');
  if(state==='active'){f.finish(reviewer,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);}
  await tick();assert.equal(f.prompts.length,1,'no replacement reviewer is launched for undelivered input');
 });
}

test('ambiguous acknowledgement after a write invalidates the old review without replaying text',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 const reviewer=f.prompts[0].id;
 f.finish(reviewer,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const session=f.terminals.sessions.get(f.worker.id);session.agentRuntime={cleanup(){}};
 const writes=[];session.process.write=data=>writes.push(data);
 const deliver=f.terminals.deliverInput.bind(f.terminals);
 f.terminals.deliverInput=(id,data,_wait,signal,beforeWrite)=>deliver(id,data,25,signal,beforeWrite);
 await assert.rejects(f.control.send(f.worker.id,'ambiguous second task'),/did not confirm accepting/u);
 assert.deepEqual(writes,['ambiguous second task\r']);
 assert.equal(f.terminals.getMetadata(reviewer),null);assert.equal(f.control.reviews.has(f.worker.id),false);
 assert.equal(f.control.isReadOnlyReviewer(reviewer),false);assert.equal(f.prompts.length,1);
 session.agentRuntime=null;
});


test('concurrent queued sends schedule only the latest written generation',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const first=f.control.send(f.worker.id,'queued second task');
 const second=f.control.send(f.worker.id,'queued third task');
 await Promise.all([first,second]);
 // The provider acknowledges a distinct turn for its latest queued input.
 f.terminals.applyProviderSignal(f.worker.id,{state:'idle',event:'Stop'},'hook');
 f.terminals.applyProviderSignal(f.worker.id,{state:'working'},'hook');
 f.finish(f.worker.id,'latest queued answer');await until(()=>f.prompts.length===2);
 assert.match(f.prompts[1].text,/latest queued answer/u);
 f.finish(f.prompts[1].id,'{"verdict":"accept","findings":"latest review"}');await until(()=>f.reviews.length===2);
 await tick();assert.equal(f.prompts.length,2);
 assert.equal((await f.control.resultWithReview(f.worker.id)).review.notes,'latest review');
});
