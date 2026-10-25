(()=>{
 'use strict';
 const $=id=>document.getElementById(id),api=window.CanvasLinkClient,input=window.CanvasLinkInput;
 let state=api.getState(),selected='',signature='',lastPointer=null,touchTimer,noticeTimer,viewTarget='';
 const put=(id,value)=>{if($(id)&&$(id).textContent!==value)$(id).textContent=value;};
 function targetStatus(){const kind=(state.source?.target==='terminal'||viewTarget==='terminal'&&state.source?.surface!=='settings')?'Терминал':state.source?.target==='text-field'?'Текстовое поле':state.source?.surface==='settings'?'Настройки':'Canvas';put('target-status',(input.active()?'Ввод · ':'')+kind);document.querySelector('.session-badge').dataset.state=state.connection;}
 const errors={'delivery-uncertain':'Доставка не подтверждена. Проверьте терминал. Ввод остановлен, повтора не будет.','input-busy':'Канал занят. Ввод остановлен. Коснитесь терминала, чтобы продолжить.','not-connected':'Связь прервана. Ввод остановлен.','text-target-required':'Коснитесь терминала или текстового поля.','invalid-code':'Введите шесть цифр из Настройки → CanvasLink.','input-rejected':'Компьютер отклонил ввод.'};
 function notice(value){put('input-status',errors[value]||value);$('input-status').hidden=!value;clearTimeout(noticeTimer);if(value)noticeTimer=setTimeout(()=>{$('input-status').hidden=true;},7000);}
 function updateConnect(){const busy=['connecting','pairing','resuming'].includes(state.connection);$('connect').disabled=busy||!/^\d{6}$/.test($('pin').value)||(!selected&&!($('manual').open&&$('address').value.trim()));$('connect').querySelector('span').textContent=busy?'Подключаем…':'Подключиться';}
 function renderComputers(s){
  const list=s.computers||[];if(!list.some(c=>c.id===selected))selected=list.length===1?list[0].id:'';
  const next=JSON.stringify(list.map(c=>[c.id,c.name]));
  if(next!==signature){signature=next;$('computers').replaceChildren();for(const c of list){const button=document.createElement('button');button.type='button';button.dataset.computerId=c.id;button.className='computer';const name=document.createElement('span');name.textContent=String(c.name||'CanvasTTY').replace(/^CanvasLink\s+/,'');const icon=document.createElement('span');icon.className='computer-icon';icon.textContent='▣';const check=document.createElement('span');check.className='computer-check';check.textContent='✓';button.append(icon,name,check);button.onclick=()=>{selected=c.id;renderComputers(state);updateConnect();};$('computers').append(button);}}
  for(const b of $('computers').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.computerId===selected));
  $('pair-status').hidden=!!list.length;put('pair-status',s.discovery==='searching'?'Ищем компьютер в вашей Wi-Fi сети…':'Включите CanvasLink в настройках CanvasTTY на компьютере.');
 }
 function render(s){
  state=s;const show=s.connection==='connected'||['reconnecting','suspended'].includes(s.connection)||(!['idle','error'].includes(s.connection)&&!$('workspace').hidden);
  $('workspace').hidden=!show;$('pairing').hidden=show;document.body.classList.toggle('is-workspace',show);renderComputers(s);updateConnect();
  const labels={connected:'Подключено',connecting:'Подключаем…',pairing:'Проверяем код…',resuming:'Восстанавливаем…',reconnecting:'Нет связи',suspended:'На паузе'};
  put('connection-status',labels[s.connection]||'Нет связи');$('connection-pill').dataset.state=s.connection;
  for(const button of $('controls').querySelectorAll('button'))if(button.id!=='menu-toggle')button.disabled=s.connection!=='connected';
  const stats=s.stats||{},source=s.source||{};
  const wait=s.connection!=='connected'||!stats.framesDecoded; // A static frame remains usable; do not cover it with an opaque waiting card.
  $('waiting').hidden=!wait;$('resume').hidden=!['reconnecting','suspended'].includes(s.connection);
  put('waiting-title',s.connection==='suspended'?'Соединение на паузе':s.connection==='reconnecting'?'Восстанавливаем связь':'Открываем CanvasTTY');
  put('waiting-copy',s.connection==='reconnecting'?'Ввод остановлен. Ничего не отправляем повторно.':'Изображение появится здесь.');
  targetStatus();
  put('metrics',`Видео         ${stats.width||'—'} × ${stats.height||'—'}\nКадров/с      ${Number.isFinite(stats.framesPerSecond)?stats.framesPerSecond.toFixed(1):'—'}\nRTT канала    ${Number.isFinite(stats.rtt)?Math.round(stats.rtt)+' мс':'—'}\nОжидают ACK   ${s.pending||0}`);
  const error=s.error?errors[s.error]||s.error:'';put('pair-error',show?'':error);put('stream-error',show?error:'');$('stream-error').hidden=!show||!error;
 }
 $('pair-form').onsubmit=e=>{e.preventDefault();try{if(api.connect({code:$('pin').value,computerId:selected||undefined,host:$('manual').open?$('address').value.trim()||undefined:undefined})){$('pin').value='';document.activeElement?.blur();api.hideKeyboard();}}catch(error){put('pair-error',errors[error.message]||error.message);}updateConnect();};
 $('pin').oninput=updateConnect;$('address').oninput=updateConnect;$('manual').ontoggle=updateConnect;$('rescan').onclick=()=>api.discover();$('resume').onclick=()=>api.resume();
 // Pointer-down never steals the native terminal IME focus.
 $('controls').addEventListener('pointerdown',e=>{if(e.target.closest('button'))e.preventDefault();});
 for(const b of document.querySelectorAll('[data-key]'))b.onclick=()=>input.key(b.dataset.key,b.dataset.control?['control']:[]);
 $('ctrl').onclick=()=>input.toggleControl();$('paste').onclick=()=>input.paste();
 $('keyboard-toggle').onclick=()=>{if(input.active())input.stop();else notice('Коснитесь терминала — клавиатура откроется сама.');};
 $('menu-toggle').onclick=()=>{input.stop();$('session-menu').showModal();};$('menu-close').onclick=()=>$('session-menu').close();
 $('diagnostics-toggle').onclick=()=>{$('session-menu').close();$('diagnostics').showModal();};$('diagnostics-close').onclick=()=>$('diagnostics').close();
 $('disconnect').onclick=()=>{$('session-menu').close();$('disconnect-dialog').showModal();};$('cancel-disconnect').onclick=()=>$('disconnect-dialog').close();$('confirm-disconnect').onclick=()=>{$('disconnect-dialog').close();input.stop();api.disconnect();};
 for(const id of ['fit','mode','reset-view'])$(id).addEventListener('click',()=>{$('session-menu').close();});
 window.addEventListener('canvaslink:tap',e=>{if(document.querySelector('dialog[open]')||state.connection!=='connected')return;input.open(e.detail.focus);});
 window.addEventListener('canvaslink:notice',e=>notice(e.detail));
 window.addEventListener('canvaslink:input-state',e=>{const d=e.detail;$('ctrl').setAttribute('aria-pressed',String(d.control));$('keyboard-toggle').setAttribute('aria-pressed',String(d.active));$('keyboard-toggle').setAttribute('aria-label',d.active?'Скрыть клавиатуру':'Как открыть клавиатуру');$('workspace').classList.toggle('is-typing',d.active);if(d.composition!==undefined){put('preedit',d.composition);$('preedit').hidden=!d.composition;}if(d.focus)state={...state,source:{...state.source,...d.focus,target:d.focus.kind}};targetStatus();});
 function pointerPosition(p){const video=$('video'),b=video.getBoundingClientRect(),v=$('viewport').getBoundingClientRect(),w=video.videoWidth||state.stats?.width||1280,h=video.videoHeight||state.stats?.height||800,k=Math.min(b.width/w,b.height/h);return{x:b.left-v.left+(b.width-w*k)/2+p.x*w*k,y:b.top-v.top+(b.height-h*k)/2+p.y*h*k};}
 function paint(p,pulse){const q=pointerPosition(p);$('local-cursor').hidden=!p.trackpad;$('local-cursor').style.transform=`translate(${q.x-4}px,${q.y-3}px)`;if(pulse&&p.action==='down'){const f=$('touch-feedback');clearTimeout(touchTimer);f.hidden=false;f.style.transform=`translate(${q.x-16}px,${q.y-16}px)`;touchTimer=setTimeout(()=>{f.hidden=true;},280);}}
 window.addEventListener('canvaslink:pointer',e=>{lastPointer=e.detail;paint(lastPointer,true);});window.addEventListener('canvaslink:view',e=>{viewTarget=e.detail.target||'';targetStatus();if(lastPointer){lastPointer.trackpad=e.detail.trackpad;paint(lastPointer,false);}});
 const resize=()=>{document.documentElement.style.setProperty('--app-height',Math.max(120,Math.round(window.visualViewport?.height||innerHeight))+'px');if(lastPointer)paint(lastPointer,false);};window.visualViewport?.addEventListener('resize',resize);window.addEventListener('resize',resize);resize();
 api.attachVideo($('video'));api.subscribe(render);
})();
