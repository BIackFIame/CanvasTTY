const {test}=require('node:test'),assert=require('node:assert/strict');
const {installSettingsHost}=require('../host/settings-host.cjs');
function fixture(command=async action=>action){
 const handlers=new Map(),mainFrame={},contents={mainFrame},target={webContents:contents,isDestroyed:()=>false};
 installSettingsHost({ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},getWindow:()=>target,snapshot:()=>({enabled:false}),command});
 return {handlers,target,event:{sender:contents,senderFrame:mainFrame}};
}
test('Settings state and commands reject other renderers, child frames and unknown actions',()=>{
 const f=fixture();for(const channel of ['canvaslink-settings:state','canvaslink-settings:command']){
  for(const event of [{sender:{},senderFrame:f.event.senderFrame},{sender:f.event.sender,senderFrame:{}}])assert.throws(()=>f.handlers.get(channel)(event,'enable'),/untrusted-settings-renderer/);
 }
 assert.throws(()=>f.handlers.get('canvaslink-settings:command')(f.event,'shell'),/invalid-settings-command/);
 assert.deepEqual(f.handlers.get('canvaslink-settings:state')(f.event),{enabled:false});
});
test('Settings operations are serialized and a failed enable does not block later commands',async()=>{
 const order=[];let release;const gate=new Promise(resolve=>release=resolve);
 const f=fixture(async action=>{order.push(action);if(action==='enable'){await gate;throw Error('bind failed');}return action;});
 const command=f.handlers.get('canvaslink-settings:command');const first=command(f.event,'enable'),second=command(f.event,'disable');
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,['enable']);release();await assert.rejects(first,/bind failed/);assert.equal(await second,'disable');assert.deepEqual(order,['enable','disable']);
});
test('A queued settings operation cannot execute after its owning window closes',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),order=[];
 const f=fixture(async action=>{order.push(action);if(action==='enable')await gate;});const command=f.handlers.get('canvaslink-settings:command');
 const first=command(f.event,'enable'),second=command(f.event,'disable');await new Promise(resolve=>setImmediate(resolve));
 f.target.isDestroyed=()=>true;release();await first;await assert.rejects(second,/untrusted-settings-renderer/);assert.deepEqual(order,['enable']);
});
