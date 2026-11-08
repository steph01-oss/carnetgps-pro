/* Mock Supabase pour tests locaux uniquement (NE PAS déployer). Usage : node tools/mock-supabase.js [port] */
'use strict';
const http = require('http');
const crypto = require('crypto');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createMock() {
  const db = { teams: [], members: [], clients: [] }, tokens = new Map(), refresh = new Map();
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
      const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(o === undefined ? '' : JSON.stringify(o)); };
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
      const rpc = p.match(/^\/rest\/v1\/rpc\/(create_team|join_team)$/);
      if (rpc && req.method === 'POST') {
        let t;
        if (rpc[1] === 'create_team') {
          let code; do { code = Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join(''); } while (db.teams.some(x => x.join_code === code));
          t = { id: crypto.randomUUID(), name: body.p_name, join_code: code }; db.teams.push(t);
        } else {
          t = db.teams.find(x => x.join_code === String(body.p_code).trim().toUpperCase());
          if (!t) return send(400, { code: 'P0001', message: 'CODE_INVALIDE' });
          if (!isMember(t.id) && db.members.filter(m => m.team_id === t.id).length >= 10) return send(400, { code: 'P0001', message: 'EQUIPE_PLEINE' });
        }
        db.members = db.members.filter(m => !(m.team_id === t.id && m.user_id === uid));
        db.members.push({ team_id: t.id, user_id: uid, display_name: body.p_display_name, color: body.p_color });
        return send(200, { team_id: t.id, team_name: t.name, join_code: t.join_code });
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
            if (old) { if (new Date(r.updated) < new Date(old.updated)) continue; Object.assign(old, r, { team_id: old.team_id, server_updated: stamp() }); }
            else db.clients.push(Object.assign({}, r, { server_updated: stamp() }));
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
