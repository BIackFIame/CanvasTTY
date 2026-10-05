import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AttentionService} from '../src/main/services/AttentionService.ts';
import {PluginSessions} from '../src/main/services/PluginSessions.ts';

test('attention masks names, coalesces events and persists independent channel/quiet/agent policies',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'attention-'));
  try{
    const path=join(dir,'preferences.json'), service=new AttentionService(path,text=>text.replaceAll('SECRET','[masked]'));
    await service.load();
    const event=service.publish('agent','SECRET agent','done',1000);
    assert.equal(event.title,'[masked] agent');assert.equal(service.publish('agent','agent','done',2000),null);
    assert.ok(service.publish('agent','agent','approval',2100));
    assert.ok(service.publish('agent','agent','approval',2200),'a second permission request is not dropped');
    assert.equal(service.list('phone').filter(item=>item.kind==='approval').length,2);
    await service.set({...service.get(),importantOnly:true,channels:{desktop:false,phone:true,glasses:false},sessionIds:['agent']});
    assert.equal(service.allows('phone',event),false);
    const failure=service.publish('agent','agent','failed',3000);
    assert.equal(service.allows('phone',failure),true);assert.equal(service.allows('desktop',failure),false);
    assert.equal(service.allows('phone',{...failure,sessionId:'other'}),false);
    await service.set({...service.get(),quietUntil:5000});assert.equal(service.allows('phone',failure,4000),false);
    assert.equal(service.allows('phone',failure,6000),true);
    const restored=new AttentionService(path,text=>text);await restored.load();assert.deepEqual(restored.get(),service.get());
    assert.equal((await readFile(path,'utf8')).includes('SECRET'),false);
    await assert.rejects(service.set({...service.get(),quietUntil:NaN}),/Invalid/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

function world(failDelivery=false){
  const calls=[],notices=[];
  const metadata={id:'source',provider:'codex',title:'Original',role:'agent',profile:'auto',cwd:'/project',position:{x:0,y:0},status:'working',startedAt:1,exitCode:null};
  const contexts=new Map([['source',{metadata,workingDirectory:'/project/worktree',environment:{kind:'worktree',pluginId:'environments',label:'branch',ref:{}},owner:'different-plugin',restored:false}]]);
  const terminals={pluginContext:id=>contexts.get(id)??null,listMetadata:()=>[...contexts.values()].map(row=>row.metadata),
    create(request,control){calls.push({type:'create',request,control});const next={...metadata,...request,id:'replacement'};contexts.set(next.id,{metadata:next,workingDirectory:request.cwd,environment:null,owner:control.ownerPluginId,restored:false});return next;},
    async deliverInput(id,text){calls.push({type:'input',id,text});return {delivered:!failDelivery};},
    dispose(id,options){calls.push({type:'dispose',id,options});contexts.delete(id);},redactSecrets:text=>text.replaceAll('SECRET','[masked]'),
    redactSecretsTail:text=>text,readBuffer:()=>({buffer:'PRIVATE OUTPUT'}),setPluginOwner(){}};
  const sessions=new PluginSessions({terminals,notify:(...args)=>{notices.push(args);return true;}});
  return {sessions,calls,contexts,notices};
}

test('activity honors subscription ownership and never includes terminal screen',()=>{
  const {sessions,notices}=world();
  sessions.handle('accounts','one','sessions.subscribe',{},['sessions:events']);
  sessions.handle('accounts','two','sessions.subscribe',{ownedOnly:true},['sessions:events']);
  sessions.activity({type:'pretool',sessionId:'source',at:1,provider:'codex',toolName:'Read',normalizedActionHash:'a'.repeat(64)});
  assert.equal(notices.length,1);assert.equal(notices[0][1],'one');assert.equal(notices[0][2],'canvastty.activity');
  assert.equal(JSON.stringify(notices).includes('PRIVATE OUTPUT'),false);
});
