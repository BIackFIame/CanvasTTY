// The desktop settings API is available only to the owning CanvasTTY main frame.
function installSettingsHost({ipcMain,getWindow,snapshot,command}){
 const trusted=event=>{const target=getWindow();if(!target||target.isDestroyed()||event.sender!==target.webContents||event.senderFrame!==target.webContents.mainFrame)throw Error('untrusted-settings-renderer');};
 let pending=Promise.resolve();
 ipcMain.handle('canvaslink-settings:state',event=>{trusted(event);return snapshot();});
 ipcMain.handle('canvaslink-settings:command',(event,action)=>{
  trusted(event);if(!['enable','disable','new-code','revoke'].includes(action))throw Error('invalid-settings-command');
  const work=pending.then(()=>{trusted(event);return command(action);});pending=work.catch(()=>{});return work;
 });
}
module.exports={installSettingsHost};
