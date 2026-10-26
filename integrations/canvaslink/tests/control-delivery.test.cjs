const {test}=require('node:test');
const assert=require('node:assert/strict');
const {InputQueue}=require('../host/input-queue.cjs');
const {Delivery}=require('../android/assets/delivery.js');
const input=(seq,extra={})=>({id:`input-${seq}`,seq,type:'key',key:'Enter',modifiers:[],...extra});
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),release:()=>resolve()};};

test('an in-flight duplicate with a different payload cannot execute twice',async()=>{
  const gate=deferred(),applied=[],replies=[];
  const q=new InputQueue({active:()=>true,apply:async e=>{applied.push(e.text);await gate.promise;},reply:e=>replies.push(e)});
  q.receive(input(1,{type:'text',text:'original'}));
  q.receive(input(2,{id:'input-1',type:'text',text:'changed'}));
  gate.release();await q.tail;
  q.receive(input(3,{id:'input-1',type:'text',text:'third'}));
  assert.deepEqual(applied,['original']);assert.equal(replies.length,2);
  assert(replies.every(e=>e.type==='input-ok'&&e.id==='input-1'));
});

test('queue saturation rejects explicitly and accepts fresh input after draining',async()=>{
  const gate=deferred(),applied=[],replies=[];
  const q=new InputQueue({limit:2,active:()=>true,apply:async e=>{applied.push(e.id);await gate.promise;},reply:e=>replies.push(e)});
  q.receive(input(1));q.receive(input(2));q.receive(input(3));
  assert.deepEqual(replies,[{type:'input-error',id:'input-3',error:'input-busy'}]);
  gate.release();await q.tail;q.receive(input(4));await q.tail;
  assert.deepEqual(applied,['input-1','input-2','input-4']);assert.equal(q.pending,0);
});

test('invalid payload and unsafe sequence cannot consume a future valid sequence',async()=>{
  const applied=[],replies=[];
  const q=new InputQueue({active:()=>true,apply:async e=>applied.push(e.seq),reply:e=>replies.push(e)});
  q.receive(input(9,{type:'text',text:''}));q.receive(input(Number.MAX_SAFE_INTEGER+1));
  q.receive(input(1));q.receive(input(3));q.receive(input(2));await q.tail;
  assert.deepEqual(applied,[1,3]);
  assert.deepEqual(replies.filter(e=>e.type==='input-error').map(e=>e.error),['invalid-text','input-expired','input-expired']);
});

test('a failed operation does not poison the ordered queue or replay on duplicate',async()=>{
  const applied=[],replies=[];
  const q=new InputQueue({active:()=>true,apply:async e=>{applied.push(e.seq);if(e.seq===1)throw Error('text-target-required');},reply:e=>replies.push(e)});
  q.receive(input(1));q.receive(input(2));await q.tail;q.receive(input(1));
  assert.deepEqual(applied,[1,2]);assert.equal(replies.at(-1).error,'text-target-required');assert.equal(q.pending,0);
});

test('revocation drains queued work without sending stale ACKs into a new peer',async()=>{
  let active=true;const gate=deferred(),applied=[],replies=[];
  const q=new InputQueue({active:()=>active,apply:async e=>{applied.push(e.seq);await gate.promise;},reply:e=>replies.push(e)});
  q.receive(input(1));q.receive(input(2));await Promise.resolve();await Promise.resolve();
  active=false;gate.release();await q.tail;
  assert.deepEqual(applied,[1]);assert.deepEqual(replies,[]);assert.equal(q.pending,0);
});

test('500 ordered operations and duplicate retries execute once beyond the ID cache',async()=>{
  const applied=[],replies=[];
  const q=new InputQueue({maxIds:8,active:()=>true,apply:async e=>applied.push(e.seq),reply:e=>replies.push(e)});
  for(let n=1;n<=500;n++){q.receive(input(n));q.receive(input(n));await q.tail;}
  for(let n=1;n<=500;n++)q.receive(input(n));await q.tail;
  assert.deepEqual(applied,Array.from({length:500},(_,i)=>i+1));assert.equal(q.pending,0);assert(q.ids.size<=8);
  assert.equal(replies.filter(e=>e.error==='input-expired').length,492);
});

test('send exception is not-sent, clears its timer and never retries',async()=>{
  let sends=0,clears=0;
  const d=new Delivery({channel:()=>({readyState:'open',bufferedAmount:0,send(){sends++;throw Error('closed');}}),id:()=> 'send-failed',setTimer:()=>42,clearTimer:t=>{assert.equal(t,42);clears++;}});
  await assert.rejects(d.send({type:'key',key:'Enter',modifiers:[]}),/not-sent/);
  assert.equal(sends,1);assert.equal(clears,1);assert.equal(d.pending.size,0);assert.equal(d.sent,0);
});

test('64 pending operations enforce backpressure; one ACK frees one slot',async()=>{
  let id=0;const messages=[];
  const d=new Delivery({channel:()=>({readyState:'open',bufferedAmount:0,send:v=>messages.push(JSON.parse(v))}),id:()=>`pending-${++id}`,setTimer:()=>0,clearTimer(){}});
  const operations=Array.from({length:64},()=>d.send({type:'key',key:'Enter',modifiers:[]}).catch(e=>e.message));
  await assert.rejects(d.send({type:'text',text:'must stay local'}),/input-busy/);
  d.receive({type:'input-ok',id:'pending-1'});
  const last=d.send({type:'key',key:'Escape',modifiers:[]}).catch(e=>e.message);
  assert.equal(messages.length,65);assert.equal(messages.at(-1).seq,65);
  d.close();await Promise.all([...operations,last]);assert.equal(d.pending.size,0);
});

test('late, duplicate and malformed ACKs cannot turn uncertainty into success',async()=>{
  const changes=[];let expire;
  const d=new Delivery({channel:()=>({readyState:'open',bufferedAmount:0,send(){}}),id:()=> 'late',onChange:e=>changes.push(e),setTimer:fn=>{expire=fn;return 1;},clearTimer(){}});
  const operation=d.send({type:'text',text:'draft'});expire();await assert.rejects(operation,/delivery-uncertain/);
  for(const ack of [null,{}, {type:'input-ok',id:'late'},{type:'input-error',id:'late',error:'rejected'}])assert.equal(d.receive(ack),false);
  assert.deepEqual(changes.map(e=>e.status),['pending','uncertain']);assert.equal(d.acked,0);
});

test('host rejection is explicit and does not retry text or Enter',async()=>{
  const sent=[];let id=0;
  const d=new Delivery({channel:()=>({readyState:'open',bufferedAmount:0,send:v=>sent.push(JSON.parse(v))}),id:()=>`rejected-${++id}`,setTimer:()=>0,clearTimer(){}});
  for(const payload of [{type:'text',text:'draft'},{type:'key',key:'Enter',modifiers:[]}]){
    const operation=d.send(payload);d.receive({type:'input-error',id:`rejected-${id}`,error:'canvas-focus-required'});
    await assert.rejects(operation,/canvas-focus-required/);
  }
  assert.equal(sent.length,2);assert.equal(d.pending.size,0);assert.equal(d.acked,0);
});

test('Focus metadata belongs to the acknowledged click and remains immutable on duplicate replay',async()=>{
 const replies=[];let call=0;
 const q=new InputQueue({active:()=>true,apply:async()=>{call++;return{focus:{editable:true,kind:'terminal',rect:{x:.1,y:.2,width:.5,height:.6}}};},reply:e=>replies.push(e)});
 const click=input(1,{type:'pointer',action:'up',button:0,x:.5,y:.5});q.receive(click);await q.tail;q.receive(click);
 assert.equal(call,1);assert.deepEqual(replies[0].focus,{editable:true,kind:'terminal',rect:{x:.1,y:.2,width:.5,height:.6}});assert.deepEqual(replies[1],replies[0]);
});
test('Delivery returns focus only from its own processed ACK, ignoring unrelated source-state',async()=>{
 const d=new Delivery({channel:()=>({readyState:'open',bufferedAmount:0,send(){}}),id:()=> 'tap-focus',setTimer:()=>0,clearTimer(){}});
 const result=d.send({type:'pointer',action:'up',button:0,x:.5,y:.5});assert.equal(d.receive({type:'source-state',focus:{editable:true}}),false);
 d.receive({type:'input-ok',id:'tap-focus',focus:{editable:false,kind:'canvas'}});assert.equal((await result).focus.editable,false);
});
