const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../android/assets/transport.js'),'utf8');
function client({remoteDescription}={}){
 const signals=[],sent=[],peers=[],intervals=[],events=new Map(),frames=new Map();let frameId=0;
 class Peer{
  constructor(){peers.push(this);this.connectionState='new';this.iceGatheringState='complete';}
  async setRemoteDescription(value){if(remoteDescription)await remoteDescription(value);} async createAnswer(){return {type:'answer',sdp:'local'};} async setLocalDescription(value){this.localDescription=value;} close(){this.closed=true;}
 }
 const context={window:{},document:{hidden:false,addEventListener:(type,handler)=>events.set(type,handler)},Native:{signal:json=>signals.push(JSON.parse(json)),disconnect(){},diagnostics(){},discover(){},restore(){},loadDraft(){}},CanvasLinkDelivery:{Delivery:class{close(){}send(value){sent.push(value);return Promise.resolve();}receive(){}}},RTCPeerConnection:Peer,setInterval:fn=>intervals.push(fn),setTimeout(){},requestAnimationFrame:fn=>{frames.set(++frameId,fn);return frameId;},cancelAnimationFrame:id=>frames.delete(id),performance:{now:()=>1}};
 vm.runInNewContext(source,context);return {...context,signals,sent,peers,intervals,events,frames,receive:context.window.CanvasLink.receive,api:context.window.CanvasLinkClient};
}
test('Successful encrypted polling after an outage retries signalling without replaying input',()=>{
 const c=client();c.receive({type:'paired',value:{host:'192.168.2.22:3497'}});c.receive({type:'network',value:'offline'});
 c.receive({type:'network-restored',value:true});assert.deepEqual(c.signals,[{type:'ping'}]);assert.deepEqual(c.sent,[]);
});
test('Network recovery cannot resume an unpaired or background client',()=>{
 const c=client();c.receive({type:'network-restored',value:true});c.receive({type:'paired',value:{host:'local'}});c.document.hidden=true;c.receive({type:'network-restored',value:true});assert.deepEqual(c.signals,[]);
});
test('An existing open data channel that recovers clears reconnecting status',async()=>{
 const c=client();c.receive({type:'paired',value:{host:'local'}});c.receive({type:'signal',value:{type:'offer',sdp:'remote'}});await new Promise(resolve=>setImmediate(resolve));
 const p=c.peers[0],channel={readyState:'open'};p.ondatachannel({channel});channel.onopen();c.receive({type:'network',value:'offline'});assert.equal(c.api.getState().connection,'reconnecting');
 p.connectionState='connected';p.onconnectionstatechange();assert.equal(c.api.getState().connection,'connected');assert.equal(c.api.getState().error,'');
});
test('Closing a peer clears its video counters and target status before reconnect',async()=>{
 const c=client();c.receive({type:'paired',value:{host:'local'}});c.receive({type:'signal',value:{type:'offer',sdp:'remote'}});await new Promise(resolve=>setImmediate(resolve));
 const peer=c.peers[0],channel={readyState:'open',send(){}};peer.ondatachannel({channel});channel.onopen();
 channel.onmessage({data:JSON.stringify({type:'source-state',capture:'active',windowFocused:true,target:'terminal'})});
 peer.getStats=async()=>new Map([['video',{type:'inbound-rtp',kind:'video',framesDecoded:17}]]);await c.intervals[0]();
 assert.equal(c.api.getState().stats.framesDecoded,17);assert.equal(c.api.getState().source.target,'terminal');
 c.receive({type:'signal',value:{type:'disconnect'}});
 assert.equal(c.api.getState().source,null);assert.equal(Object.keys(c.api.getState().stats).length,0);
 assert.equal(Object.keys(c.window.CanvasLink.stats).length,0);
});
test('Video feedback reports zero before decoding and the current peer frame count after decoding',async()=>{
 const c=client();c.receive({type:'paired',value:{host:'local'}});c.receive({type:'signal',value:{type:'offer',sdp:'remote'}});await new Promise(resolve=>setImmediate(resolve));
 const packets=[],p=c.peers[0],channel={readyState:'open',bufferedAmount:0,send:s=>packets.push(JSON.parse(s))};p.ondatachannel({channel});channel.onopen();
 p.getStats=async()=>new Map([['v',{type:'inbound-rtp',kind:'video',framesDecoded:7}]]);
 await c.intervals[0]();await c.intervals[0]();assert.equal(packets[0].videoFrames,0);assert.equal(packets[1].videoFrames,7);
 c.receive({type:'signal',value:{type:'offer',sdp:'new'}});await new Promise(resolve=>setImmediate(resolve));
 const fresh=c.peers[1];fresh.ondatachannel({channel});fresh.getStats=async()=>new Map();await c.intervals[0]();assert.equal(packets.at(-1).videoFrames,0);
});
test('Late offers cannot reopen an unpaired, explicitly disconnected or hidden client',async()=>{
 for(const status of ['unpaired','disconnected','hidden']){
  const c=client();if(status!=='unpaired')c.receive({type:'paired',value:{host:'local'}});
  if(status==='disconnected')c.api.disconnect();
  if(status==='hidden'){c.document.hidden=true;c.events.get('visibilitychange')();}
  const before=c.api.getState().connection;
  c.receive({type:'signal',value:{type:'offer',sdp:'late'}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.peers.length,0,status);assert.equal(c.api.getState().connection,before);
  c.receive({type:'signal',value:{type:'disconnect'}});assert.equal(c.api.getState().connection,before);
 }
});
test('A rejected old negotiation cannot replace the new connected peer status',async()=>{
 let rejectOld;const c=client({remoteDescription:value=>value.sdp==='old'?new Promise((resolve,reject)=>rejectOld=reject):undefined});
 c.receive({type:'paired',value:{host:'local'}});c.receive({type:'signal',value:{type:'offer',sdp:'old'}});
 c.receive({type:'signal',value:{type:'offer',sdp:'new'}});await new Promise(resolve=>setImmediate(resolve));
 const fresh=c.peers[1],channel={readyState:'open'};fresh.ondatachannel({channel});channel.onopen();
 rejectOld(Error('old-peer-closed'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(c.api.getState().connection,'connected');assert.equal(c.api.getState().error,'');assert.equal(fresh.closed,undefined);
 assert.equal(c.signals.filter(value=>value.type==='answer').length,1);
});
test('Closing a session discards buffered pointer motion before any new peer',()=>{
 const c=client();c.receive({type:'paired',value:{host:'local'}});
 c.api.sendInput({type:'pointer',action:'move',x:.5,y:.5,button:0});assert.equal(c.frames.size,1);
 c.api.disconnect();for(const fn of c.frames.values())fn();
 assert.deepEqual(c.sent,[]);assert.equal(c.frames.size,0);
});
test('A delayed native pairing callback cannot undo explicit disconnect',async()=>{
 const c=client();c.api.disconnect();
 c.receive({type:'paired',value:{host:'old-host'}});c.receive({type:'signal',value:{type:'offer',sdp:'old'}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(c.peers.length,0);assert.equal(c.api.getState().connection,'idle');
});
test('A negotiation completing after disconnect sends no answer',async()=>{
 let resolveOld;const c=client({remoteDescription:()=>new Promise(resolve=>resolveOld=resolve)});
 c.receive({type:'paired',value:{host:'local'}});c.receive({type:'signal',value:{type:'offer',sdp:'old'}});
 c.api.disconnect();resolveOld();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(c.signals,[]);assert.equal(c.api.getState().connection,'idle');
});
