// Optional high-density startup; the desktop must opt in explicitly.
// Never change density or restart the default desktop process.
function configureRenderScale(app,argv=process.argv){
 if(app.isReady())throw Error('render-scale-requires-startup');
 const scale=argv.find(arg=>arg.startsWith('--force-device-scale-factor='));
 if(scale){if(!['--force-device-scale-factor=1','--force-device-scale-factor=2'].includes(scale))throw Error('invalid-render-scale');return;}
 // Electron 43/macOS reads this switch before JavaScript: appendSwitch at the
 // top of main still leaves DPR=1. A normal preview launch restarts once with
 // the process-start switch. The owned acceptance launcher already passes it.
 app.relaunch({args:[...argv.slice(1),'--force-device-scale-factor=2']});
 app.exit(0);
}
module.exports={configureRenderScale};
