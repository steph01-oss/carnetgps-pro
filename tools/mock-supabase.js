/* Mock Supabase pour tests locaux uniquement (NE PAS déployer). Usage : node tools/mock-supabase.js [port] */
'use strict';
const http = require('http');
const crypto = require('crypto');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createMock() {
  const db = { teams: [], members: [], clients: [], attempts: [] }, tokens = new Map(), refresh = new Map();
  let tick = 0, ttl = 3600;
  const stats = { signups: 0, refreshes: 0 };
  const stamp = () => new Date(Date.UTC(2030, 0, 1) + (++tick)).toISOString(); // strictement croissant
  const session = (uid) => {
    const at = 'at_' + crypto.randomUUID(), rt = 'rt_' + crypto.randomUUID();
    tokens.set(at, uid); refresh.set(rt, uid);
    return { access_token: at, refresh_token: rt, expires_in: ttl, expires_at: Math.floor(Date.now() / 1000) + ttl, user: { id: uid } };
  };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d);
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), body = raw ? JSON.parse(raw) : null;
      const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); res.end(o === undefined ? '' : JSON.stringify(o)); };
      if (req.method === 'OPTIONS') return send(204);
      if (!req.headers.apikey) return send(401, { message: 'No API key' });
      const p = u.pathname;
      if (p === '/__expire') { tokens.clear(); return send(200, {}); }          // invalide tous les access tokens
      if (p === '/__ttl') { ttl = body.ttl; return send(200, {}); }
      if (p === '/auth/v1/signup') { stats.signups++; return send(200, session(crypto.randomUUID())); }
      if (p === '/auth/v1/token') {
        const uid = refresh.get(body && body.refresh_token);
        if (!uid) return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
        stats.refreshes++; return send(200, session(uid));
      }
      const uid = tokens.get((req.headers.authorization || '').replace('Bearer ', ''));
      if (!uid) return send(401, { message: 'JWT expired', code: 'PGRST301' });
      const isMember = t => db.members.some(m => m.team_id === t && m.user_id === uid);
      const rpc = p.match(/^\/rest\/v1\/rpc\/(\w+)$/);
      const isAdmin = t => db.members.some(m => m.team_id === t && m.user_id === uid && m.role === 'admin');
      const newCode = () => { let code; do { code = Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join(''); } while (db.teams.some(x => x.join_code === code)); return code; };
      const week = () => new Date(Date.now() + (db.__week || 7 * 864e5)).toISOString();
      const bad = msg => send(400, { code: 'P0001', message: msg });
      if (rpc && req.method === 'POST') {
        const fn = rpc[1];
        if (fn === 'create_team') {
          const t = { id: crypto.randomUUID(), name: body.p_name, join_code: newCode(), code_expires_at: week() }; db.teams.push(t);
          db.members.push({ team_id: t.id, user_id: uid, display_name: body.p_display_name, color: body.p_color, role: 'admin', joined_at: stamp() });
          return send(200, { team_id: t.id, team_name: t.name, join_code: t.join_code, code_expires_at: t.code_expires_at, role: 'admin' });
        }
        if (fn === 'join_team') {
          const recent = db.attempts.filter(x => x.uid === uid && Date.now() - x.at < 15 * 60000).length;
          if (recent >= 5) return send(200, { error: 'TROP_DESSAIS' });
          const t = db.teams.find(x => x.join_code === String(body.p_code).trim().toUpperCase());
          if (!t) { db.attempts.push({ uid, at: Date.now() }); return send(200, { error: 'CODE_INVALIDE' }); }
          let mem = db.members.find(x => x.team_id === t.id && x.user_id === uid);
          if (!mem) {
            if (Date.now() > new Date(t.code_expires_at).getTime()) return send(200, { error: 'CODE_EXPIRE' });
            if (db.members.filter(x => x.team_id === t.id).length >= 10) return bad('EQUIPE_PLEINE');
            mem = { team_id: t.id, user_id: uid, role: 'member', joined_at: stamp() }; db.members.push(mem);
          }
          Object.assign(mem, { display_name: body.p_display_name, color: body.p_color });
          const adm = mem.role === 'admin';
          return send(200, { team_id: t.id, team_name: t.name, role: mem.role, join_code: adm ? t.join_code : null, code_expires_at: adm ? t.code_expires_at : null });
        }
        const T = db.teams.find(x => x.id === body.p_team);
        if (['regenerate_code', 'team_code', 'remove_member', 'delete_team'].includes(fn) && !(T && isAdmin(T.id))) return bad('NON_ADMIN');
        if (fn === 'regenerate_code') { T.join_code = newCode(); T.code_expires_at = week(); return send(200, { join_code: T.join_code, code_expires_at: T.code_expires_at }); }
        if (fn === 'team_code') return send(200, { join_code: T.join_code, code_expires_at: T.code_expires_at });
        if (fn === 'remove_member') { if (body.p_user === uid) return bad('NON_ADMIN'); db.members = db.members.filter(x => !(x.team_id === T.id && x.user_id === body.p_user)); return send(200); }
        if (fn === 'delete_team') { db.teams = db.teams.filter(x => x !== T); db.members = db.members.filter(x => x.team_id !== T.id); db.clients = db.clients.filter(x => x.team_id !== T.id); return send(200); }
        if (fn === 'leave_team') {
          const mem = db.members.find(x => x.team_id === body.p_team && x.user_id === uid); if (!mem) return send(200);
          db.members = db.members.filter(x => x !== mem);
          const left = db.members.filter(x => x.team_id === body.p_team);
          if (!left.length) { db.teams = db.teams.filter(x => x.id !== body.p_team); db.clients = db.clients.filter(x => x.team_id !== body.p_team); }
          else if (mem.role === 'admin' && !left.some(x => x.role === 'admin')) left.sort((a, b) => a.joined_at < b.joined_at ? -1 : 1)[0].role = 'admin';
          return send(200);
        }
      }
      if (p === '/rest/v1/members' && req.method === 'GET') {
        const t = (u.searchParams.get('team_id') || '').replace('eq.', '');
        return send(200, isMember(t) ? db.members.filter(m => m.team_id === t) : []);
      }
      if (p === '/rest/v1/clients') {
        if (req.method === 'POST') {
          for (const r of body) {
            if (!isMember(r.team_id)) return send(403, { message: 'RLS' });
            const old = db.clients.find(c => c.id === r.id);
            if (old) { if (new Date(r.updated) < new Date(old.updated)) continue; Object.assign(old, r, { team_id: old.team_id, owner_id: old.owner_id, owner_name: old.owner_name, owner_color: old.owner_color, server_updated: stamp() }); }
            else db.clients.push(Object.assign({}, r, { owner_id: uid, server_updated: stamp() }));
          }
          return send(201);
        }
        if (req.method === 'GET') {
          const t = (u.searchParams.get('team_id') || '').replace('eq.', ''), s = (u.searchParams.get('server_updated') || '').replace('gt.', '');
          if (!isMember(t)) return send(200, []);
          return send(200, db.clients.filter(c => c.team_id === t && (!s || c.server_updated > s))
            .sort((a, b) => a.server_updated < b.server_updated ? -1 : 1).slice(0, +u.searchParams.get('limit') || 1000));
        }
      }
      send(404, { message: 'not found' });
    });
  });
  return { server, db, stats };
}
module.exports = { createMock };
if (require.main === module) {
  const port = +process.argv[2] || 54321;
  createMock().server.listen(port, () => console.log('Mock Supabase sur http://localhost:' + port + ' (anonKey : n\'importe laquelle)'));
}
