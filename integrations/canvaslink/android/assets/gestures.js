/* Local interaction layer. CanvasLinkClient v2 and the pointer DOM contract stay stable. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = window.CanvasLinkClient;
  const viewport = $('viewport'), video = $('video');
  const touches = new Map();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const editor = target => target instanceof Element && (target.isContentEditable ||
    Boolean(target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')));
  const control = target => target instanceof Element &&
    Boolean(target.closest('button,input,textarea,select,a,summary,[role="button"],[contenteditable]'));
  let scale = 1, offset = {x: 0, y: 0}, trackpad = false;
  let pointer = {x: .5, y: .5}, drag = false, press = null, pinch = null;
  let composing = false, pairFrame = 0, holdTimer = 0;
  let tapEpoch=0, focusRect=null, focusCaret=null, focusKind='',focusFont=14,focusViewportWidth=0,focusContext=null,knownTerminal=null,autoFramePending=true,focusedView=false,beforeFocus=null,remoteSurface='canvas',remoteViewportWidth=0,dragRects=[];
  const validRect=r=>r&&['x','y','width','height'].every(k=>Number.isFinite(r[k]))&&r.width>0&&r.height>0;

  const connected = () => api.getState().connection === 'connected';
  const canInput = () => connected() && !composing && !editor(document.activeElement);
  // Never queue, retry, or turn a rejected/uncertain delivery into another input.
  function deliver(send) {
    try { return Promise.resolve(send()).catch(() => undefined); } catch (_) { return Promise.resolve(); }
  }
  function send(value, cleanup = false) {
    if (cleanup ? connected() : canInput()) return deliver(() => api.sendInput(value));
  }
  function mouse(action, at, extra = {}) {
    // A held button must still be released if focus has just entered an editor.
    const cleanup = action === 'up' && drag;
    if (!(cleanup ? connected() : canInput())) return;
    pointer = {x: at.x, y: at.y};
    window.dispatchEvent(new CustomEvent('canvaslink:pointer', {
      detail: {...pointer, action, trackpad}
    }));
    return send({type: 'pointer', action, ...pointer, button: 0, ...extra}, cleanup);
  }

  // The element fills the viewport, but object-fit:contain can leave letterboxes.
  // Its transformed bounding box already includes our centre-origin scale/offset.
  function contentBox() {
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 800;
    const fit = Math.min(rect.width / vw, rect.height / vh);
    const width = vw * fit, height = vh * fit;
    return {rect, width, height, left: rect.left + (rect.width - width) / 2,
      top: rect.top + (rect.height - height) / 2};
  }
  function position(x, y) {
    const box = contentBox();
    return {x: clamp((x - box.left) / Math.max(1, box.width), 0, 1),
      y: clamp((y - box.top) / Math.max(1, box.height), 0, 1)};
  }
  function transform() {
    video.style.transform = `translate(${offset.x}px,${offset.y}px) scale(${scale})`;
    const percentage = `${Math.round(scale * 100)}%`;
    if($('view-toggle')){$('view-toggle').disabled=!connected()||!focusedView&&scale===1&&(!knownTerminal||remoteSurface==='settings');$('view-toggle').setAttribute('aria-label',focusedView||scale>1?'Показать весь Canvas':'Приблизить активный терминал');$('view-toggle-label').textContent=focusedView||scale>1?'Весь Canvas':'Терминал';}
    if ($('zoom-label')) $('zoom-label').textContent = percentage;
    $('fit').setAttribute('aria-label', `${percentage} — ${scale === 1 ? 'увеличить окно' : 'вписать окно целиком'}`);
    if ($('mode-label')) $('mode-label').textContent = trackpad ? 'Тачпад' : 'Касание';
    $('mode').setAttribute('aria-pressed', String(trackpad));
    if ($('gesture-hint')) $('gesture-hint').textContent = trackpad
      ? 'Палец — курсор · касание — клик · удержание — перетаскивание · два пальца — прокрутка · щипок — масштаб'
      : 'Касание — клик · движение — перетаскивание · два пальца — масштаб и обзор';
    window.dispatchEvent(new CustomEvent('canvaslink:view', {
      detail: {scale, offset: {...offset}, trackpad,...(focusedView?{target:focusKind}:{})}
    }));
  }
  function zoomView(nextScale, anchor, nextAnchor = anchor, base = {scale, offset: {...offset}}) {
    autoFramePending=false;focusedView=false;
    const box = contentBox(), bounds = viewport.getBoundingClientRect();
    const centre = {x: box.rect.left + box.rect.width / 2 - offset.x,
      y: box.rect.top + box.rect.height / 2 - offset.y};
    const width = box.width / scale, height = box.height / scale;
    scale = clamp(nextScale, 1, 8);
    const ratio = scale / base.scale;
    const maxX = Math.max(0, (width * scale - bounds.width) / 2);
    const maxY = Math.max(0, (height * scale - bounds.height) / 2);
    offset = {
      x: clamp(nextAnchor.x - centre.x - (anchor.x - centre.x - base.offset.x) * ratio, -maxX, maxX),
      y: clamp(nextAnchor.y - centre.y - (anchor.y - centre.y - base.offset.y) * ratio, -maxY, maxY)
    };
    transform();
  }

  function frameFocus(){
    if(!focusedView||!focusRect)return;
    const r=viewport.getBoundingClientRect(),vw=video.videoWidth||1280,vh=video.videoHeight||800;
    const fit=Math.min(r.width/vw,r.height/vh),width=vw*fit,height=vh*fit;
    const field=focusKind==='text-field',typing=!!window.CanvasLinkInput?.active();
    const remoteWidth=focusViewportWidth||vw;
    scale=field?clamp(Math.min(r.width*.92/(Math.max(.08,focusRect.width)*width),14/(width/remoteWidth*Math.max(10,focusFont))),1,4):clamp(Math.min(r.width*.96/(Math.max(.08,focusRect.width)*width),typing?8:r.height*.92/(Math.max(.08,focusRect.height)*height)),1,8);
    const maxX=Math.max(0,(width*scale-r.width)/2),maxY=Math.max(0,(height*scale-r.height)/2);
    const context=field&&validRect(focusContext)&&focusContext.width*width*scale<r.width*.95?focusContext:focusRect;
    const caretY=!field&&typing&&validRect(focusCaret)?clamp(focusCaret.y+focusCaret.height/2,focusRect.y,focusRect.y+focusRect.height):focusRect.y+focusRect.height/2;
    offset={x:clamp((.5-context.x-context.width/2)*width*scale,-maxX,maxX),
      y:clamp((field||!typing?0:r.height*.1)-(caretY-.5)*height*scale,-maxY,maxY)};
    transform();
  }
  window.addEventListener('canvaslink:input-state',e=>{
    const d=e.detail;
    if(d.focus){remoteSurface=d.focus.surface||'canvas';dragRects=d.focus.dragRects||[];}
    if(['terminal','text-field'].includes(d.focus?.kind)&&d.focus.editable&&validRect(d.focus.rect)){
      if(!focusedView)beforeFocus={scale,offset:{...offset}};
      focusRect=d.focus.rect;focusCaret=d.focus.caret;focusKind=d.focus.kind;focusFont=d.focus.fontSize||14;focusViewportWidth=d.focus.viewport?.width||0;focusContext=d.focus.contextRect;focusedView=true;frameFocus();
    }else if(d.focus){
      // Non-text controls keep the surrounding Settings context.
      if(focusedView&&beforeFocus){scale=beforeFocus.scale;offset=beforeFocus.offset;transform();}
      focusedView=false;beforeFocus=null;focusRect=null;focusCaret=null;
    }else if(!d.active){if(focusedView&&focusKind==='text-field'&&beforeFocus){scale=beforeFocus.scale;offset=beforeFocus.offset;transform();beforeFocus=null;focusedView=false;}else if(focusedView&&focusKind==='terminal')frameFocus();}
  });
  new ResizeObserver(()=>{if(focusedView)frameFocus();else transform();}).observe(viewport);
  video.addEventListener('resize',()=>{if(focusedView)frameFocus();});
  $('view-toggle')?.addEventListener('click',()=>{autoFramePending=false;if(focusedView||scale>1){window.CanvasLinkInput?.stop();focusedView=false;scale=1;offset={x:0,y:0};transform();}else if(knownTerminal&&remoteSurface!=='settings'){focusKind='terminal';focusRect=knownTerminal.rect;focusCaret=knownTerminal.caret;focusViewportWidth=knownTerminal.viewport?.width||0;focusedView=true;frameFocus();}});

  const stopHold = () => { clearTimeout(holdTimer); holdTimer = 0; };
  function updatePair() {
    pairFrame = 0;
    if (touches.size !== 2 || !pinch || !canInput()) return;
    const [a, b] = [...touches.values()];
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (trackpad && !pinch.kind) {
      if (Math.abs(distance - pinch.distance) > 8 && Math.abs(distance / pinch.distance - 1) > .06) pinch.kind = 'zoom';
      else if (Math.hypot(x - pinch.x, y - pinch.y) > 6) pinch.kind = 'scroll';
      else return;
    }
    if (trackpad && pinch.kind === 'scroll') {
      focusedView=false;
      const dx = clamp(pinch.lastX - x, -2000, 2000), dy = clamp(pinch.lastY - y, -2000, 2000);
      if (dx || dy) send({type: 'scroll', ...pointer, dx, dy});
    } else {
      zoomView(pinch.scale * distance / pinch.distance, {x: pinch.x, y: pinch.y}, {x, y}, pinch);
    }
    pinch.lastX = x; pinch.lastY = y;
  }
  function flushPair() {
    if (pairFrame) { cancelAnimationFrame(pairFrame); updatePair(); }
  }
  function cancelGesture() {
    stopHold();
    if (pairFrame) { cancelAnimationFrame(pairFrame); pairFrame = 0; }
    if (drag && connected()) mouse('up', pointer);
    drag = false; press = null; pinch = null;
    const ids = [...touches.keys()];
    touches.clear(); // Clear before releasing capture: loss can arrive synchronously.
    for (const id of ids) {
      try { if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id); } catch (_) {}
    }
  }

  $('fit').onclick = () => {
    cancelGesture(); autoFramePending=false;focusedView=false;scale = scale === 1 ? 2 : 1; offset = {x: 0, y: 0}; transform();
  };
  $('mode').onclick = () => { cancelGesture(); trackpad = !trackpad; transform(); };
  // Optional hook: also works while the parent UI is being upgraded in place.
  document.addEventListener('click', e => {
    if (e.target instanceof Element && e.target.closest('#reset-view')) {
      cancelGesture(); autoFramePending=false;focusedView=false;scale = 1; offset = {x: 0, y: 0}; transform();
    }
  });
  if (!viewport.hasAttribute('tabindex')) viewport.tabIndex = 0;
  viewport.addEventListener('pointerdown', e => {
    if (!canInput()) { e.preventDefault(); return; }
    if (e.button !== 0 || control(e.target) || e.target.closest?.('#waiting')) return;
    e.preventDefault();++tapEpoch;viewport.focus({preventScroll: true});
    try { viewport.setPointerCapture(e.pointerId); } catch (_) { cancelGesture(); return; }
    touches.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (touches.size === 1) {
      const at=position(e.clientX,e.clientY);
      const onSlider=dragRects.some(r=>validRect(r)&&at.x>=r.x&&at.x<=r.x+r.width&&at.y>=r.y&&at.y<=r.y+r.height);
      press = {x: e.clientX, y: e.clientY, travel: 0,scroll:!trackpad&&remoteSurface==='settings'&&!onSlider,at};
      if (trackpad && e.pointerType !== 'mouse') {
        const held = press;
        holdTimer = setTimeout(() => {
          holdTimer = 0;
          if (press === held && touches.size === 1 && held.travel < 8 && canInput()) {
            drag = true; mouse('down', pointer);
          }
        }, 450);
      }
    } else if (touches.size === 2) {
      stopHold();
      if (drag) mouse('up', pointer);
      drag = false; press = null;
      const [a, b] = [...touches.values()];
      pinch = {distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale,
        x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, lastX: (a.x + b.x) / 2,
        lastY: (a.y + b.y) / 2, offset: {...offset}, kind: null};
    }
  });
  viewport.addEventListener('pointermove', e => {
    const previous = touches.get(e.pointerId);
    if (!previous) return;
    touches.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (touches.size === 2 && pinch) {
      // Classify the settled frame, not half of a two-pointer update. Scroll uses
      // centroid deltas, so moving both fingers never doubles the remote scroll.
      if (!pairFrame) pairFrame = requestAnimationFrame(updatePair);
      return;
    }
    if (!press) return;
    press.travel = Math.max(press.travel, Math.hypot(e.clientX - press.x, e.clientY - press.y));
    if (press.travel >= 8) stopHold();
    if (trackpad) {
      const r = viewport.getBoundingClientRect();
      pointer = {x: clamp(pointer.x + (e.clientX - previous.x) / Math.max(1, r.width), 0, 1),
        y: clamp(pointer.y + (e.clientY - previous.y) / Math.max(1, r.height), 0, 1)};
      mouse('move', pointer, drag ? {drag: true} : {});
    } else if(press.scroll&&press.travel>8){
      focusedView=false;
      const k=(remoteViewportWidth||video.videoWidth)/Math.max(1,contentBox().width);
      send({type:'scroll',...press.at,dx:clamp((previous.x-e.clientX)*k,-2000,2000),dy:clamp((previous.y-e.clientY)*k,-2000,2000)});
    } else if (press.travel > 8 || drag) {
      if (!drag) { mouse('down', position(press.x, press.y)); drag = true; }
      mouse('move', position(e.clientX, e.clientY), {drag: true});
    }
  });
  function release(e) {
    if (!touches.has(e.pointerId)) return;
    stopHold();
    if (e.type === 'pointerup') flushPair();
    else if (pairFrame) { cancelAnimationFrame(pairFrame); pairFrame = 0; }
    if (drag && e.type === 'pointercancel') mouse('up', pointer);
    if (touches.size === 1 && press && e.type !== 'pointercancel') {
      const at = trackpad ? pointer : position(e.clientX, e.clientY);
      if (drag) mouse('up', at);
      else if (press.travel < 8 && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8) {
        const epoch=tapEpoch;
        mouse('down', at);Promise.resolve(mouse('up', at)).then(receipt=>{
          if(epoch===tapEpoch&&connected()&&receipt?.status==='processed')window.dispatchEvent(new CustomEvent('canvaslink:tap',{detail:{focus:receipt.focus,at}}));
        });
      }
    }
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    // No remaining finger may turn a pair gesture into a tap or resumed drag.
    press = null; drag = false;
  }
  viewport.addEventListener('pointerup', release);
  viewport.addEventListener('pointercancel', release);
  viewport.addEventListener('lostpointercapture', e => {
    // The video's implicit capture is transferred to the viewport. Its own loss
    // bubbles here but must NOT cancel the viewport's newly captured gesture.
    if (e.target === viewport) release({pointerId: e.pointerId, type: 'pointercancel'});
  });
  window.addEventListener('blur', cancelGesture);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelGesture(); });
  api.subscribe(state => {
    if(state.connection!=='connected'){++tapEpoch;cancelGesture();focusedView=false;focusCaret=null;return;}
    if(state.source?.viewport?.width>0)remoteViewportWidth=state.source.viewport.width;
    if(state.source?.surface){remoteSurface=state.source.surface;dragRects=state.source.dragRects||[];}
    const terminal=state.source?.target==='terminal'&&validRect(state.source.rect)?state.source:state.source?.terminalView;
    if(terminal&&validRect(terminal.rect)){knownTerminal=terminal;if(autoFramePending&&remoteSurface!=='settings'){autoFramePending=false;focusKind='terminal';focusRect=knownTerminal.rect;focusCaret=knownTerminal.caret;focusViewportWidth=knownTerminal.viewport?.width||0;focusedView=true;frameFocus();}}
    if(remoteSurface==='settings'&&focusedView&&focusKind==='terminal'){focusedView=false;scale=1;offset={x:0,y:0};transform();}
    // Health may follow an already selected cursor, but can never open an IME.
    // Manual pan/zoom/scroll disables following until another confirmed tap.
    if(focusedView&&focusKind==='terminal'&&state.source?.target==='terminal'&&validRect(state.source.rect)&&validRect(state.source.caret)){focusRect=state.source.rect;focusCaret=state.source.caret;frameFocus();}
  });
  document.addEventListener('focusin', e => { if (editor(e.target)) cancelGesture(); });
  window.addEventListener('compositionstart', () => { composing = true; cancelGesture(); });
  window.addEventListener('compositionend', () => { composing = false; });

  viewport.addEventListener('wheel', e => {
    if (!canInput() || control(e.target) || e.target.closest?.('#waiting')) return;
    e.preventDefault();
    const dx = e.deltaX * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientWidth : 1);
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight : 1);
    // Chromium exposes physical trackpad pinch as Ctrl+wheel, not touch pointers.
    if (e.ctrlKey) { cancelGesture(); zoomView(scale * Math.exp(-dy * .002), {x: e.clientX, y: e.clientY}); return; }
    focusedView=false;send({type: 'scroll', ...(trackpad ? pointer : position(e.clientX, e.clientY)),
      dx: clamp(dx, -2000, 2000), dy: clamp(dy, -2000, 2000)});
  }, {passive: false});
  const terminalKeys = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  window.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]') || !canInput() || e.defaultPrevented || e.isComposing || e.keyCode === 229 || editor(e.target)) return;
    if (!(e.target instanceof Element) || control(e.target)) return;
    if (e.target !== $('workspace') && !viewport.contains(e.target)) return;
    if (e.key === 'Enter' && e.repeat) { e.preventDefault(); return; }
    const modifiers = [e.ctrlKey ? 'control' : null, e.shiftKey ? 'shift' : null,
      e.altKey ? 'alt' : null, e.metaKey ? 'meta' : null].filter(Boolean);
    let sendKey;
    if (terminalKeys.has(e.key)) sendKey = () => api.sendKey(e.key, modifiers);
    else if ((e.ctrlKey || e.metaKey) && 'cavzdl'.includes(e.key.toLowerCase())) sendKey = () => api.sendKey(e.key.toLowerCase(), modifiers);
    else if ([...e.key].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) sendKey = () => api.sendText(e.key);
    if (sendKey) { e.preventDefault(); deliver(sendKey); }
  });
})();
