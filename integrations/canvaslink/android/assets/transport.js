/* Public designer API v2. This file owns secure transport and delivery state. */
(()=>{
 let pc,dc,video,paired=false,move,moveFrame,stats={},lastFrames=0,lastFrameAt=0,draftTouched=false;
 const listeners=new Set(),computers=new Map();
 let state={version:2,connection:'idle',discovery:'searching',computers:[],computer:'',error:'',pending:0,delivery:null,stats:{},source:null,draft:''};
 const snapshot=()=>JSON.parse(JSON.stringify(state));
 const update=patch=>{Object.assign(state,patch);for(const listener of listeners)listener(snapshot());};
 const signal=message=>Native.signal(JSON.stringify(message));
 const delivery=new CanvasLinkDelivery.Delivery({channel:()=>dc,onChange:value=>{if(['pointer','scroll'].includes(value.kind)){state.pending=value.pending;return;}update({delivery:value,pending:value.pending});}});
 const raw=value=>{if(dc?.readyState==='open'&&dc.bufferedAmount<65536)dc.send(JSON.stringify(value));};
 function close(){delivery.close();dc=null;pc?.close();pc=null;stats={};lastFrames=0;lastFrameAt=0;window.CanvasLink.stats={};update({stats:{},source:null});if(video)video.srcObject=null;}
 async function offer(message){
   close();update({connection:'connecting',error:''});
   const current=pc=new RTCPeerConnection({iceServers:[]});
   current.ontrack=event=>{if(current!==pc)return;if(video){video.srcObject=event.streams[0];video.play().catch(()=>{});}};
   current.ondatachannel=event=>{
     if(current!==pc)return;dc=event.channel;
     dc.onopen=()=>{if(current===pc)update({connection:'connected',error:''});};
     dc.onclose=()=>{if(current===pc){delivery.close();update({connection:'reconnecting'});}};
     dc.onmessage=event=>{
       if(current!==pc||typeof event.data!=='string'||event.data.length>40000)return;
       let value;try{value=JSON.parse(event.data);}catch{return;}
       if(value.type==='source-state'){update({source:{capture:value.capture,windowFocused:!!value.windowFocused,target:value.target,surface:value.surface||'canvas',viewport:value.viewport||null,terminalView:value.terminalView||null,dragRects:value.dragRects||[],rect:value.rect||null,caret:value.caret||null}});return;}
       if(value.type==='pong')stats.rtt=Math.round(performance.now()-value.at);
       if(delivery.receive(value))return;
       if(value.type==='fixture-state'){window.CanvasLink.fixture=value;Native.acceptance(JSON.stringify(value));}
     };
   };
   current.onconnectionstatechange=()=>{
     if(current!==pc)return;
     if(current.connectionState==='connected'&&dc?.readyState==='open')update({connection:'connected',error:''});
     if(['failed','disconnected'].includes(current.connectionState)){
       delivery.close();update({connection:'reconnecting'});
       setTimeout(()=>{if(paired&&current===pc&&current.connectionState!=='connected')signal({type:'ping'});},2500);
     }
   };
   await current.setRemoteDescription(message);await current.setLocalDescription(await current.createAnswer());
   await new Promise((resolve,reject)=>{if(current.iceGatheringState==='complete')return resolve();const timer=setTimeout(()=>reject(Error('ice-timeout')),12000);current.onicegatheringstatechange=()=>{if(current.iceGatheringState==='complete'){clearTimeout(timer);resolve();}};});
   if(current===pc)signal({type:'answer',sdp:current.localDescription.sdp});
 }
 function connect({code,computerId,host}={}){
   const address=host||computers.get(computerId)?.host||(computers.size===1?[...computers.values()][0].host:'');
   if(!address){update({error:computers.size?'choose-computer':'computer-not-found'});return false;}
   if(!/^\d{6}$/.test(code||'')){update({error:'invalid-code'});return false;}
   update({connection:'pairing',computer:address,error:''});Native.connect(address,code);return true;
 }
 function sendInput(input){
   if(input.type==='pointer'&&input.action==='move'){
     // Coalesce motion only; never replay or coalesce text, clicks, or keys.
     move=input;if(!moveFrame)moveFrame=requestAnimationFrame(()=>{moveFrame=null;const m=move;move=null;delivery.send(m).catch(()=>{});});return Promise.resolve({status:'coalesced'});
   }
   if(move){cancelAnimationFrame(moveFrame);moveFrame=null;const m=move;move=null;delivery.send(m).catch(()=>{});}
   return delivery.send(input);
 }
 const api=window.CanvasLinkClient=Object.freeze({
   version:2,getState:snapshot,subscribe(listener){listeners.add(listener);listener(snapshot());return()=>listeners.delete(listener);},
   attachVideo(element){video=element;},connect,discover(){update({discovery:'searching'});Native.discover();},
   disconnect(){paired=false;close();Native.disconnect();update({connection:'idle'});},
   sendInput,sendText(text){if(typeof text!=='string'||!text.length||text.length>8000)return Promise.reject(Error('invalid-text'));return sendInput({type:'text',text});},
   sendKey(key,modifiers=[]){return sendInput({type:'key',key,modifiers});},
   setDraft(text){draftTouched=true;state.draft=String(text).slice(0,8000);return Native.saveDraft(state.draft);},
   hideKeyboard(){Native.hideKeyboard();},resume(){if(paired)signal({type:'ping'});}
 });
 window.CanvasLink={stats:{},fixture:null,connectForTest:(host,code)=>connect({host,code}),requestFixture:requestId=>raw({type:'stats',...(typeof requestId==='string'&&requestId.length<=80?{requestId}:{})}),receive(event){
   const value=event.value;
   if(event.type==='discovered'){computers.set(value.id,{...value});update({discovery:'ready',computers:[...computers.values()]});}
   if(event.type==='lost'){computers.delete(value);update({computers:[...computers.values()]});}
   if(event.type==='discovery')update({discovery:value});
   if(event.type==='draft'&&!draftTouched)update({draft:value||''});
   if(event.type==='paired'){paired=true;update({connection:'connecting',computer:value.host,error:''});}
   if(event.type==='signal'){
     if(value.type==='offer')offer(value).catch(error=>update({connection:'error',error:error.message}));
     if(value.type==='disconnect'){close();update({connection:'reconnecting'});}
   }
   if(event.type==='error')update({connection:paired?'reconnecting':'error',error:String(value)});
   if(event.type==='network')update({connection:paired?'reconnecting':'idle',error:String(value)});
   // A reconnect ping sent while Wi-Fi is down cannot reach the host. Retry
   // only signalling once encrypted polling succeeds; input is never replayed.
   if(event.type==='network-restored'&&paired&&!document.hidden&&state.connection!=='connected')signal({type:'ping'});
   if(event.type==='disconnected'){paired=false;close();update({connection:'idle'});}
 }};
 document.addEventListener('visibilitychange',()=>{if(!paired)return;if(document.hidden){signal({type:'disconnect'});close();update({connection:'suspended'});}else{update({connection:'reconnecting'});signal({type:'ping'});}});
 setInterval(async()=>{
   const current=pc;if(!current)return;
   try{
     raw({type:'ping',at:performance.now(),videoFrames:stats.framesDecoded||0});const reports=await current.getStats();if(current!==pc)return;let inbound,selected;
     reports.forEach(r=>{if(r.type==='inbound-rtp'&&r.kind==='video')inbound=r;if(r.type==='candidate-pair'&&r.state==='succeeded'&&r.nominated)selected=r;});
     if(inbound){
       const now=performance.now(),frames=inbound.framesDecoded||0;if(frames>lastFrames){lastFrameAt=now;lastFrames=frames;}
       stats={...stats,framesDecoded:frames,framesPerSecond:inbound.framesPerSecond||0,width:inbound.frameWidth||0,height:inbound.frameHeight||0,inputs:delivery.sent,ackedInputs:delivery.acked,state:current.connectionState,bytes:inbound.bytesReceived||0,stalled:state.source?state.source.capture==='stalled':!!lastFrameAt&&now-lastFrameAt>15000};
       if(selected){const local=reports.get(selected.localCandidateId),remote=reports.get(selected.remoteCandidateId);stats.transport=local?.protocol||'';stats.local=local?.address||'';stats.remote=remote?.address||'';stats.candidateType=remote?.candidateType||'';}
       window.CanvasLink.stats=stats;Native.diagnostics(JSON.stringify(stats));update({stats:{...stats}});
     }
   }catch{}
 },1000);
 Native.discover();Native.restore();Native.loadDraft();
})();
