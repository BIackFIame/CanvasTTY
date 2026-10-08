import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function fixture(t,{supported=true,ui=true}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ctty-restore-lease-'))),other=join(root,'other'),project=join(root,'project');await mkdir(other);await mkdir(project);
 const paused=new Set(),events=[],calls=[],writes=[];let failPause=false,failResume=false;
 const pause={supported,isPaused:p=>paused.has(p),pause(p){paused.add(p);events.push(['pause',p.pid]);return{supported, ...(failPause?{failed:'partial suspension'}:{})};},resume(p){events.push(['resume',p.pid]);if(failResume)return{supported,failed:'resume failure'};paused.delete(p);return{supported};}};
 const terminal=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,ui,fakeSpawner(calls,{onWrite:value=>writes.push(value)}),pause);
 const create=(cwd=project)=>{const row=terminal.create({provider:'codex',profile:'normal',cwd,position:{x:0,y:0}});terminal.resize(row.id,80,24);return row;};
 const idle=id=>terminal.applyProviderSignal(id,{kind:'lifecycle',state:'idle',event:'SessionStart'});
 t.after(async()=>{terminal.disposeAll();await rm(root,{recursive:true,force:true});});
 return{terminal,project,other,create,idle,calls,writes,paused,events,pause,failPause:()=>{failPause=true;},failResume:()=>{failResume=true;}};
}

test('restore excludes all input, launches, restart and lifecycle for affected owned sessions; unrelated close and deferred target close remain safe',async t=>{
 const f=await fixture(t),a=f.create(),b=f.create(),other=f.create(f.other);f.idle(a.id);f.idle(b.id);
 const entered=deferred(),release=deferred();const restore=f.terminal.withCheckpointRestore(a.id,async cwd=>{assert.equal(cwd,f.project);entered.resolve();await release.promise;return 7;});await entered.promise;
 assert.equal(f.paused.size,2);for(const value of ['hello','\r','\x03'])assert.equal(f.terminal.inputChecked(a.id,value),false);
 f.terminal.input(b.id,'new\r');assert.equal((await f.terminal.deliverInput(a.id,'controlled\r',50)).delivered,false);assert.deepEqual(f.writes,[]);
 assert.throws(()=>f.create(),/restoration/);assert.throws(()=>f.terminal.restart(a.id),/restoration/);
 await assert.rejects(f.terminal.stopSubagentPtyForRetry(a.id),/restoration/);
 assert.equal(f.terminal.applyProviderSignal(a.id,{state:'working'}),false);
 f.terminal.dispose(other.id);assert.equal(f.terminal.getMetadata(other.id),null);
 f.terminal.dispose(a.id);assert.ok(f.terminal.getMetadata(a.id),'close is deferred, without killing protected PTY');
 release.resolve();assert.equal(await restore,7);assert.equal(f.paused.size,0);assert.equal(f.terminal.getMetadata(a.id),null);
 assert.equal(f.terminal.inputChecked(b.id,'next\r'),true);
});

for(const state of ['working','needs_approval','unobserved','submitted'])test(`restore rejects ${state} with lifecycle UI disabled`,async t=>{
 const f=await fixture(t,{ui:false}),a=f.create();
 if(state!=='unobserved')f.terminal.applyProviderSignal(a.id,{state:state==='submitted'?'idle':state});
 if(state==='submitted')assert.equal(f.terminal.inputChecked(a.id,'new\r'),true);
 assert.equal(f.terminal.getMetadata(a.id).status,'unavailable');let ran=false;
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>{ran=true;}),/observed agent idle/);assert.equal(ran,false);assert.equal(f.events.length,0);
});

test('Windows live restore refuses rather than pretending input gating suspends a process',async t=>{
 const f=await fixture(t,{supported:false}),a=f.create();f.idle(a.id);
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>assert.fail()),/cannot safely suspend/);assert.equal(f.events.length,0);
});

test('pending environment preparation prevents restore before an effective cwd exists',async t=>{
 const f=await fixture(t),a=f.create(),other=f.create(f.other);f.idle(a.id);
 const task=deferred();f.terminal.sessions.get(other.id).launchTasks=new Set([task.promise]);
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>assert.fail()),/pending agent launches/);
 task.resolve();f.terminal.sessions.get(other.id).launchTasks.clear();
});

test('existing budget pause stays owned; clearing budget during restore defers resume until transaction ends',async t=>{
 const f=await fixture(t),a=f.create();f.idle(a.id);f.terminal.setBudgetPaused(a.id,true);
 await f.terminal.withCheckpointRestore(a.id,async()=>{});assert.equal(f.paused.size,1);assert.equal(f.events.filter(([type])=>type==='resume').length,0);
 await f.terminal.withCheckpointRestore(a.id,async()=>{f.terminal.setBudgetPaused(a.id,false);assert.equal(f.paused.size,1);assert.equal(f.terminal.inputChecked(a.id,'x'),false);});assert.equal(f.paused.size,0);
});

test('partial pause failure resumes acquired ownership; failed transaction and natural exit do not resume descendants early',async t=>{
 const f=await fixture(t),a=f.create();f.idle(a.id);f.failPause();
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>assert.fail()),/partial suspension/);assert.equal(f.paused.size,0);
 const g=await fixture(t),b=g.create();g.idle(b.id);g.terminal.setBudgetPaused(b.id,true);
 await assert.rejects(g.terminal.withCheckpointRestore(b.id,async()=>{g.calls[0].process.emitExit(0);assert.equal(g.paused.size,1);throw new Error('restore failed');}),/restore failed/);assert.equal(g.paused.size,0);
});

test('failed resume keeps budget input gate, with neutral diagnostic even when restore failed',async t=>{
 const f=await fixture(t),a=f.create();f.idle(a.id);f.failResume();
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>{throw new Error('git failed');}),error=>/remains budget-paused/.test(error.message)&&!/Files were restored/.test(error.message));
 assert.equal(f.terminal.isBudgetPaused(a.id),true);assert.equal(f.terminal.inputChecked(a.id,'x'),false);
});

test('shutdown drains a protected transaction before disposing sessions',async t=>{
 const f=await fixture(t),a=f.create();f.idle(a.id);const entered=deferred(),release=deferred();
 const restore=f.terminal.withCheckpointRestore(a.id,async()=>{entered.resolve();await release.promise;});await entered.promise;
 const shutdown=f.terminal.shutdown();assert.ok(f.terminal.getMetadata(a.id));release.resolve();await restore;await shutdown;assert.equal(f.terminal.getMetadata(a.id),null);
});

 test('missing unrelated exited folder does not prevent restoring a valid owned workspace',async t=>{
 const f=await fixture(t),a=f.create(),other=f.create(f.other);f.idle(a.id);f.calls[1].process.emitExit(0);await rm(f.other,{recursive:true});let restored=false;
 await f.terminal.withCheckpointRestore(a.id,async()=>{restored=true;});assert.equal(restored,true);
 });
