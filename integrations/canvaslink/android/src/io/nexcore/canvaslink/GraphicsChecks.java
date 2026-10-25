package io.nexcore.canvaslink;

import android.os.Bundle;
import android.os.SystemClock;
import org.json.JSONArray;

/** ADB-only visual acceptance; all view controls use real Android touches. */
final class GraphicsChecks {
  final AcceptanceInstrumentation test;
  GraphicsChecks(AcceptanceInstrumentation test){this.test=test;}
  void until(String expression,String error)throws Exception{
    long end=SystemClock.uptimeMillis()+12000;
    while(SystemClock.uptimeMillis()<end){if("true".equals(test.js(expression)))return;SystemClock.sleep(100);}
    throw new Exception(error+"; geometry="+test.js("JSON.stringify({source:CanvasLinkClient.getState().source,zoom:document.getElementById(\"zoom-label\").textContent})"));
  }
  void run(Bundle result)throws Exception{
    until("[...document.fonts].some(f=>f.family==='Onest'&&f.status==='loaded')","Bundled Onest font was not consumed by WebView");
    until("document.getElementById('view-toggle-label').textContent==='Весь Canvas'&&!!CanvasLinkClient.getState().source?.terminalView","Initial terminal view did not follow source geometry");
    if(!"false".equals(test.js("CanvasLinkInput.active()")))throw new Exception("Visual framing must not start terminal input");
    until("(()=>{const s=CanvasLinkClient.getState().source.terminalView,e=document.getElementById('video'),r=e.getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect(),k=Math.min(r.width/e.videoWidth,r.height/e.videoHeight),left=r.left+(r.width-e.videoWidth*k)/2+s.rect.x*e.videoWidth*k,top=r.top+(r.height-e.videoHeight*k)/2+s.rect.y*e.videoHeight*k;return left>=v.left-2&&top>=v.top-2&&left+s.rect.width*e.videoWidth*k<=v.right+2&&top+s.rect.height*e.videoHeight*k<=v.bottom+2;})()","Initial framing cuts off the selected terminal");
    result.putBoolean("automaticTerminalViewWithoutIme",true);result.putBoolean("bundledFontLoaded",true);
    test.stage("graphics-terminal-view-ready");SystemClock.sleep(700);
    int sent=Integer.parseInt(test.js("CanvasLink.stats.inputs||0"));
    test.tap("#view-toggle");
    until("document.getElementById('zoom-label').textContent==='100%'","Overview button did not restore Canvas");
    SystemClock.sleep(1200);
    if(!"100%".equals(new JSONArray("["+test.js("document.getElementById('zoom-label').textContent")+"]").getString(0)))throw new Exception("Source health overrode explicit overview");
    test.stage("graphics-overview-ready");SystemClock.sleep(700);test.tap("#view-toggle");
    until("document.getElementById('view-toggle-label').textContent==='Весь Canvas'","Terminal button did not restore framing");
    if(!"false".equals(test.js("CanvasLinkInput.active()"))||Integer.parseInt(test.js("CanvasLink.stats.inputs||0"))!=sent)throw new Exception("Local view button sent remote input");
    result.putBoolean("viewToggleTouchRoundtripWithoutRemoteInput",true);
    String encoded=new JSONArray("["+test.js("(()=>{const v=document.getElementById('video'),c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);return c.toDataURL('image/png').split(',')[1];})()")+"]").getString(0);
    byte[] frame=android.util.Base64.decode(encoded,android.util.Base64.DEFAULT);
    java.nio.file.Files.write(new java.io.File(MainActivity.active.getExternalFilesDir(null),"graphics-decoded-frame.png").toPath(),frame);
    result.putBoolean("decodedVideoFrameSavedPrivately",true);test.stage("graphics-decoded-frame-ready");SystemClock.sleep(500);
  }
}
