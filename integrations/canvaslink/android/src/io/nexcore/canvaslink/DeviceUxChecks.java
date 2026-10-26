package io.nexcore.canvaslink;

import android.content.pm.ActivityInfo;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.inputmethod.InputConnection;
import org.json.JSONObject;
import java.io.FileInputStream;

/** Additional adb-only checks on the owned fixture, never a user's terminal. */
final class DeviceUxChecks {
  final AcceptanceInstrumentation test; final MainActivity activity;
  DeviceUxChecks(AcceptanceInstrumentation test,MainActivity activity){this.test=test;this.activity=activity;}
  boolean value(String expression)throws Exception{return "true".equals(test.js(expression));}
  void require(boolean ok,String message)throws Exception{if(!ok)throw new Exception(message);}
  void until(String expression,int timeout,String failure)throws Exception{
    long end=SystemClock.uptimeMillis()+timeout;
    while(SystemClock.uptimeMillis()<end){if(value(expression))return;SystemClock.sleep(100);}
    throw new Exception(failure);
  }
  void shell(String command)throws Exception{
    try(ParcelFileDescriptor p=test.getUiAutomation().executeShellCommand(command);FileInputStream in=new FileInputStream(p.getFileDescriptor())){byte[] bytes=new byte[1024];while(in.read(bytes)!=-1){}}
  }
  JSONObject fixture()throws Exception{
    // A fixed sleep can observe a previous response or unfinished input queue.
    // Wait for delivered input, then require this exact diagnostic response.
    until("CanvasLinkClient.getState().pending===0",8000,"Fixture input queue did not drain");
    String id="fixture-"+SystemClock.uptimeMillis();test.js("CanvasLink.requestFixture("+JSONObject.quote(id)+")");
    until("CanvasLink.fixture?.requestId==="+JSONObject.quote(id),8000,"Fresh fixture response missing");
    return new JSONObject(test.js("CanvasLink.fixture"));
  }
  int clicks()throws Exception{return fixture().getInt("clicks");}
  int acked()throws Exception{return new JSONObject(test.js("CanvasLink.stats")).optInt("ackedInputs");}
  float[] point(double x,double y)throws Exception{
    JSONObject r=new JSONObject(test.js("(()=>{const r=document.getElementById('viewport').getBoundingClientRect();return {x:r.x+r.width*"+x+",y:r.y+r.height*"+y+",d:devicePixelRatio}})()"));
    int[] origin=new int[2];test.runOnMainSync(()->activity.web.getLocationOnScreen(origin));
    return new float[]{(float)(r.getDouble("x")*r.getDouble("d"))+origin[0],(float)(r.getDouble("y")*r.getDouble("d"))+origin[1]};
  }
  void motion(long down,int action,float[][] coordinates)throws Exception{
    MotionEvent.PointerProperties[] properties=new MotionEvent.PointerProperties[coordinates.length];
    MotionEvent.PointerCoords[] points=new MotionEvent.PointerCoords[coordinates.length];
    for(int i=0;i<coordinates.length;i++){properties[i]=new MotionEvent.PointerProperties();properties[i].id=i;properties[i].toolType=MotionEvent.TOOL_TYPE_FINGER;points[i]=new MotionEvent.PointerCoords();points[i].x=coordinates[i][0];points[i].y=coordinates[i][1];points[i].pressure=1;points[i].size=.1f;}
    MotionEvent event=MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,coordinates.length,properties,points,0,0,1,1,0,0,InputDevice.SOURCE_TOUCHSCREEN,0);
    boolean accepted=test.getUiAutomation().injectInputEvent(event,true);event.recycle();require(accepted,"Native gesture was rejected");
  }
  void drag(boolean hold,boolean cancel)throws Exception{
    float[] a=point(.35,.45),b=point(.55,.55);long down=SystemClock.uptimeMillis();motion(down,MotionEvent.ACTION_DOWN,new float[][]{a});
    if(hold)SystemClock.sleep(600);
    for(int i=1;i<=10;i++){SystemClock.sleep(25);float f=i/10f;motion(down,MotionEvent.ACTION_MOVE,new float[][]{{a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f}});}
    motion(down,cancel?MotionEvent.ACTION_CANCEL:MotionEvent.ACTION_UP,new float[][]{b});SystemClock.sleep(350);
  }
  void pair(boolean zoom)throws Exception{
    float[] a=point(.40,.45),b=point(.60,.45);long down=SystemClock.uptimeMillis();
    motion(down,MotionEvent.ACTION_DOWN,new float[][]{a});SystemClock.sleep(30);
    motion(down,MotionEvent.ACTION_POINTER_DOWN|(1<<MotionEvent.ACTION_POINTER_INDEX_SHIFT),new float[][]{a,b});
    for(int i=1;i<=10;i++){SystemClock.sleep(30);float f=i/10f;float[] aa=point(zoom?.40-.12*f:.40,zoom?.45:.45+.12*f),bb=point(zoom?.60+.12*f:.60,zoom?.45:.45+.12*f);motion(down,MotionEvent.ACTION_MOVE,new float[][]{aa,bb});}
    float[] aa=point(zoom?.28:.40,zoom?.45:.57),bb=point(zoom?.72:.60,zoom?.45:.57);
    motion(down,MotionEvent.ACTION_POINTER_UP|(1<<MotionEvent.ACTION_POINTER_INDEX_SHIFT),new float[][]{aa,bb});SystemClock.sleep(30);motion(down,MotionEvent.ACTION_UP,new float[][]{aa});SystemClock.sleep(350);
  }
  void workspaceFits()throws Exception{
    require(value("(()=>{const v=document.getElementById('viewport').getBoundingClientRect(),bar=document.getElementById('controls').getBoundingClientRect(),rows=[...document.querySelectorAll('#controls button')].map(e=>e.getBoundingClientRect().top);return Math.abs(v.width-innerWidth)<2&&Math.abs(v.height+56-innerHeight)<2&&bar.height===56&&new Set(rows).size===1&&!document.getElementById('compose');})()"),"Direct workspace geometry failed with real IME");
  }
  void rotate(int orientation)throws Exception{
    test.runOnMainSync(()->activity.setRequestedOrientation(orientation));
    until(orientation==ActivityInfo.SCREEN_ORIENTATION_PORTRAIT?"screen.height>screen.width":"screen.width>screen.height",6000,"Android orientation did not change");SystemClock.sleep(500);
  }
  void run(Bundle result)throws Exception{
    test.stage("ux-gestures");test.menu("reset-view");
    test.js("window.__gestureAudit=[];for(const type of ['pointerdown','pointerup','pointercancel','lostpointercapture','canvaslink:pointer'])document.addEventListener(type,e=>{const a=window.__gestureAudit;a.push({type,id:e.pointerId,target:e.target?.id,action:e.detail?.action});if(a.length>40)a.shift();},true)");
    int before=clicks();drag(false,false);int observed=clicks();require(observed==before+1,"Direct drag press mismatch before="+before+", after="+observed+", state="+test.js("JSON.stringify({pending:CanvasLinkClient.getState().pending,ime:CanvasLinkInput.active(),focus:document.activeElement.id,mode:document.getElementById('mode').getAttribute('aria-pressed'),events:window.__gestureAudit})"));
    before=clicks();drag(false,true);test.tap("#video","0.5,0.5");require(clicks()==before+2,"Cancellation left held button or duplicate tap");result.putBoolean("nativeDragAndCancel",true);
    test.menu("mode");before=clicks();int acks=acked();drag(false,false);require(clicks()==before&&value("!document.getElementById('local-cursor').hidden"),"Trackpad movement clicked or had no cursor");until("CanvasLink.stats.ackedInputs>"+acks,4000,"Trackpad move missing");
    before=clicks();drag(true,false);require(clicks()==before+1,"Hold-drag press count wrong");test.menu("reset-view");before=clicks();acks=acked();pair(false);require(clicks()==before,"Scroll created click");until("CanvasLink.stats.ackedInputs>"+acks,4000,"Native scroll missing");result.putBoolean("nativeTrackpadAndScroll",true);
    test.menu("mode");before=clicks();pair(true);require(value("new DOMMatrix(getComputedStyle(document.getElementById('video')).transform).a>1.25"),"Pinch did not zoom");require(clicks()==before,"Pinch ghost click");test.menu("reset-view");result.putBoolean("nativePinchAndFit",true);
    test.stage("ux-direct-ime");test.tap("#video","0.5,0.5");test.waitTerminalKeyboard();
    int oldLength=fixture().getString("text").length();boolean[] accepted={false};
    test.runOnMainSync(()->{InputConnection retired=activity.web.onCreateInputConnection(new android.view.inputmethod.EditorInfo());InputConnection input=activity.web.onCreateInputConnection(new android.view.inputmethod.EditorInfo());accepted[0]=input!=null&&!retired.commitText("STALE",1)&&input.setComposingText("日本🙂X",1)&&input.deleteSurroundingText(1,0)&&input.deleteSurroundingTextInCodePoints(1,0)&&((android.view.inputmethod.BaseInputConnection)input).getEditable().toString().equals("日本")&&input.commitText("日本語🙂",1)&&input.finishComposingText();if(input!=null){input.deleteSurroundingText(1,0);input.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_ENTER));input.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_ENTER));}});
    require(accepted[0],"Native composition/commit failed");SystemClock.sleep(500);JSONObject remote=fixture();require(remote.getString("text").substring(oldLength).equals("日本語"),"Composition was duplicated or lost after emoji Backspace");require(remote.getJSONArray("keys").toString().contains("Backspace"),"Native deletion missing");result.putBoolean("directCompositionUnicodeDeleteEnter",true);
    int unchanged=acked();test.runOnMainSync(()->((TerminalWebView)activity.web).paste(new String(new char[8001]).replace('\0','x')));until("document.getElementById('input-status').textContent.includes('8000')",4000,"Oversized paste feedback missing");require(value("CanvasLinkClient.getState().connection==='connected'&&CanvasLinkInput.active()"),"Oversized paste interrupted terminal connection");require(acked()==unchanged,"Oversized paste sent remote input");result.putBoolean("staleConnectionCodePointDeleteOversizedPaste",true);
    int previous=activity.getRequestedOrientation();try{for(int orientation:new int[]{ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE}){rotate(orientation);test.waitTerminalKeyboard();workspaceFits();}}finally{test.runOnMainSync(()->activity.setRequestedOrientation(previous));SystemClock.sleep(700);}result.putBoolean("singleRowRealImeBothOrientations",true);
    shell("input keyevent KEYCODE_BACK");until("!CanvasLinkInput.active()",4000,"Android Back did not retire terminal input");test.tap("#video","0.5,0.5");test.waitTerminalKeyboard();result.putBoolean("keyboardBackDismissAndRetap",true);
    test.stage("ux-background");int hostLength=fixture().getString("text").length();shell("input keyevent KEYCODE_HOME");until("document.hidden&&['suspended','reconnecting'].includes(CanvasLinkClient.getState().connection)",8000,"Background not suspended");shell("am start -n io.nexcore.canvaslink/.MainActivity");until("!document.hidden&&CanvasLinkClient.getState().connection==='connected'&&CanvasLink.stats.framesDecoded>8",30000,"Foreground video missing");require(fixture().getString("text").length()==hostLength,"Background replayed text");require(value("!CanvasLinkInput.active()"),"Old native input owner survived background");result.putBoolean("backgroundNoReplay",true);
    test.stage("ux-wifi-loss");try{shell("svc wifi disable");until("CanvasLinkClient.getState().connection!=='connected'",20000,"Wi-Fi loss not detected");require(value("!CanvasLinkInput.active()"),"Offline IME not stopped");}finally{shell("svc wifi enable");}until("CanvasLinkClient.getState().connection==='connected'&&CanvasLink.stats.framesDecoded>8",40000,"Wi-Fi video recovery missing");require(fixture().getString("text").length()==hostLength,"Wi-Fi recovery replayed text");result.putBoolean("wifiLossRecoveryNoReplay",true);test.stage("ux-complete");
  }
}
