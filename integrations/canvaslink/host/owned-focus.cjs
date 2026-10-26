// Activation is asynchronous on macOS. Wait only for our own window; never send
// system keys or continue a revoked input after waiting for activation.
async function focusOwnedWindow({app,target,active,timeout=1000,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const check=()=>{if(!active())throw Error('session-ended');if(target.isDestroyed())throw Error('window-closed');if(target.isMinimized())throw Error('window-minimized');};
 check();
 const request=()=>{app.focus({steal:true});target.show();target.focus();};
 if(!target.isFocused())request();
 const deadline=now()+timeout;let retryAt=now()+100;
 while(!target.isFocused()){
  check();if(now()>=deadline)throw Error('canvas-focus-required');
  // Hiding the pairing child may asynchronously resign the app's key window
  // after the first activation request. Reassert only this own window, bounded.
  if(now()>=retryAt){request();retryAt=now()+100;}
  await wait(20);
 }
 check();target.webContents.focus();
}
module.exports={focusOwnedWindow};
