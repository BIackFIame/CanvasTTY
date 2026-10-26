const {test}=require('node:test');const assert=require('node:assert/strict');const {openUI}=require('../scripts/ui-test-harness.cjs');
const focus={editable:true,kind:'terminal',rect:{x:.2,y:.2,width:.6,height:.6}};
async function typing(t,options={}){const ui=await openUI({connected:true,touch:true,...options});t.after(async()=>{await ui.browser.close();assert.deepEqual(ui.errors,[]);});await ui.page.evaluate(focus=>__uiFixture.configure({focus}),options.focus||focus);await ui.page.locator('#viewport').click();await ui.page.waitForFunction(()=>__uiFixture.calls.some(c=>c.type==='show-keyboard'));return ui;}
const commands=page=>page.evaluate(()=>__uiFixture.calls.filter(c=>c.type==='input'&&['key','text'].includes(c.input.type)).map(c=>c.input));
test('Tap opens direct native input only after processed pointer-up confirms editable target',async t=>{const {page}=await typing(t);assert.equal(await page.locator('#compose,#text,#send,.session-badge').count(),0);assert.equal(await page.locator('#keyboard-toggle').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#ctrl').evaluate(e=>getComputedStyle(e).userSelect),'none');await page.evaluate(()=>__uiFixture.ime({type:'text',text:'Привет 🙂'}));assert.deepEqual(await commands(page),[{type:'text',text:'Привет 🙂'}]);});
test('A canvas tap never opens a keyboard from stale polled source.target',async t=>{const ui=await openUI({connected:true});t.after(()=>ui.browser.close());await ui.page.locator('#viewport').click();assert.equal(await ui.page.evaluate(()=>__uiFixture.calls.filter(c=>c.type==='show-keyboard').length),0);});
test('Composition is displayed locally; one commit is sent and Enter follows it directly',async t=>{const {page}=await typing(t);await page.evaluate(()=>{__uiFixture.ime({type:'composition',text:'日本'});});assert.equal(await page.locator('#preedit').textContent(),'日本');assert.deepEqual(await commands(page),[]);await page.evaluate(()=>{__uiFixture.ime({type:'text',text:'日本語'});__uiFixture.ime({type:'composition',text:''});__uiFixture.ime({type:'key',key:'Enter',modifiers:[]});});assert.deepEqual(await commands(page),[{type:'text',text:'日本語'},{type:'key',key:'Enter',modifiers:[]}]);});
test('Native delete, arrows and Enter preserve order without a second editor',async t=>{const {page}=await typing(t);await page.evaluate(()=>{__uiFixture.ime({type:'text',text:'ab'});for(const key of ['Backspace','ArrowLeft','Enter'])__uiFixture.ime({type:'key',key,modifiers:[]});});assert.deepEqual((await commands(page)).map(v=>v.key||v.text),['ab','Backspace','ArrowLeft','Enter']);});
test('Uncertain delivery stops IME and reconnect never replays committed input or Enter',async t=>{const {page}=await typing(t);await page.evaluate(()=>{__uiFixture.configure({deferText:true});__uiFixture.ime({type:'text',text:'uncertain'});__uiFixture.rejectText();});await page.waitForFunction(()=>!CanvasLinkInput.active());await page.evaluate(()=>{__uiFixture.emit({connection:'reconnecting'});__uiFixture.emit({connection:'connected'});__uiFixture.ime({type:'key',key:'Enter',modifiers:[]});});assert.deepEqual(await commands(page),[{type:'text',text:'uncertain'}]);assert.match(await page.locator('#input-status').textContent(),/подтвержд|Проверьте/);});
test('Ctrl is one-shot and Paste sends Android clipboard as text with no implicit Enter',async t=>{const {page}=await typing(t);await page.locator('#ctrl').click();await page.evaluate(()=>__uiFixture.ime({type:'text',text:'c'}));assert.equal(await page.locator('#ctrl').getAttribute('aria-pressed'),'false');await page.evaluate(()=>__uiFixture.configure({clipboard:'текст 🙂'}));await page.locator('#paste').click();assert.deepEqual(await commands(page),[{type:'key',key:'c',modifiers:['control']},{type:'text',text:'текст 🙂'}]);});
test('A late native callback from the old keyboard token is ignored after a new target tap',async t=>{const {page}=await typing(t);await page.evaluate(()=>{const f=Native.showKeyboard;Native.showKeyboard=t=>{window.__lastToken=t;f(t);};CanvasLinkInput.open({editable:true,kind:'terminal'});window.__oldToken=__lastToken;CanvasLinkInput.open({editable:true,kind:'terminal'});CanvasLinkInput.receive({token:__oldToken,type:'text',text:'old'});});assert.deepEqual(await commands(page),[]);});
test('One computer is automatic; IP is secondary; pairing hint names actual native Settings',async t=>{const {browser,page}=await openUI();t.after(()=>browser.close());assert.equal(await page.locator('#computers button').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#manual').evaluate(e=>e.open),false);assert.match(await page.locator('#pin-hint').textContent(),/Настройки.*CanvasLink/);await page.locator('#pin').fill('1'.repeat(6));await page.locator('#connect').click();assert.equal(await page.locator('#pin').inputValue(),'');});
test('Only a single 56px bind row reserves workspace space across keyboard sizes',async t=>{for(const [width,height] of [[390,844],[844,390],[844,240],[1280,800],[768,1024],[320,320]]){const {browser,page}=await openUI({connected:true,width,height});try{const g=await page.evaluate(()=>{const r=document.getElementById('viewport').getBoundingClientRect(),b=document.getElementById('controls').getBoundingClientRect();const rows=[...document.getElementById('controls').querySelectorAll('button')].map(e=>e.getBoundingClientRect().top);return{r:{width:r.width,height:r.height},b:{top:b.top,height:b.height},rows,overflow:document.documentElement.scrollWidth>innerWidth};});assert.equal(g.r.width,width);assert.equal(g.r.height,height-56);assert.equal(g.b.height,56);assert.equal(new Set(g.rows).size,1);assert.equal(g.overflow,false);}finally{await browser.close();}}});
test('Selected terminal keeps usable width and focus when IME shrinks the viewport',async t=>{const {page}=await typing(t,{width:1024,height:768});await page.setViewportSize({width:1024,height:360});await page.waitForTimeout(50);const g=await page.evaluate(()=>{const r=document.getElementById('video').getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect(),k=Math.min(r.width/1280,r.height/800);return {terminalWidth:1280*k*.6,viewportWidth:v.width,viewportHeight:v.height};});assert.ok(g.terminalWidth>=g.viewportWidth*.9);assert.equal(g.viewportHeight,304);});
test('Diagnostics is a sheet off the working canvas, RTT explicitly ms',async t=>{const {page}=await typing(t);assert.equal(await page.locator('#metrics').isVisible(),false);await page.evaluate(()=>__uiFixture.emit({stats:{rtt:17.4,framesDecoded:20}}));await page.locator('#menu-toggle').click();await page.locator('#diagnostics-toggle').click();assert.match(await page.locator('#metrics').textContent(),/RTT канала\s+17 мс/);});

test('An empty terminal cursor and a moving bottom cursor stay visible with the IME',async t=>{
 const selected={...focus,caret:{x:.25,y:.22,width:.012,height:.025}};
 const {page}=await typing(t,{width:1024,height:768,focus:selected});
 const visible=()=>page.evaluate(()=>{const c=CanvasLinkClient.getState().source?.caret||window.__caret;const r=document.getElementById('video').getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect(),k=Math.min(r.width/1280,r.height/800),y=r.top+(r.height-800*k)/2+(c.y+c.height/2)*800*k;return y>v.top+8&&y<v.bottom-8;});
 await page.evaluate(c=>window.__caret=c,selected.caret);
 for(const [width,height] of [[1024,360],[390,310],[1024,768]]){await page.setViewportSize({width,height});await page.waitForTimeout(70);assert.ok(await visible(),'top cursor must stay visible after IME or rotation');}
 await page.evaluate(focus=>__uiFixture.emit({source:{target:'terminal',rect:focus.rect,caret:{x:.65,y:.77,width:.012,height:.025}}}),selected);
 await page.waitForTimeout(30);assert.ok(await visible(),'health must follow the active selected cursor');
});
test('Cursor following never overrides a manual view or opens a new keyboard',async t=>{
 const {page}=await typing(t);await page.locator('#menu-toggle').click();await page.locator('#reset-view').click();
 const before=await page.locator('#video').evaluate(e=>getComputedStyle(e).transform);
 await page.evaluate(focus=>__uiFixture.emit({source:{target:'terminal',rect:focus.rect,caret:{x:.2,y:.21,width:.01,height:.02}}}),focus);
 assert.equal(await page.locator('#video').evaluate(e=>getComputedStyle(e).transform),before);assert.equal(await page.evaluate(()=>CanvasLinkInput.active()),false);
});

test('Explicit paste is literal even when one-shot Ctrl was latched',async t=>{const {page}=await typing(t);await page.locator('#ctrl').click();await page.evaluate(()=>__uiFixture.configure({clipboard:'a'}));await page.locator('#paste').click();assert.deepEqual(await commands(page),[{type:'text',text:'a'}]);assert.equal(await page.locator('#ctrl').getAttribute('aria-pressed'),'false');});
test('One-shot Ctrl cannot leak through a Unicode commit or native key into the next letter',async t=>{
 const {page}=await typing(t);
 for(const text of ['Ж','🙂','word']){
  await page.locator('#ctrl').click();await page.evaluate(text=>{__uiFixture.ime({type:'text',text});__uiFixture.ime({type:'text',text:'c'});},text);
  assert.equal(await page.locator('#ctrl').getAttribute('aria-pressed'),'false');
 }
 await page.locator('#ctrl').click();await page.evaluate(()=>{__uiFixture.ime({type:'key',key:'ArrowLeft',modifiers:[]});__uiFixture.ime({type:'text',text:'c'});});
 assert.deepEqual(await commands(page),['Ж','c','🙂','c','word','c'].map(text=>({type:'text',text})).concat([{type:'key',key:'ArrowLeft',modifiers:['control']},{type:'text',text:'c'}]));
});

test('Initial terminal framing is visual only and overview stays under user control',async t=>{
 const ui=await openUI({connected:true,width:1024,height:768,touch:true});t.after(()=>ui.browser.close());
 const source={target:'canvas',surface:'canvas',terminalView:{rect:{x:.3,y:.2,width:.5,height:.5},viewport:{width:1440,height:900}}};
 await ui.page.evaluate(source=>__uiFixture.emit({source}),source);
 assert.equal(await ui.page.evaluate(()=>CanvasLinkInput.active()),false);
 assert.equal(await ui.page.locator('#view-toggle-label').textContent(),'Весь Canvas');
 assert.notEqual(await ui.page.locator('#video').evaluate(e=>getComputedStyle(e).transform),'matrix(1, 0, 0, 1, 0, 0)');
 await ui.page.locator('#view-toggle').click();await ui.page.evaluate(source=>__uiFixture.emit({source}),source);
 assert.equal(await ui.page.locator('#video').evaluate(e=>getComputedStyle(e).transform),'matrix(1, 0, 0, 1, 0, 0)');
 await ui.page.locator('#view-toggle').click();assert.equal(await ui.page.evaluate(()=>CanvasLinkInput.active()),false);
 assert.equal(await ui.page.evaluate(()=>__uiFixture.calls.filter(c=>c.type==='show-keyboard').length),0);
});
