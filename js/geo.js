/* geo.js — distances, ordre de tournée, géocodage OSM (Nominatim), liens de navigation */
(function (root) {
  'use strict';
  var R = 6371;
  function rad(d) { return d * Math.PI / 180; }
  function dist(a, b) {   // km à vol d'oiseau
    var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function has(c) { return c && typeof c.lat === 'number' && typeof c.lng === 'number' && isFinite(c.lat) && isFinite(c.lng); }

  /* Plus proche voisin, puis amélioration 2-opt (suffisant pour une tournée de quelques dizaines d'arrêts).
   * start : {lat,lng} optionnel (position du livreur). Les clients sans coordonnées restent à la fin, dans l'ordre. */
  function optimize(list, start) {
    var withGeo = list.filter(has), without = list.filter(function (c) { return !has(c); });
    if (withGeo.length < 2) return list.slice();
    var left = withGeo.slice(), route = [], cur = has(start) ? start : left.shift();
    if (cur !== start) route.push(cur);
    while (left.length) {
      var bi = 0, bd = Infinity;
      for (var i = 0; i < left.length; i++) { var d = dist(cur, left[i]); if (d < bd) { bd = d; bi = i; } }
      cur = left.splice(bi, 1)[0]; route.push(cur);
    }
    var improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (var a = 0; a < route.length - 2; a++) for (var b = a + 2; b < route.length; b++) {
        var p1 = a === 0 && has(start) ? start : route[a - 1 < 0 ? 0 : a - 1];
        var before = (a === 0 ? (has(start) ? dist(start, route[0]) : 0) : dist(route[a - 1], route[a])) + (b < route.length - 1 ? dist(route[b], route[b + 1]) : 0);
        var after = (a === 0 ? (has(start) ? dist(start, route[b]) : 0) : dist(route[a - 1], route[b])) + (b < route.length - 1 ? dist(route[a], route[b + 1]) : 0);
        if (after + 1e-9 < before) { var seg = route.slice(a, b + 1).reverse(); route = route.slice(0, a).concat(seg, route.slice(b + 1)); improved = true; }
      }
    }
    return route.concat(without);
  }
  function routeLength(list, start) {
    var pts = list.filter(has); if (has(start)) pts = [start].concat(pts);
    var s = 0; for (var i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s;
  }

  function target(c) { return has(c) ? c.lat + ',' + c.lng : (c.address || c.name || ''); }
  var Nav = {
    google: function (c) { return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(target(c)) + '&travelmode=driving'; },
    waze: function (c) {
      return has(c) ? 'https://waze.com/ul?ll=' + c.lat + '%2C' + c.lng + '&navigate=yes'
                    : 'https://waze.com/ul?q=' + encodeURIComponent(c.address || c.name || '') + '&navigate=yes';
    },
    /* Itinéraire multi-arrêts Google Maps (max ~9 étapes intermédiaires). */
    googleRoute: function (list, start) {
      var stops = list.filter(function (c) { return has(c) || c.address; });
      if (!stops.length) return null;
      var dest = stops[stops.length - 1], way = stops.slice(0, -1).slice(0, 9).map(target).join('|');
      var u = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(target(dest)) + '&travelmode=driving';
      if (way) u += '&waypoints=' + encodeURIComponent(way);
      if (has(start)) u += '&origin=' + start.lat + ',' + start.lng;
      return u;
    },
    tel: function (p) { return 'tel:' + String(p || '').replace(/[^\d+]/g, ''); }
  };

  /* Géocodage (Nominatim / OpenStreetMap) : à utiliser sur action de l'utilisateur uniquement (1 requête/clic). */
  async function geocode(address) {
    var q = String(address || '').trim(); if (!q) throw new Error('Saisis d\'abord une adresse.');
    var res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=fr&q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('Service de localisation indisponible.');
    var arr = await res.json();
    if (!arr.length) throw new Error('Adresse introuvable.');
    return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), label: arr[0].display_name };
  }
  function once(opts) {
    return new Promise(function (ok, ko) {
      navigator.geolocation.getCurrentPosition(function (p) { ok({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }); }, ko, opts);
    });
  }
  /* Position actuelle : essai précis, puis repli sur une position approximative (réseau). Erreurs en français. */
  function position() {
    if (!root.navigator || !navigator.geolocation) return Promise.reject(new Error('Ce navigateur ne sait pas donner ta position.'));
    return once({ enableHighAccuracy: true, timeout: 9000, maximumAge: 15000 }).catch(function (e) {
      if (e && e.code === 1) throw e;
      return once({ enableHighAccuracy: false, timeout: 20000, maximumAge: 120000 });
    }).catch(function (e) {
      var c = e && e.code;
      throw new Error(c === 1 ? 'Localisation refusée. Clique sur le cadenas à côté de l\'adresse du site, autorise « Position », puis réessaie.'
        : c === 3 ? 'Délai dépassé. Active la localisation de l\'appareil, puis réessaie.'
        : 'Position introuvable. Vérifie que la localisation est activée (GPS sur téléphone, « Services de localisation » sous Windows).');
    });
  }
  root.Geo = { dist: dist, has: has, optimize: optimize, routeLength: routeLength, Nav: Nav, geocode: geocode, position: position };
})(typeof globalThis !== 'undefined' ? globalThis : this);
