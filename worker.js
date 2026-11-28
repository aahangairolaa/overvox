// OVERVOX: serves the game (public/) and runs the relay that passes game messages between the host and players when a direct
// connection is blocked. One "Room" (Durable Object) per 4-letter code.
//   wss://<worker>/host/ABCD   the host opens the room
//   wss://<worker>/join/ABCD   a player joins it
const send = (ws, s) => { try { ws.send(s); } catch (e) { } };
import { handleAccounts } from './accounts.js';   // v2.6: /api/* accounts
import { socialHub } from './social.js';   // v2.9.1: friends + party (the Room named ~HUB)
export class Room {
  constructor(state, env) { this.host = null; this.clients = new Map(); this.n = 0; this.env = env; this.hub = null; }
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    const role = new URL(req.url).pathname.split('/')[1], pair = new WebSocketPair(), [c, s] = Object.values(pair); s.accept();
    if (role === 'social') {   /* v2.9.1 friends + party hub */
      if (!this.hub) this.hub = socialHub(this.env); const k = req.headers.get('x-key'), name = req.headers.get('x-name') || k;
      s.addEventListener('message', (e) => this.hub.message(k, e.data)); const bye = () => this.hub.close(k, s); s.addEventListener('close', bye); s.addEventListener('error', bye);
      await this.hub.open(k, name, s); return new Response(null, { status: 101, webSocket: c });
    }
    if (role === 'host') {
      if (this.host) try { this.host.close(4000, 'replaced'); } catch (e) { }
      this.host = s;
      s.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch (er) { return; }
        if (m.kick) { const w = this.clients.get(m.kick); if (w) try { w.close(4001, 'kicked'); } catch (er) { } return; }
        const w = this.clients.get(m.to); if (w) send(w, JSON.stringify(m.d)); });
      const bye = () => { if (this.host !== s) return; this.host = null; for (const w of this.clients.values()) try { w.close(4002, 'host left'); } catch (er) { } this.clients.clear(); };
      s.addEventListener('close', bye); s.addEventListener('error', bye);
    } else {
      if (!this.host) { s.close(4004, 'no room'); return new Response(null, { status: 101, webSocket: c }); }
      const id = 'c' + (++this.n); this.clients.set(id, s); send(this.host, JSON.stringify({ join: id }));
      s.addEventListener('message', (e) => { if (!this.host) return; let d; try { d = JSON.parse(e.data); } catch (er) { return; } send(this.host, JSON.stringify({ from: id, d })); });
      const bye = () => { if (!this.clients.delete(id)) return; if (this.host) send(this.host, JSON.stringify({ leave: id })); };
      s.addEventListener('close', bye); s.addEventListener('error', bye);
    }
    return new Response(null, { status: 101, webSocket: c });
  }
}
export default {
  async fetch(req, env) {
    const acct = await handleAccounts(req, env); if (acct) return acct;
    const url = new URL(req.url);
    if (url.pathname === '/social') {   /* v2.9.1: signed-in players only; the token is checked here, the hub gets the user */
      if (req.headers.get('Upgrade') !== 'websocket' || !env.ACCOUNTS) return new Response('no', { status: 426 });
      const t = url.searchParams.get('t') || '', key = /^[A-Za-z0-9_-]{20,}$/.test(t) ? await env.ACCOUNTS.get('s:' + t) : null; if (!key) return new Response('signed out', { status: 401 });
      const u = await env.ACCOUNTS.get('u:' + key, 'json'); if (!u) return new Response('signed out', { status: 401 });
      const h = new Headers(req.headers); h.set('x-key', key); h.set('x-name', u.name);
      return env.ROOMS.get(env.ROOMS.idFromName('~HUB')).fetch(new Request('https://room/social', { headers: h }));
    }
    const m = new URL(req.url).pathname.match(/^\/(host|join)\/([A-Z0-9]{4})$/);
    if (!m) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('OVERVOX relay is running');
    return env.ROOMS.get(env.ROOMS.idFromName(m[2])).fetch(new Request('https://room/' + m[1], req));
  },
};
