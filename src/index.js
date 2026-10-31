// EVOLVED ZONE · ponte online (Cloudflare Worker + Durable Object)
// Ogni lobby ha una "stanza": chi crea la lobby (host) e gli amici si collegano qui e i messaggi passano dal ponte.
// Così non serve più il collegamento diretto tra le due reti (che i router spesso bloccano).
// 0.37 (31/10/2026): qui passano anche gli account del gioco (/acc/...), vedi accounts.js.
import { Accounts, accFetch } from './accounts.js';
export { Accounts };
export class Room {
  constructor(state, env) { this.state = state; this.host = null; this.clients = new Map(); }
  async fetch(req) {
    const u = new URL(req.url);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    const role = u.searchParams.get('role'), cid = (u.searchParams.get('cid') || '').slice(0, 64);
    const [client, s] = Object.values(new WebSocketPair());
    s.accept();
    const send = (w, o) => { try { w.send(JSON.stringify(o)); } catch (e) {} };
    if (role === 'host') {
      if (this.host) { send(s, { t: 'err', type: 'unavailable-id' }); s.close(1000, 'taken'); return new Response(null, { status: 101, webSocket: client }); }
      this.host = s; send(s, { t: 'open' });
      s.addEventListener('message', e => {
        let m; try { m = JSON.parse(e.data); } catch (x) { return; }
        if (m.t === 'ping') return send(s, { t: 'pong' });
        const k = this.clients.get(m.to); if (!k) return;
        if (m.t === 'd') send(k, { t: 'd', d: m.d });
        else if (m.t === 'close') { send(k, { t: 'close' }); try { k.close(1000, 'host'); } catch (x) {} this.clients.delete(m.to); }
      });
      const bye = () => { if (this.host !== s) return; this.host = null; for (const k of this.clients.values()) { send(k, { t: 'close' }); try { k.close(1000, 'host gone'); } catch (x) {} } this.clients.clear(); };
      s.addEventListener('close', bye); s.addEventListener('error', bye);
    } else {
      if (!this.host || !cid) { send(s, { t: 'err', type: 'peer-unavailable' }); s.close(1000, 'nohost'); return new Response(null, { status: 101, webSocket: client }); }
      const old = this.clients.get(cid); if (old) { try { old.close(1000, 'replaced'); } catch (x) {} }
      this.clients.set(cid, s); send(this.host, { t: 'conn', cid }); send(s, { t: 'open' });
      s.addEventListener('message', e => {
        let m; try { m = JSON.parse(e.data); } catch (x) { return; }
        if (m.t === 'ping') return send(s, { t: 'pong' });
        if (m.t === 'd' && this.host) send(this.host, { t: 'd', cid, d: m.d });
      });
      const bye = () => { if (this.clients.get(cid) !== s) return; this.clients.delete(cid); if (this.host) send(this.host, { t: 'close', cid }); };
      s.addEventListener('close', bye); s.addEventListener('error', bye);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/acc/')) return accFetch(req, env);
    const m = u.pathname.match(/^\/r\/([A-Za-z0-9_-]{3,64})$/);
    if (!m) return new Response('EVOLVED ZONE relay ok', { headers: { 'access-control-allow-origin': '*' } });
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
  }
};
