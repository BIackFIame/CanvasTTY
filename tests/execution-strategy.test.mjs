import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentalModelRouter } from "../src/main/services/ModelRouter.ts";
import { TerminalSessionStore, persistedTerminalSession } from "../src/main/services/TerminalSessionStore.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";
function fixture(t, goal, options={}) {
 const calls=[]; const terminals=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner(calls));
 t.after(()=>terminals.disposeAll());
 const root=terminals.create({provider:"codex",profile:"normal",cwd:"/private/tmp",position:{x:0,y:0},role:"orchestrator",...(goal?{executionGoal:goal}:{})});
 const control=new AgentControlService(terminals,options);
 return {terminals,root,control,calls};
}
const request=(tool,args={})=>({id:"test",tool,arguments:args});
test("manual economical strategy is local and enforces one live worker",async t=>{
 const f=fixture(t,"economical"); let queried=0;
 const h=new ScopedOrchestrationHandler(f.control,null,undefined,{router:{route:async()=>{throw Error("unused")},strategy:async()=>{queried++; return {goal:"deep",reason:"ignored"}}}});
 const result=await h.execute(f.root.id,request("get_execution_strategy",{task:"a task"}));
 assert.equal(result.strategy.resolved,"economical"); assert.equal(queried,0);
 await f.control.spawn({parentSessionId:f.root.id,provider:"opencode",cwd:"/private/tmp"});
 await assert.rejects(async()=>f.control.spawn({parentSessionId:f.root.id,provider:"opencode",cwd:"/private/tmp"}),/limit|strategy/i);
});
test("auto resolves once for concurrent root requests and persists the host cap",async t=>{
 const f=fixture(t,"auto");let queried=0;
 const h=new ScopedOrchestrationHandler(f.control,null,undefined,{router:{route:async()=>{throw Error("unused")},strategy:async()=>{queried++; await new Promise(r=>setTimeout(r,10));return {goal:"fast",reason:"independent",maxConcurrent:999}}}});
 const results=await Promise.all([1,2].map(()=>h.execute(f.root.id,request("get_execution_strategy",{task:"overall task"}))));
 assert.equal(queried,1);assert.equal(results[0].strategy.maxConcurrent,4);assert.deepEqual(results[0],results[1]);
 assert.equal(f.terminals.getMetadata(f.root.id).executionStrategy.resolved,"fast");
});
test("deep reserves a reviewer slot and cannot bypass the person's cap",async t=>{
 const f=fixture(t,"deep",{limits:()=>({maxDepth:2,maxSubagents:1})});
 await assert.rejects(async()=>f.control.spawn({parentSessionId:f.root.id,provider:"opencode",cwd:"/private/tmp"}),/review|limit/i);
});
test("sessions without a goal retain existing behavior",async t=>{
 const f=fixture(t); const h=new ScopedOrchestrationHandler(f.control);
 assert.equal(h.listTools(f.root.id).some(x=>x.name==="get_execution_strategy"),false);
 await f.control.spawn({parentSessionId:f.root.id,provider:"opencode",cwd:"/private/tmp"});
 await f.control.spawn({parentSessionId:f.root.id,provider:"opencode",cwd:"/private/tmp"});
});

test("the model route receives the root policy and explicit effort remains authoritative",async t=>{
 const f=fixture(t,"fast"); const routed=[];
 const h=new ScopedOrchestrationHandler(f.control,null,{cli:()=>"available",limits:()=>null,models:()=>({models:["fixture-model"],checkedAt:Date.now()})},{router:{route:async r=>{routed.push(r);return {candidateId:r.candidates.find(c=>c.model).id,reason:"fixture"}}}});
 const child=await h.execute(f.root.id,request("spawn_agent",{provider:"codex",cwd:"/private/tmp",effort:"high"}));
 assert.equal(routed[0].executionStrategy.resolved,"fast");assert.equal(child.executionStrategy.resolved,"fast");
 assert.ok(routed[0].candidates.every(c=>c.reasoningEffort==="high"));assert.equal(f.terminals.getMetadata(child.sessionId).effort,"high");
 h.forgetSession(child.sessionId);
});
test("worker prompts never become an absent overall task, and invalid or late answers fall back once",async t=>{
 const f=fixture(t,"auto");let queries=0;
 const router={route:async()=>{throw Error("unused")},strategy:async()=>{queries++;return {goal:"deep",reason:"wrong"}}};
 const h=new ScopedOrchestrationHandler(f.control,null,undefined,{router});
 const child=await h.execute(f.root.id,request("spawn_agent",{provider:"opencode",cwd:"/private/tmp",prompt:"A worker subtask"}));
 assert.equal(queries,0);assert.equal(child.executionStrategy.source,"fallback");assert.match(child.executionStrategy.reason,/No overall task/);
 h.forgetSession(child.sessionId);
 for(const answer of [{goal:"auto",reason:"invalid"},{goal:"deep",source:"person",reason:"invalid source"}]){
  const g=fixture(t,"auto");const handler=new ScopedOrchestrationHandler(g.control,null,undefined,{router:{...router,strategy:async()=>answer}});
  const result=await handler.execute(g.root.id,request("get_execution_strategy",{task:"overall"}));assert.equal(result.strategy.source,"fallback");
 }
 const late=fixture(t,"auto");let finish;
 const handler=new ScopedOrchestrationHandler(late.control,null,undefined,{routeTimeoutMs:5,router:{...router,strategy:()=>new Promise(r=>{finish=r;})}});
 const fallback=await handler.execute(late.root.id,request("get_execution_strategy",{task:"overall"}));finish({goal:"deep",reason:"late"});await new Promise(r=>setTimeout(r,5));
 assert.equal(fallback.strategy.source,"fallback");assert.equal(late.terminals.getMetadata(late.root.id).executionStrategy.resolved,"balanced");
});
test("experimental opt-out blocks late Jev acceptance and restored goal behavior",async t=>{
 let enabled=true,finish;const f=fixture(t,"auto",{executionEnabled:()=>enabled});
 const router=experimentalModelRouter({route:async()=>{throw Error("unused")},strategy:()=>new Promise(r=>{finish=r})},()=>enabled);
 const h=new ScopedOrchestrationHandler(f.control,null,undefined,{router});
 const pending=h.execute(f.root.id,request("get_execution_strategy",{task:"overall"}));enabled=false;finish({goal:"deep",reason:"late"});
 await assert.rejects(pending,/goal/);assert.equal(f.terminals.getMetadata(f.root.id).executionStrategy,undefined);
 assert.equal(h.listTools(f.root.id).some(x=>x.name==="get_execution_strategy"),false);
 const manual=fixture(t,"economical",{executionEnabled:()=>false});
 await manual.control.spawn({parentSessionId:manual.root.id,provider:"opencode",cwd:"/private/tmp"});
 await manual.control.spawn({parentSessionId:manual.root.id,provider:"opencode",cwd:"/private/tmp"});
});
test("logical root policy survives handoff and store reload; nested workers share its capacity",async t=>{
 const f=fixture(t,"economical"); const h=new ScopedOrchestrationHandler(f.control);
 await h.execute(f.root.id,request("get_execution_strategy"));
 const child=await f.control.spawn({parentSessionId:f.root.id,provider:"opencode",cwd:"/private/tmp"});
 const replacement=f.terminals.create({provider:"codex",profile:"normal",cwd:"/private/tmp",position:{x:0,y:0},role:"orchestrator"});
 f.terminals.inheritTaskScope(f.root.id,replacement.id);
 await assert.rejects(async()=>f.control.spawn({parentSessionId:replacement.id,provider:"opencode",cwd:"/private/tmp"}),/strategy/);
 await assert.rejects(async()=>f.control.spawn({parentSessionId:child.id,provider:"opencode",cwd:"/private/tmp"}),/strategy/);
 f.terminals.completeTaskContinuation(f.root.id,replacement.id);f.terminals.dispose(f.root.id,{keepEnvironmentData:true});
 assert.equal(f.control.executionContext(child.id).strategy.resolved,"economical");
 const dir=await mkdtemp(join(tmpdir(),"ctty-strategy-store-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new TerminalSessionStore(dir);await store.replace([persistedTerminalSession(f.terminals.getMetadata(replacement.id))]);
 const rows=await new TerminalSessionStore(dir).load();assert.equal(rows[0].executionStrategy.resolved,"economical");assert.equal(rows[0].executionGoal,"economical");
});

function reviewFixture(t,extra={}) {
 const calls=[];let terminals;const writes=[];
 terminals=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner(calls,{onWrite(data){
  if(!data.includes("Review only the supplied answer"))return;
  writes.push(data);const reviewer=terminals.listMetadata().find(s=>s.title.startsWith("Review:") && s.exitCode===null);
  const pty=calls.at(-1).process;pty.kill=()=>pty.emitExit(0);
  terminals.applyProviderSignal(reviewer.id,{state:"working"},"hook");
  terminals.recordAnswer(reviewer.id,{text:'{"verdict":"accept","findings":"fixture"}',truncated:false});
  terminals.applyProviderSignal(reviewer.id,{state:"idle",event:"Stop"},"hook");
 }}));
 terminals.configureIsolation({containment:()=>true,decide:({profile})=>profile==="plan"?{apply:true,profile,isolation:{state:"on",layer:"seatbelt"}}:{apply:false,profile},wrap:l=>({command:l.command,args:[...l.args],env:l.env,cleanup(){}})});
 t.after(()=>terminals.disposeAll());
 const control=new AgentControlService(terminals,{workerModel:()=>"fixture-worker",reviewModel:()=>"fixture-reviewer",reviewDiff:async()=>"+fixture",waitTiming:{checkMs:1,settleMs:0,quietMs:10},...extra});
 return {calls,terminals,control,writes};
}
test("deep forces real Plan reviews, serializes them and reuses the reserved slot",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"ctty-strategy-review-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=reviewFixture(t); const root=f.terminals.create({provider:"codex",profile:"normal",cwd:dir,position:{x:0,y:0},role:"orchestrator",executionGoal:"deep"});
 const workers=await Promise.all([1,2].map(()=>f.control.spawn({parentSessionId:root.id,provider:"codex",cwd:dir,review:false})));
 for(const worker of workers){f.terminals.applyProviderSignal(worker.id,{state:"working"},"hook");f.terminals.applyProviderSignal(worker.id,{state:"idle",event:"Stop"},"hook");}
 const results=await Promise.all(workers.map(w=>f.control.resultWithReview(w.id)));
 assert.deepEqual(results.map(r=>r.review.status),["accepted","accepted"]);assert.equal(f.writes.length,2);
 assert.equal(f.terminals.listMetadata().filter(s=>s.parentSessionId===root.id && s.exitCode===null).length,2,"only the two workers occupy live slots");
 assert.equal(f.terminals.listMetadata().filter(s=>s.title.startsWith("Review:") && s.exitCode===0).length,2,"completed review cards remain available for late usage and audit");
 assert.equal(f.calls.length,5,"root, two workers, two actual reviewers");
});
test("review admission rechecks global capacity and budget after asynchronous preparation",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"ctty-strategy-review-guard-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const kind of ["capacity","budget"]){
  let paused=false,cap=2;
  const f=reviewFixture(t,{limits:()=>({maxDepth:2,maxSubagents:cap}),budget:{snapshot:()=>({paused,reason:"Budget paused"})},reviewDiff:async()=>{if(kind==="capacity")cap=1;else paused=true;return "+fixture"}});
  const root=f.terminals.create({provider:"codex",profile:"normal",cwd:dir,position:{x:0,y:0},role:"orchestrator"});
  const worker=await f.control.spawn({parentSessionId:root.id,provider:"codex",cwd:dir,review:true});
  f.terminals.applyProviderSignal(worker.id,{state:"working"},"hook");f.terminals.applyProviderSignal(worker.id,{state:"idle",event:"Stop"},"hook");
  const result=await f.control.resultWithReview(worker.id);assert.equal(result.review.status,"unavailable");assert.match(result.review.reason,kind==="capacity"?/limit/:/Budget/);assert.equal(f.calls.length,2);
 }
});
