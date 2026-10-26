package io.nexcore.canvaslink;

import android.os.Bundle;
import android.os.SystemClock;

/** ADB-only controls against the controller's disposable CanvasTTY terminal. */
final class NativeControlChecks {
  final AcceptanceInstrumentation test;
  NativeControlChecks(AcceptanceInstrumentation test){this.test=test;}
  void until(String expression,String error)throws Exception{
    long end=SystemClock.uptimeMillis()+10000;
    while(SystemClock.uptimeMillis()<end){if("true".equals(test.js(expression)))return;SystemClock.sleep(100);}
    throw new Exception(error+"; state="+test.js("JSON.stringify({connection:CanvasLinkClient.getState().connection,pending:CanvasLinkClient.getState().pending,delivery:CanvasLinkClient.getState().delivery,acked:CanvasLink.stats.ackedInputs,notice:document.getElementById('stream-error').textContent})"));
  }
  void key(String key)throws Exception{
    int before=Integer.parseInt(test.js("CanvasLink.stats.ackedInputs"));
    test.tap("[data-key="+key+"]");
    until("CanvasLink.stats.ackedInputs>"+before,"Control was not acknowledged: "+key);
    test.waitTerminalKeyboard();
  }
  void text(String value)throws Exception{
    if(!"true".equals(test.js("CanvasLinkInput.active()")))throw new Exception("Direct IME must remain active during terminal editing");
    int before=Integer.parseInt(test.js("CanvasLink.stats.ackedInputs"));test.commitText(value);
    until("CanvasLink.stats.ackedInputs>"+before+"&&CanvasLinkClient.getState().pending===0","Direct text was not acknowledged");
  }
  String quote(String text){return "'"+text.replace("'","'\\''")+"'";}
  void cursorVisible()throws Exception{
    until("(()=>{const c=CanvasLinkClient.getState().source?.caret;if(!c)return false;const e=document.getElementById('video'),r=e.getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect(),k=Math.min(r.width/e.videoWidth,r.height/e.videoHeight),x=r.left+(r.width-e.videoWidth*k)/2+(c.x+c.width/2)*e.videoWidth*k,y=r.top+(r.height-e.videoHeight*k)/2+(c.y+c.height/2)*e.videoHeight*k;return x>v.left&&x<v.right&&y>v.top+8&&y<v.bottom-8;})()","Actual terminal cursor is outside the visible workspace");
  }
  void orientations(Bundle result)throws Exception{
    int previous=MainActivity.active.getRequestedOrientation();
    try{for(int orientation:new int[]{android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE}){
      test.runOnMainSync(()->MainActivity.active.setRequestedOrientation(orientation));
      until(orientation==android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT?"screen.height>screen.width":"screen.width>screen.height","Native orientation not applied");test.waitTerminalKeyboard();cursorVisible();
      until("(()=>{const v=document.getElementById('viewport').getBoundingClientRect(),b=document.getElementById('controls').getBoundingClientRect();return Math.abs(v.height+56-innerHeight)<2&&b.height===56&&new Set([...document.querySelectorAll('#controls button')].map(e=>e.getBoundingClientRect().top)).size===1;})()","Native IME workspace geometry failed");
      test.stage(orientation==android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT?"native-real-portrait-ready":"native-real-landscape-ready");android.os.SystemClock.sleep(900);
    }}finally{test.runOnMainSync(()->MainActivity.active.setRequestedOrientation(previous));}
    result.putBoolean("actualCursorAndSingleRowWithRealImeBothOrientations",true);
  }
  void run(String directory,Bundle result)throws Exception{
    if(directory==null||!directory.startsWith("/")||directory.indexOf('\n')>=0)throw new Exception("Owned proof directory required");
    cursorVisible();orientations(result);
    test.stage("native-five-real-retaps");
    for(int i=0;i<5;i++){test.menu("reset-view");test.tap("#video",test.freshNativePoint());test.waitTerminalKeyboard();cursorVisible();}
    result.putInt("realTerminalRetaps",5);
    test.stage("native-control-cancel-and-history");
    text("touch "+quote(directory+"/must-not-exist"));key("c");key("Escape");key("ArrowUp");key("ArrowDown");key("c");
    test.stage("native-control-editing");
    text("printf '%s\\n' > "+quote(directory+"/controls-edit.txt")+" 'OKX'");
    key("ArrowLeft");key("Backspace");key("ArrowRight");key("Enter");
    test.stage("native-control-tab");
    text("cd "+quote(directory)+"; : > canvaslink-tab-proof.txt");key("Enter");
    text("printf '%s\\n' 'TAB' > canvaslink-tab-pro");key("Tab");key("Enter");
    test.stage("native-control-no-duplicate-enter");
    for(int i=1;i<=5;i++){text("printf '%s\\n' '"+i+"' >> "+quote(directory+"/controls-once.txt"));key("Enter");}
    test.stage("native-direct-composition-paste");
    text("printf '%s\\n' '");
    final android.content.ClipData[] oldClip={null};
    boolean[] direct={false},clipboardChanged={false};try{test.runOnMainSync(()->{
      android.view.inputmethod.InputConnection input=MainActivity.active.web.onCreateInputConnection(new android.view.inputmethod.EditorInfo());
      direct[0]=input!=null&&input.setComposingText("日本X",1)&&input.deleteSurroundingText(1,0)&&input.commitText("日本語🙂X",1)&&input.finishComposingText()&&input.deleteSurroundingText(1,0);
      android.content.ClipboardManager clipboard=(android.content.ClipboardManager)MainActivity.active.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
      oldClip[0]=clipboard.getPrimaryClip();
      clipboard.setPrimaryClip(android.content.ClipData.newPlainText("CanvasLink acceptance"," · ёЖ"));
      clipboardChanged[0]=true;
    });
    if(!direct[0])throw new Exception("Native direct composing input failed");
    until("CanvasLinkClient.getState().pending===0","Composition did not finish");test.tap("#paste");
    until("CanvasLinkClient.getState().pending===0","Clipboard input did not finish");
    test.runOnMainSync(()->((android.content.ClipboardManager)MainActivity.active.getSystemService(android.content.Context.CLIPBOARD_SERVICE)).setPrimaryClip(android.content.ClipData.newPlainText("CanvasLink acceptance","a")));
    test.tap("#ctrl");test.tap("#paste");until("CanvasLinkClient.getState().pending===0","Literal one-letter paste did not finish");
    }finally{if(clipboardChanged[0])test.runOnMainSync(()->{android.content.ClipboardManager c=(android.content.ClipboardManager)MainActivity.active.getSystemService(android.content.Context.CLIPBOARD_SERVICE);if(oldClip[0]!=null)c.setPrimaryClip(oldClip[0]);else if(android.os.Build.VERSION.SDK_INT>=28)c.clearPrimaryClip();});}
    result.putBoolean("literalClipboardWithLatchedCtrl",true);
    text("' > "+quote(directory+"/controls-direct.txt"));
    test.runOnMainSync(()->MainActivity.active.web.onCreateInputConnection(new android.view.inputmethod.EditorInfo()).performEditorAction(android.view.inputmethod.EditorInfo.IME_ACTION_NONE));
    until("CanvasLinkClient.getState().pending===0","Native IME Enter did not finish");
    result.putBoolean("directCompositionUnicodeBackspaceClipboardImeEnter",true);
    test.stage("native-physical-ime-key");text("printf '%s\\n' '");
    test.runOnMainSync(()->((android.view.inputmethod.InputMethodManager)MainActivity.active.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).restartInput(MainActivity.active.web));
    test.waitTerminalKeyboard();test.stage("native-physical-ime-key-ready");android.os.SystemClock.sleep(800);
    android.accessibilityservice.AccessibilityServiceInfo info=test.getUiAutomation().getServiceInfo();info.flags|=android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;test.getUiAutomation().setServiceInfo(info);
    android.graphics.Rect keyRect=null;StringBuilder labels=new StringBuilder();
    for(android.view.accessibility.AccessibilityWindowInfo window:test.getUiAutomation().getWindows())if(window.getType()==android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD){keyRect=findImeKey(window.getRoot(),"a",labels);if(keyRect!=null)break;}
    if(keyRect==null){result.putString("imeKeyLabels",labels.toString());throw new Exception("Real keyboard letter a not exposed; inspect IME-only labels");}
    long at=android.os.SystemClock.uptimeMillis();for(int action:new int[]{android.view.MotionEvent.ACTION_DOWN,android.view.MotionEvent.ACTION_UP}){android.view.MotionEvent e=android.view.MotionEvent.obtain(at,android.os.SystemClock.uptimeMillis(),action,keyRect.centerX(),keyRect.centerY(),0);e.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);if(!test.getUiAutomation().injectInputEvent(e,true))throw new Exception("IME key touch rejected");e.recycle();android.os.SystemClock.sleep(80);}
    android.os.SystemClock.sleep(400);text("' > "+quote(directory+"/controls-ime-key.txt"));key("Enter");result.putBoolean("physicalKeyboardKeyTouched",true);
    result.putBoolean("nativeToolbarControlsAcknowledged",true);
    result.putInt("nativeSingleEnterCommands",5);
  }
  android.graphics.Rect findImeKey(android.view.accessibility.AccessibilityNodeInfo node,String wanted,StringBuilder labels){
    if(node==null)return null;String text=node.getText()==null?"":node.getText().toString(),desc=node.getContentDescription()==null?"":node.getContentDescription().toString();
    if(labels.length()<1500&&(!text.isEmpty()||!desc.isEmpty()))labels.append('[').append(text).append('|').append(desc).append(']');
    android.graphics.Rect r=new android.graphics.Rect();node.getBoundsInScreen(r);if(node.isVisibleToUser()&&!r.isEmpty()&&(wanted.equalsIgnoreCase(text)||wanted.equalsIgnoreCase(desc)))return r;
    for(int i=0;i<node.getChildCount();i++){android.graphics.Rect found=findImeKey(node.getChild(i),wanted,labels);if(found!=null)return found;}return null;
  }
}
