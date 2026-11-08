/* license.js — vérification hors-ligne des licences Pro (ECDSA P-256, clé publique dans js/pubkey.js) */
(function (root) {
  'use strict';
  var LS = 'gc_license';
  var FREE_LIMIT = 30;
  var cur = { pro: false, plan: null, exp: 0, email: '', daysLeft: 0 };
  var listeners = [];

  function b64uToBytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = atob(s), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function read() { try { return root.localStorage.getItem(LS) || ''; } catch (e) { return ''; } }
  function write(v) { try { if (v) root.localStorage.setItem(LS, v); else root.localStorage.removeItem(LS); } catch (e) {} }

  /* Retourne le contenu {e,p,i,x} si la signature est valide, sinon lève une erreur lisible. */
  async function verify(key) {
    var parts = String(key || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'GC1') throw new Error('Cette clé n\'a pas le bon format.');
    if (!root.GC_PUBKEY) throw new Error('Clé publique absente de l\'appli.');
    if (!root.crypto || !root.crypto.subtle) throw new Error('Ce navigateur ne peut pas vérifier la clé (connexion non sécurisée).');
    var pk = await root.crypto.subtle.importKey('jwk', root.GC_PUBKEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    var ok = await root.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, b64uToBytes(parts[2]), new TextEncoder().encode(parts[1]));
    if (!ok) throw new Error('Clé invalide (signature incorrecte).');
    var data;
    try { data = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[1]))); } catch (e) { throw new Error('Clé illisible.'); }
    if (!data || typeof data.x !== 'number') throw new Error('Clé illisible.');
    return data;
  }
  function apply(data) {
    var left = data ? Math.ceil((data.x - Date.now()) / 86400000) : 0;
    cur = data && data.x > Date.now()
      ? { pro: true, plan: data.p, exp: data.x, email: data.e || '', daysLeft: left }
      : { pro: false, plan: data ? data.p : null, exp: data ? data.x : 0, email: data ? (data.e || '') : '', daysLeft: Math.min(0, left), expired: !!data };
    listeners.forEach(function (f) { try { f(cur); } catch (e) {} });
    return cur;
  }

  var License = {
    FREE_LIMIT: FREE_LIMIT,
    status: function () { return cur; },
    isPro: function () { return cur.pro; },
    onChange: function (f) { listeners.push(f); },
    /* À appeler au démarrage : relit la clé enregistrée et la revérifie. */
    init: async function () {
      var k = read(); if (!k) return apply(null);
      try { return apply(await verify(k)); } catch (e) { write(''); return apply(null); }
    },
    /* Active une clé saisie par l'utilisateur. Lève une Error (message en français) si invalide. */
    activate: async function (key) {
      key = String(key || '').replace(/\s+/g, '');
      var data = await verify(key);
      if (data.x <= Date.now()) throw new Error('Cette clé est expirée. Demande un renouvellement.');
      write(key); return apply(data);
    },
    remove: function () { write(''); return apply(null); },
    _verify: verify
  };
  root.License = License;
})(typeof globalThis !== 'undefined' ? globalThis : this);
