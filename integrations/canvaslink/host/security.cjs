const crypto = require('node:crypto');
const srp = require('secure-remote-password/server');
const client = require('secure-remote-password/client');

const USER = 'CanvasLink/v1';
const hex = n => crypto.randomBytes(n).toString('hex');
function privateAddress(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (ip === '::1') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const a = ip.split('.').map(Number);
  return a.every(v => v >= 0 && v <= 255) &&
    (a[0] === 127 || a[0] === 10 || (a[0] === 192 && a[1] === 168) ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 169 && a[1] === 254));
}
function seal(key, id, seq, direction, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`CanvasLink/1/${id}/${seq}/${direction}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return { id, seq, iv: iv.toString('hex'), data: data.toString('base64') };
}
function open(key, id, packet, direction) {
  if (!packet || packet.id !== id || !Number.isSafeInteger(packet.seq) || packet.seq < 1 ||
      !/^[0-9a-f]{24}$/.test(packet.iv) || typeof packet.data !== 'string' || packet.data.length > 131072 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.data)) throw Error('invalid-packet');
  const data = Buffer.from(packet.data, 'base64');
  if (data.length < 17) throw Error('invalid-packet');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(packet.iv, 'hex'));
  cipher.setAAD(Buffer.from(`CanvasLink/1/${id}/${packet.seq}/${direction}`));
  cipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString());
}
class Pairing {
  constructor({ now = Date.now, onPair = () => {}, onRevoke = () => {} } = {}) {
    this.now = now; this.onPair = onPair; this.onRevoke = onRevoke;
    this.sessions = new Map(); this.rotate();
  }
  rotate() {
    for (const id of this.sessions.keys()) this.onRevoke(id);
    this.sessions.clear(); this.pending = new Map(); this.attempts = 0; this.starts = 0;
    this.pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.expires = this.now() + 120000;
    this.salt = client.generateSalt();
    this.verifier = client.deriveVerifier(client.derivePrivateKey(this.salt, USER, this.pin));
  }
  start(body, address) {
    if (this.now() >= this.expires || this.attempts >= 5 || this.starts >= 30) throw Error('pairing-closed');
    if (!body || !/^[0-9a-f]{512}$/.test(body.A) || typeof body.name !== 'string' || body.name.length > 80)
      throw Error('invalid-pairing');
    if (BigInt('0x' + body.A) === 0n) throw Error('invalid-pairing');
    this.starts++;
    const id = hex(16), ephemeral = srp.generateEphemeral(this.verifier);
    this.pending.set(id, { ...ephemeral, A: body.A, name: body.name.replace(/[\x00-\x1f]/g, ''), address, until: this.now() + 30000 });
    return { id, salt: this.salt, B: ephemeral.public, user: USER };
  }
  finish(body, address) {
    const p = this.pending.get(body?.id);
    if (p) this.pending.delete(body.id);
    if (!p || p.address !== address || this.now() >= p.until || this.now() >= this.expires || this.attempts >= 5)
      throw Error('pairing-closed');
    this.attempts++;
    if (!/^[0-9a-f]{64}$/.test(body.proof)) throw Error('invalid-proof');
    const result = srp.deriveSession(p.secret, p.A, this.salt, USER, this.verifier, body.proof);
    const key = crypto.createHash('sha256').update(Buffer.from(result.key, 'hex')).update('CanvasLink/channel/1').digest();
    const id = hex(16);
    this.expires = 0; this.pending.clear(); this.pin = '';
    const session = { id, key, name: p.name, address, incoming: 0, outgoing: 0, expires: this.now() + 12 * 3600000, queue: [] };
    this.sessions.set(id, session); this.onPair(session);
    return { id, proof: result.proof };
  }
  receive(packet, address, handle) {
    const session = this.sessions.get(packet?.id);
    if (!session || session.expires <= this.now() || session.address !== address || packet.seq <= session.incoming)
      throw Error('unauthorized');
    const value = open(session.key, session.id, packet, 'request');
    session.incoming = packet.seq; // Authenticated requests are consumed once, including rejected operations.
    const result = handle(session, value);
    return seal(session.key, session.id, packet.seq, 'response', result);
  }
  queue(id, message) {
    const session = this.sessions.get(id);
    if (session && session.queue.length < 16) session.queue.push(message);
  }
}
module.exports = { USER, hex, privateAddress, seal, open, Pairing };
