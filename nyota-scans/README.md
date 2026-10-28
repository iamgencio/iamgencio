<p align="center"><img src="brand/logo.svg" alt="Nyota Scans" width="360"></p>

# Nyota Scans

**Le Netflix des mangas et des BD africaines** — une plateforme éditée et lancée par **Starlight Network**.
*Chaque histoire est une étoile.* (Nyota = « étoile » en swahili.)

## Fonctionnalités (MVP)
- Accueil façon streaming : vedette + rangées (tendances, BD africaines, nouveautés, mangas, manhwas)
- Catalogue avec recherche, filtres (type, genre) et tri
- Fiche série, liste de chapitres, **lecteur vertical** avec reprise de lecture automatique
- Comptes lecteur / créateur / admin (JWT), favoris, historique
- **Premium** : chapitres verrouillés (aperçu de 2 pages) débloqués par abonnement
- **Paiement Mobile Money via FeexPay** (MTN, Moov, Orange, Wave, Celtiis) avec webhook et statut en temps réel
- **Espace créateur** : création de série, upload de couverture et de pages, soumission
- **Admin** : statistiques, file de validation, mise à la une, dépublication
- Modèle de contenu **licencié / publié par les créateurs** uniquement

## Architecture
```
brand/   logo, charte graphique (BRAND.md)
api/     API PHP 8.1+ (sans framework) + MySQL — routes dans public/index.php
web/     Next.js 14 (App Router, TypeScript)
```

## Démarrage rapide
```bash
# 1. API + base (Docker)
docker compose up            # MySQL + API sur http://localhost:8080 (schéma + données de démo)

# …ou sans Docker
cd api && cp .env.example .env     # renseigner DB_*
php bin/migrate.php --seed
php -S localhost:8080 -t public public/index.php

# 2. Front
cd web && cp .env.example .env.local && npm install && npm run dev   # http://localhost:3000
```
Comptes de démo (mot de passe `Nyota2026!`) : `admin@starlight.network`, `creator@starlight.network`, `reader@starlight.network`.
Les couvertures et planches de démonstration sont générées automatiquement (œuvres fictives).

## Paiements FeexPay
`FEEXPAY_MODE=mock` (défaut) simule un paiement réussi. En production :
```
FEEXPAY_MODE=live
FEEXPAY_TOKEN=...          # clé API
FEEXPAY_SHOP_ID=...
FEEXPAY_WEBHOOK_SECRET=... # callback : https://api.votre-domaine/payments/webhook?secret=...
```
Tous les appels FeexPay sont isolés dans `api/src/FeexPay.php`. **À vérifier avant la mise en production** :
les chemins et noms de champs ont été écrits d'après la documentation publique et n'ont pas pu être testés
contre l'API réelle — comparez avec https://docs.feexpay.me et testez en sandbox. Le webhook ne fait jamais
confiance au corps reçu : il revérifie le statut auprès de FeexPay avant d'activer l'abonnement.

## Sécurité & production
Changer `APP_SECRET`, servir l'API et le front en HTTPS, restreindre `WEB_ORIGIN`, servir `/uploads` via nginx,
sauvegardes MySQL. Pistes suivantes : stockage S3/CDN, filigrane des pages, limitation de débit,
vérification d'email, i18n (FR/EN), app mobile, paiement par carte.

© Starlight Network
