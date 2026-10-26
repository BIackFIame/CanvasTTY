package io.nexcore.canvaslink;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Pairing credentials are encrypted with an application-scoped Android Keystore key. */
final class SessionVault {
  private final SharedPreferences prefs; private final String name;
  SessionVault(Context context){this(context,"paired-host");}
  SessionVault(Context context,String name){this.name=name;prefs=context.getSharedPreferences(name,Context.MODE_PRIVATE);}
  private SecretKey key() throws Exception {
    KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
    String alias=name.equals("paired-host")?"CanvasLink-session-v1":"CanvasLink-"+name+"-v1";
    if(!store.containsAlias(alias)){
      KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
      generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
      generator.generateKey();
    }
    return (SecretKey)store.getKey(alias,null);
  }
  void save(JSONObject value) throws Exception {
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
    cipher.updateAAD(Srp.utf8(name.equals("paired-host")?"CanvasLink/session/1":"CanvasLink/"+name+"/1"));
    String data=Base64.encodeToString(cipher.doFinal(Srp.utf8(value.toString())),Base64.NO_WRAP);
    if(!prefs.edit().putString("iv",Srp.hex(cipher.getIV())).putString("data",data).commit())throw new Exception("Не удалось сохранить сопряжение");
  }
  JSONObject load() throws Exception {
    String data=prefs.getString("data",null);if(data==null)return null;
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Srp.bytes(prefs.getString("iv",""))));
    cipher.updateAAD(Srp.utf8(name.equals("paired-host")?"CanvasLink/session/1":"CanvasLink/"+name+"/1"));
    return new JSONObject(new String(cipher.doFinal(Base64.decode(data,Base64.NO_WRAP)),"UTF-8"));
  }
  void clear(){prefs.edit().clear().apply();}
}
