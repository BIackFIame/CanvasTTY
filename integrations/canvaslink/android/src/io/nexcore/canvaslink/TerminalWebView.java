package io.nexcore.canvaslink;

import android.content.Context;
import android.text.Editable;
import android.text.Selection;
import android.text.SpannableStringBuilder;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import org.json.*;

/** A terminal IME endpoint, not a second user-facing text editor.
 * Only composing text is local. Committed text is emitted once, then forgotten;
 * reconnect and restart can never replay an already committed terminal buffer.
 */
final class TerminalWebView extends WebView {
  private String token="";
  private TerminalConnection connection;
  TerminalWebView(Context context){super(context);}
  private InputMethodManager ime(){return (InputMethodManager)getContext().getSystemService(Context.INPUT_METHOD_SERVICE);}
  void openTerminal(String next){
    if(!next.matches("[A-Za-z0-9-]{1,80}"))return;
    requestFocus();
    if(!token.equals(next)){token=next;connection=null;ime().restartInput(this);}
    showTerminal(next);postDelayed(()->showTerminal(next),150);postDelayed(()->showTerminal(next),350);
  }
  private void showTerminal(String owner){if(owner.equals(token)&&!owner.isEmpty()){requestFocus();ime().showSoftInput(this,InputMethodManager.SHOW_IMPLICIT);}}
  void closeTerminal(){token="";connection=null;ime().hideSoftInputFromWindow(getWindowToken(),0);ime().restartInput(this);}
  boolean terminalActive(){return !token.isEmpty();}
  @Override public boolean onTouchEvent(MotionEvent event){
    String owner=token;boolean handled=super.onTouchEvent(event);
    // Blink dismisses its DOM keyboard when a toolbar button is touched. Our
    // terminal input connection still owns focus, so keep the terminal IME up.
    // Menu/explicit hide invalidates owner before this delayed callback runs.
    if(event.getActionMasked()==MotionEvent.ACTION_UP&&!owner.isEmpty())postDelayed(()->showTerminal(owner),150);
    return handled;
  }
  private void event(JSONObject value){
    if(token.isEmpty())return;
    try{value.put("token",token);}catch(JSONException ignored){}
    evaluateJavascript("window.CanvasLinkInput&&window.CanvasLinkInput.receive("+value.toString()+")",null);
  }
  private void text(String value){if(value.isEmpty())return;try{event(new JSONObject().put("type","text").put("text",value));}catch(JSONException ignored){}}
  void key(String key,String modifiers){
    if(connection!=null)connection.finishComposingText();
    try{event(new JSONObject().put("type","key").put("key",key).put("modifiers",new JSONArray(modifiers)));}catch(JSONException ignored){}
  }
  void paste(String value){
    if(value.isEmpty()){try{event(new JSONObject().put("type","notice").put("text","Буфер обмена пуст"));}catch(JSONException ignored){}return;}
    if(value.length()>8000){try{event(new JSONObject().put("type","notice").put("text","В буфере больше 8000 символов"));}catch(JSONException ignored){}return;}
    if(connection!=null)connection.finishComposingText();
    try{event(new JSONObject().put("type","paste").put("text",value));}catch(JSONException ignored){}
  }
  @Override public boolean onCheckIsTextEditor(){return terminalActive()||super.onCheckIsTextEditor();}
  @Override public InputConnection onCreateInputConnection(EditorInfo out){
    if(!terminalActive())return super.onCreateInputConnection(out);
    out.inputType=InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS|InputType.TYPE_TEXT_FLAG_MULTI_LINE;
    out.imeOptions=EditorInfo.IME_FLAG_NO_EXTRACT_UI|EditorInfo.IME_FLAG_NO_FULLSCREEN|EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING|EditorInfo.IME_ACTION_NONE;
    out.initialSelStart=out.initialSelEnd=0;
    return connection=new TerminalConnection(token);
  }
  private boolean hardware(KeyEvent e){
    if(!terminalActive()||e.getKeyCode()==KeyEvent.KEYCODE_BACK)return false;
    String k=null;
    switch(e.getKeyCode()){
      case KeyEvent.KEYCODE_ENTER:k="Enter";break;case KeyEvent.KEYCODE_DEL:k="Backspace";break;
      case KeyEvent.KEYCODE_FORWARD_DEL:k="Delete";break;case KeyEvent.KEYCODE_TAB:k="Tab";break;
      case KeyEvent.KEYCODE_ESCAPE:k="Escape";break;case KeyEvent.KEYCODE_DPAD_LEFT:k="ArrowLeft";break;
      case KeyEvent.KEYCODE_DPAD_RIGHT:k="ArrowRight";break;case KeyEvent.KEYCODE_DPAD_UP:k="ArrowUp";break;
      case KeyEvent.KEYCODE_DPAD_DOWN:k="ArrowDown";break;case KeyEvent.KEYCODE_MOVE_HOME:k="Home";break;
      case KeyEvent.KEYCODE_MOVE_END:k="End";break;case KeyEvent.KEYCODE_PAGE_UP:k="PageUp";break;
      case KeyEvent.KEYCODE_PAGE_DOWN:k="PageDown";break;
    }
    int code=e.getUnicodeChar();
    if(k==null&&code==0)return false;
    if(e.getAction()!=KeyEvent.ACTION_DOWN)return true;
    JSONArray mods=new JSONArray();if(e.isCtrlPressed())mods.put("control");if(e.isAltPressed())mods.put("alt");if(e.isShiftPressed())mods.put("shift");if(e.isMetaPressed())mods.put("meta");
    if(k!=null)key(k,mods.toString());
    else if(e.isCtrlPressed()||e.isMetaPressed()){
      int base=e.getUnicodeChar(0);if(base>0)key(new String(Character.toChars(base)).toLowerCase(java.util.Locale.ROOT),mods.toString());
    }else if(code>0&&code<=Character.MAX_CODE_POINT){if(connection!=null)connection.finishComposingText();text(new String(Character.toChars(code)));}
    return true;
  }
  @Override public boolean dispatchKeyEvent(KeyEvent e){return hardware(e)||super.dispatchKeyEvent(e);}
  @Override public boolean onKeyPreIme(int code,KeyEvent event){
    if(code==KeyEvent.KEYCODE_BACK&&terminalActive()){
      if(event.getAction()==KeyEvent.ACTION_UP){closeTerminal();evaluateJavascript("window.CanvasLinkInput&&window.CanvasLinkInput.stop()",null);}
      return true;
    }
    return super.onKeyPreIme(code,event);
  }
  private final class TerminalConnection extends BaseInputConnection {
    final String owner;final Editable composing=new SpannableStringBuilder();
    TerminalConnection(String owner){super(TerminalWebView.this,true);this.owner=owner;Selection.setSelection(composing,0);}
    private boolean valid(){return connection==this&&owner.equals(token)&&!token.isEmpty();}
    @Override public Editable getEditable(){return composing;}
    private void preedit(){try{event(new JSONObject().put("type","composition").put("text",composing.toString()));}catch(JSONException ignored){}ime().updateSelection(TerminalWebView.this,Selection.getSelectionStart(composing),Selection.getSelectionEnd(composing),getComposingSpanStart(composing),getComposingSpanEnd(composing));}
    private void clear(){composing.clear();Selection.setSelection(composing,0);preedit();}
    @Override public boolean setComposingText(CharSequence value,int cursor){if(!valid())return false;super.setComposingText(value,cursor);preedit();return true;}
    @Override public boolean commitText(CharSequence value,int cursor){if(!valid())return false;String committed=value.toString();clear();if("\n".equals(committed))key("Enter","[]");else text(committed);return true;}
    @Override public boolean finishComposingText(){if(!valid())return false;String value=composing.toString();super.finishComposingText();clear();text(value);return true;}
    @Override public boolean deleteSurroundingText(int before,int after){
      if(!valid()||before<0||after<0||before>8000||after>8000)return false;
      if(composing.length()>0){int cursor=Math.max(0,Selection.getSelectionEnd(composing));int from=Math.max(0,cursor-before),to=Math.min(composing.length(),cursor+after);composing.delete(from,to);Selection.setSelection(composing,from);preedit();return true;}
      for(int i=0;i<before;i++)key("Backspace","[]");for(int i=0;i<after;i++)key("Delete","[]");return true;
    }
    @Override public boolean deleteSurroundingTextInCodePoints(int before,int after){
      if(!valid()||before<0||after<0||before>8000||after>8000)return false;
      if(composing.length()==0)return deleteSurroundingText(before,after);
      int cursor=Math.max(0,Selection.getSelectionEnd(composing));
      int left=Character.codePointCount(composing,0,cursor),right=Character.codePointCount(composing,cursor,composing.length());
      int from=Character.offsetByCodePoints(composing,cursor,-Math.min(before,left)),to=Character.offsetByCodePoints(composing,cursor,Math.min(after,right));
      composing.delete(from,to);Selection.setSelection(composing,from);preedit();return true;
    }
    @Override public boolean sendKeyEvent(KeyEvent event){return valid()&&hardware(event);}
    @Override public boolean performEditorAction(int action){if(!valid())return false;key("Enter","[]");return true;}
    @Override public boolean performContextMenuAction(int action){
      if(!valid()||action!=android.R.id.paste)return false;
      android.content.ClipboardManager clipboard=(android.content.ClipboardManager)getContext().getSystemService(Context.CLIPBOARD_SERVICE);
      if(clipboard.hasPrimaryClip()&&clipboard.getPrimaryClip().getItemCount()>0){CharSequence value=clipboard.getPrimaryClip().getItemAt(0).coerceToText(getContext());if(value!=null)paste(value.toString());}return true;
    }
  }
}
