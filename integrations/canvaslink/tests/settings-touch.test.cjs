const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openUI}=require('../scripts/ui-test-harness.cjs');
const {focusScript}=require('../host/focus.cjs');
test('Only actual text inputs are editable; Settings controls do not summon a text editor',async t=>{
 const ui=await openUI();t.after(()=>ui.browser.close());
 await ui.page.setContent('<div class="settings-panel--open"><input id="range" type="range"><input id="check" type="checkbox"><input id="color" type="color"><input id="file" type="file"><select id="select"><option>A</option></select><button id="button">Bind</button><input id="text"><input id="password" type="password"><textarea id="area"></textarea><input id="readonly" readonly><div id="rich" contenteditable="true">x</div></div>');
 for(const [id,editable]of Object.entries({range:false,check:false,color:false,file:false,select:false,button:false,text:true,password:true,area:true,readonly:false,rich:true})){
  await ui.page.locator('#'+id).focus();const value=await ui.page.evaluate(focusScript);assert.equal(value.editable,editable,id);assert.equal(value.surface,'settings');assert.ok(value.dragRects.length===1);
 }
});
test('Screen arrows, Enter, Esc and Ctrl work after selecting a nontext control',async t=>{
 const ui=await openUI({connected:true,touch:true,width:390,height:844});t.after(()=>ui.browser.close());
 await ui.page.evaluate(()=>__uiFixture.configure({focus:{kind:'control',editable:false,surface:'settings'}}));await ui.page.locator('#viewport').click();
 assert.equal(await ui.page.evaluate(()=>CanvasLinkInput.active()),false);
 for(const key of ['ArrowDown','Enter','Escape'])await ui.page.locator('[data-key='+key+']').click();
 await ui.page.locator('#ctrl').click();await ui.page.locator('[data-key=c]').click();
 const keys=await ui.page.evaluate(()=>__uiFixture.calls.filter(c=>c.type==='input'&&c.input.type==='key').map(c=>c.input));
 assert.deepEqual(keys.map(c=>c.key),['ArrowDown','Enter','Escape','c']);assert.deepEqual(keys[3].modifiers,['control']);
 assert.equal(await ui.page.evaluate(()=>__uiFixture.calls.filter(c=>c.type==='show-keyboard').length),0);
});
test('Paste remains accessible without horizontal scrolling on a narrow phone',async t=>{
 const ui=await openUI({connected:true,width:320,height:640});t.after(()=>ui.browser.close());
 const r=await ui.page.locator('#paste').boundingBox();assert.ok(r.x>=0&&r.x+r.width<=320);assert.match(await ui.page.locator('#paste').getAttribute('aria-label'),/Вставить.*без Enter/);
 await ui.page.locator('#paste').click();assert.match(await ui.page.locator('#input-status').textContent(),/коснитесь.*поля/);assert.equal(await ui.page.evaluate(()=>__uiFixture.calls.filter(c=>c.type==='input').length),0);
});
test('A Settings text field preserves context instead of terminal-style zoom',async t=>{
 const ui=await openUI({connected:true,touch:true});t.after(()=>ui.browser.close());
 await ui.page.evaluate(()=>__uiFixture.configure({focus:{editable:true,kind:'text-field',surface:'settings',rect:{x:.7,y:.5,width:.08,height:.03}}}));
 await ui.page.locator('#viewport').click();const zoom=parseInt(await ui.page.locator('#zoom-label').textContent());assert.ok(zoom>=100&&zoom<=400);assert.equal(await ui.page.evaluate(()=>CanvasLinkInput.active()),true);
});
test('Text fields remain readable with IME and restore overview when editing ends',async t=>{
 const ui=await openUI({connected:true,touch:true,width:1280,height:800});t.after(()=>ui.browser.close());
 await ui.page.evaluate(()=>__uiFixture.configure({focus:{editable:true,kind:'text-field',surface:'settings',fontSize:12,rect:{x:.35,y:.68,width:.21,height:.033},contextRect:{x:.34,y:.67,width:.45,height:.14}}}));
 await ui.page.locator('#viewport').click();await ui.page.setViewportSize({width:1280,height:320});await ui.page.waitForTimeout(100);
 const geometry=await ui.page.evaluate(()=>{const v=document.getElementById('video'),r=v.getBoundingClientRect();return {font:12*Math.min(r.width/v.videoWidth,r.height/v.videoHeight),scale:new DOMMatrix(getComputedStyle(v).transform).a};});
 assert.ok(geometry.font>=12,JSON.stringify(geometry));assert.ok(geometry.scale<=4);
 await ui.page.evaluate(()=>CanvasLinkInput.stop());assert.equal(await ui.page.locator('#zoom-label').textContent(),'100%');
});
