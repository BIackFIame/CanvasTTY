import assert from 'node:assert/strict';
import test from 'node:test';
import {importWithFakeReact,findAll,tick} from './helpers/fake-react.mjs';
const dialog=await importWithFakeReact('src/renderer/src/features/terminal/PluginChangesReviewDialog.tsx','PluginChangesReviewDialog');
const file=path=>({path,diff:'+change',page:0});
for(const action of ['Accept selected files','Reject this subtask'])test(`mutation replaces the remaining review scope: ${action}`,async t=>{
 const oldWindow=globalThis.window,oldDocument=globalThis.document;
 globalThis.document={body:{nodeType:1}};
 globalThis.window={setTimeout,clearTimeout,canvasTTY:{terminal:{onSession:()=>()=>{},list:async()=>[]}}};
 t.after(()=>{dialog.__unmount();globalThis.window=oldWindow;globalThis.document=oldDocument;});dialog.__reset();
 const calls=[],remaining={acceptActionId:'accept',rejectActionId:'reject',groups:[{sessionId:'second',title:'Second',files:[file('remaining.txt')]}]};
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review:{acceptActionId:'accept',rejectActionId:'reject',groups:[
  {sessionId:'first',title:'First',files:[file('removed.txt')]},{sessionId:'second',title:'Second',files:[file('remaining.txt')]}]},
  invokeAction:async(id,input)=>{calls.push({id,input});return {review:remaining};},onReviewChange:review=>{props.review=review;},onActionResult(){},onClose(){}};
 let tree;const render=()=>{dialog.__flush();tree=dialog.__render(dialog.PluginChangesReviewDialog,props).children;return tree;};
 const button=label=>findAll(tree,node=>node.type==='button'&&node.props.children===label)[0];
 const click=label=>{const target=button(label);assert.ok(target,label);assert.equal(Boolean(target.props.disabled),false,label);target.props.onClick({currentTarget:{}});};
 render();await tick();render();click(action);render();click('Confirm');await tick();render();render();
 assert.equal(props.review,remaining,'mutation payload replaces cached groups');assert.equal(button('Confirm'),undefined);
 assert.ok(!JSON.stringify(tree).includes('removed.txt'));click('Accept selected files');render();click('Confirm');await tick();render();
 assert.deepEqual(calls[1],{id:'accept',input:{agentSessionId:'second',files:['remaining.txt']}});
});
