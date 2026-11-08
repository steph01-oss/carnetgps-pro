#!/usr/bin/env node
/* Licences CarnetGPS Pro — signature ECDSA P-256 (aucun serveur nécessaire pour vendre les premières licences).
 *
 *   node tools/make-key.js init [--force]                 crée TA paire de clés : tools/private-key.json (SECRET, ne jamais publier)
 *                                                          et js/pubkey.js (publique, dans l'appli)
 *   node tools/make-key.js issue <email> <plan> [--days N] fabrique une clé à envoyer au client
 *        plan : monthly (35 jours) | yearly (370 jours) | trial (7 jours) | founder (3650 jours)
 *   node tools/make-key.js check <clé>                     vérifie une clé et affiche son contenu
 *
 * Important : si tu refais `init`, toutes les clés déjà vendues deviennent invalides.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const PRIV = path.join(__dirname, 'private-key.json');
const PUBJS = path.join(root, 'js', 'pubkey.js');
const b64u = b => Buffer.from(b).toString('base64url');
const DAYS = { monthly: 35, yearly: 370, trial: 7, founder: 3650 };

function init(force) {
  if (fs.existsSync(PRIV) && !force) { console.error('private-key.json existe déjà. Utilise --force pour la remplacer (les clés déjà vendues seront invalides).'); process.exit(1); }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  fs.writeFileSync(PRIV, JSON.stringify(privateKey.export({ format: 'jwk' }), null, 2), { mode: 0o600 });
  const pub = publicKey.export({ format: 'jwk' });
  fs.writeFileSync(PUBJS, '/* Clé PUBLIQUE de vérification des licences (générée par tools/make-key.js init) */\nwindow.GC_PUBKEY = ' + JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }) + ';\n');
  console.log('✔ Clés créées. Garde tools/private-key.json en lieu sûr (ne le mets JAMAIS sur GitHub). js/pubkey.js est public.');
}
function issue(email, plan, days) {
  if (!fs.existsSync(PRIV)) { console.error('Lance d\'abord : node tools/make-key.js init'); process.exit(1); }
  if (!email || !DAYS[plan]) { console.error('Usage : issue <email> <monthly|yearly|trial|founder> [--days N]'); process.exit(1); }
  const now = Date.now(), d = days || DAYS[plan];
  const payload = b64u(JSON.stringify({ e: email, p: plan, i: now, x: now + d * 86400000 }));
  const key = crypto.createPrivateKey({ key: JSON.parse(fs.readFileSync(PRIV, 'utf8')), format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' });
  const out = 'GC1.' + payload + '.' + b64u(sig);
  console.log(out); console.error('→ plan ' + plan + ', valable jusqu\'au ' + new Date(now + d * 86400000).toLocaleDateString('fr-FR'));
  return out;
}
function check(k) {
  const p = String(k).trim().split('.'); if (p.length !== 3 || p[0] !== 'GC1') { console.error('Format invalide'); process.exit(1); }
  const pubJwk = JSON.parse(fs.readFileSync(PUBJS, 'utf8').replace(/^[\s\S]*?window\.GC_PUBKEY = /, '').replace(/;\s*$/, ''));
  const pub = crypto.createPublicKey({ key: pubJwk, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(p[1]), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(p[2], 'base64url'));
  const data = JSON.parse(Buffer.from(p[1], 'base64url').toString());
  console.log(ok ? 'Signature VALIDE' : 'Signature INVALIDE', data, 'expire le', new Date(data.x).toLocaleString('fr-FR'));
}
module.exports = { issue };
if (require.main === module) {
  const a = process.argv.slice(2), cmd = a[0];
  const di = a.indexOf('--days'); const days = di >= 0 ? parseInt(a[di + 1], 10) : 0;
  if (cmd === 'init') init(a.includes('--force'));
  else if (cmd === 'issue') issue(a[1], a[2], days);
  else if (cmd === 'check') check(a[1]);
  else console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).join('\n'));
}
