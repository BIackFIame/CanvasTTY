import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
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
async function fixture(t) {
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
 const control=new AgentControlService(terminals,{reviewModel:()=> 'fixture-reviewer',reviewDiff:async()=>'+worker scoped fixture',
  waitTiming:{checkMs:1,settleMs:0,quietMs:10_000},onReview:(_id,review)=>reviews.push(review)});
 t.after(async()=>{for(const row of terminals.listMetadata())control.forgetSession(row.id);terminals.disposeAll();await rm(root,{recursive:true,force:true});});
 const parent=terminals.create({provider:'codex',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
 const worker=await control.spawn({parentSessionId:parent.id,provider:'codex',cwd:root,review:true,initialPrompt:'first task'});
 const finish=(id,text)=>{terminals.recordAnswer(id,{text,truncated:false});terminals.applyProviderSignal(id,{state:'idle',event:'Stop'},'hook');};
 return {control,terminals,worker,prompts,reviews,finish};
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
