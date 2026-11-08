/* CarnetGPS Pro — logique de l'appli (données locales + synchro équipe optionnelle) */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var LS = window.localStorage;
  function load(k, d) { try { var v = JSON.parse(LS.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { LS.setItem(k, JSON.stringify(v)); } catch (e) { toast('Stockage plein ou bloqué.'); } }

  var clients = load('gc_clients', []);     // synchronisés
  var flags = load('gc_flags', {});          // locaux : {id:{fav,today,order}}
  var me = load('gc_me', null);
  if (!me) { me = { id: 'u' + Math.random().toString(36).slice(2, 10), name: '', color: '#22c55e' }; save('gc_me', me); }
  var filter = 'all', query = '', map = null, layer = null, here = null, markers = {}, fit = true;
  var COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899', '#eab308'];

  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function live() { return clients.filter(function (c) { return !c.deleted; }); }
  function persist() { save('gc_clients', clients); save('gc_flags', flags); }
  function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.remove('hide'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add('hide'); }, 2800); }
  function fl(id) { return flags[id] || (flags[id] = {}); }
  function ownerId() { var s = window.Cloud && Cloud.session(); return s ? s.userId : me.id; }

  /* --- Synchro --- */
  function pushOne(c) { if (window.Cloud && Cloud.session()) Cloud.push([c]).catch(function (e) { if (e.code !== 'HORS_LIGNE') toast(e.userMessage || 'Synchro impossible'); }); }
  function upsert(c) {
    c.updated = new Date().toISOString();
    var i = clients.findIndex(function (x) { return x.id === c.id; });
    if (i >= 0) clients[i] = c; else clients.push(c);
    persist(); pushOne(c); render();
  }
  function merge(remote) {
    var changed = false;
    remote.forEach(function (r) {
      var i = clients.findIndex(function (x) { return x.id === r.id; });
      if (i < 0) { clients.push(r); changed = true; }
      else if (String(r.updated) > String(clients[i].updated)) { clients[i] = r; changed = true; }
    });
    if (changed) { persist(); render(); }
  }
  var members = [];
  function startSync() {
    if (!window.Cloud || !Cloud.configured() || !Cloud.session()) return;
    Cloud.startPolling(function (res) { members = res.members || members; merge(res.clients || []); if (curTab() === 'team') renderTeam(); }, 8000);
    Cloud.push(clients.filter(function (c) { return c.ownerId === ownerId(); })).catch(function () {});
  }

  /* --- Liste --- */
  function render() {
    var l = live(), q = query.toLowerCase();
    var n = l.length, lim = License.isPro() ? '' : ' / ' + License.FREE_LIMIT;
    $('#count').textContent = n + ' client' + (n > 1 ? 's' : '') + lim;
    var b = $('#badge'); b.textContent = License.isPro() ? 'PRO' : 'Gratuit'; b.className = 'badge' + (License.isPro() ? ' pro' : '');
    var rows = l.filter(function (c) {
      if (q && (c.name + ' ' + c.address + ' ' + c.phone + ' ' + c.notes).toLowerCase().indexOf(q) < 0) return false;
      if (filter === 'today') return fl(c.id).today; if (filter === 'fav') return fl(c.id).fav; if (filter === 'rep') return c.reported; return true;
    });
    if (filter === 'today') rows.sort(function (a, b) { return (fl(a.id).order || 0) - (fl(b.id).order || 0); });
    else rows.sort(function (a, b) { return a.name.localeCompare(b.name, 'fr'); });
    $('#today-actions').classList.toggle('hide', filter !== 'today' || !rows.length);
    $('#empty').classList.toggle('hide', rows.length > 0);
    $('#list').innerHTML = rows.map(function (c, i) {
      var f = fl(c.id);
      return '<li class="c" style="border-left-color:' + esc(c.ownerColor || '#334155') + '" data-id="' + c.id + '">' +
        '<div class="t"><span>' + (filter === 'today' ? (i + 1) + '. ' : '') + esc(c.name) + (c.reported ? ' ⚠' : '') + '</span><span><button class="btn sm" data-a="fav">' + (f.fav ? '★' : '☆') + '</button> <button class="btn sm" data-a="today">' + (f.today ? '📌' : '＋ Auj.') + '</button></span></div>' +
        '<div class="a">' + esc(c.address || 'Adresse non renseignée') + (Geo.has(c) ? '' : ' · <i>sans position</i>') + '</div>' +
        (c.notes ? '<div class="n">' + esc(c.notes) + '</div>' : '') +
        (c.ownerName && Cloud.session() ? '<div class="own"><span class="dot" style="background:' + esc(c.ownerColor) + '"></span>' + esc(c.ownerName) + '</div>' : '') +
        '<div class="acts"><button class="btn sm" data-a="gm">🧭 Maps</button><button class="btn sm" data-a="waze">Waze</button>' + (c.phone ? '<button class="btn sm" data-a="tel">📞</button>' : '') + '<button class="btn sm" data-a="edit">✏️</button></div></li>';
    }).join('');
    renderAlpha(rows); updateMap(rows);
  }
  function renderAlpha(rows) {
    var el = $('#alpha'); if (filter === 'today') { el.innerHTML = ''; return; }
    var seen = {}; rows.forEach(function (c) { var L = (c.name[0] || '#').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); seen[/[A-Z]/.test(L) ? L : '#'] = 1; });
    el.innerHTML = Object.keys(seen).sort().map(function (L) { return '<span data-l="' + L + '">' + L + '</span>'; }).join('');
  }
  $('#alpha').addEventListener('click', function (e) {
    var L = e.target.dataset && e.target.dataset.l; if (!L) return;
    var li = Array.prototype.find.call(document.querySelectorAll('#list li'), function (x) { var n = x.querySelector('.t span').textContent.trim()[0] || '#'; n = n.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); return (/[A-Z]/.test(n) ? n : '#') === L; });
    if (li) $('#list').scrollTop = li.offsetTop - $('#list').offsetTop;
  });
  function selectCard(id, scroll) {
    document.querySelectorAll('#list li.sel').forEach(function (x) { x.classList.remove('sel'); });
    var li = document.querySelector('#list li[data-id="' + id + '"]'); if (!li) return; li.classList.add('sel');
    if (scroll) $('#list').scrollTop = li.offsetTop - $('#list').offsetTop - 4;
  }
  $('#list').addEventListener('click', function (e) {
    var b = e.target.closest('button'); var li = e.target.closest('li'); if (!li) return;
    if (!b) { var cc = clients.find(function (x) { return x.id === li.dataset.id; }); if (cc && map && Geo.has(cc)) { map.setView([cc.lat, cc.lng], Math.max(map.getZoom(), 16)); if (markers[cc.id]) markers[cc.id].openPopup(); } selectCard(li.dataset.id, false); return; } var c = clients.find(function (x) { return x.id === li.dataset.id; }); if (!c) return;
    var a = b.dataset.a;
    if (a === 'fav') { fl(c.id).fav = !fl(c.id).fav; persist(); render(); }
    else if (a === 'today') { var f = fl(c.id); f.today = !f.today; f.order = Date.now(); persist(); render(); }
    else if (a === 'gm') window.open(Geo.Nav.google(c), '_blank');
    else if (a === 'waze') window.open(Geo.Nav.waze(c), '_blank');
    else if (a === 'tel') location.href = Geo.Nav.tel(c.phone);
    else if (a === 'edit') editor(c);
  });
  $('#q').addEventListener('input', function (e) { query = e.target.value; fit = true; render(); });
  document.querySelectorAll('.chip').forEach(function (b) { b.onclick = function () { document.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); filter = b.dataset.f; fit = true; render(); }; });
  $('#add').onclick = function () { if (!License.isPro() && live().length >= License.FREE_LIMIT) return upsell('Tu as atteint ' + License.FREE_LIMIT + ' clients (limite gratuite).'); editor(null); };

  /* --- Tournée --- */
  function todayList() { return live().filter(function (c) { return fl(c.id).today; }).sort(function (a, b) { return (fl(a.id).order || 0) - (fl(b.id).order || 0); }); }
  $('#optim').onclick = async function () {
    if (!License.isPro()) return upsell('L\'optimisation de tournée est une fonction Pro.');
    var list = todayList(), start = null; try { start = await Geo.position(); } catch (e) { toast('Position indisponible : départ = 1er client.'); }
    var before = Geo.routeLength(list, start), out = Geo.optimize(list, start), after = Geo.routeLength(out, start);
    out.forEach(function (c, i) { fl(c.id).order = i + 1; }); persist(); render();
    toast(before > after + 0.05 ? 'Tournée optimisée : −' + (before - after).toFixed(1) + ' km à vol d\'oiseau' : 'Ordre déjà bon.');
  };
  $('#gmroute').onclick = async function () {
    var list = todayList(); if (!list.length) return;
    var s = null; try { s = await Geo.position(); } catch (e) {}
    var u = Geo.Nav.googleRoute(list, s); if (u) window.open(u, '_blank');
    if (list.length > 10) toast('Google Maps limite à ~10 arrêts : les premiers sont envoyés.');
  };

  /* --- Fiche client --- */
  function modal(html) { $('#sheet').innerHTML = html; $('#modal').classList.remove('hide'); }
  function closeModal() { $('#modal').classList.add('hide'); }
  $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal') closeModal(); });
  function editor(c) {
    var n = !c; c = c || { id: uid(), name: '', address: '', phone: '', notes: '', lat: null, lng: null, reported: false, deleted: false };
    modal('<h2>' + (n ? 'Nouveau client' : 'Modifier') + '</h2>' +
      '<label>Nom</label><input id="f-name" value="' + esc(c.name) + '"><label>Adresse</label><input id="f-addr" value="' + esc(c.address) + '">' +
      '<div class="row"><button class="btn" id="f-geo">📍 Localiser l\'adresse</button><button class="btn" id="f-here">🎯 Ma position</button></div><p class="muted" id="f-pos">' + (Geo.has(c) ? 'Position : ' + c.lat.toFixed(5) + ', ' + c.lng.toFixed(5) : 'Pas encore de position (nécessaire pour la carte et la tournée).') + '</p>' +
      '<label>Téléphone</label><input id="f-tel" type="tel" value="' + esc(c.phone) + '"><label>Notes (code porte, étage, chien…)</label><textarea id="f-notes">' + esc(c.notes) + '</textarea>' +
      '<label><input type="checkbox" id="f-rep" style="width:auto"' + (c.reported ? ' checked' : '') + '> ⚠ Adresse à signaler (introuvable / difficile)</label>' +
      '<div class="row"><button class="btn pri" id="f-ok">Enregistrer</button><button class="btn" id="f-no">Annuler</button></div>' + (n ? '' : '<div class="row"><button class="btn danger" id="f-del">Supprimer</button></div>'));
    var pos = { lat: c.lat, lng: c.lng };
    $('#f-geo').onclick = async function () { try { var r = await Geo.geocode($('#f-addr').value); pos = r; $('#f-pos').textContent = '✔ ' + r.label; } catch (e) { toast(e.message); } };
    $('#f-here').onclick = async function () { try { pos = await Geo.position(); $('#f-pos').textContent = '✔ Position actuelle : ' + pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5); } catch (e) { toast(e.message); } };
    $('#f-no').onclick = closeModal;
    $('#f-ok').onclick = function () {
      var name = $('#f-name').value.trim(); if (!name) return toast('Le nom est obligatoire.');
      var s = window.Cloud && Cloud.session();
      c.name = name; c.address = $('#f-addr').value.trim(); c.phone = $('#f-tel').value.trim(); c.notes = $('#f-notes').value.trim();
      c.reported = $('#f-rep').checked; c.lat = pos.lat == null ? null : pos.lat; c.lng = pos.lng == null ? null : pos.lng;
      if (n) { c.ownerId = ownerId(); c.ownerName = s ? s.displayName : me.name; c.ownerColor = s ? s.color : me.color; }
      upsert(c); closeModal();
    };
    var d = $('#f-del'); if (d) d.onclick = function () { if (confirm('Supprimer « ' + c.name + ' » ?')) { c.deleted = true; upsert(c); closeModal(); } };
  }
  function upsell(msg) {
    var C = window.GC_CONFIG || {};
    modal('<h2>🚀 Passe en Pro</h2><p>' + esc(msg) + '</p><div class="card"><p>✔ Clients illimités</p><p>✔ Équipe jusqu\'à 10 personnes (adresses partagées)</p><p>✔ Import / export CSV</p><p>✔ Tournée optimisée</p><p class="price">4,99 €/mois <span class="muted" style="font-size:14px">ou 39 €/an</span></p></div>' +
      (C.payLinkMonthly ? '<div class="row"><a class="btn pri" style="text-align:center;text-decoration:none" target="_blank" href="' + esc(C.payLinkMonthly) + '">Mensuel</a>' + (C.payLinkYearly ? '<a class="btn" style="text-align:center;text-decoration:none" target="_blank" href="' + esc(C.payLinkYearly) + '">Annuel</a>' : '') + '</div>' : '<p class="muted">Contact : ' + esc(C.contact || '') + '</p>') +
      '<div class="row"><button class="btn" id="u-key">J\'ai une clé</button><button class="btn" id="u-no">Plus tard</button></div>');
    $('#u-no').onclick = closeModal; $('#u-key').onclick = function () { closeModal(); tab('set'); };
  }

  /* --- Carte (toujours visible au-dessus de la liste) --- */
  function updateMap(rows) {
    if (!window.L) return;
    if (!map) { map = L.map('map', { zoomControl: false }).setView([14.64, -61.02], 11); L.control.zoom({ position: 'topright' }).addTo(map); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map); layer = L.layerGroup().addTo(map); }
    layer.clearLayers(); markers = {}; var pts = [];
    rows.filter(Geo.has).forEach(function (c) {
      var m = L.circleMarker([c.lat, c.lng], { radius: 10, color: '#fff', weight: 2, fillColor: c.reported ? '#ef4444' : (c.ownerColor || '#22c55e'), fillOpacity: 1 }).addTo(layer);
      m.bindPopup('<b>' + esc(c.name) + '</b><br>' + esc(c.address) + '<br><a target="_blank" href="' + Geo.Nav.google(c) + '">Google Maps</a> · <a target="_blank" href="' + Geo.Nav.waze(c) + '">Waze</a>');
      m.on('click', function () { selectCard(c.id, true); }); markers[c.id] = m; pts.push([c.lat, c.lng]);
    });
    setTimeout(function () { map.invalidateSize(); if (fit && pts.length) { map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 }); fit = false; } }, 60);
  }
  window.addEventListener('resize', function () { if (map) map.invalidateSize(); });

  /* --- Équipe --- */
  function renderTeam() {
    var el = $('#team'), s = window.Cloud && Cloud.session(), C = window.GC_CONFIG || {};
    if (!window.Cloud || !Cloud.configured()) { el.innerHTML = '<div class="card"><h3>🤝 Équipe</h3><p>Partage tes adresses avec tes collègues en temps réel.</p><p class="muted">La synchronisation n\'est pas encore activée sur cette installation.</p></div>'; return; }
    if (s) {
      el.innerHTML = '<div class="card"><h3>' + esc(s.teamName) + '</h3><p>Code à donner à tes collègues :</p><p class="code">' + esc(s.joinCode) + '</p></div><div class="card"><h3>Membres</h3>' +
        (members.length ? members.map(function (m) { return '<p><span class="dot" style="background:' + esc(m.color) + '"></span>' + esc(m.display_name || m.displayName || m.name || '') + '</p>'; }).join('') : '<p class="muted">Chargement…</p>') + '</div><button class="btn danger" id="t-leave">Quitter l\'équipe</button>';
      $('#t-leave').onclick = function () { if (confirm('Quitter l\'équipe ? Tes clients restent sur ce téléphone.')) { Cloud.leave(); renderTeam(); } };
      return;
    }
    var col = COLORS.map(function (c) { return '<option value="' + c + '"' + (c === me.color ? ' selected' : '') + ' style="color:' + c + '">● ' + c + '</option>'; }).join('');
    el.innerHTML = '<div class="card"><h3>Ton nom dans l\'équipe</h3><input id="t-name" placeholder="Ex : Marc" value="' + esc(me.name) + '"><label>Ta couleur</label><select id="t-col">' + col + '</select></div>' +
      '<div class="card"><h3>Rejoindre une équipe</h3><input id="t-code" placeholder="Code (6 caractères)" maxlength="8" style="text-transform:uppercase"><div class="row"><button class="btn pri" id="t-join">Rejoindre (gratuit)</button></div></div>' +
      '<div class="card"><h3>Créer une équipe <span class="badge pro">PRO</span></h3><input id="t-tname" placeholder="Nom de l\'équipe"><div class="row"><button class="btn" id="t-create">Créer</button></div></div>';
    function ident() { var n = $('#t-name').value.trim(); if (!n) { toast('Indique ton nom.'); return null; } me.name = n; me.color = $('#t-col').value; save('gc_me', me); return me; }
    async function go(p) { try { await p; toast('Équipe connectée ✔'); clients.forEach(function (c) { if (c.ownerId === me.id) { c.ownerId = ownerId(); } }); startSync(); renderTeam(); } catch (e) { toast(e.userMessage || e.message); } }
    $('#t-join').onclick = function () { var m = ident(); if (m) go(Cloud.joinTeam($('#t-code').value, m.name, m.color)); };
    $('#t-create').onclick = function () { if (!License.isPro()) return upsell('Créer une équipe est une fonction Pro.'); var m = ident(), tn = $('#t-tname').value.trim(); if (m && !tn) return toast('Donne un nom à l\'équipe.'); if (m) go(Cloud.createTeam(tn, m.name, m.color)); };
  }

  /* --- Réglages / Pro --- */
  function csvEsc(v) { v = String(v == null ? '' : v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function parseCSV(t) {
    t = t.replace(/^﻿/, ''); var sep = (t.split('\n')[0].match(/;/g) || []).length >= (t.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < t.length; i++) { var ch = t[i];
      if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === sep) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(function (x) { return x.trim(); })) rows.push(row); row = []; }
      else cur += ch; }
    row.push(cur); if (row.some(function (x) { return x.trim(); })) rows.push(row); return rows;
  }
  function importCSV(text) {
    var rows = parseCSV(text); if (rows.length < 2) return toast('Fichier vide.');
    var h = rows[0].map(function (x) { return x.trim().toLowerCase(); });
    function ix(names) { for (var i = 0; i < h.length; i++) if (names.indexOf(h[i]) >= 0) return i; return -1; }
    var iN = ix(['nom', 'name', 'client']), iA = ix(['adresse', 'address']), iT = ix(['telephone', 'téléphone', 'tel', 'phone']), iNo = ix(['notes', 'note']), iLa = ix(['lat', 'latitude']), iLn = ix(['lng', 'lon', 'longitude']);
    if (iN < 0) return toast('Colonne « nom » introuvable.');
    var s = window.Cloud && Cloud.session(), add = [];
    rows.slice(1).forEach(function (r) { if (!(r[iN] || '').trim()) return;
      var la = iLa >= 0 ? parseFloat(String(r[iLa]).replace(',', '.')) : NaN, ln = iLn >= 0 ? parseFloat(String(r[iLn]).replace(',', '.')) : NaN;
      add.push({ id: uid(), name: r[iN].trim(), address: iA >= 0 ? (r[iA] || '').trim() : '', phone: iT >= 0 ? (r[iT] || '').trim() : '', notes: iNo >= 0 ? (r[iNo] || '').trim() : '', lat: isFinite(la) ? la : null, lng: isFinite(ln) ? ln : null, reported: false, deleted: false, updated: new Date().toISOString(), ownerId: ownerId(), ownerName: s ? s.displayName : me.name, ownerColor: s ? s.color : me.color }); });
    add.forEach(function (c) { clients.push(c); }); persist(); if (window.Cloud && Cloud.session()) Cloud.push(add).catch(function () {}); render(); toast(add.length + ' client(s) importé(s).');
  }
  function exportCSV() {
    var head = 'nom;adresse;telephone;notes;lat;lng', body = live().map(function (c) { return [c.name, c.address, c.phone, c.notes, c.lat, c.lng].map(csvEsc).join(';'); });
    var blob = new Blob(['﻿' + head + '\n' + body.join('\n')], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'clients-carnetgps.csv'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function renderSettings() {
    var st = License.status(), C = window.GC_CONFIG || {};
    var h = '<div class="card"><h3>' + (st.pro ? '✅ Pro actif' : 'Version gratuite') + '</h3>' +
      (st.pro ? '<p>Plan : ' + esc(st.plan) + ' · expire dans ' + st.daysLeft + ' jour(s)</p><p class="muted">' + esc(st.email) + '</p>' : (st.expired ? '<p style="color:var(--o)">Ta licence a expiré. Renouvelle-la pour retrouver les fonctions Pro.</p>' : '<p>Jusqu\'à ' + License.FREE_LIMIT + ' clients, carte, navigation Maps/Waze.</p>')) + '</div>';
    if (!st.pro) h += '<div class="card"><h3>Passer en Pro — 4,99 €/mois</h3><p>Clients illimités · équipe · CSV · tournée optimisée</p>' + (C.payLinkMonthly ? '<div class="row"><a class="btn pri" style="text-align:center;text-decoration:none" target="_blank" href="' + esc(C.payLinkMonthly) + '">Mensuel 4,99 €</a>' + (C.payLinkYearly ? '<a class="btn" style="text-align:center;text-decoration:none" target="_blank" href="' + esc(C.payLinkYearly) + '">Annuel 39 €</a>' : '') + '</div>' : '<p class="muted">Contact : ' + esc(C.contact || '') + '</p>') + '</div>';
    h += '<div class="card"><h3>Clé de licence</h3><textarea id="s-key" placeholder="GC1.…"></textarea><div class="row"><button class="btn pri" id="s-act">Activer</button>' + (st.pro || st.expired ? '<button class="btn" id="s-rm">Retirer</button>' : '') + '</div></div>' +
      '<div class="card"><h3>Données ' + (License.isPro() ? '' : '<span class="badge">PRO</span>') + '</h3><div class="row"><button class="btn" id="s-imp">⬆ Importer CSV</button><button class="btn" id="s-exp">⬇ Exporter CSV</button></div><input type="file" id="s-file" accept=".csv,text/csv" class="hide"><p class="muted">Colonnes : nom;adresse;telephone;notes;lat;lng</p></div>' +
      '<div class="card"><h3>Confidentialité</h3><p class="muted">Tes clients restent sur ton téléphone. Ils ne sont envoyés à un serveur que si tu rejoins une équipe. Aucune publicité, aucune revente de données. L\'adresse saisie est envoyée à OpenStreetMap uniquement quand tu appuies sur « Localiser ».</p></div>';
    $('#settings').innerHTML = h;
    $('#s-act').onclick = async function () { try { await License.activate($('#s-key').value); toast('Pro activé 🎉'); } catch (e) { toast(e.message); } };
    var rm = $('#s-rm'); if (rm) rm.onclick = function () { if (confirm('Retirer la licence de cet appareil ?')) License.remove(); };
    $('#s-imp').onclick = function () { if (!License.isPro()) return upsell('L\'import CSV est une fonction Pro.'); $('#s-file').click(); };
    $('#s-file').onchange = function (e) { var f = e.target.files[0]; if (f) f.text().then(importCSV); };
    $('#s-exp').onclick = function () { if (!License.isPro()) return upsell('L\'export CSV est une fonction Pro.'); exportCSV(); };
  }

  /* --- Onglets --- */
  function curTab() { var b = document.querySelector('nav button.on'); return b ? b.dataset.t : 'clients'; }
  function tab(t) {
    document.querySelectorAll('nav button').forEach(function (b) { b.classList.toggle('on', b.dataset.t === t); });
    document.querySelectorAll('.tab').forEach(function (s) { s.classList.toggle('on', s.id === 'tab-' + (t === 'set' ? 'set' : t)); });
    if (t === 'team') renderTeam(); if (t === 'set') renderSettings(); if (t === 'clients') { render(); if (map) setTimeout(function () { map.invalidateSize(); }, 80); }
  }
  document.querySelectorAll('nav button').forEach(function (b) { b.onclick = function () { tab(b.dataset.t); }; });
  License.onChange(function () { render(); if (curTab() === 'set') renderSettings(); });

  License.init().then(function () { render(); startSync(); });
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) navigator.serviceWorker.register('sw.js').catch(function () {});
  window.GC_DEBUG = { clients: function () { return clients; }, tab: tab, editor: editor };
})();
