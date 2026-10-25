const { test } = require('node:test');
const assert = require('node:assert/strict');
const srp = require('secure-remote-password/client');
const crypto = require('node:crypto');
const { Pairing, seal, open, USER, privateAddress } = require('../host/security.cjs');
const { validateInput } = require('../host/native-input.cjs');
function authenticate(p, pin=p.pin) {
  const a=srp.generateEphemeral(); const start=p.start({A:a.public,name:'Synthetic Android'},'192.168.2.23');
  const client=srp.deriveSession(a.secret,start.B,start.salt,USER,srp.derivePrivateKey(start.salt,USER,pin));
  const finish=p.finish({id:start.id,proof:client.proof},'192.168.2.23');srp.verifySession(a.public,client,finish.proof);
  const key=crypto.createHash('sha256').update(Buffer.from(client.key,'hex')).update('CanvasLink/channel/1').digest();
  return {id:finish.id,key};
}
test('SRP mutual authentication, encrypted request/reply, one use PIN',()=>{
  const p=new Pairing(),pin=p.pin,c=authenticate(p);
  assert.equal(p.pin,'');assert.throws(()=>authenticate(p,pin));
  const packet=seal(c.key,c.id,1,'request',{type:'poll'});
  const response=p.receive(packet,'192.168.2.23',()=>({ok:true}));
  assert.deepEqual(open(c.key,c.id,response,'response'),{ok:true});
  assert.throws(()=>p.receive(packet,'192.168.2.23',()=>({ok:true})),/unauthorized/);
});
test('wrong PIN, expiration, host revocation and address changes fail closed',()=>{
  let now=1000;const p=new Pairing({now:()=>now});
  assert.throws(()=>authenticate(p,p.pin==='000000'?'000001':'000000'));
  now+=120001;assert.throws(()=>authenticate(p));
  p.rotate();const c=authenticate(p),packet=seal(c.key,c.id,1,'request',{type:'poll'});
  assert.throws(()=>p.receive(packet,'192.168.2.99',()=>({ok:true})));
  p.rotate();assert.throws(()=>p.receive(packet,'192.168.2.23',()=>({ok:true})));
});
test('tampering, reflection and untrusted input do not become actions',()=>{
  const p=new Pairing(),c=authenticate(p),packet=seal(c.key,c.id,1,'request',{type:'poll'});
  let calls=0;const corrupt={...packet,data:Buffer.alloc(80).toString('base64')};
  assert.throws(()=>p.receive(corrupt,'192.168.2.23',()=>{calls++;}));assert.equal(calls,0);
  assert.throws(()=>open(c.key,c.id,packet,'response'));
  for(const input of [{type:'exec',command:'sh'},{type:'text',text:'x'.repeat(8001)},{type:'pointer',x:2,y:0,button:0,action:'down'},{type:'key',key:'unknown',modifiers:[]}])assert.throws(()=>validateInput(input));
  validateInput({type:'text',text:'Проверка'});
});
test('only private IPv4 and loopback peers are accepted',()=>{
  for(const a of ['127.0.0.1','::1','::ffff:192.168.2.23','10.1.2.3','172.31.2.3'])assert.equal(privateAddress(a),true);
  for(const a of ['8.8.8.8','192.168.999.1','example.com','172.32.2.3',''])assert.equal(privateAddress(a),false);
});
test('pairing attempts are globally bounded, not reset by a new peer address',()=>{
  const p=new Pairing();for(let i=0;i<5;i++)assert.throws(()=>authenticate(p,p.pin==='000000'?'000001':'000000'));
  assert.throws(()=>authenticate(p),/pairing-closed/);
  p.rotate();const ephemeral=srp.generateEphemeral();for(let i=0;i<30;i++)p.start({A:ephemeral.public,name:'Synthetic'},'192.168.2.'+(i+1));
  assert.throws(()=>p.start({A:ephemeral.public,name:'Synthetic'},'192.168.2.99'),/pairing-closed/);
});
test('counter gaps after Android crash are accepted; old replies and expired sessions are not',()=>{
  let now=1000;const p=new Pairing({now:()=>now}),c=authenticate(p);
  const packet=seal(c.key,c.id,10001,'request',{type:'poll'});
  const response=p.receive(packet,'192.168.2.23',()=>({ok:true}));assert.equal(response.seq,10001);
  assert.throws(()=>p.receive(seal(c.key,c.id,2,'request',{}),'192.168.2.23',()=>({})),/unauthorized/);
  now+=12*3600000;
  assert.throws(()=>p.receive(seal(c.key,c.id,10002,'request',{}),'192.168.2.23',()=>({})),/unauthorized/);
});
