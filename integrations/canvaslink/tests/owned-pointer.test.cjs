const {test}=require('node:test'),assert=require('node:assert/strict');
const {OwnedPointer}=require('../host/owned-pointer.cjs');
test('revocation releases both held buttons at their latest owned-renderer position',()=>{
 const events=[],contents={isDestroyed:()=>false,sendInputEvent:e=>events.push(e)},p=new OwnedPointer();
 p.send(contents,{type:'mouseDown',button:'left',x:1,y:2});p.send(contents,{type:'mouseDown',button:'right',x:1,y:2});
 p.send(contents,{type:'mouseMove',button:'left',x:8,y:9,modifiers:['leftButtonDown']});p.release();p.release();
 assert.deepEqual(events.slice(3).map(e=>[e.type,e.button,e.x,e.y,e.modifiers]),[['mouseUp','left',8,9,[]],['mouseUp','right',8,9,[]]]);
});
test('a released or destroyed target cannot receive a duplicate cancellation event',()=>{
 const events=[];let destroyed=false;const contents={isDestroyed:()=>destroyed,sendInputEvent:e=>events.push(e)},p=new OwnedPointer();
 p.send(contents,{type:'mouseDown',button:'left'});p.send(contents,{type:'mouseUp',button:'left'});p.release();assert.equal(events.length,2);
 p.send(contents,{type:'mouseDown',button:'right'});destroyed=true;p.release();assert.equal(events.length,3);assert.equal(p.held.size,0);
});
test('failed mouseDown is never recorded as an applied press',()=>{
 const p=new OwnedPointer();assert.throws(()=>p.send({sendInputEvent(){throw Error('closed');}},{type:'mouseDown',button:'left'}));assert.equal(p.held.size,0);
});
