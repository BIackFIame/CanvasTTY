/* Ordered, immediate terminal input. Only the peer owns the queue; never replay. */
(()=>{
 const api=window.CanvasLinkClient;
 let token='',control=false,inflight=0;
 const notify=detail=>window.dispatchEvent(new CustomEvent('canvaslink:input-state',{detail:{active:!!token,control,inflight,...detail}}));
 function stop(focus){token='';control=false;api.hideKeyboard();notify({composition:'',...(focus?{focus}:{})});}
 function fail(error){stop();window.dispatchEvent(new CustomEvent('canvaslink:notice',{detail:error.message||String(error)}));}
 function send(value){
  if(api.getState().connection!=='connected')return Promise.reject(Error('not-connected'));
  const owner=token;inflight++;notify();
  let promise;try{promise=api.sendInput(value);}catch(error){promise=Promise.reject(error);}
  return Promise.resolve(promise).then(result=>{if(result?.status!=='processed')throw Error('delivery-uncertain');return result;}).catch(error=>{if(owner===token)fail(error);throw error;}).finally(()=>{inflight--;notify();});
 }
 window.CanvasLinkInput=Object.freeze({
  open(focus){if(!focus?.editable)return stop(focus);token=crypto.randomUUID();control=false;notify({focus,composition:''});if(typeof Native?.showKeyboard==='function')Native.showKeyboard(token);},
  stop,
  toggleControl(){control=!control;notify();},
  key(key,modifiers=[]){
   if(control&&!modifiers.includes('control'))modifiers=[...modifiers,'control'];control=false;notify();
   if(typeof Native?.terminalKey==='function'&&token)Native.terminalKey(key,JSON.stringify(modifiers));else send({type:'key',key,modifiers}).catch(()=>{});
  },
  paste(){control=false;notify();if(token&&typeof Native?.paste==='function')Native.paste();else window.dispatchEvent(new CustomEvent('canvaslink:notice',{detail:'Сначала коснитесь терминала или текстового поля для вставки.'}));},
  receive(value){
   if(!token||value?.token!==token)return;
   if(value.type==='composition'){notify({composition:value.text||''});return;}
   if(value.type==='notice'){window.dispatchEvent(new CustomEvent('canvaslink:notice',{detail:value.text}));return;}
   if(value.type==='paste'){control=false;notify();send({type:'text',text:value.text}).catch(()=>{});return;}
   if(value.type==='text'){
    const useControl=control;control=false;notify();
    if(useControl&&[...value.text].length===1&&/^[a-z]$/i.test(value.text)){send({type:'key',key:value.text.toLowerCase(),modifiers:['control']}).catch(()=>{});}
    else send({type:'text',text:value.text}).catch(()=>{});
   }
   if(value.type==='key'){
    let modifiers=value.modifiers||[];if(control&&!modifiers.includes('control'))modifiers=[...modifiers,'control'];
    control=false;notify();send({type:'key',key:value.key,modifiers}).catch(()=>{});
   }
  },
  active:()=>!!token
 });
 api.subscribe(state=>{if(state.connection!=='connected'&&token)stop();});
})();
