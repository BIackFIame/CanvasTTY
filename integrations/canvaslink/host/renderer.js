const $ = id => document.getElementById(id);
let state, stream, peer, channel, activeId, inputs = 0, generation = 0, firstFrameTimer;
let fixtureText = '', fixtureClicks = 0, fixtureKeys = [], fixturePointer = { x: .5, y: .5 };
function report(phase, error = '') { window.host.report({ phase, inputs, error }); }
async function refreshState() {
  state = await window.host.state();
  if(state.embedded){$('source-section').hidden=true;$('mac-permissions').hidden=true;$('device-tabs').hidden=!state.glassesSupported;}
  $('pin').textContent = state.pin ? state.pin.slice(0, 3) + ' ' + state.pin.slice(3) : 'СВЯЗАНО';
  $('addresses').textContent = state.addresses.map(ip => `${ip}:${state.port}`).join('\n') || 'Нет локального IPv4-адреса';
  $('status').textContent = state.connected.length ? `Подключено: ${state.connected[0].name} · ${state.source || 'выберите окно'}` : 'Ожидание планшета';
}
function closePeer() {
  clearTimeout(firstFrameTimer);
  if(activeId)window.host.inputSession(activeId,null).catch(()=>{});
  generation++; activeId = null; channel?.close(); peer?.close(); stream?.getTracks().forEach(t => t.stop());
  channel = null; peer = null; stream = null;
}
const iceReady = pc => new Promise((resolve, reject) => {
  if (pc.iceGatheringState === 'complete') return resolve();
  const timer = setTimeout(() => { pc.removeEventListener('icegatheringstatechange', listener); reject(Error('Не удалось подготовить локальное соединение')); }, 12000);
  function listener() { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', listener); resolve(); } }
  pc.addEventListener('icegatheringstatechange', listener);
});
async function start(id) {
  closePeer(); activeId = id;
  const token=generation;
  let captured;
  const current=()=>token===generation&&activeId===id;
  $('error').textContent = '';
  try {
    if (!state.source) return;
    if (state.embedded) {
      try{if(['jpeg-fallback','snapshot-fallback'].includes(state.captureMode))throw Error('SnapshotCapture');captured=await navigator.mediaDevices.getDisplayMedia({video:{width:{max:2560},height:{max:1600},frameRate:{ideal:30,max:30}},audio:false});}
      catch(error){if(!current())return;const canvas=$('fixture');canvas.width=state.width;canvas.height=state.height;captured=canvas.captureStream(30);await window.host.captureFallback(error.name);}
    } else if (state.fixture) captured = $('fixture').captureStream(30);
    else captured = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    if (!current()) { captured.getTracks().forEach(t => t.stop()); return; }
    stream=captured;
    const pc = peer = new RTCPeerConnection({ iceServers: [] });
    const track = stream.getVideoTracks()[0]; track.contentHint = 'detail';
    const sender = pc.addTrack(track, stream);
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs || [];
    const h264 = codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
    const transceiver = pc.getTransceivers()[0];
    if (h264.length) transceiver.setCodecPreferences([...h264, ...codecs.filter(c => !h264.includes(c))]);
    const dc = channel = pc.createDataChannel('input', { ordered: true });let receivedVideoFrames;
    await window.host.inputSession(id,String(token));
    if(!current())return;
    dc.onmessage = message => {
      if (typeof message.data !== 'string' || message.data.length > 40000 || !current()) return;
      let value; try { value = JSON.parse(message.data); } catch { return; }
      if (value.type === 'ping') { if(Number.isSafeInteger(value.videoFrames)&&value.videoFrames>=0)receivedVideoFrames=value.videoFrames;if (dc.readyState === 'open') dc.send(JSON.stringify({ type: 'pong', at: value.at })); return; }
      if (value.type === 'stats') { if (state.fixture && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'fixture-state', ...(typeof value.requestId==='string'&&value.requestId.length<=80?{requestId:value.requestId}:{}), clicks: fixtureClicks, text: fixtureText, keys: fixtureKeys })); return; }
      if(typeof value.id!=='string')return;
      // Main owns validation, deduplication and cancellation of queued events.
      window.host.input(id, {...value,epoch:String(token)}).then(result=>{
        if(token!==generation||activeId!==id)return;
        if(result.type==='input-ok'){inputs++;report('streaming');}
        else{$('error').textContent=result.error;report('input-error',result.error);}
        if(dc.readyState==='open')dc.send(JSON.stringify(result));
      }).catch(error=>{if(token===generation&&dc.readyState==='open')dc.send(JSON.stringify({type:'input-error',id:value.id,error:error.message}));});
    };
    dc.onopen = () => {
      if(!current())return; $('status').textContent = 'Видео и управление подключены'; report('streaming');
      // Some owned-tab captures produce no initial frame when the window is
      // unchanged or occluded. A connected data channel alone is not video.
      if(state.embedded)firstFrameTimer=setTimeout(async()=>{
        let fallback;
        try{
          if(!current())return;
          const stats=await pc.getStats();let sent=0;
          stats.forEach(s=>{if(s.type==='outbound-rtp'&&(s.kind==='video'||s.mediaType==='video'))sent+=s.framesEncoded||s.framesSent||0;});
          if((sent&&receivedVideoFrames!==0)||!current())return;
          const canvas=$('fixture');canvas.width=state.width;canvas.height=state.height;
          fallback=canvas.captureStream(10);
          await window.host.captureFallback('NoInitialVideo');
          if(!current()){fallback.getTracks().forEach(t=>t.stop());return;}
          const replacement=fallback.getVideoTracks()[0];replacement.contentHint='detail';
          await sender.replaceTrack(replacement);
          if(!current()){fallback.getTracks().forEach(t=>t.stop());return;}
          const previous=stream;stream=fallback;
          previous.getTracks().forEach(t=>{t.onended=null;t.stop();});
          replacement.onended=()=>{if(current()){window.host.signal(id,{type:'disconnect'});closePeer();report('capture-ended');}};
        }catch(error){fallback?.getTracks().forEach(t=>t.stop());if(current()){closePeer();report('capture-error',error.message);}}
      },5000);
    };
    dc.onclose = () => { if(token===generation&&activeId===id){closePeer();report('disconnected');} };
    pc.onconnectionstatechange = () => { if (['failed', 'disconnected'].includes(pc.connectionState)&&token===generation&&activeId===id) { const phase=pc.connectionState; $('status').textContent = 'Соединение прервано — переподключение с планшета'; closePeer();report(phase); } };
    track.onended = () => { if (current()) { window.host.signal(id, { type: 'disconnect' }); closePeer(); report('capture-ended'); } };
    await pc.setLocalDescription(await pc.createOffer());
    if(!current())return;
    await iceReady(pc);
    if(!current())return;
    await window.host.signal(id, { type: 'offer', sdp: pc.localDescription.sdp });
    if(!current())return;
    const params = sender.getParameters();
    if (params.encodings?.length) { params.encodings[0].maxBitrate = 18000000; params.degradationPreference='maintain-resolution'; await sender.setParameters(params); }
    if(current())report('offered');
  } catch (error) { if(!current()){captured?.getTracks().forEach(t=>t.stop());return;} $('error').textContent = error.message; report('capture-error', error.message); closePeer(); }
}
$('refresh').onclick = async () => {
  try {
    $('error').textContent = ''; const sources = await window.host.sources(); $('source').replaceChildren();
    for (const s of sources) { const option = document.createElement('option'); option.value = s.id; option.textContent = s.name; $('source').append(option); }
    if (!sources.length) throw Error('Окно CanvasTTY не найдено. Проверьте разрешение на запись экрана.');
    await window.host.select(sources[0].id); await refreshState();
  } catch (error) { $('error').textContent = error.message; }
};
$('source').onchange = async () => { await window.host.select($('source').value); await refreshState(); };
$('rotate').onclick = async () => { closePeer(); await window.host.rotate(); await refreshState(); report('waiting'); };
$('screen-settings').onclick=()=>window.host.settings('screen');
$('input-settings').onclick=()=>window.host.settings('input');
window.host.permissions().then(p=>{if(p.platform==='darwin'&&!p.embedded){$('mac-permissions').hidden=false;$('permission-status').textContent=`Экран: ${p.screen==='granted'?'доступ есть':'нужен доступ'}. Управление: ${p.inputAccess?'доступ есть':'нужен доступ'}.`;}}).catch(()=>{});
window.host.onEvent(async event => {
  if(event.type==='show-glasses'){$('glasses-tab').click();return;}
  if(event.type==='health'){if(channel?.readyState==='open')channel.send(JSON.stringify({type:'source-state',...event.value}));return;}
  if(event.type==='frame'){
    if(event.pixels){try{if(state?.embedded&&activeId){const c=$('fixture');if(c.width!==event.width||c.height!==event.height){c.width=event.width;c.height=event.height;}context.putImageData(new ImageData(window.CanvasLinkFrames.rgba(event.pixels,c.width,c.height),c.width,c.height),0,0);}}finally{window.host.frameConsumed(event.sequence);}return;}
    return;
  }
  if (event.type === 'fixture-input') {
    const e = event.input;
    if (e.type === 'text') fixtureText += e.text;
    if (e.type === 'key') { fixtureKeys.push(e.key); if (e.key === 'Backspace') fixtureText = [...fixtureText].slice(0, -1).join(''); }
    if (e.type === 'pointer') { fixturePointer = e; if (e.action === 'down') fixtureClicks++; }
    return;
  }
  await refreshState();
  if (event.type === 'paired' || event.type === 'source') {
    if (state.connected[0] && state.source) await start(state.connected[0].id);
  }
  if (event.type === 'revoke' && activeId === event.id) closePeer();
  if (event.type === 'signal') {
    if (event.message.type === 'answer' && peer && activeId === event.id) await peer.setRemoteDescription(event.message);
    if (event.message.type === 'ping') await start(event.id);
    if (event.message.type === 'disconnect' && activeId === event.id) closePeer();
  }
});
setInterval(() => { if (state) $('expiry').textContent = state.pin ? `Действует ещё ${Math.max(0, Math.ceil((state.expires - Date.now()) / 1000))} с` : 'Код использован · связь зашифрована'; }, 1000);
const context = $('fixture').getContext('2d');
setInterval(() => {
  if (!state?.fixture) return;
  const c = context; c.fillStyle = '#101a14'; c.fillRect(0, 0, 1280, 800);
  c.fillStyle = '#d6ef88'; c.font = 'bold 42px monospace'; c.fillText('CanvasLink / live acceptance', 50, 80);
  c.fillStyle = '#a8b6ac'; c.font = '24px monospace'; c.fillText('Android ↔ Mac · WebRTC · LAN', 50, 128);
  c.fillStyle = '#eaf1e5'; c.font = '28px monospace';
  c.fillText(`Clicks: ${fixtureClicks}    Keys: ${fixtureKeys.join(' ').slice(-60)}`, 50, 230);
  c.fillText('Text:', 50, 310);
  fixtureText.match(/.{1,65}/gu)?.slice(-6).forEach((l, i) => c.fillText(l, 50, 360 + i * 36));
  c.fillStyle = '#d6ef88'; c.beginPath(); c.arc(60 + (Date.now() % 5000) / 5, 700, 14, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#ed9272'; c.strokeRect(fixturePointer.x * 1280 - 12, fixturePointer.y * 800 - 12, 24, 24);
  c.fillStyle = '#798d80'; c.font = '18px monospace'; c.fillText(new Date().toISOString(), 50, 770);
}, 33);
refreshState().then(async () => { if (state.fixture||state.embedded) await $('refresh').onclick(); report('waiting'); });

async function glasses(command){
 try{const s=await window.host.glasses(command);$('glasses-code').textContent=s.pairing?.code||'';$('glasses-status').textContent=s.pairing?'Код для очков действует 2 минуты. Подтверждение устройства — в настройках Even G2.':'Используются существующие настройки и разрешения Even G2.';}
 catch{$('glasses-status').textContent='Сначала включите Even G2 и выберите доступные сессии в настройках CanvasTTY.';}
}
$('glasses-tab').onclick=()=>{$('phone-panel').hidden=true;$('glasses-panel').hidden=false;glasses('state');};
$('phone-tab').onclick=()=>{$('phone-panel').hidden=false;$('glasses-panel').hidden=true;};
$('glasses-begin').onclick=()=>glasses('begin-pairing');$('glasses-cancel').onclick=()=>glasses('cancel-pairing');
