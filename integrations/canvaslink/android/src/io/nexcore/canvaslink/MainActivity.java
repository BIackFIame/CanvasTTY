package io.nexcore.canvaslink;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.LinkProperties;
import android.net.RouteInfo;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.webkit.*;
import android.view.WindowManager;
import android.util.Log;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.*;
import javax.crypto.spec.*;

public final class MainActivity extends Activity {
  static volatile MainActivity active;
  WebView web;
  private final ScheduledExecutorService network = Executors.newSingleThreadScheduledExecutor();
  private final SecureRandom random = new SecureRandom();
  private NsdManager nsd; private NsdManager.DiscoveryListener discovery;
  private WifiManager.MulticastLock multicast;
  private final Map<String,String> found = new HashMap<>();
  private final ArrayDeque<NsdServiceInfo> resolving = new ArrayDeque<>();
  private final android.os.Handler ui = new android.os.Handler(android.os.Looper.getMainLooper());
  private boolean resolveBusy=false; private int discoveryEpoch=0;
  private final ExecutorService storage=Executors.newSingleThreadExecutor();
  private SessionVault drafts;
  private String base, id; private byte[] key; private long sent=0, received=0;
  private long reserved=0; private SessionVault vault;
  private ScheduledFuture<?> polling; private int errors=0; private long networkFailureAt=0;
  private ConnectivityManager connectivity; private ConnectivityManager.NetworkCallback localNetworks;
  private volatile Network localNetwork; private String localAddresses=""; private volatile boolean destroyed=false;
  volatile String acceptance = "", diagnostics = "{}";
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    connectivity=(ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);
    watchLocalNetworks();
    getWindow().setStatusBarColor(0xff353442); getWindow().setNavigationBarColor(0xff353442);
    web = new TerminalWebView(this); setContentView(web);
    web.setBackgroundColor(0xff353442);
    WebSettings s=web.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(false);
    s.setAllowFileAccess(false); s.setAllowContentAccess(false); s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    s.setMediaPlaybackRequiresUserGesture(false); s.setSupportZoom(false);
    web.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage m) {
        if (m.messageLevel()==ConsoleMessage.MessageLevel.ERROR) Log.e("CanvasLink", "Web client error at line " + m.lineNumber());
        return true;
      }
      @Override public void onPermissionRequest(PermissionRequest r) { r.deny(); }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        android.net.Uri u=request.getUrl();
        if (!"https".equals(u.getScheme()) || !"appassets.androidplatform.net".equals(u.getHost()) || !u.getPath().startsWith("/client/")) return blocked();
        String file=u.getPath().substring(8);
        if (!Arrays.asList("index.html","client.js","style.css","delivery.js","transport.js","gestures.js","direct-input.js","onest.ttf").contains(file)) return blocked();
        try { return new WebResourceResponse(file.endsWith(".js")?"application/javascript":file.endsWith(".css")?"text/css":file.endsWith(".ttf")?"font/ttf":"text/html", "UTF-8", getAssets().open(file)); }
        catch(Exception e) { return blocked(); }
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
    });
    web.addJavascriptInterface(new Bridge(), "Native");
    web.loadUrl("https://appassets.androidplatform.net/client/index.html");
    nsd=(NsdManager)getSystemService(NSD_SERVICE);
    vault=new SessionVault(this);drafts=new SessionVault(this,"draft");
    synchronized(MainActivity.class){active=this;}
  }
  private static WebResourceResponse blocked() { return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",Collections.emptyMap(),new ByteArrayInputStream(new byte[0])); }
  private void emit(String type, Object value) {
    if(destroyed)return;
    JSONObject event=new JSONObject(); try { event.put("type",type); event.put("value",value); }catch(JSONException ignored){}
    runOnUiThread(() -> {if(!destroyed)web.evaluateJavascript("window.CanvasLink&&window.CanvasLink.receive("+event.toString()+")",null);});
  }
  private void watchLocalNetworks(){
    localNetworks=new ConnectivityManager.NetworkCallback(){
      private void refresh(){if(!destroyed)network.execute(()->{if(base==null||id==null)return;try{selectLocalNetwork(new URL(base));}catch(Exception e){emit("network",e.getMessage());}});}
      @Override public void onAvailable(Network value){refresh();}
      @Override public void onCapabilitiesChanged(Network value,NetworkCapabilities capabilities){refresh();}
      @Override public void onLinkPropertiesChanged(Network value,LinkProperties properties){refresh();}
      @Override public void onLost(Network value){if(value.equals(localNetwork))emit("network-changed","offline");refresh();}
    };
    try{connectivity.registerNetworkCallback(localNetworkRequest(),localNetworks,ui);}
    catch(SecurityException e){localNetworks=null;}
  }
  private NetworkRequest localNetworkRequest(){
    return new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET).addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build();
  }
  private synchronized Network selectLocalNetwork(URL url) throws Exception {
    if(destroyed)throw new IOException("Приложение закрыто");
    InetAddress address=InetAddress.getByName(url.getHost());
    if(address.isLoopbackAddress())return null;
    Network selected=null,fallback=null;String addresses="",fallbackAddresses="";int prefix=0,fallbacks=0;
    for(Network candidate:connectivity.getAllNetworks()){
      NetworkCapabilities capabilities=connectivity.getNetworkCapabilities(candidate);
      if(capabilities==null||!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)||
        !(capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)||capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)))continue;
      LinkProperties properties=connectivity.getLinkProperties(candidate);if(properties==null)continue;
      boolean defaultRoute=false;
      for(RouteInfo route:properties.getRoutes()){
        int bits=route.getDestination().getPrefixLength();
        if(bits==0&&route.getDestination().getAddress() instanceof Inet4Address)defaultRoute=true;
        if(bits>0&&(bits>prefix||bits==prefix&&candidate.equals(localNetwork))&&route.getDestination().contains(address)){
          selected=candidate;prefix=bits;addresses=properties.getLinkAddresses().toString();
        }
      }
      if(defaultRoute){fallbacks++;fallback=candidate;fallbackAddresses=properties.getLinkAddresses().toString();}
    }
    // A sole physical LAN can reach a neighbouring private subnet via its router.
    if(selected==null&&fallbacks==1){selected=fallback;addresses=fallbackAddresses;}
    if(selected==null){
      if(localNetwork!=null){localNetwork=null;emit("network-changed","offline");}
      // Keep the old process binding on loss: never fall back to cellular/VPN.
      throw new IOException("Нет локального маршрута к ПК. Подключите устройства к одной сети Wi-Fi и разрешите доступ к локальной сети в VPN.");
    }
    if(!selected.equals(localNetwork)||!addresses.equals(localAddresses)){
      if(localNetwork!=null)emit("network-changed","offline");
      try{synchronized(MainActivity.class){if(destroyed||active!=this||!connectivity.bindProcessToNetwork(selected))throw new SecurityException();}}
      catch(SecurityException e){throw new IOException("Не удалось выбрать локальную сеть. Разрешите CanvasLink доступ к локальной сети в настройках VPN.",e);}
      localNetwork=selected;localAddresses=addresses;
      // WebRTC runs in WebView; process binding is best effort for its sockets.
      if(id!=null)emit("network-changed","ready");
    }
    return selected;
  }
  private String localBase(String host) throws Exception {
    if (!host.matches("[0-9.]+:[0-9]{1,5}")) throw new Exception("Нужен локальный IPv4-адрес и порт");
    String[] hp=host.split(":"); String[] parts=hp[0].split("\\.");
    if(parts.length!=4) throw new Exception("Неверный адрес");
    int[] a=new int[4]; for(int i=0;i<4;i++){a[i]=Integer.parseInt(parts[i]); if(a[i]<0||a[i]>255)throw new Exception("Неверный адрес");}
    boolean local=a[0]==10||a[0]==127||(a[0]==192&&a[1]==168)||(a[0]==172&&a[1]>=16&&a[1]<=31)||(a[0]==169&&a[1]==254);
    int p=Integer.parseInt(hp[1]); if(!local||p<1024||p>65535) throw new Exception("Разрешена только локальная сеть");
    return "http://"+hp[0]+":"+p;
  }
  private JSONObject post(String route, JSONObject payload) throws Exception {
    URL url=new URL(base+route);Network selected=selectLocalNetwork(url);
    HttpURLConnection c=(HttpURLConnection)(selected==null?url.openConnection(Proxy.NO_PROXY):selected.openConnection(url,Proxy.NO_PROXY));
    c.setConnectTimeout(4000);c.setReadTimeout(5000);c.setInstanceFollowRedirects(false);
    c.setRequestMethod("POST");c.setRequestProperty("Content-Type","application/json");c.setDoOutput(true);
    byte[] bytes=payload.toString().getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(bytes.length);
    try {
      try(OutputStream out=c.getOutputStream()){out.write(bytes);}
      if(c.getResponseCode()!=200) throw new Exception("Компьютер отклонил подключение. Проверьте код и срок его действия.");
      try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
        byte[] buffer=new byte[4096];int n;while((n=in.read(buffer))!=-1){out.write(buffer,0,n);if(out.size()>150000)throw new Exception("Ответ слишком большой");}
        return new JSONObject(out.toString("UTF-8"));
      }
    }catch(IOException e){throw new IOException("Нет связи с ПК по локальной сети. Проверьте Wi-Fi и разрешение локальных подключений в VPN.",e);}
    finally{c.disconnect();}
  }
  private JSONObject exchange(JSONObject value) throws Exception {
    if(id==null||key==null)throw new Exception("Нет сопряжения");
    if(sent+1>=reserved)reserve();
    long seq=++sent;byte[] iv=new byte[12];random.nextBytes(iv);
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));
    cipher.updateAAD(Srp.utf8("CanvasLink/1/"+id+"/"+seq+"/request"));
    JSONObject packet=new JSONObject().put("id",id).put("seq",seq).put("iv",Srp.hex(iv))
      .put("data",android.util.Base64.encodeToString(cipher.doFinal(Srp.utf8(value.toString())),android.util.Base64.NO_WRAP));
    JSONObject response=post("/channel",packet);
    long next=response.getLong("seq");if(!id.equals(response.getString("id"))||next!=seq||next<=received)throw new SecurityException("Повторный или неподтверждённый ответ");
    String nonce=response.getString("iv");if(!nonce.matches("[0-9a-f]{24}"))throw new SecurityException("Неверный пакет");
    cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,Srp.bytes(nonce)));
    cipher.updateAAD(Srp.utf8("CanvasLink/1/"+id+"/"+next+"/response"));
    byte[] plain=cipher.doFinal(android.util.Base64.decode(response.getString("data"),android.util.Base64.NO_WRAP));
    received=next;return new JSONObject(new String(plain,StandardCharsets.UTF_8));
  }
  private void connect(String host,String pin){
    network.execute(()->{try{
      if(polling!=null)polling.cancel(false);id=null;key=null;
      base=localBase(host);if(!pin.matches("[0-9]{6}"))throw new Exception("Введите шесть цифр");
      Srp srp=new Srp();
      JSONObject challenge=post("/pair/start",new JSONObject().put("A",srp.publicHex()).put("name",(Build.MANUFACTURER+" "+Build.MODEL)));
      if(!Srp.USER.equals(challenge.getString("user")))throw new SecurityException("Неверный протокол");
      Srp.Session result=srp.derive(pin,challenge.getString("salt"),challenge.getString("B"));
      JSONObject finish=post("/pair/finish",new JSONObject().put("id",challenge.getString("id")).put("proof",Srp.hex(result.proof)));
      result.verify(finish.getString("proof"));
      String nextId=finish.getString("id");if(!nextId.matches("[0-9a-f]{32}"))throw new SecurityException("Неверный идентификатор");
      id=nextId;key=result.channelKey;sent=0;received=0;reserved=0;errors=0;reserve();
      emit("paired",new JSONObject().put("host",host));
      runOnUiThread(()->getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
      startPolling();
    }catch(Exception e){emit("error",e.getMessage());}});
  }
  private void reserve() throws Exception {
    reserved=sent+10000;
    vault.save(new JSONObject().put("host",base.substring(7)).put("id",id).put("key",Srp.hex(key)).put("counter",reserved));
  }
  private void startPolling(){
      if(polling!=null)polling.cancel(false);
      networkFailureAt=0;errors=0;
      polling=network.scheduleWithFixedDelay(()->{try{
        JSONObject response=exchange(new JSONObject().put("type","poll"));boolean recovered=errors>0;errors=0;networkFailureAt=0;
        if(recovered)emit("network-restored",true);
        JSONArray messages=response.getJSONArray("messages");for(int i=0;i<messages.length();i++)emit("signal",messages.getJSONObject(i));
      }catch(Exception e){errors++;if(errors==1){networkFailureAt=android.os.SystemClock.elapsedRealtime();emit("network", "Связь прервана, повторная попытка…");}if(android.os.SystemClock.elapsedRealtime()-networkFailureAt>=60000){polling.cancel(false);vault.clear();id=null;key=null;emit("disconnected",true);emit("error","Соединение потеряно. Создайте новый код на компьютере.");}}},0,200,TimeUnit.MILLISECONDS);
  }
  public final class Bridge {
    @JavascriptInterface public boolean saveDraft(String text){if(text.length()>8000)return false;try{synchronized(drafts){drafts.save(new JSONObject().put("text",text));}return true;}catch(Exception e){emit("error","Не удалось сохранить черновик");return false;}}
    @JavascriptInterface public void loadDraft(){storage.execute(()->{try{JSONObject saved=drafts.load();emit("draft",saved==null?"":saved.optString("text"));}catch(Exception ignored){}});}
    @JavascriptInterface public void showKeyboard(String token){runOnUiThread(()->((TerminalWebView)web).openTerminal(token));}
    @JavascriptInterface public void terminalKey(String key,String modifiers){runOnUiThread(()->((TerminalWebView)web).key(key,modifiers));}
    @JavascriptInterface public void paste(){runOnUiThread(()->{android.content.ClipboardManager clipboard=(android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);if(clipboard.hasPrimaryClip()&&clipboard.getPrimaryClip().getItemCount()>0){CharSequence value=clipboard.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);((TerminalWebView)web).paste(value==null?"":value.toString());}else ((TerminalWebView)web).paste("");});}
    @JavascriptInterface public void hideKeyboard(){runOnUiThread(()->((TerminalWebView)web).closeTerminal());}
    @JavascriptInterface public void connect(String host,String pin){MainActivity.this.connect(host,pin);}
    @JavascriptInterface public void signal(String json){
      if(json.length()>90000)return;
      network.execute(()->{try{exchange(new JSONObject().put("type","signal").put("message",new JSONObject(json)));}catch(Exception e){emit("error",e.getMessage());}});
    }
    @JavascriptInterface public void discover(){runOnUiThread(()->startDiscovery());}
    @JavascriptInterface public void restore(){network.execute(()->{try{
      JSONObject saved=vault.load();if(saved==null)return;
      base=localBase(saved.getString("host"));id=saved.getString("id");key=Srp.bytes(saved.getString("key"));
      if(!id.matches("[0-9a-f]{32}")||key.length!=32)throw new Exception("Invalid saved pairing");
      sent=saved.getLong("counter");received=0;reserve();
      exchange(new JSONObject().put("type","signal").put("message",new JSONObject().put("type","ping")));
      emit("paired",new JSONObject().put("host",saved.getString("host")));startPolling();
      runOnUiThread(()->getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
    }catch(Exception e){vault.clear();id=null;key=null;emit("network","Введите новый код подключения на компьютере.");}});}
    @JavascriptInterface public void disconnect(){network.execute(()->{try{exchange(new JSONObject().put("type","revoke"));}catch(Exception ignored){} if(polling!=null)polling.cancel(false);id=null;key=null;vault.clear();emit("disconnected",true);});runOnUiThread(()->getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));}
    @JavascriptInterface public void diagnostics(String json){if(json.length()<2000){diagnostics=json;Log.i("CanvasLink", "STATS "+json);}}
    @JavascriptInterface public void acceptance(String json){if(json.length()<2000)acceptance=json;}
  }
  private void resolveNext(final int epoch){
    if(epoch!=discoveryEpoch||resolveBusy||resolving.isEmpty())return;
    final NsdServiceInfo service=resolving.remove();resolveBusy=true;
    nsd.resolveService(service,new NsdManager.ResolveListener(){
      public void onResolveFailed(NsdServiceInfo s,int c){ui.post(()->{if(epoch!=discoveryEpoch)return;resolveBusy=false;emit("discovery","resolving-failed");ui.postDelayed(()->resolveNext(epoch),500);});}
      public void onServiceResolved(NsdServiceInfo s){ui.post(()->{
        if(epoch!=discoveryEpoch)return;resolveBusy=false;
        try{
          String address=s.getHost().getHostAddress()+":"+s.getPort();
          // Host advertises a private IPv4 hint for API26-32 resolvers that
          // return only one IPv6 address. This is discovery, never authority:
          // localBase and the existing SRP proof remain mandatory.
          byte[] hint=s.getAttributes().get("ipv4");
          if(!(s.getHost() instanceof Inet4Address)&&hint!=null)address=new String(hint,StandardCharsets.UTF_8)+":"+s.getPort();
          localBase(address);found.put(s.getServiceName(),address);
          emit("discovered",new JSONObject().put("id",s.getServiceName()).put("name",s.getServiceName()).put("host",address));
        }catch(Exception e){emit("discovery","unsupported-address");}
        resolveNext(epoch);
      });}
    });
  }
  private void startDiscovery(){
    if(discovery!=null){
      try{nsd.stopServiceDiscovery(discovery);}catch(Exception ignored){}
      discovery=null;discoveryEpoch++;resolving.clear();resolveBusy=false;
      for(String name:found.keySet())emit("lost",name);found.clear();
      ui.postDelayed(()->startDiscovery(),500);return;
    }
    final int epoch=++discoveryEpoch;
    WifiManager wifi=(WifiManager)getApplicationContext().getSystemService(WIFI_SERVICE);
    if(multicast==null){multicast=wifi.createMulticastLock("CanvasLink discovery");multicast.setReferenceCounted(false);}
    if(!multicast.isHeld())multicast.acquire();
    discovery=new NsdManager.DiscoveryListener(){
      public void onDiscoveryStarted(String t){if(epoch==discoveryEpoch)emit("discovery","searching");}
      public void onDiscoveryStopped(String t){}
      public void onStartDiscoveryFailed(String t,int c){ui.post(()->{if(epoch!=discoveryEpoch)return;discovery=null;emit("discovery","unavailable");if(multicast.isHeld())multicast.release();});}
      public void onStopDiscoveryFailed(String t,int c){}
      public void onServiceLost(NsdServiceInfo service){ui.post(()->{if(epoch!=discoveryEpoch)return;found.remove(service.getServiceName());resolving.removeIf(s->s.getServiceName().equals(service.getServiceName()));emit("lost",service.getServiceName());});}
      public void onServiceFound(NsdServiceInfo service){ui.post(()->{if(epoch!=discoveryEpoch||!service.getServiceName().startsWith("CanvasLink "))return;resolving.add(service);resolveNext(epoch);});}
    };
    try{
      if(Build.VERSION.SDK_INT>=33)nsd.discoverServices("_canvaslink._tcp.",NsdManager.PROTOCOL_DNS_SD,localNetworkRequest(),getMainExecutor(),discovery);
      else nsd.discoverServices("_canvaslink._tcp.",NsdManager.PROTOCOL_DNS_SD,discovery);
    }catch(Exception e){discovery=null;emit("discovery","unavailable");}
  }
  @Override protected void onDestroy(){
    synchronized(MainActivity.class){destroyed=true;if(active==this){active=null;connectivity.bindProcessToNetwork(null);}}
    if(localNetworks!=null)try{connectivity.unregisterNetworkCallback(localNetworks);}catch(Exception ignored){}
    if(discovery!=null)try{nsd.stopServiceDiscovery(discovery);}catch(Exception ignored){}
    if(multicast!=null&&multicast.isHeld())multicast.release();
    discoveryEpoch++;ui.removeCallbacksAndMessages(null);storage.shutdown();network.shutdownNow();web.destroy();super.onDestroy();
  }
}
