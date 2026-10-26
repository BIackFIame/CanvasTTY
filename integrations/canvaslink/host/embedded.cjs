// CanvasTTY main-process integration. No global input or desktop capture.
const {app,BrowserWindow,ipcMain,session,nativeImage}=require('electron');
const http=require('node:http'),os=require('node:os'),path=require('node:path'),fs=require('node:fs');
const {publish}=require('./discovery.cjs');
const {lanAddresses:addresses}=require('./network.cjs');
const {Pairing,privateAddress}=require('./security.cjs');
const {InputQueue}=require('./input-queue.cjs');
const {focusOwnedWindow}=require('./owned-focus.cjs');
const {OwnedPointer}=require('./owned-pointer.cjs');
const {installSettingsHost}=require('./settings-host.cjs');
const {validateInput}=require('./native-input.cjs');
const {selectPointerScript,closeSelectScript}=require('./remote-select.cjs');
const {createSnapshot}=require('./snapshot.cjs');
function install({getWindow,glasses}={}){
 let target,panel,server,bonjour,pairing,port,frameTimer,healthTimer,enabled=false;
 const queues=new Map(),epochs=new Map(),pointer=new OwnedPointer();let bound=false,captureMode='tab',captureError='',captureQuality=null,frameSequence=0,pendingFrame=0,healthBusy=false,selectPointer=false,sourceSurface='canvas',lastHealth=0;let report={phase:'disabled'},lastFrame=0,startFallback=()=>{};
 const runtime=()=>path.join(app.getPath('userData'),'canvaslink');
 const option=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
 const closeRemoteSelect=()=>{selectPointer=false;if(target&&!target.isDestroyed())target.webContents.executeJavaScript(closeSelectScript).catch(()=>{});};
 const ownWindow=()=>getWindow?.()||BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()&&/\/renderer\/index\.html/.test(w.webContents.getURL()));
 const settingsSnapshot=()=>({enabled,phase:enabled?report.phase:'disabled',pin:enabled?pairing.pin:'',expires:enabled?pairing.expires:0,devices:enabled?[...pairing.sessions.values()].filter(s=>s.expires>Date.now()).map(s=>({name:s.name})):[]});
 installSettingsHost({ipcMain,getWindow:ownWindow,snapshot:settingsSnapshot,command:async action=>{
  if(action==='enable')await open();
  else if(action==='disable')disable();
  else{if(!enabled)throw Error('canvaslink-disabled');pairing.rotate();report={phase:'waiting',inputs:0,error:''};events({type:'state'});}
  return settingsSnapshot();
 }});
 const events=value=>{if(panel&&!panel.isDestroyed())panel.webContents.send('link:event',value);};
 const source=()=>({id:'embedded:'+target.id,name:target.getTitle(),pid:process.pid});
 const state=()=>{const [width,height]=target.getContentSize();return {pin:pairing.pin,expires:pairing.expires,addresses:addresses(),port,fixture:false,embedded:true,nativeCapture:true,captureMode,glassesSupported:!!glasses,width,height,source:target.getTitle(),connected:[...pairing.sessions.values()].map(s=>({id:s.id,name:s.name})),report};};
 const trusted=event=>{if(!panel||event.sender!==panel.webContents||event.senderFrame!==panel.webContents.mainFrame)throw Error('untrusted-renderer');};
 const authorized=id=>enabled&&pairing?.sessions.has(id)&&pairing.sessions.get(id).expires>Date.now()&&target&&!target.isDestroyed();
 function safeSignal(message){if(!message||!['offer','answer','disconnect','ping'].includes(message.type))throw Error('invalid-signal');if(['offer','answer'].includes(message.type)&&(typeof message.sdp!=='string'||message.sdp.length>80000))throw Error('invalid-sdp');return message;}
 function stopFrames(){clearInterval(healthTimer);clearInterval(frameTimer);frameTimer=null;try{if(target&&!target.isDestroyed())target.webContents.endFrameSubscription();}catch{}}
 const {focusScript}=require('./focus.cjs');
 async function apply(input,active){
   validateInput(input);if(!target||target.isDestroyed())throw Error('window-closed');
   if(target.isMinimized())throw Error('window-minimized');
   // Electron routes these events solely to its own renderer. Never use CGEvent
   // or system keystrokes, and never inject into another app's focused window.
   // The pairing child must not retain key-window focus over its parent.
   if(panel&&!panel.isDestroyed()&&panel.isVisible())panel.hide();
   await focusOwnedWindow({app,target,active});
   if(!target.isFocused())throw Error('canvas-focus-required');
   const wc=target.webContents,[width,height]=target.getContentSize();
   const point={x:Math.min(width-1,Math.round(input.x*width)),y:Math.min(height-1,Math.round(input.y*height))};
   if(input.type==='text'){const focus=await wc.executeJavaScript(focusScript);if(!active())throw Error('session-ended');if(!focus.editable)throw Error('text-target-required');await wc.insertText(input.text);return;}
   if(input.type==='pointer'){
     if(input.action==='down')selectPointer=input.button!==2&&await wc.executeJavaScript(selectPointerScript(point.x,point.y));
     if(!active()){await wc.executeJavaScript(closeSelectScript);throw Error('session-ended');}
     if(!selectPointer)pointer.send(wc,{...point,type:{down:'mouseDown',up:'mouseUp',move:'mouseMove'}[input.action],button:input.button===2?'right':'left',clickCount:1,modifiers:input.drag?['leftButtonDown']:[]});if(input.action==='up'){
     selectPointer=false;
     // Input dispatch is asynchronous. Read focus after the renderer has handled
     // the click and settled its layout, rather than acknowledging old focus.
     const focus=await wc.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(${focusScript}))))`);
     sourceSurface=focus.surface;if(!active())throw Error('session-ended');return {focus};}return;}
   if(input.type==='scroll'){wc.sendInputEvent({...point,type:'mouseWheel',deltaX:-input.dx,deltaY:-input.dy,canScroll:true});return;}
   const keyCode={Enter:'Return',ArrowLeft:'Left',ArrowRight:'Right',ArrowUp:'Up',ArrowDown:'Down'}[input.key]||input.key;
   wc.sendInputEvent({type:'keyDown',keyCode,modifiers:input.modifiers});wc.sendInputEvent({type:'keyUp',keyCode,modifiers:input.modifiers});
 }
 function reply(res,status,body){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
 async function serve(req,res){
   if(!enabled||!privateAddress(req.socket.remoteAddress)||req.headers.origin||req.method!=='POST'||!['/pair/start','/pair/finish','/channel'].includes(req.url)){reply(res,403,{error:'forbidden'});return;}
   if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){reply(res,415,{error:'json-required'});return;}
   try{let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>131072)throw Error('too-large');chunks.push(chunk);}const body=JSON.parse(Buffer.concat(chunks).toString());let result;
     if(req.url==='/pair/start')result=pairing.start(body,req.socket.remoteAddress);
     else if(req.url==='/pair/finish')result=pairing.finish(body,req.socket.remoteAddress);
     else result=pairing.receive(body,req.socket.remoteAddress,(s,message)=>{
       if(message.type==='poll')return {messages:s.queue.splice(0),source:target.getTitle()};
       if(message.type==='signal'){events({type:'signal',id:s.id,message:safeSignal(message.message)});return {ok:true};}
       if(message.type==='revoke'){pairing.rotate();events({type:'state'});return {ok:true};}throw Error('unsupported-operation');
     });reply(res,200,result);
   }catch{if(!res.headersSent)reply(res,403,{error:'request-rejected'});}
 }
 function bindIPC(){
   if(bound)return;bound=true;
   ipcMain.handle('link:input-session',(event,id,token)=>{trusted(event);if(token===null){epochs.delete(id);pointer.release();selectPointer=false;target?.webContents.executeJavaScript(closeSelectScript).catch(()=>{});}else{if(!authorized(id))throw Error('not-authorized');pointer.release();epochs.set(id,token);queues.delete(id);}return true;});
   ipcMain.handle('link:capture-fallback',(event,reason)=>{trusted(event);captureMode='snapshot-fallback';captureError=String(reason||'').replace(/[^A-Za-z]/g,'').slice(0,60);startFallback();return true;});
   ipcMain.on('link:frame-consumed',(event,sequence)=>{trusted(event);if(sequence===pendingFrame)pendingFrame=0;});
   ipcMain.handle('link:glasses',async(event,command)=>{trusted(event);if(!glasses||!['state','begin-pairing','cancel-pairing'].includes(command))throw Error('unsupported-glasses-command');return command==='state'?glasses.state():glasses.command({type:command});});
   ipcMain.handle('link:state',event=>{trusted(event);return state();});
   ipcMain.handle('link:permissions',event=>{trusted(event);return {platform:process.platform,embedded:true};});
   ipcMain.handle('link:settings',event=>{trusted(event);throw Error('not-required-for-owned-window');});
   ipcMain.handle('link:sources',event=>{trusted(event);return [source()];});
   ipcMain.handle('link:select',(event,id)=>{trusted(event);if(id!==source().id)throw Error('invalid-source');return state();});
   ipcMain.handle('link:rotate',event=>{trusted(event);pairing.rotate();return state();});
   ipcMain.handle('link:signal',(event,id,message)=>{trusted(event);if(!authorized(id))throw Error('not-authorized');pairing.queue(id,safeSignal(message));});
   ipcMain.handle('link:input',(event,id,input)=>{
     trusted(event);if(!authorized(id))throw Error('not-authorized');if(typeof input?.id!=='string'||!/^[A-Za-z0-9-]{1,80}$/.test(input.id))throw Error('invalid-input-id');
     let q=queues.get(id);if(!q){const active=()=>authorized(id)&&epochs.get(id)===input.epoch;q=new InputQueue({active,apply:value=>apply(value,active),reply:result=>{const resolve=q.waiters.get(result.id);if(resolve){q.waiters.delete(result.id);resolve(result);}}});q.waiters=new Map();queues.set(id,q);}
     if(q.waiters.has(input.id))throw Error('input-in-progress');return new Promise(resolve=>{q.waiters.set(input.id,resolve);q.receive(input);});
   });
   ipcMain.on('link:report',(event,value)=>{
     if(!panel||panel.isDestroyed())return;
     trusted(event);if(!value||typeof value.phase!=='string')return;
     report={phase:value.phase.slice(0,80),inputs:Number(value.inputs)||0,error:String(value.error||'').slice(0,200)};
   });
 }
 async function open(){
   if(enabled)return;
   target=ownWindow();
   if(!target||target.isDestroyed())throw Error('canvas-window-unavailable');
   fs.mkdirSync(runtime(),{recursive:true,mode:0o700});
   pairing=new Pairing({onPair:s=>{events({type:'paired',id:s.id});},onRevoke:id=>{epochs.delete(id);queues.delete(id);pointer.release();closeRemoteSelect();events({type:'revoke',id});}});
   server=http.createServer(serve);server.requestTimeout=10000;server.headersTimeout=5000;server.maxConnections=32;
   try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(option('--canvaslink-port')||3499),'0.0.0.0',resolve);});}catch(error){server.close();throw error;}
   try{
   port=server.address().port;enabled=true;captureMode='tab';captureError='';lastFrame=0;pendingFrame=0;bindIPC();
   const captureSession=session.fromPartition('canvaslink-owned-capture');
   panel=new BrowserWindow({width:600,height:700,show:false,parent:target,title:'CanvasTTY · Телефон / планшет',webPreferences:{session:captureSession,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
   // Older Electron reports display capture as media with an empty mediaTypes
   // array. Actual camera/microphone requests remain denied in this own session.
   captureSession.setPermissionCheckHandler((contents,permission)=>contents===panel?.webContents&&permission==='display-capture');
   captureSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===panel?.webContents&&(permission==='display-capture'||permission==='media'&&Array.isArray(details.mediaTypes)&&details.mediaTypes.length===0)));
   captureSession.setDisplayMediaRequestHandler((request,callback)=>{try{if(!enabled||request.frame!==panel.webContents.mainFrame||target.isDestroyed())return callback({});callback({video:target.webContents.mainFrame});}catch{callback({});}});
   panel.webContents.setWindowOpenHandler(()=>({action:'deny'}));panel.webContents.on('will-navigate',e=>e.preventDefault());
   panel.on('close',event=>{if(enabled){event.preventDefault();panel.hide();}});
   bonjour=publish({name:`CanvasLink ${os.hostname().split('.')[0]}`,port,ipv4:addresses()[0]||'',embedded:true});
   await panel.loadFile(path.join(__dirname,'index.html'));
   startFallback=()=>{if(frameTimer)return;let busy=false;
   const frame=image=>{
     const now=Date.now();if(!enabled||!pairing.sessions.size||pendingFrame||now-lastFrame<100||image.isEmpty())return;lastFrame=now;
     const encoded=createSnapshot(image,nativeImage);if(!encoded)return;
     captureQuality={format:encoded.format,width:encoded.width,height:encoded.height,nativeScale:encoded.scaleFactor,bytes:encoded.pixels.length,encodeMs:Date.now()-now};
     pendingFrame=++frameSequence;events({type:'frame',sequence:pendingFrame,width:encoded.width,height:encoded.height,pixels:encoded.pixels});
   };
   target.webContents.beginFrameSubscription(false,frame);
   frameTimer=setInterval(async()=>{if(busy||pendingFrame||!pairing.sessions.size||Date.now()-lastFrame<100||target.isDestroyed())return;busy=true;try{frame(await target.webContents.capturePage(undefined,{stayHidden:true,stayAwake:false}));}catch{}finally{busy=false;}},100);
   };
   healthTimer=setInterval(async()=>{pairing.expire();if(healthBusy||!pairing.sessions.size||target.isDestroyed()||sourceSurface!=='settings'&&Date.now()-lastHealth<1000)return;healthBusy=true;lastHealth=Date.now();try{const focus=await target.webContents.executeJavaScript(focusScript);sourceSurface=focus.surface;events({type:'health',value:{capture:captureMode==='tab'?(target.webContents.isBeingCaptured()?'active':'stalled'):(Date.now()-lastFrame<3000?'active':'stalled'),windowFocused:target.isFocused(),target:focus.kind,surface:focus.surface,viewport:focus.viewport,terminalView:focus.terminalView,dragRects:focus.dragRects,rect:focus.rect,caret:focus.caret}});}catch{}finally{healthBusy=false;}},200);
   target.removeListener('closed',disable);target.once('closed',disable);
   }catch(error){disable();throw error;}
 }
 function disable(){enabled=false;pairing?.rotate();pointer.release();closeRemoteSelect();stopFrames();bonjour?.destroy();server?.close();if(panel&&!panel.isDestroyed())panel.destroy();queues.clear();epochs.clear();}
 app.on('before-quit',()=>{disable();});
 return {open,disable};
}
module.exports={install};
