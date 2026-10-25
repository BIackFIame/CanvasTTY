package io.nexcore.canvaslink;

import android.os.Bundle;
import android.os.SystemClock;
import android.view.MotionEvent;
import org.json.*;

/** Actual Android touch -> WebRTC -> ordinary compiled CanvasTTY Settings. */
final class SettingsTouchChecks {
 final AcceptanceInstrumentation test;
 final DeviceUxChecks gestures;
 SettingsTouchChecks(AcceptanceInstrumentation test){this.test=test;gestures=new DeviceUxChecks(test,MainActivity.active);}
 JSONObject probe()throws Exception{
  java.io.File file=new java.io.File(MainActivity.active.getExternalFilesDir(null),"acceptance-settings.json");
  file.delete();test.stage("remote-settings-request");
  for(int i=0;i<80&&!file.exists();i++)SystemClock.sleep(100);
  if(!file.exists())throw new Exception("Read-only Settings geometry unavailable");
  JSONObject value=new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()),java.nio.charset.StandardCharsets.UTF_8));file.delete();return value;
 }
 JSONObject rect(JSONObject p,String name)throws Exception{
  JSONObject item=name.startsWith("settings-tab-")?p.getJSONObject("tabs").optJSONObject(name):p.getJSONObject("controls").optJSONObject(name);
  if(item==null||item.isNull("rect"))throw new Exception("Settings target not visible: "+name);
  JSONObject r=item.getJSONObject("rect");if(!r.optBoolean("hit"))throw new Exception("Settings target covered: "+name);return r;
 }
 void tap(JSONObject p,String name)throws Exception{JSONObject r=rect(p,name);test.tap("#video",(r.getDouble("x")+r.getDouble("width")/2)+","+(r.getDouble("y")+r.getDouble("height")/2));SystemClock.sleep(500);}
 float[] point(double x,double y)throws Exception{
  JSONObject r=new JSONObject(test.js("(()=>{const e=document.getElementById('video'),r=e.getBoundingClientRect(),k=Math.min(r.width/e.videoWidth,r.height/e.videoHeight);return {x:r.x+(r.width-e.videoWidth*k)/2+e.videoWidth*k*"+x+",y:r.y+(r.height-e.videoHeight*k)/2+e.videoHeight*k*"+y+",d:devicePixelRatio}})()"));
  int[] origin=new int[2];test.runOnMainSync(()->MainActivity.active.web.getLocationOnScreen(origin));return new float[]{(float)(r.getDouble("x")*r.getDouble("d"))+origin[0],(float)(r.getDouble("y")*r.getDouble("d"))+origin[1]};
 }
 void swipe(JSONObject r,double direction)throws Exception{
  double x=r.getDouble("x")+r.getDouble("width")*.9,y=r.getDouble("y"),h=r.getDouble("height");
  float[] a=point(x,y+h*(direction>0?.75:.25)),b=point(x,y+h*(direction>0?.25:.75));
  long down=SystemClock.uptimeMillis();gestures.motion(down,MotionEvent.ACTION_DOWN,new float[][]{a});
  for(int i=1;i<=16;i++){SystemClock.sleep(25);float f=i/16f;gestures.motion(down,MotionEvent.ACTION_MOVE,new float[][]{{a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f}});}
  gestures.motion(down,MotionEvent.ACTION_UP,new float[][]{b});SystemClock.sleep(600);
 }
 JSONObject reveal(JSONObject p,String name)throws Exception{
  for(int i=0;i<28;i++){JSONObject c=p.getJSONObject("controls").optJSONObject(name);if(c!=null&&!c.isNull("rect")&&c.getJSONObject("rect").optBoolean("hit"))return p;
   JSONObject scroll=p.getJSONObject("scroll");if(scroll.getDouble("top")+scroll.getDouble("height")>=scroll.getDouble("total")-2)break;
   swipe(rect(p,"content"),1);p=probe();
  }throw new Exception("Cannot reveal Settings control: "+name);
 }
 void noKeyboard(String context)throws Exception{
  boolean[] visible={false};test.runOnMainSync(()->visible[0]=MainActivity.active.web.getRootWindowInsets()!=null&&MainActivity.active.web.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()));
  if(visible[0]||!"false".equals(test.js("CanvasLinkInput.active()")))throw new Exception("Non-text Settings control opened IME: "+context);
  if(!"true".equals(test.js("document.getElementById('zoom-label').textContent==='100%'")))throw new Exception("Non-text Settings control changed Canvas zoom: "+context);
 }
 void dragRange(JSONObject r)throws Exception{
  float[] a=point(r.getDouble("x")+r.getDouble("width")*.3,r.getDouble("y")+r.getDouble("height")/2),b=point(r.getDouble("x")+r.getDouble("width")*.65,r.getDouble("y")+r.getDouble("height")/2);
  long down=SystemClock.uptimeMillis();gestures.motion(down,MotionEvent.ACTION_DOWN,new float[][]{a});for(int i=1;i<=12;i++){SystemClock.sleep(25);float f=i/12f;gestures.motion(down,MotionEvent.ACTION_MOVE,new float[][]{{a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f}});}gestures.motion(down,MotionEvent.ACTION_UP,new float[][]{b});SystemClock.sleep(400);
 }
 void run(Bundle result)throws Exception{
  test.stage("settings-touch-open");test.menu("reset-view");JSONObject p=probe();int framesBeforeTouch=test.decodedFrames();tap(p,"open");p=probe();
  if(!p.optBoolean("open"))throw new Exception("Touch did not open Settings");result.putBoolean("remoteSettingsOpened",true);noKeyboard("open");
  test.waitVideoAfterTouch(framesBeforeTouch);result.putBoolean("remoteSettingsVideoRespondedToTouch",true);
  tap(p,"settings-tab-general");p=probe();boolean wasOn=p.getJSONObject("controls").getJSONObject("toggleOn").getBoolean("selected");
  tap(p,wasOn?"toggleOff":"toggleOn");p=probe();if(p.getJSONObject("controls").getJSONObject("toggleOn").getBoolean("selected")==wasOn)throw new Exception("Touch toggle did not change");noKeyboard("toggle");
  tap(p,wasOn?"toggleOn":"toggleOff");result.putBoolean("remoteToggleChangedAndRestored",true);
  tap(probe(),"settings-tab-appearance");p=probe();if(!"settings-panel-appearance".equals(p.optString("tab")))throw new Exception("Touch did not select Appearance");
  double before=p.getJSONObject("scroll").getDouble("top");swipe(rect(p,"content"),1);p=probe();
  if(p.getJSONObject("scroll").getDouble("top")<=before+20)throw new Exception("One-finger Settings swipe did not scroll remote content");
  result.putBoolean("remoteSettingsOneFingerScroll",true);noKeyboard("scroll");
  for(int i=0;i<12&&(p.getJSONObject("controls").optJSONObject("range")==null||p.getJSONObject("controls").getJSONObject("range").isNull("rect"));i++){swipe(rect(p,"content"),1);p=probe();}
  double oldRange=p.getJSONObject("controls").getJSONObject("range").getDouble("value");
  tap(p,"range");noKeyboard("range");p=probe();double beforeDrag=p.getJSONObject("controls").getJSONObject("range").getDouble("value");JSONObject slider=rect(p,"range");
  String fresh="(()=>{const p="+slider.toString()+",x=p.x+p.width/2,y=p.y+p.height/2;return CanvasLinkClient.getState().source.dragRects.some(r=>x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height)})()";
  if(!"true".equals(test.js(fresh)))throw new Exception("Slider geometry stayed stale after UI resize");
  dragRange(slider);p=probe();double selected=p.getJSONObject("controls").getJSONObject("range").getDouble("value");if(Math.abs(selected-beforeDrag)<.001)throw new Exception("Actual range drag did not change value");result.putBoolean("remoteRangeTouchDrag",true);noKeyboard("range drag");
  test.tap("[data-key=ArrowRight]");SystemClock.sleep(300);p=probe();double next=p.getJSONObject("controls").getJSONObject("range").getDouble("value");
  if(next<=selected)throw new Exception("Range ArrowRight failed without IME");
  for(int i=0;i<60&&Math.abs(next-oldRange)>.001;i++){test.tap(next>oldRange?"[data-key=ArrowLeft]":"[data-key=ArrowRight]");SystemClock.sleep(120);p=probe();next=p.getJSONObject("controls").getJSONObject("range").getDouble("value");}
  if(Math.abs(next-oldRange)>.001)throw new Exception("Range could not be restored");
  result.putBoolean("remoteRangeNoKeyboard",true);result.putBoolean("remoteRangeScreenKeysChangedAndRestored",true);
  test.stage("settings-text-and-select");tap(probe(),"settings-tab-agents");p=reveal(probe(),"preset");tap(p,"preset");p=reveal(probe(),"text");
  JSONObject textRect=rect(p,"text");test.tap("#video",(textRect.getDouble("x")+textRect.getDouble("width")*.96)+","+(textRect.getDouble("y")+textRect.getDouble("height")/2));test.waitTerminalKeyboard();test.stage("settings-text-ime-ready");SystemClock.sleep(800);
  JSONObject legibility=new JSONObject(test.js("(()=>{const e=document.getElementById('video'),r=e.getBoundingClientRect(),k=Math.min(r.width/e.videoWidth,r.height/e.videoHeight);return {font:"+p.getJSONObject("controls").getJSONObject("text").getDouble("fontSize")+"*e.videoWidth/(CanvasLinkClient.getState().source.viewport?.width||e.videoWidth)*k,scale:new DOMMatrix(getComputedStyle(e).transform).a}})()"));if(legibility.getDouble("font")<11.5||legibility.getDouble("scale")>4.01)throw new Exception("Settings field too small or excessively zoomed with real IME");
  test.commitText(" · CL touch");SystemClock.sleep(400);p=probe();if(!p.getJSONObject("controls").getJSONObject("text").optBoolean("testMarker"))throw new Exception("Text field did not receive direct IME commit");
  test.tap("#keyboard-toggle");SystemClock.sleep(400);noKeyboard("text edit ended");result.putBoolean("remoteTextReadableWithImeAndOverviewRestored",true);p=probe();tap(p,"save");SystemClock.sleep(500);
  tap(probe(),"settings-tab-general");tap(probe(),"settings-tab-agents");p=reveal(probe(),"text");if(!p.getJSONObject("controls").getJSONObject("text").optBoolean("testMarker"))throw new Exception("Settings text did not persist across tab reopen");result.putBoolean("remoteTextDirectImeSavedAndReopened",true);
  p=reveal(p,"select");int prior=p.getJSONObject("controls").getJSONObject("select").getInt("index");tap(p,"select");noKeyboard("select");test.stage("settings-select-open");SystemClock.sleep(800);
  p=probe();int choice=prior==0?1:0;tap(p,"option-"+choice);p=probe();
  if(p.getJSONObject("controls").getJSONObject("select").getInt("index")!=choice)throw new Exception("Select did not change through actual option touch");result.putBoolean("remoteSelectOptionTouch",true);
  tap(p,"select");test.tap("[data-key=ArrowDown]");test.tap("[data-key=Enter]");SystemClock.sleep(400);p=probe();
  int keyboardChoice=p.getJSONObject("controls").getJSONObject("select").getInt("index");if(keyboardChoice==choice)throw new Exception("Select did not change through screen keys");result.putBoolean("remoteSelectScreenKeys",true);
  tap(p,"select");test.tap("[data-key=ArrowUp]");test.tap("[data-key=Escape]");p=probe();if(p.getJSONObject("controls").getJSONObject("select").getInt("index")!=keyboardChoice||p.getJSONObject("controls").has("option-0"))throw new Exception("Select Escape did not dismiss without applying");result.putBoolean("remoteSelectEscape",true);noKeyboard("select options");
  tap(p,"save");tap(probe(),"settings-tab-general");tap(probe(),"settings-tab-agents");p=reveal(probe(),"select");if(p.getJSONObject("controls").getJSONObject("select").getInt("index")!=keyboardChoice)throw new Exception("Select value did not persist");result.putBoolean("remoteSelectSavedAndReopened",true);
  tap(p,"remove");SystemClock.sleep(400);
  tap(probe(),"close");if(probe().optBoolean("open"))throw new Exception("Touch did not close Settings");result.putBoolean("remoteSettingsClosed",true);
 }
}
