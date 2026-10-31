// EVOLVED ZONE · account del gioco (0.37, 31/10/2026)
// Decisione di Michele (30/10): chi gioca su CrazyGames salva con il loro modulo dati; chi vuole tenere lo stesso account
// anche sul nostro sito usa questo account. L'account nasce dall'utente CrazyGames (verificato con la loro chiave pubblica,
// mai fidandosi di quello che dice il browser); sul sito si entra con un codice di 6 caratteri creato dentro il gioco su CrazyGames.
// Tutto sta in un Durable Object con SQLite (piano gratuito di Cloudflare), un'unica istanza "main".
const CG_KEY_URL = 'https://sdk.crazygames.com/publicKey.json';
const MAX_SAVE = 300000, CODE_MIN = 15;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' } });
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const rnd = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
// la chiave di CrazyGames è "RSA PUBLIC KEY" (PKCS#1): la si avvolge in SPKI per WebCrypto
function derLen(n) { if (n < 128) return [n]; const b = []; while (n) { b.unshift(n & 255); n >>= 8; } return [0x80 | b.length, ...b]; }
function pkcs1ToSpki(pk1) {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const bit = [0x03, ...derLen(pk1.length + 1), 0x00, ...pk1];
  const body = [...algo, ...bit];
  return new Uint8Array([0x30, ...derLen(body.length), ...body]);
}
let KEY = null, KEY_T = 0, KEY_URL = CG_KEY_URL;
async function cgKey(force) {
  if (KEY && !force && Date.now() - KEY_T < 6 * 3600e3) return KEY;
  const r = await fetch(KEY_URL); const o = await r.json();
  const pem = o.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  KEY = await crypto.subtle.importKey('spki', pkcs1ToSpki(der), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']); KEY_T = Date.now();
  return KEY;
}
async function verifyCg(token) {
  const p = String(token || '').split('.'); if (p.length !== 3) throw new Error('token');
  const head = JSON.parse(new TextDecoder().decode(b64u(p[0]))); if (head.alg !== 'RS256') throw new Error('alg');
  const data = new TextEncoder().encode(p[0] + '.' + p[1]), sig = b64u(p[2]);
  let ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await cgKey(), sig, data);
  if (!ok) ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await cgKey(true), sig, data);
  if (!ok) throw new Error('firma');
  const pl = JSON.parse(new TextDecoder().decode(b64u(p[1])));
  if (pl.exp && pl.exp * 1000 < Date.now() - 60e3) throw new Error('scaduto');
  if (!pl.userId) throw new Error('utente');
  return pl;
}
export class Accounts {
  constructor(state, env) {
    if (env && env.CG_KEY_URL) KEY_URL = env.CG_KEY_URL; // solo per le prove in locale
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS acc(id TEXT PRIMARY KEY, cg TEXT UNIQUE, name TEXT, save TEXT, t INTEGER, created INTEGER);
      CREATE TABLE IF NOT EXISTS dev(token TEXT PRIMARY KEY, acc TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS code(code TEXT PRIMARY KEY, acc TEXT, exp INTEGER);`);
  }
  one(q, ...a) { const r = this.sql.exec(q, ...a).toArray(); return r[0] || null; }
  async who(b) { // chi è: utente CrazyGames verificato oppure dispositivo del sito con il suo gettone
    if (b.token) {
      const pl = await verifyCg(b.token);
      let a = this.one('SELECT * FROM acc WHERE cg=?', String(pl.userId));
      if (!a) { const id = rnd(8); this.sql.exec('INSERT INTO acc(id,cg,name,save,t,created) VALUES(?,?,?,?,?,?)', id, String(pl.userId), String(pl.username || '').slice(0, 40), null, 0, Date.now()); a = this.one('SELECT * FROM acc WHERE id=?', id); }
      else if (pl.username && pl.username !== a.name) this.sql.exec('UPDATE acc SET name=? WHERE id=?', String(pl.username).slice(0, 40), a.id);
      return { a, via: 'cg' };
    }
    if (b.dev) { const d = this.one('SELECT * FROM dev WHERE token=?', String(b.dev)); if (d) { const a = this.one('SELECT * FROM acc WHERE id=?', d.acc); if (a) return { a, via: 'dev' }; } }
    throw new Error('accesso');
  }
  async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/acc\//, '');
    let b = {}; try { b = await req.json(); } catch (e) {}
    try {
      if (path === 'redeem') { // codice → gettone del dispositivo (sito)
        const c = this.one('SELECT * FROM code WHERE code=?', String(b.code || '').toUpperCase().trim());
        if (!c || c.exp < Date.now()) return json({ ok: false, err: 'codice' }, 404);
        this.sql.exec('DELETE FROM code WHERE code=?', c.code);
        const tok = rnd(24); this.sql.exec('INSERT INTO dev(token,acc,created) VALUES(?,?,?)', tok, c.acc, Date.now());
        const a = this.one('SELECT name,save,t FROM acc WHERE id=?', c.acc);
        return json({ ok: true, dev: tok, name: a.name, save: a.save, t: a.t });
      }
      if (path === 'forget') { this.sql.exec('DELETE FROM dev WHERE token=?', String(b.dev || '')); return json({ ok: true }); }
      const { a, via } = await this.who(b);
      if (path === 'load') return json({ ok: true, name: a.name, save: a.save, t: a.t, via });
      if (path === 'save') {
        const s = String(b.save || ''); if (s.length > MAX_SAVE) return json({ ok: false, err: 'grande' }, 413);
        const t = Number(b.t) || Date.now();
        if (t >= (a.t || 0)) this.sql.exec('UPDATE acc SET save=?, t=? WHERE id=?', s, t, a.id);
        return json({ ok: true, t: Math.max(t, a.t || 0), kept: t >= (a.t || 0) });
      }
      if (path === 'code') { // solo da CrazyGames: codice per entrare sul sito con lo stesso account
        if (via !== 'cg') return json({ ok: false, err: 'solo crazygames' }, 403);
        this.sql.exec('DELETE FROM code WHERE acc=? OR exp<?', a.id, Date.now());
        const al = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code = ''; const r = crypto.getRandomValues(new Uint8Array(6)); for (const x of r) code += al[x % al.length];
        const exp = Date.now() + CODE_MIN * 60e3; this.sql.exec('INSERT INTO code(code,acc,exp) VALUES(?,?,?)', code, a.id, exp);
        return json({ ok: true, code, exp });
      }
      return json({ ok: false, err: 'percorso' }, 404);
    } catch (e) { return json({ ok: false, err: String(e.message || e) }, 401); }
  }
}
export function accFetch(req, env) {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ ok: false, err: 'POST' }, 405);
  return env.ACC.get(env.ACC.idFromName('main')).fetch(req);
}
