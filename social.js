// VOXOVR v2.9.1: FRIENDS + PARTY hub.
// One Durable Object instance (the Room named "~HUB") keeps every signed-in player's live socket, status and parties in memory.
// Friend lists live in KV as  f:<user key> -> { f: [friend keys], i: [incoming requests], o: [outgoing requests] }.
// Only this hub writes f:* keys and it caches them, so there are no races with profile saves (those write u:*).
// The game connects to  wss://<site>/social?t=<session token>; the worker checks the token and passes x-key / x-name.
//
// game -> hub                                   hub -> game
//   { t:'st', s:'menu'|'lobby'|'match', m }       { t:'fr', friends:[{k,n,on,s,m}], inc:[{k,n}], out:[{k,n}] }
//   { t:'add', name }   friend request            { t:'party', id, lead, mem:[{k,n}] }   (id null = no party)
//   { t:'acc', k } / { t:'dec', k } / { t:'rm', k }{ t:'inv', id, k, n }  party invite from a friend
//   { t:'inv', k }      invite a friend           { t:'go', code, mode, n }  the leader opened a room: join it
//   { t:'pjoin', id } / { t:'pleave' }            { t:'msg', text }
//   { t:'go', code, mode }  leader only
//   { t:'look', lk:{ look, gun, skin } }   your outfit + gun, shown to your party on their home screen (v2.9.1)
export const FR_MAX = 10, PARTY_MAX = 4, PARTY_GRACE = 20000;

export function socialHub(env) {
  const H = { on: new Map(), fr: new Map(), names: new Map(), looks: new Map(), parties: new Map(), partyOf: new Map(), seq: 0, gone: new Map() };
  const KV = env.ACCOUNTS;
  const send = (k, o) => { const u = H.on.get(k); if (!u) return; const s = JSON.stringify(o); for (const w of u.socks) try { w.send(s); } catch (e) { } };
  async function getF(k) { if (H.fr.has(k)) return H.fr.get(k); const d = (await KV.get('f:' + k, 'json')) || { f: [], i: [], o: [] }; H.fr.set(k, d); return d; }
  async function putF(k, d) { H.fr.set(k, d); await KV.put('f:' + k, JSON.stringify(d)); }
  async function nameOf(k) { if (H.names.has(k)) return H.names.get(k); const u = await KV.get('u:' + k, 'json'); const n = u ? u.name : null; if (n) H.names.set(k, n); return n; }
  const rmv = (a, x) => { const i = a.indexOf(x); if (i >= 0) a.splice(i, 1); };
  async function pushFriends(k) {
    if (!H.on.has(k)) return; const d = await getF(k), row = async (x) => { const u = H.on.get(x); return { k: x, n: await nameOf(x) || x, on: !!u, s: u ? u.s : '', m: u ? u.m : '' }; };
    send(k, { t: 'fr', friends: await Promise.all(d.f.map(row)), inc: await Promise.all(d.i.map(async x => ({ k: x, n: await nameOf(x) || x }))), out: await Promise.all(d.o.map(async x => ({ k: x, n: await nameOf(x) || x }))) });
  }
  async function notifyFriendsOf(k) { const d = await getF(k); for (const x of d.f) if (H.on.has(x)) await pushFriends(x); }
  async function pushParty(id) { const P = H.parties.get(id); if (!P) return; const mem = await Promise.all(P.mem.map(async x => ({ k: x, n: await nameOf(x) || x, on: H.on.has(x), lk: H.looks.get(x) || null }))); for (const x of P.mem) send(x, { t: 'party', id, lead: P.mem[0], mem }); }
  async function leaveParty(k) {
    const id = H.partyOf.get(k); if (!id) return; const P = H.parties.get(id); H.partyOf.delete(k); send(k, { t: 'party', id: null }); if (!P) return; rmv(P.mem, k);
    if (P.mem.length <= 1) { for (const x of P.mem) { H.partyOf.delete(x); send(x, { t: 'party', id: null }); } H.parties.delete(id); return; }
    await pushParty(id);
  }
  async function onMsg(k, m) {
    const me = H.on.get(k); if (!me || !m || typeof m.t !== 'string') return;
    if (m.t === 'look') { const j = JSON.stringify(m.lk || null); if (j.length > 900) return; H.looks.set(k, m.lk || null); const id = H.partyOf.get(k); if (id) await pushParty(id); return; }   // outfit + gun for the party lineup on the home screen
    if (m.t === 'st') { me.s = String(m.s || '').slice(0, 10); me.m = String(m.m || '').slice(0, 12); await notifyFriendsOf(k); return; }
    if (m.t === 'add') {
      const t = String(m.name || '').trim().toLowerCase(); if (!t) return;
      if (t === k) return send(k, { t: 'msg', text: 'That\'s you.' });
      const tn = await nameOf(t); if (!tn) return send(k, { t: 'msg', text: 'No player called "' + String(m.name).slice(0, 16) + '".' });
      const a = await getF(k), b = await getF(t);
      if (a.f.includes(t)) return send(k, { t: 'msg', text: tn + ' is already your friend.' });
      if (a.o.includes(t)) return send(k, { t: 'msg', text: 'Request already sent to ' + tn + '.' });
      if (a.f.length >= FR_MAX) return send(k, { t: 'msg', text: 'Your friends list is full (' + FR_MAX + ').' });
      if (b.f.length >= FR_MAX) return send(k, { t: 'msg', text: tn + '\'s friends list is full.' });
      if (a.i.includes(t)) { rmv(a.i, t); rmv(b.o, k); a.f.push(t); b.f.push(k); }   // they had already asked you: that's a yes
      else { a.o.push(t); b.i.push(k); send(k, { t: 'msg', text: 'Friend request sent to ' + tn + '.' }); }
      await putF(k, a); await putF(t, b); await pushFriends(k); await pushFriends(t); return;
    }
    if (m.t === 'acc' || m.t === 'dec') {
      const t = String(m.k || ''), a = await getF(k), b = await getF(t); if (!a.i.includes(t)) return;
      rmv(a.i, t); rmv(b.o, k);
      if (m.t === 'acc') { if (a.f.length >= FR_MAX) { send(k, { t: 'msg', text: 'Your friends list is full (' + FR_MAX + ').' }); } else if (b.f.length >= FR_MAX) { send(k, { t: 'msg', text: 'Their friends list is full.' }); } else { a.f.push(t); b.f.push(k); } }
      await putF(k, a); await putF(t, b); await pushFriends(k); await pushFriends(t); return;
    }
    if (m.t === 'rm') { const t = String(m.k || ''), a = await getF(k), b = await getF(t); rmv(a.f, t); rmv(b.f, k); rmv(a.o, t); rmv(b.i, k); await putF(k, a); await putF(t, b); await pushFriends(k); await pushFriends(t); return; }
    if (m.t === 'inv') {
      const t = String(m.k || ''), a = await getF(k); if (!a.f.includes(t)) return; if (!H.on.has(t)) return send(k, { t: 'msg', text: 'They\'re offline.' });
      let id = H.partyOf.get(k); if (id && H.partyOf.get(t) === id) return send(k, { t: 'msg', text: 'Already in your party.' });
      if (!id) { id = 'p' + (++H.seq); H.parties.set(id, { mem: [k], inv: new Set() }); H.partyOf.set(k, id); await pushParty(id); }
      const P = H.parties.get(id); if (P.mem.length >= PARTY_MAX) return send(k, { t: 'msg', text: 'Party is full (' + PARTY_MAX + ').' });
      P.inv.add(t); send(t, { t: 'inv', id, k, n: me.n }); send(k, { t: 'msg', text: 'Invite sent.' }); return;
    }
    if (m.t === 'pjoin') {
      const id = String(m.id || ''), P = H.parties.get(id); if (!P || !P.inv.has(k)) return send(k, { t: 'msg', text: 'That invite has expired.' });
      if (P.mem.length >= PARTY_MAX) return send(k, { t: 'msg', text: 'That party is full.' });
      if (H.partyOf.get(k) !== id) await leaveParty(k); P.inv.delete(k); P.mem.push(k); H.partyOf.set(k, id); await pushParty(id); return;
    }
    if (m.t === 'pleave') { await leaveParty(k); return; }
    if (m.t === 'go') { const id = H.partyOf.get(k), P = id && H.parties.get(id); if (!P || P.mem[0] !== k) return; const code = String(m.code || '').toUpperCase(); if (!/^[A-Z0-9]{4}$/.test(code)) return;
      for (const x of P.mem) if (x !== k) send(x, { t: 'go', code, mode: String(m.mode || '').slice(0, 12), n: me.n }); return; }
  }
  return {
    H,
    async open(k, name, sock) {
      H.names.set(k, name); let u = H.on.get(k); const fresh = !u; if (!u) { u = { socks: new Set(), n: name, s: 'menu', m: '' }; H.on.set(k, u); } u.socks.add(sock);
      const g = H.gone.get(k); if (g) { clearTimeout(g); H.gone.delete(k); }
      await pushFriends(k); const id = H.partyOf.get(k); if (id) await pushParty(id); else send(k, { t: 'party', id: null });
      if (fresh) await notifyFriendsOf(k);
    },
    async message(k, data) { let m; try { m = JSON.parse(data); } catch (e) { return; } try { await onMsg(k, m); } catch (e) { send(k, { t: 'msg', text: 'Something went wrong. Try again.' }); } },
    async close(k, sock) {
      const u = H.on.get(k); if (!u || !u.socks.delete(sock) || u.socks.size) return; H.on.delete(k); await notifyFriendsOf(k);
      const id = H.partyOf.get(k); if (id) { await pushParty(id); H.gone.set(k, setTimeout(() => { H.gone.delete(k); if (!H.on.has(k)) leaveParty(k); }, PARTY_GRACE)); }   // a page reload keeps your party spot
    },
  };
}
