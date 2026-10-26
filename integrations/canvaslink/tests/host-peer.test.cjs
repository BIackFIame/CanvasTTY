const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../host/renderer.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function host(){
 const elements=new Map(),captures=[],peers=[],signals=[],sessions=[],timers=[],fallbacks=[];
 const stream=()=>{const track={stopped:false,stop(){this.stopped=true;}};return {track,getVideoTracks:()=>[track],getTracks:()=>[track]};};
 const element=id=>{if(!elements.has(id))elements.set(id,{hidden:false,textContent:'',replaceChildren(){},append(){},getContext:()=>({}),captureStream:()=>{const s=stream();fallbacks.push(s);return s;}});return elements.get(id);};
 class Peer{
  constructor(){peers.push(this);this.iceGatheringState='complete';this.connectionState='new';}
  addTrack(track){this.track=track;return {getParameters:()=>({encodings:[]}),replaceTrack:async value=>{this.track=value;}};}
  async getStats(){return new Map([['video',{type:'outbound-rtp',kind:'video',framesEncoded:this.frames||0}]]);}
  getTransceivers(){return [{setCodecPreferences(){}}];}
  createDataChannel(){return this.channel={readyState:'connecting',close(){this.readyState='closed';},send(){}};}
  async createOffer(){return {type:'offer',sdp:'owned-test-offer'};}
  async setLocalDescription(value){this.localDescription=value;}
  close(){this.closed=true;}
 }
 let event;
 const context={window:{CanvasLinkFrames:require('../host/frames.js'),host:{state:async()=>({embedded:true,source:'Owned target',addresses:[],connected:[],width:100,height:100}),permissions:async()=>({platform:'linux'}),sources:async()=>[{id:'owned',name:'Owned target'}],select:async()=>{},onEvent:handler=>event=handler,report(){},captureFallback:async()=>{},inputSession:async(...args)=>sessions.push(args),signal:async(...args)=>signals.push(args)}},document:{getElementById:element,createElement:()=>({})},navigator:{mediaDevices:{getDisplayMedia:()=>new Promise((resolve,reject)=>captures.push({resolve,reject}))}},RTCPeerConnection:Peer,RTCRtpSender:{getCapabilities:()=>({codecs:[]})},setInterval(){},setTimeout:fn=>{const t={fn};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cancelled=true;}};
 vm.runInNewContext(source,context);await tick();
 return {event,captures,peers,signals,sessions,stream,timers,fallbacks,bridge:context.window.host};
}
test('Overlapping reconnect capture resolves only the newest generation',async()=>{
 const h=await host(),first=h.event({type:'signal',id:'device',message:{type:'ping'}});await tick();
 const second=h.event({type:'signal',id:'device',message:{type:'ping'}});await tick();
 assert.equal(h.captures.length,2);const old=h.stream(),current=h.stream();
 h.captures[1].resolve(current);await second;h.captures[0].resolve(old);await first;
 assert.equal(h.peers.length,1,'a stale capture created a second peer');
 assert.equal(h.peers[0].track,current.track);assert.equal(old.track.stopped,true);assert.equal(current.track.stopped,false);
 assert.equal(h.signals.length,1);
});
test('A delayed ended event from the old track cannot close the new peer',async()=>{
 const h=await host();let run=h.event({type:'signal',id:'device',message:{type:'ping'}});await tick();
 const old=h.stream();h.captures[0].resolve(old);await run;
 run=h.event({type:'signal',id:'device',message:{type:'ping'}});await tick();
 const current=h.stream();h.captures[1].resolve(current);await run;
 old.track.onended();assert.equal(current.track.stopped,false);assert.equal(h.peers[1].closed,undefined);
 assert.equal(h.signals.filter(([,value])=>value.type==='disconnect').length,0);
});
test('A connected tab with no first frame switches to owned snapshot capture',async()=>{
 const h=await host(),run=h.event({type:'signal',id:'device',message:{type:'ping'}});await tick();
 const capture=h.stream();h.captures[0].resolve(capture);await run;
 const p=h.peers[0];p.channel.onopen();await h.timers[0].fn();
 assert.equal(h.fallbacks.length,1);assert.equal(p.track,h.fallbacks[0].track);
 assert.equal(capture.track.stopped,true);assert.equal(p.track.stopped,false);
});
test('A tab that already encoded video keeps its original capture',async()=>{
 const h=await host(),run=h.event({type:'signal',id:'device',message:{type:'ping'}});await tick();
 const capture=h.stream();h.captures[0].resolve(capture);await run;
 const p=h.peers[0];p.frames=1;p.channel.onopen();await h.timers[0].fn();
 assert.equal(h.fallbacks.length,0);assert.equal(p.track,capture.track);assert.equal(capture.track.stopped,false);
});
test('Zero decoded-frame feedback recovers even when the sender encoded frames',async()=>{
 const h=await host(),run=h.event({type:'signal',id:'device',message:{type:'ping'}});await tick();
 const capture=h.stream();h.captures[0].resolve(capture);await run;
 const p=h.peers[0];p.frames=8;p.channel.readyState='open';p.channel.onopen();
 p.channel.onmessage({data:JSON.stringify({type:'ping',at:1,videoFrames:0})});await h.timers[0].fn();
 assert.equal(h.fallbacks.length,1);assert.equal(capture.track.stopped,true);
});
test('An old initial-frame watchdog cannot replace a reconnected capture',async()=>{
 const h=await host();let run=h.event({type:'signal',id:'device',message:{type:'ping'}});await tick();h.captures[0].resolve(h.stream());await run;
 let resolve;h.peers[0].getStats=()=>new Promise(r=>resolve=r);h.peers[0].channel.onopen();const waiting=h.timers[0].fn();
 run=h.event({type:'signal',id:'device',message:{type:'ping'}});await tick();const capture=h.stream();h.captures[1].resolve(capture);await run;
 resolve(new Map());await waiting;
 assert.equal(h.timers[0].cancelled,true);assert.equal(h.fallbacks.length,0);assert.equal(h.peers[1].track,capture.track);
});
test('Revocation stops tracks and control before any settings refresh, even if refresh fails',async()=>{
 const h=await host(),run=h.event({type:'signal',id:'device',message:{type:'ping'}});await tick();
 const capture=h.stream();h.captures[0].resolve(capture);await run;
 let refresh;h.bridge.state=()=>new Promise((resolve,reject)=>refresh={reject});
 const revoke=h.event({type:'revoke',id:'device'}).catch(error=>error);
 assert.equal(capture.track.stopped,true,'revocation waited for UI state');assert.equal(h.peers[0].closed,true);
 assert.equal(h.sessions.at(-1)[1],null);
 refresh.reject(Error('state-unavailable'));await revoke;
});
