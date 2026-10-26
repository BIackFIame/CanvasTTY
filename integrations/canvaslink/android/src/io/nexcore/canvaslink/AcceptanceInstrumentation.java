package io.nexcore.canvaslink;

import android.app.Instrumentation;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.MotionEvent;
import org.json.*;
import java.util.concurrent.*;

/** Local adb-only acceptance. Never logs pairing material or captured content. */
public final class AcceptanceInstrumentation extends Instrumentation {
  private Bundle arguments; private MainActivity activity;
  void stage(String name){Bundle b=new Bundle();b.putString("stage",name);sendStatus(0,b);}
  @Override public void onCreate(Bundle args){arguments=args;start();}
  String js(String code) throws Exception {
    CountDownLatch latch=new CountDownLatch(1);String[] out={"null"};
    runOnMainSync(()->activity.web.evaluateJavascript(code,value->{out[0]=value;latch.countDown();}));
    if(!latch.await(5,TimeUnit.SECONDS))throw new Exception("WebView evaluation timeout");return out[0];
  }
  void tap(String selector) throws Exception {
    tap(selector,null);
  }
  void tap(String selector, String point) throws Exception {
    boolean[] focused={false};runOnMainSync(()->focused[0]=activity.web.hasWindowFocus());
    if(!focused[0])throw new Exception("Touch Activity is not foreground");
    String coordinate="{x:r.x+r.width/2,y:r.y+r.height/2}";
    if(point!=null){String[] xy=point.split(",");double x=Double.parseDouble(xy[0]),y=Double.parseDouble(xy[1]);if(x<0||x>1||y<0||y>1)throw new Exception("Invalid normalized point");coordinate="(()=>{const f=Math.min(r.width/e.videoWidth,r.height/e.videoHeight),w=e.videoWidth*f,h=e.videoHeight*f;return {x:r.x+(r.width-w)/2+w*"+x+",y:r.y+(r.height-h)/2+h*"+y+"}})()";}
    String rect=js("(()=>{const e=document.querySelector("+JSONObject.quote(selector)+");e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect(),p="+coordinate+";return {...p,dpr:devicePixelRatio,w:innerWidth,h:innerHeight}})()");
    JSONObject p=new JSONObject(rect);int[] offset=new int[2];runOnMainSync(()->activity.web.getLocationOnScreen(offset));
    if(p.getDouble("x")<0||p.getDouble("x")>=p.getDouble("w")||p.getDouble("y")<0||p.getDouble("y")>=p.getDouble("h"))throw new Exception("Touch target outside viewport: "+selector);
    float x=(float)(p.getDouble("x")*p.getDouble("dpr"))+offset[0];
    float y=(float)(p.getDouble("y")*p.getDouble("dpr"))+offset[1];
    // CSS px and WebView device px differ by density, including viewport scaling.
    long at=SystemClock.uptimeMillis();MotionEvent down=MotionEvent.obtain(at,at,MotionEvent.ACTION_DOWN,x,y,0);
    MotionEvent up=MotionEvent.obtain(at,at+60,MotionEvent.ACTION_UP,x,y,0);
    down.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);up.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
    if(!getUiAutomation().injectInputEvent(down,true)||!getUiAutomation().injectInputEvent(up,true))throw new Exception("Android rejected touch: "+selector);
    down.recycle();up.recycle();
    SystemClock.sleep(120);
  }
  void commitText(String text) throws Exception {
    boolean[] committed={false};runOnMainSync(()->{
      android.view.inputmethod.InputConnection input=activity.web.onCreateInputConnection(new android.view.inputmethod.EditorInfo());
      if(input!=null){input.performContextMenuAction(android.R.id.selectAll);committed[0]=input.commitText(text,1);}
    });
    SystemClock.sleep(200);
    if(!committed[0])throw new Exception("Android IME commit was rejected");
    stage("android-ime-commit");
  }
  void menu(String id)throws Exception{tap("#menu-toggle");tap("#"+id);SystemClock.sleep(400);}
  int decodedFrames()throws Exception{return new JSONObject(js("window.CanvasLink.stats")).optInt("framesDecoded");}
  void waitVideoAfterTouch(int before)throws Exception{
    for(int i=0;i<120;i++){if(decodedFrames()>before)return;SystemClock.sleep(100);}
    throw new Exception("Decoded video did not advance after real remote touch");
  }
  String freshNativePoint()throws Exception{
    java.io.File directory=activity.getExternalFilesDir(null);if(directory==null)throw new Exception("Owned external acceptance directory unavailable");
    java.io.File target=new java.io.File(directory,"acceptance-target.json");stage("native-target-request");
    for(int i=0;i<80&&!target.exists();i++)SystemClock.sleep(100);
    if(!target.exists())throw new Exception("Fresh owned terminal target unavailable");
    JSONObject p=new JSONObject(new String(java.nio.file.Files.readAllBytes(target.toPath()),java.nio.charset.StandardCharsets.UTF_8));target.delete();
    return p.getDouble("x")+","+p.getDouble("y");
  }
  void waitTerminalKeyboard()throws Exception{
    for(int i=0;i<60;i++){
      boolean[] visible={false};runOnMainSync(()->{TerminalWebView view=(TerminalWebView)activity.web;visible[0]=view.terminalActive()&&(android.os.Build.VERSION.SDK_INT<30||view.getRootWindowInsets()!=null&&view.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()));});
      if(visible[0]&&"true".equals(js("CanvasLinkInput.active()"))){SystemClock.sleep(400);return;}
      SystemClock.sleep(100);
    }
    boolean[] nativeState={false,false};runOnMainSync(()->{nativeState[0]=((TerminalWebView)activity.web).terminalActive();nativeState[1]=activity.web.getRootWindowInsets()!=null&&activity.web.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime());});
    throw new Exception("Terminal keyboard inactive: native="+nativeState[0]+",visible="+nativeState[1]+",client="+js("JSON.stringify({active:CanvasLinkInput.active(),delivery:CanvasLinkClient.getState().delivery,notice:document.getElementById('stream-error').textContent,source:CanvasLinkClient.getState().source})"));
  }
  @Override public void onStart(){
    Bundle result=new Bundle();
    try{
      stage("launch");
      Intent intent=new Intent(getTargetContext(),MainActivity.class);intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getTargetContext().startActivity(intent);
      for(int i=0;i<100&&MainActivity.active==null;i++)SystemClock.sleep(100);
      activity=MainActivity.active;if(activity==null)throw new Exception("Activity launch timeout");stage("activity-ready");
      for(int i=0;i<80&&!"true".equals(js("!!window.CanvasLink"));i++)SystemClock.sleep(100);
      String host=arguments.getString("host"),pin=arguments.getString("pin");
      boolean restoring="restore".equals(arguments.getString("mode"));
      boolean discoveryFlow="true".equals(arguments.getString("discovery"));
      if(!restoring){
        if(pin==null)throw new Exception("pin argument required");
        if(discoveryFlow){
          String selected=null,port=arguments.getString("port");
          for(int i=0;i<150&&selected==null;i++){
            JSONArray computers=new JSONObject(js("window.CanvasLinkClient.getState()")).getJSONArray("computers");
            for(int j=0;j<computers.length();j++){JSONObject c=computers.getJSONObject(j);if(port==null||c.getString("host").endsWith(":"+port)){selected=c.getString("id");break;}}
            if(selected==null)SystemClock.sleep(200);
          }
          if(selected==null)throw new Exception("No matching NSD computer discovered");
          final String chosen=selected;
          int index=Integer.parseInt(js("CanvasLinkClient.getState().computers.findIndex(c=>c.id==="+JSONObject.quote(chosen)+")"));
          tap("#computers button:nth-child("+(index+1)+")");SystemClock.sleep(400);
          tap("#pin");SystemClock.sleep(200);commitText(pin);
          if(!"true".equals(js("document.getElementById('pin').value.length===6")))throw new Exception("PIN IME input did not reach form; focused="+js("document.activeElement.id")+", length="+js("document.getElementById('pin').value.length"));
          runOnMainSync(()->((android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(activity.web.getWindowToken(),0));SystemClock.sleep(400);
          tap("#connect");stage("discovery-and-code-form");result.putBoolean("discoveryForm",true);
        }else{
          if(host==null)throw new Exception("host required without discovery");
          js("window.CanvasLink.connectForTest("+JSONObject.quote(host)+","+JSONObject.quote(pin)+")");
        }
      }
      stage("connecting");
      // A static owned window legitimately sends one initial image. Confirm
      // subsequent live updates after an actual remote action, below.
      int minimumFrames=("native".equals(arguments.getString("mode"))||"settings".equals(arguments.getString("mode")))?1:9;
      JSONObject stats=null;
      for(int i=0;i<200;i++){
        SystemClock.sleep(200);
        try{stats=new JSONObject(js("window.CanvasLink.stats"));}catch(Exception ignored){}
        if(stats!=null&&stats.optInt("framesDecoded")>=minimumFrames&&"connected".equals(stats.optString("state")))break;
      }
      if(stats==null||stats.optInt("framesDecoded")<minimumFrames)throw new Exception("No decoded live video frames");
      stage("video-decoded");
      if("native".equals(arguments.getString("mode"))){
        if("true".equals(arguments.getString("graphics")))new GraphicsChecks(this).run(result);
        JSONArray samples=new JSONArray();for(int i=0;i<6;i++){SystemClock.sleep(500);samples.put(new JSONObject(js("window.CanvasLink.stats")));}result.putString("motionSamples",samples.toString());
      }
      // Let the local controller capture this Activity before finish tears it down.
      if("true".equals(arguments.getString("snapshot")))SystemClock.sleep(4000);
      boolean isFixture="fixture".equals(arguments.getString("mode"));
      if("native".equals(arguments.getString("mode"))){
        String point=arguments.getString("point"),text64=arguments.getString("text64");
        if(point==null||text64==null)throw new Exception("Native target and text required");
        String text=new String(android.util.Base64.decode(text64,android.util.Base64.DEFAULT),java.nio.charset.StandardCharsets.UTF_8);
        if("true".equals(arguments.getString("livePoint"))){
          point=freshNativePoint();result.putBoolean("freshOwnedTarget",true);
        }
        int framesBeforeTouch=decodedFrames();tap("#video",point);stage("native-touch-sent");waitTerminalKeyboard();result.putBoolean("tapOpenedNativeIme",true);
        waitVideoAfterTouch(framesBeforeTouch);result.putBoolean("nativeVideoRespondedToTouch",true);
        if("true".equals(arguments.getString("shellReady"))){java.io.File shellReady=new java.io.File(activity.getExternalFilesDir(null),"acceptance-shell-ready");shellReady.delete();stage("native-shell-ready-request");for(int i=0;i<400&&!shellReady.exists();i++)SystemClock.sleep(100);if(!shellReady.exists())throw new Exception("Owned shell first prompt was not confirmed");shellReady.delete();result.putBoolean("controlledShellReadyBeforeText",true);}
        commitText(text);
        SystemClock.sleep(600);tap("[data-key=Enter]");
        boolean complete=false;
        for(int i=0;i<150;i++){
          SystemClock.sleep(200);
          String inputError=new JSONArray("["+js("document.getElementById('stream-error').textContent")+"]").getString(0);
          if(!inputError.isEmpty())throw new Exception("Native input: "+inputError);
          JSONObject delivery=new JSONObject(js("CanvasLinkClient.getState()"));
          if(!delivery.isNull("delivery")&&"failed".equals(delivery.getJSONObject("delivery").optString("status")))throw new Exception("Native input rejected: "+delivery.getJSONObject("delivery").optString("error"));
          if(new JSONObject(js("window.CanvasLink.stats")).optInt("ackedInputs")>=4){complete=true;break;}
        }
        if(!complete)throw new Exception("Host did not finish all native input events");
        stage("native-text-and-enter-sent");
        if("true".equals(arguments.getString("snapshot")))SystemClock.sleep(4000);
        if("true".equals(arguments.getString("controls"))){
          String encoded=arguments.getString("proofDir64");
          if(encoded==null)throw new Exception("Owned control proof directory required");
          String directory=new String(android.util.Base64.decode(encoded,android.util.Base64.DEFAULT),java.nio.charset.StandardCharsets.UTF_8);
          new NativeControlChecks(this).run(directory,result);
        }
      }
      if("settings".equals(arguments.getString("mode")))new SettingsTouchChecks(this).run(result);
      if(isFixture){
        menu("fit");
        if(!"true".equals(js("getComputedStyle(document.getElementById('video')).transform.startsWith('matrix(2')")))throw new Exception("Zoom control failed");
        menu("fit");menu("mode");
        if(!"true".equals(js("document.getElementById('mode').getAttribute('aria-pressed')==='true'")))throw new Exception("Trackpad mode failed");
        menu("mode");result.putBoolean("zoomAndModeControls",true);
        tap("#viewport");stage("touch-sent");waitTerminalKeyboard();
        commitText("Проверка CanvasLink 42");
        SystemClock.sleep(600);tap("[data-key=Enter]");
        stage("text-and-key-sent");
        JSONObject fixture=null;
        for(int i=0;i<40;i++){
          js("window.CanvasLink.requestFixture()");SystemClock.sleep(150);
          try{fixture=new JSONObject(js("window.CanvasLink.fixture"));}catch(Exception ignored){}
          if(fixture!=null&&fixture.optInt("clicks")>0&&fixture.optString("text").contains("Проверка CanvasLink 42")&&fixture.optJSONArray("keys").toString().contains("Enter"))break;
        }
        if(fixture==null||fixture.optInt("clicks")<1||!fixture.optString("text").contains("Проверка CanvasLink 42")||!fixture.optJSONArray("keys").toString().contains("Enter"))throw new Exception("Fixture input roundtrip failed: clicks="+(fixture==null?-1:fixture.optInt("clicks"))+", text="+(fixture!=null&&fixture.optString("text").contains("Проверка CanvasLink 42"))+", Enter="+(fixture!=null&&fixture.optJSONArray("keys").toString().contains("Enter")));
        result.putBoolean("touchRoundtrip",true);result.putBoolean("unicodeTextRoundtrip",true);result.putBoolean("enterRoundtrip",true);
        if("true".equals(arguments.getString("ux")))new DeviceUxChecks(this,activity).run(result);
      }
      if("true".equals(arguments.getString("draftCheck")))throw new Exception("Removed composer draft flow; use direct-input UX acceptance");
      result.putString("stats",js("window.CanvasLink.stats"));result.putBoolean("fixture",isFixture);result.putBoolean("restored",restoring);result.putString("status","PASS");
      finish(Activity.RESULT_OK,result);
    }catch(Exception e){result.putString("status","FAIL");result.putString("error",e.getMessage());finish(Activity.RESULT_CANCELED,result);}
  }
}
