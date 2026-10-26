'use strict';
const fs=require('node:fs');const path=require('node:path');
const {chromium}=require(process.env.CANVASLINK_PLAYWRIGHT || 'playwright');
const root=path.resolve(__dirname,'..');
function fixtureTransport(){
 const state={version:2,connection:'idle',discovery:'ready',computers:[{id:'test-computer',name:'CanvasLink Тестовый компьютер',host:'127.0.0.1:3499'}],computer:'',error:'',pending:0,delivery:null,draft:'',stats:{width:1280,height:800,framesDecoded:2,framesPerSecond:0,rtt:0},source:{capture:'active',windowFocused:true,target:'terminal'}};
 const listeners=new Set(),calls=[];let behavior={saveDraft:true,deferText:false,focus:null};let pendingText;let nativeToken='';window.Native={showKeyboard(token){nativeToken=token;calls.push({type:'show-keyboard'});},terminalKey(key,modifiers){CanvasLinkInput.receive({token:nativeToken,type:'key',key,modifiers:JSON.parse(modifiers)});},paste(){CanvasLinkInput.receive({token:nativeToken,type:'paste',text:behavior.clipboard||''});}};
 const snapshot=()=>JSON.parse(JSON.stringify(state));const emit=patch=>{Object.assign(state,patch);listeners.forEach(fn=>fn(snapshot()));};
 const ensure=()=>{if(state.connection!=='connected')throw Error('not-connected');};
 window.__uiFixture={calls,emit,ime:value=>CanvasLinkInput.receive({...value,token:nativeToken}),configure:patch=>Object.assign(behavior,patch),resolveText(status='processed'){if(!pendingText)throw Error('No pending send');const id='fixture-text';emit({pending:0,delivery:{id,kind:'text',status}});pendingText.resolve({id,status});pendingText=null;},rejectText(message='delivery-uncertain'){emit({pending:0,delivery:{id:'fixture-text',kind:'text',status:'uncertain'}});pendingText?.reject(Error(message));pendingText=null;}};
 const api=window.CanvasLinkClient={version:2,getState:snapshot,subscribe(fn){listeners.add(fn);fn(snapshot());return()=>listeners.delete(fn);},attachVideo(video){
  const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=800;const c=canvas.getContext('2d');
  c.fillStyle='#161d18';c.fillRect(0,0,1280,800);c.fillStyle='#202a22';c.fillRect(0,0,190,800);c.fillStyle='#d6ef88';c.font='bold 23px sans-serif';c.fillText('CanvasTTY',28,54);c.fillStyle='#aab6a5';c.font='18px sans-serif';c.fillText('Тестовая сцена',28,117);c.fillText('Интерфейс',28,162);c.fillText('Жесты',28,206);
  c.strokeStyle='#3e4b3f';c.lineWidth=2;c.strokeRect(235,105,990,570);c.fillStyle='#edf1e6';c.font='32px sans-serif';c.fillText('Рабочее пространство',273,165);c.fillStyle='#aab6a5';c.font='22px sans-serif';c.fillText('Собственная сцена для проверки интерфейса',273,220);c.font='18px sans-serif';c.fillText('Нет подключения к компьютеру. Нет реального терминала.',273,264);
  c.fillStyle='#28352a';for(let i=0;i<3;i++)c.fillRect(273+i*300,320,270,210);c.fillStyle='#d6ef88';c.font='20px sans-serif';c.fillText('Касание',297,365);c.fillText('Масштаб',597,365);c.fillText('Ввод',897,365);c.fillStyle='#879682';c.font='15px sans-serif';c.fillText('UI FIXTURE · НЕ СНИМОК ПОДКЛЮЧЁННОГО КОМПЬЮТЕРА',273,720);
  video.srcObject=canvas.captureStream(2);video.play().catch(()=>{});
 },discover(){calls.push({type:'discover'});emit({discovery:'searching'});},connect(options){calls.push({type:'connect',computerId:options.computerId,manual:Boolean(options.host),codeLength:options.code?.length});if(!/^\d{6}$/.test(options.code||'')){emit({error:'invalid-code'});return false;}emit({connection:'pairing',error:''});return true;},setDraft(text){calls.push({type:'draft',text});state.draft=String(text).slice(0,8000);return behavior.saveDraft;},sendText(text){calls.push({type:'text',text});try{ensure();}catch(error){return Promise.reject(error);}emit({pending:1,delivery:{id:'fixture-text',kind:'text',status:'pending'}});if(behavior.deferText)return new Promise((resolve,reject)=>{pendingText={resolve,reject};});emit({pending:0,delivery:{id:'fixture-text',kind:'text',status:'processed'}});return Promise.resolve({id:'fixture-text',status:'processed'});},sendKey(key,modifiers=[]){calls.push({type:'key',key,modifiers});try{ensure();return Promise.resolve({id:'fixture-key',status:'processed'});}catch(error){return Promise.reject(error);}},sendInput(input){calls.push({type:'input',input});if(input.type==='text')return api.sendText(input.text);try{ensure();return Promise.resolve({id:'fixture-input',status:'processed',...(input.action==='up'&&behavior.focus?{focus:behavior.focus}:{})});}catch(error){return Promise.reject(error);}},hideKeyboard(){calls.push({type:'hide-keyboard'});},resume(){calls.push({type:'resume'});},disconnect(){calls.push({type:'disconnect'});emit({connection:'idle'});}};
}
async function openUI({width=1024,height=768,touch=false,connected=false}={}){
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width,height},isMobile:touch,hasTouch:touch});
 const errors=[];const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));page.on('console',event=>{if(event.type()==='error')errors.push(event.text());});
 await page.route('https://appassets.androidplatform.net/client/**',route=>{
  const file=new URL(route.request().url()).pathname.split('/').pop();
  if(file==='transport.js')return route.fulfill({contentType:'application/javascript',body:'('+fixtureTransport.toString()+')();'});
  if(!['index.html','style.css','client.js','gestures.js','delivery.js','direct-input.js','onest.ttf'].includes(file))return route.abort();
  return route.fulfill({contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':'text/html',body:fs.readFileSync(path.join(root,'android/assets',file))});
 });
 await page.goto('https://appassets.androidplatform.net/client/index.html');
 if(connected)await page.evaluate(()=>__uiFixture.emit({connection:'connected'}));
 return {browser,context,page,errors};
}
module.exports={openUI,root};
