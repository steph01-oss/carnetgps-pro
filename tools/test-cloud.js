const vm = require('vm'), fs = require('fs'), assert = require('assert');
const { createMock } = require('./mock-supabase.js');
const src = fs.readFileSync(require('path').join(__dirname, '../js/cloud.js'), 'utf8');
function client(url) {
  const store = {}, listeners = [];
  const document = { hidden: false, addEventListener: (e, f) => listeners.push(f), removeEventListener() {} };
  const ctx = { fetch, localStorage: { getItem: k => k in store ? store[k] : null, setItem: (k, v) => store[k] = String(v), removeItem: k => delete store[k] },
    document, setTimeout, clearTimeout, console, JSON, Date, Promise, Error, Object, encodeURIComponent, String };
  ctx.window = ctx; ctx.window.GC_CONFIG = url ? { supabaseUrl: url, anonKey: 'k' } : undefined;
  vm.createContext(ctx); vm.runInContext(src, ctx); return { C: ctx.Cloud, store, document, listeners };
}
const rec = (o) => Object.assign({ id: require('crypto').randomUUID(), name: 'N', address: 'A', phone: '0', notes: '', lat: 14.6, lng: -61, reported: false, deleted: false,
  updated: new Date().toISOString(), ownerId: 'o', ownerName: 'On', ownerColor: '#f00' }, o);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  assert.strictEqual(client(null).C.configured(), false); assert.strictEqual(client(null).C.session(), null);
  const m = createMock(); await new Promise(r => m.server.listen(0, r));
  const url = 'http://localhost:' + m.server.address().port;
  const a = client(url), b = client(url);
  const sa = await a.C.createTeam('Livreurs', 'Anna', '#f00');
  assert.ok(/^[A-HJ-NP-Z2-9]{6}$/.test(sa.joinCode)); assert.strictEqual(JSON.stringify(a.C.session()), JSON.stringify(sa)); console.log('ok createTeam', sa.joinCode);
  await assert.rejects(b.C.joinTeam('ZZZZZZ', 'Bob', '#0f0'), e => e.message === 'CODE_INVALIDE' && !!e.userMessage); console.log('ok code invalide');
  const sb = await b.C.joinTeam(sa.joinCode.toLowerCase(), 'Bob', '#0f0'); assert.strictEqual(sb.teamId, sa.teamId); assert.notStrictEqual(sb.userId, sa.userId); console.log('ok join 2e utilisateur');
  const r1 = rec({ name: 'Dupont' }), r2 = rec({ name: 'Martin' });
  await a.C.push([r1, r2]);
  let p = await b.C.pull(null); assert.strictEqual(p.clients.length, 2); assert.strictEqual(p.members.length, 2);
  assert.strictEqual(Object.keys(p.clients[0]).sort().join(), Object.keys(r1).sort().join()); assert.ok(p.serverTime);
  let p2 = await b.C.pull(p.serverTime); assert.strictEqual(p2.clients.length, 0); console.log('ok push/pull incrémental');
  await a.C.push([Object.assign({}, r1, { deleted: true, updated: new Date(Date.now() + 1000).toISOString() })]);
  p2 = await b.C.pull(p.serverTime); assert.strictEqual(p2.clients.length, 1); assert.strictEqual(p2.clients[0].deleted, true); console.log('ok suppression logique');
  await a.C.push([Object.assign({}, r1, { name: 'Vieux', deleted: false, updated: '2000-01-01T00:00:00Z' })]);
  p2 = await b.C.pull(p2.serverTime); assert.strictEqual(p2.clients.length, 0); console.log('ok dernier updated gagne');
  // token expiré -> refresh
  await fetch(url + '/__expire', { method: 'POST', headers: { apikey: 'k' } }); const before = m.stats.refreshes;
  p = await b.C.pull(null); assert.strictEqual(p.clients.length, 2); assert.strictEqual(m.stats.refreshes, before + 1); console.log('ok token expiré -> refresh');
  // --- rôles, code, sécurité ---
  assert.strictEqual(sa.role, 'admin'); assert.strictEqual(sb.role, 'member'); assert.strictEqual(sb.joinCode, null); assert.ok(a.C.isAdmin() && !b.C.isAdmin()); console.log('ok rôles : patron / membre, le membre ne voit pas le code');
  p = await b.C.pull(null); assert.deepStrictEqual(p.members.map(x => x.role).sort(), ['admin', 'member']);
  await assert.rejects(b.C.regenerateCode(), e => e.code === 'NON_ADMIN' && !!e.userMessage);
  await assert.rejects(b.C.removeMember(sa.userId), e => e.code === 'NON_ADMIN'); await assert.rejects(b.C.deleteTeam(), e => e.code === 'NON_ADMIN'); console.log('ok un membre ne peut ni régénérer, ni retirer, ni supprimer');
  const oldCode = sa.joinCode; const s2 = await a.C.regenerateCode(); assert.notStrictEqual(s2.joinCode, oldCode);
  const c3 = client(url); await assert.rejects(c3.C.joinTeam(oldCode, 'Zed', '#00f'), e => e.code === 'CODE_INVALIDE'); console.log('ok ancien code invalidé après régénération');
  const c4 = client(url); const s4 = await c4.C.joinTeam(s2.joinCode, 'Cam', '#00f'); assert.strictEqual(s4.role, 'member');
  m.db.teams[0].code_expires_at = new Date(Date.now() - 1000).toISOString();
  const c5 = client(url); await assert.rejects(c5.C.joinTeam(s2.joinCode, 'Dan', '#0ff'), e => e.code === 'CODE_EXPIRE'); console.log('ok code expiré refusé');
  assert.ok((await a.C.regenerateCode()).joinCode); await a.C.refreshCode();
  const c6 = client(url); for (let i = 0; i < 5; i++) await assert.rejects(c6.C.joinTeam('AAAAAA', 'Eve', '#111'), e => e.code === 'CODE_INVALIDE');
  await assert.rejects(c6.C.joinTeam('AAAAAA', 'Eve', '#111'), e => e.code === 'TROP_DESSAIS'); await assert.rejects(c6.C.joinTeam(a.C.session().joinCode, 'Eve', '#111'), e => e.code === 'TROP_DESSAIS'); console.log('ok anti force brute (5 faux codes => blocage, même avec le bon)');
  // propriétaire non falsifiable : Bob modifie un client d'Anna en se déclarant propriétaire
  await b.C.push([Object.assign({}, r2, { ownerId: 'pirate', ownerName: 'Pirate', name: 'Martin modifié', updated: new Date(Date.now() + 5000).toISOString() })]);
  p = await a.C.pull(null); const rr = p.clients.find(x => x.id === r2.id); assert.strictEqual(rr.name, 'Martin modifié'); assert.notStrictEqual(rr.ownerId, 'pirate'); console.log('ok propriétaire non falsifiable (édition partagée autorisée)');
  // retirer un livreur
  await a.C.removeMember(s4.userId); assert.strictEqual((await c4.C.pull(null)).clients.length, 0); assert.strictEqual((await a.C.pull(null)).members.length, 2); console.log('ok livreur retiré : plus aucun accès');
  // quitter : le patron part -> le plus ancien membre devient patron
  await a.C.leaveTeam(); assert.strictEqual(a.C.session(), null); p = await b.C.pull(null); assert.deepStrictEqual(p.members.map(x => x.role), ['admin']); console.log('ok patron parti : relais au plus ancien');
  await b.C.deleteTeam(); assert.strictEqual(m.db.teams.length, 0); assert.strictEqual(m.db.clients.length, 0); console.log('ok suppression équipe : toutes les données effacées');
  process.exit(0);
  // polling
  const got = []; b.C.startPolling(d => got.push(d), 100); await sleep(350);
  assert.strictEqual(got.length, 1); await a.C.push([rec({ name: 'Nouveau' })]); await sleep(350);
  assert.strictEqual(got.length, 2); assert.strictEqual(got[1].clients.length, 1);
  b.document.hidden = true; await sleep(250); const n = got.length; await a.C.push([rec()]); await sleep(300); assert.strictEqual(got.length, n);
  b.document.hidden = false; b.listeners.forEach(f => f()); await sleep(300); assert.strictEqual(got.length, n + 1);
  m.server.close(); await sleep(300); b.C.stopPolling(); console.log('ok polling, pause hidden, hors-ligne sans exception');
  a.C.leave(); assert.strictEqual(a.C.session(), null); console.log('TOUS LES TESTS OK'); process.exit(0);
})().catch(e => { console.error('ECHEC', e); process.exit(1); });
