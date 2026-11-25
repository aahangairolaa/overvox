// OVERVOX: serves the game (public/) and runs the relay that passes game messages between the host and players when a direct
// connection is blocked. One "Room" (Durable Object) per 4-letter code.
//   wss://<worker>/host/ABCD   the host opens the room
//   wss://<worker>/join/ABCD   a player joins it
const send = (ws, s) => { try { ws.send(s); } catch (e) { } };
export class Room {
  constructor(state, env) { this.host = null; this.clients = new Map(); this.n = 0; }
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    const role = new URL(req.url).pathname.split('/')[1], pair = new WebSocketPair(), [c, s] = Object.values(pair); s.accept();
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
    const m = new URL(req.url).pathname.match(/^\/(host|join)\/([A-Z0-9]{4})$/);
    if (!m) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('OVERVOX relay is running');
    return env.ROOMS.get(env.ROOMS.idFromName(m[2])).fetch(new Request('https://room/' + m[1], req));
  },
};
