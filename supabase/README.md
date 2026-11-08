# Configurer le cloud de CarnetGPS Pro (Supabase)

Compte gratuit suffisant pour démarrer. Compte 15 minutes.

## 1. Créer le projet (région UE obligatoire)
1. Va sur https://supabase.com, crée un compte, puis **New project**.
2. Donne un nom (ex. `carnetgps-pro`) et un mot de passe de base de données (garde-le).
3. **Region** : choisis une région **Europe** (ex. *West EU (Paris)* ou *Frankfurt*). Ne choisis pas une région hors UE.
4. Clique **Create new project** et attends 1 à 2 minutes.

## 2. Activer la connexion anonyme
**Authentication > Sign In / Providers** (ou *Settings*) : active **Allow anonymous sign-ins**, puis **Save**.
(Les utilisateurs n'ont ni e-mail ni mot de passe.)

## 3. Créer les tables
1. Menu **SQL Editor > New query**.
2. Copie tout le contenu de `supabase/schema.sql`, colle-le, clique **Run**.
3. Tu dois voir « Success. No rows returned ». Le script peut être relancé sans danger.

## 4. Copier l'URL et la clé dans config.js
**Project Settings > API** : copie *Project URL* et la clé **anon public** (jamais la `service_role` !). Dans `config.js` :

```js
window.GC_CONFIG = {
  supabaseUrl: 'https://xxxxxxxx.supabase.co',
  anonKey: 'eyJ...'
};
```
La clé anon est faite pour être publique : la sécurité repose sur les règles RLS du schéma.

## 5. Vérifier
1. Ouvre l'appli, crée une équipe : un code de 6 caractères s'affiche.
2. Sur un 2e téléphone (ou navigateur privé), rejoins avec ce code.
3. Ajoute un client sur l'un : il apparaît sur l'autre en ~8 secondes.
4. Dans Supabase **Table Editor** : tables `teams`, `members`, `clients` remplies.
Si le code est refusé : vérifie l'étape 2 (connexion anonyme) et que le SQL s'est bien exécuté.

## Avertissement RGPD
Les noms, adresses et téléphones des clients des livreurs sont des **données personnelles**.
- Garde le projet en **région UE** et informe les utilisateurs de l'usage fait des données.
- **Minimisation** : ne stocke que le nécessaire (nom, adresse, téléphone, consigne de livraison).
- **Aucune donnée de santé** (ex. pathologie, matériel médical d'une personne) dans les notes.
- Supprime les données d'un client sur demande ; limite l'accès aux membres de confiance (code d'équipe = secret).
