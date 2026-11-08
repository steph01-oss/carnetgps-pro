# CarnetGPS Pro
PWA carnet d'adresses clients (livreurs / artisans). Gratuit ≤30 clients, Pro 4,99 €/mois ou 39 €/an.

## Lancer en local
`python3 -m http.server 8000` puis http://localhost:8000

## Mettre en ligne (GitHub Pages)
1. Nouveau dépôt GitHub public, y mettre TOUT sauf `tools/private-key.json` et `gtm/`.
2. Settings → Pages → Branch main / root. URL : https://TON-PSEUDO.github.io/carnetgps-pro/

## Vendre une licence
`node tools/make-key.js issue client@mail.fr monthly` → envoyer la clé au client (plans: monthly, yearly, trial, founder).
Garde `tools/private-key.json` SECRET et sauvegardé (si perdu : refaire `init` = toutes les clés vendues invalides).

## Équipe (optionnel)
Suivre supabase/README.md puis renseigner config.js (supabaseUrl, anonKey, payLinkMonthly, payLinkYearly, contact).
