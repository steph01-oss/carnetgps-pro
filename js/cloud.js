/* CarnetGPS Pro - couche cloud (Supabase REST, auth anonyme). Aucune dépendance. */
(function () {
  'use strict';
  var K_SESSION = 'gc_cloud', K_AUTH = 'gc_cloud_auth';
  var COLS = { id: 'id', name: 'name', address: 'address', phone: 'phone', notes: 'notes', lat: 'lat', lng: 'lng',
    reported: 'reported', deleted: 'deleted', updated: 'updated', ownerId: 'owner_id', ownerName: 'owner_name', ownerColor: 'owner_color' };
  var MSG = {
    CODE_INVALIDE: "Code d'équipe invalide : vérifie les 6 caractères.",
    EQUIPE_PLEINE: "Cette équipe est complète (10 membres maximum).",
    HORS_LIGNE: "Pas de connexion pour le moment.",
    NON_CONFIGURE: "Le cloud n'est pas configuré.",
    SESSION_EXPIREE: "Session expirée, reconnecte-toi à l'équipe."
  };

  function cfg() { var c = window.GC_CONFIG || {}; return { url: String(c.supabaseUrl || '').replace(/\/+$/, ''), key: c.anonKey || '' }; }
  function configured() { var c = cfg(); return !!(c.url && c.key); }
  function ls(k, v) {
    try {
      if (v === undefined) { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; }
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
  }
  function err(code, extra) { var e = new Error(code); e.code = code; e.userMessage = MSG[code] || extra || code; return e; }
  function session() { return ls(K_SESSION); }

  function rawFetch(path, opts) {
    var c = cfg();
    if (!c.url) return Promise.reject(err('NON_CONFIGURE'));
    opts = opts || {};
    var h = Object.assign({ apikey: c.key, 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(c.url + path, { method: opts.method || 'GET', headers: h, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
      .catch(function () { throw err('HORS_LIGNE'); });
  }
  function readJson(r) { return r.text().then(function (t) { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }); }
  function failFrom(r, body) {
    var m = (body && (body.message || body.msg || body.error_description || body.error)) || ('HTTP ' + r.status);
    for (var k in MSG) if (String(m).indexOf(k) >= 0) return err(k);
    var e = new Error(m); e.status = r.status; return e;
  }

  function storeAuth(d) {
    var a = { accessToken: d.access_token, refreshToken: d.refresh_token,
      expiresAt: d.expires_at ? d.expires_at * 1000 : Date.now() + (d.expires_in || 3600) * 1000,
      userId: (d.user && d.user.id) || (ls(K_AUTH) || {}).userId };
    ls(K_AUTH, a); return a;
  }
  function signup() {
    return rawFetch('/auth/v1/signup', { method: 'POST', body: {} }).then(function (r) {
      return readJson(r).then(function (b) { if (!r.ok) throw failFrom(r, b); return storeAuth(b); });
    });
  }
  var refreshing = null;
  function refresh(a) {
    if (refreshing) return refreshing;
    refreshing = rawFetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: a.refreshToken } })
      .then(function (r) {
        return readJson(r).then(function (b) {
          if (!r.ok) { if (r.status >= 400 && r.status < 500) ls(K_AUTH, null); throw r.status >= 500 ? failFrom(r, b) : err('SESSION_EXPIREE'); }
          return storeAuth(b);
        });
      }).then(function (x) { refreshing = null; return x; }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }
  function getAuth(force) {
    var a = ls(K_AUTH);
    if (!a) return signup();
    if (force || Date.now() > a.expiresAt - 60000) return refresh(a);
    return Promise.resolve(a);
  }
  // Appel authentifié ; sur 401 : un seul rafraîchissement puis nouvel essai.
  function api(path, opts, retried) {
    return getAuth(false).then(function (a) {
      var o = Object.assign({}, opts); o.headers = Object.assign({ Authorization: 'Bearer ' + a.accessToken }, opts && opts.headers);
      return rawFetch(path, o).then(function (r) {
        return readJson(r).then(function (b) {
          if (r.status === 401 && !retried) return getAuth(true).then(function () { return api(path, opts, true); });
          if (!r.ok) throw failFrom(r, b);
          return b;
        });
      });
    });
  }

  function saveSession(a, d, displayName, color) {
    var s = { userId: a.userId, teamId: d.team_id, teamName: d.team_name, joinCode: d.join_code, displayName: displayName, color: color };
    ls(K_SESSION, s); return s;
  }
  function enter(fn, args, displayName, color) {
    if (!configured()) return Promise.reject(err('NON_CONFIGURE'));
    return getAuth(false).then(function (a) {
      return api('/rest/v1/rpc/' + fn, { method: 'POST', body: args }).then(function (d) { return saveSession(a, d, displayName, color); });
    });
  }
  function createTeam(teamName, displayName, color) {
    return enter('create_team', { p_name: teamName, p_display_name: displayName, p_color: color }, displayName, color);
  }
  function joinTeam(code, displayName, color) {
    return enter('join_team', { p_code: String(code || '').trim().toUpperCase(), p_display_name: displayName, p_color: color }, displayName, color);
  }
  function leave() { stopPolling(); ls(K_SESSION, null); }

  function toRow(rec, teamId) {
    var o = { team_id: teamId };
    for (var k in COLS) o[COLS[k]] = rec[k] === undefined ? null : rec[k];
    o.reported = !!rec.reported; o.deleted = !!rec.deleted;
    return o;
  }
  function fromRow(r) {
    var o = {}; for (var k in COLS) o[k] = r[COLS[k]];
    o.reported = !!o.reported; o.deleted = !!o.deleted; return o;
  }
  function need() { var s = session(); if (!s) throw err('NON_CONFIGURE', "Pas d'équipe active."); return s; }

  function push(records) {
    if (!records || !records.length) return Promise.resolve();
    var s; try { s = need(); } catch (e) { return Promise.reject(e); }
    var chunks = [], i; for (i = 0; i < records.length; i += 200) chunks.push(records.slice(i, i + 200));
    return chunks.reduce(function (p, ch) {
      return p.then(function () {
        return api('/rest/v1/clients?on_conflict=id', { method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: ch.map(function (r) { return toRow(r, s.teamId); }) });
      });
    }, Promise.resolve());
  }

  function pull(since) {
    var s; try { s = need(); } catch (e) { return Promise.reject(e); }
    var rows = [], cursor = since || null, serverTime = since || null;
    function page() {
      var q = '/rest/v1/clients?select=*&team_id=eq.' + encodeURIComponent(s.teamId) +
        (cursor ? '&server_updated=gt.' + encodeURIComponent(cursor) : '') + '&order=server_updated.asc&limit=1000';
      return api(q).then(function (b) {
        b = b || []; rows = rows.concat(b);
        if (b.length) { cursor = serverTime = b[b.length - 1].server_updated; }
        return b.length >= 1000 ? page() : null;
      });
    }
    return page().then(function () {
      return api('/rest/v1/members?select=user_id,display_name,color&team_id=eq.' + encodeURIComponent(s.teamId));
    }).then(function (m) {
      return { clients: rows.map(fromRow), serverTime: serverTime,
        members: (m || []).map(function (x) { return { userId: x.user_id, displayName: x.display_name, color: x.color }; }) };
    });
  }

  var timer = null, polling = false, cursor = null, lastMembers = '', hiddenListener = false;
  function tick(cb, every) {
    if (!polling) return;
    if (typeof document !== 'undefined' && document.hidden) return; // reprise via visibilitychange
    var p;
    try { p = pull(cursor); } catch (e) { p = Promise.reject(e); }
    p.then(function (r) {
      if (!polling) return;
      var ms = JSON.stringify(r.members), changed = ms !== lastMembers;
      if (r.serverTime) cursor = r.serverTime;
      lastMembers = ms;
      if (r.clients.length || changed) { try { cb({ clients: r.clients, members: r.members, serverTime: r.serverTime }); } catch (e) {} }
    }).catch(function () { /* hors-ligne ou erreur : on réessaie au prochain cycle */ })
      .then(function () { if (polling && !(typeof document !== 'undefined' && document.hidden)) timer = setTimeout(function () { tick(cb, every); }, every); });
  }
  function startPolling(cb, everyMs) {
    stopPolling();
    if (!configured() || !session()) return;
    var every = everyMs || 8000;
    polling = true; cursor = null; lastMembers = '';
    if (typeof document !== 'undefined' && document.addEventListener) {
      if (hiddenListener) document.removeEventListener('visibilitychange', hiddenListener);
      hiddenListener = function () { if (polling && !document.hidden) { clearTimeout(timer); tick(cb, every); } };
      document.addEventListener('visibilitychange', hiddenListener);
    }
    tick(cb, every);
  }
  function stopPolling() {
    polling = false; clearTimeout(timer); timer = null;
    if (hiddenListener && typeof document !== 'undefined') { document.removeEventListener('visibilitychange', hiddenListener); hiddenListener = false; }
  }

  window.Cloud = { configured: configured, session: session, createTeam: createTeam, joinTeam: joinTeam, leave: leave,
    push: push, pull: pull, startPolling: startPolling, stopPolling: stopPolling };
})();
