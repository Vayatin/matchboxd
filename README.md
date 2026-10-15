# Matchboxd

Tu donnes ton pseudo Letterboxd, Matchboxd lit tes notes et te recommande des films.

## Lancer

```bash
node nextreel/server.js
```

Puis ouvre http://localhost:3000 (ou `http://localhost:3000/?u=pseudo` pour lancer direct une analyse).

Aucune dépendance, ni clé API : Node 18+ suffit.

## Mise en ligne (Render)

1. `npm run preparer-github` crée `../matchboxd-github/` : le projet sans le cache.
2. Sur GitHub, créer un dépôt `matchboxd` et y glisser le contenu de ce dossier (« uploading an existing file »).
3. Sur Render : **New → Blueprint**, choisir le dépôt. `render.yaml` crée le service web (Node, offre gratuite, Francfort, vérification sur `/healthz`).
4. Le site est servi sur `https://<nom>.onrender.com`. L'extension téléchargée depuis `/extension.zip` est réglée automatiquement sur cette adresse (ou sur `PUBLIC_URL` si défini).

Variables d'environnement utiles : `PORT`, `PUBLIC_URL`, `CACHE_DIR` (disque persistant), `MAX_RUNNING` (analyses simultanées, 3 par défaut), `RATE_MAX` (analyses par visiteur / 10 min, 10 par défaut), `MAX_OUTGOING` (requêtes simultanées vers Letterboxd, 8 par défaut).

Protections en place : file d'attente globale, une analyse à la fois par visiteur, limite par tranche de 10 min, plafond de requêtes vers Letterboxd partagé entre tous les visiteurs, caches mémoire bornés, en-têtes de sécurité, page 404, proxy d'images limité au CDN de Letterboxd.

## Comment ça marche

- `lib/letterboxd.js` lit les pages publiques de Letterboxd : la 1re page de `/{pseudo}/films/`, le flux RSS, et les fiches `/film/{slug}/` (genres, réal, casting, pays, « Similar Films »). Les fiches sont mises en cache dans `cache/films.json`.
- `lib/taste.js` (v2) :
  - **Profil** : poids de chaque film = ta note − ce qu'on attendrait de toi pour ce film (ta moyenne, ajustée par sa note Letterboxd : un navet noté bas ne compte pas contre son genre), + bonus si liké, centré. Pour les genres, s'ajoute une « habitude » : ta part du genre comparée à sa fréquence habituelle (`GENRE_BASE`), pour qu'un genre très regardé mais noté durement (ex. horreur) reste un goût. Affinités par genre, réalisateur, acteur, pays, langue, décennie et niveau de popularité (pépite → blockbuster, d'après le nombre de notes Letterboxd).
  - **Candidats**, 3 sources : « Similar Films » de tes films (+ si aimé, − si détesté), filmographies de tes réalisateurs préférés (`/director/{slug}/`) et de tes acteurs préférés (`/actor/{slug}/`).
  - **Score** = votes des sources + ressemblance avec le profil + note Letterboxd corrigée par le nombre de notes (moyenne bayésienne) + bonus watchlist. Puis diversification (pénalité par réalisateur / saga déjà proposés). Vivier de ~160 films.
  - Aussi : films évités, watchlist classée, pépites (seuil relatif à tes habitudes), avis à contre-courant.
- Effets visuels (règle : chaque animation explique quelque chose ou marque un moment) : couleur dominante de l'affiche extraite par canvas (fiche teintée, lueur au survol), couleur par genre (`GENRE_COLORS`), jauge de compatibilité, frise d'étapes pendant le chargement, profil écrit à la machine, masquage animé + notification « Annuler », rangs dans la watchlist, infos au survol des affiches. Tout est coupé si le système demande de réduire les animations.
- `public/fx.js` : mur d'affiches de l'accueil (`/api/wall`, films populaires du cache), bobine d'affiches pendant l'analyse (le serveur joint l'affiche du film lu à chaque événement de progression), inclinaison 3D + reflet au survol, ambiance de couleur (deux calques en fondu : genre choisi, film ouvert), carte d'identité ciné générée en canvas (PNG 1080×1350, téléchargement / partage).
- `public/app.js` : onglets Pour toi (filtres genre / époque / durée, « Voir plus »), Par genre, Tes réalisateurs, Pépites, Ta watchlist ; « Surprends-moi » ; « Déjà vu » / « Pas pour moi » (mémorisés dans le navigateur).
- `server.js` sert la page, envoie la progression en direct (SSE) et fait proxy pour les affiches.

## Modes

- **Pseudo + extension Chrome** (recommandé) : `extension/` (Manifest V3). Installation : `chrome://extensions` → Mode développeur → « Charger l'extension non empaquetée » → dossier `nextreel/extension`. Quand on clique sur « Analyser mon profil », la page demande à l'extension (pont `content.js` ↔ `background.js`) de lire toutes les pages de `/{pseudo}/films/` (+ 8 pages de watchlist) avec le navigateur de l'utilisateur. Si Letterboxd refuse les lectures en arrière-plan, l'extension relit dans un onglet Letterboxd ouvert en arrière-plan puis le ferme. En cas d'échec, la page retombe sur le mode pseudo seul.

- **Favori « Lire tout mon profil »** (recommandé) : un bookmarklet (`public/bookmarklet.js`, transformé en lien `javascript:` par la page). Cliqué depuis letterboxd.com, il lit toutes les pages de `/{pseudo}/films/` (+ 8 pages de watchlist) depuis le navigateur de l'utilisateur, puis ouvre Matchboxd avec la liste compressée (gzip + base64url) dans le `#import=…` de l'adresse. Profil complet, aucune dépendance au mode d'ouverture des onglets.

- **Pseudo** : rapide, mais Letterboxd protège la plupart de ses pages derrière Cloudflare : seule la 1re page de la liste (+ le RSS) est lisible, soit ~100 films. Pour ne jamais recommander un film déjà vu, chaque candidat est vérifié sur `/{pseudo}/film/{slug}/` (200 = vu, avec la note dans `reviewRating` ; 404 = pas vu). Les films découverts « déjà vus » enrichissent le profil, et seuls les films vérifiés « pas vus » sont recommandables. Le profil reste partiel (bandeau affiché avec l'estimation du total via la pagination).
- **Export** (Settings → Data → Export your data sur letterboxd.com) : on dépose le .zip. Il est lu dans le navigateur (`public/export.js`, décompression native, pas de dépendance) ; seuls titres, années, notes, likes et liens courts `boxd.it` sont envoyés au serveur.
  - Les 400 films les plus parlants (notes les plus éloignées de ta moyenne, likes) sont analysés en détail ; les liens `boxd.it` sont résolus en slugs et mis en cache (`cache/links.json`).
  - Moyenne et histogramme des notes sont calculés sur toutes tes notes.
  - Tous les films vus sont exclus des recos (comparaison titre + année), et les films de ta watchlist sont signalés et légèrement favorisés.
