package io.nexcore.canvaslink;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;

/** SRP-6a/SHA-256 interoperability with secure-remote-password 0.3.1.
 * Fixed RFC 5054 2048-bit group. PIN is never sent to the network. */
public final class Srp {
  static final String PRIME = "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC319294"
    + "3DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310D"
    + "CD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FB"
    + "D5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF74"
    + "7359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A"
    + "436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D"
    + "5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E73"
    + "03CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6"
    + "94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73";
  static final BigInteger N = new BigInteger(PRIME, 16), G = BigInteger.valueOf(2);
  static final String USER = "CanvasLink/v1";
  final BigInteger secret, publicValue;
  public Srp() { byte[] a = new byte[32]; new SecureRandom().nextBytes(a); secret = new BigInteger(1, a); publicValue = G.modPow(secret, N); }
  Srp(String fixedSecret) { secret = new BigInteger(fixedSecret, 16); publicValue = G.modPow(secret, N); }
  public String publicHex() { return hex(pad(publicValue, 256)); }
  public static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }
  public static byte[] hash(byte[]... values) {
    try { MessageDigest d = MessageDigest.getInstance("SHA-256"); for (byte[] v : values) d.update(v); return d.digest(); }
    catch (Exception e) { throw new IllegalStateException(e); }
  }
  public static String hex(byte[] value) { StringBuilder s = new StringBuilder(); for (byte b : value) s.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return s.toString(); }
  public static byte[] bytes(String value) {
    if (value == null || !value.matches("[0-9a-fA-F]+") || value.length() % 2 != 0) throw new IllegalArgumentException("Invalid hex");
    byte[] out = new byte[value.length() / 2]; for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(value.substring(i*2, i*2+2), 16); return out;
  }
  static byte[] pad(BigInteger value, int length) {
    byte[] raw = value.toByteArray(), out = new byte[length];
    int count = Math.min(length, raw.length); System.arraycopy(raw, raw.length-count, out, length-count, count); return out;
  }
  public Session derive(String pin, String saltHex, String serverHex) {
    if (!pin.matches("[0-9]{6}") || !saltHex.matches("[0-9a-f]{64}") || !serverHex.matches("[0-9a-f]{512}")) throw new IllegalArgumentException("Invalid SRP challenge");
    byte[] salt = bytes(saltHex), a = pad(publicValue, 256), b = bytes(serverHex), n = bytes(PRIME), g = {2};
    BigInteger B = new BigInteger(1, b);
    if (B.mod(N).equals(BigInteger.ZERO)) throw new IllegalArgumentException("Invalid server ephemeral");
    BigInteger k = new BigInteger(1, hash(n, g));
    BigInteger x = new BigInteger(1, hash(salt, hash(utf8(USER + ":" + pin))));
    BigInteger u = new BigInteger(1, hash(a, b));
    if (u.equals(BigInteger.ZERO)) throw new IllegalArgumentException("Invalid scrambling parameter");
    BigInteger S = B.subtract(k.multiply(G.modPow(x, N))).mod(N).modPow(secret.add(u.multiply(x)), N);
    byte[] K = hash(pad(S, 256)), xor = hash(n), hg = hash(g);
    for (int i=0; i<xor.length; i++) xor[i] ^= hg[i];
    byte[] proof = hash(xor, hash(utf8(USER)), salt, a, b, K);
    return new Session(hash(K, utf8("CanvasLink/channel/1")), proof, hash(a, proof, K));
  }
  public static final class Session {
    public final byte[] channelKey, proof, serverProof;
    Session(byte[] k, byte[] p, byte[] s) { channelKey=k; proof=p; serverProof=s; }
    public void verify(String proofHex) { if (!MessageDigest.isEqual(serverProof, bytes(proofHex))) throw new SecurityException("Неверный код или неподтверждённый компьютер"); }
  }
}
