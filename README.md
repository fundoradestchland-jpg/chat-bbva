# Chat Fundora

Un premier espace de discussion privé entre les clients et l’équipe Fundora. Les clients créent leur compte avec leur nom et un mot de passe ; l’équipe se connecte séparément pour consulter la boîte de réception et répondre.

## Démarrer sur votre ordinateur

Utilisez Node.js 20 ou une version plus récente. Remplissez d’abord `.env` avec vos secrets locaux, puis lancez depuis ce dossier :

```powershell
npm start
```

Ouvrez ensuite [http://localhost:3000](http://localhost:3000). Pour accéder à la boîte de réception, sélectionnez **Admin Fundora** et saisissez **BEN ANT** et **ben@2006** ; ses réponses s’affichent sous le nom **Fundora**. Les clients choisissent **Créer mon espace** une seule fois, puis utilisent ensuite le même nom et le même mot de passe pour retrouver leurs conversations. Un mot de passe incorrect n’ouvre pas leur compte.

Sans `DATABASE_URL`, les comptes et messages restent enregistrés dans `data/fundora.json` et les pièces jointes dans `data/attachments`.

## Connecter PostgreSQL

Dans le fichier `.env` à la racine du projet, configurez `DATABASE_URL` avec l’URL PostgreSQL privée fournie par Neon, ainsi que le mot de passe administrateur :

```dotenv
DATABASE_URL=collez_ici_votre_url_neon
FUNDORA_STAFF_NAME=BEN ANT
FUNDORA_STAFF_PASSWORD=choisissez_un_mot_de_passe_long
```

Ne partagez pas cette URL et ne la mettez jamais dans le code. Le fichier `.env` est exclu de Git ; remplacez les valeurs vides présentes dans le fichier créé pour vous avant de démarrer. Si le mot de passe de la base contient des caractères réservés à une URL, utilisez l’URL de connexion complète copiée depuis Neon.

Le serveur crée automatiquement ses tables et index au premier démarrage. Si la base est vide et que `data/fundora.json` existe, les comptes, messages, états de lecture et pièces jointes sont importés dans une transaction. Les fichiers locaux restent en place : cette importation ne les supprime pas. Si la base contient déjà des comptes sans historique de migration Fundora, le démarrage s’arrête au lieu d’écraser ou de mélanger les données ; utilisez une base vide pour l’import automatique. Les nouveaux fichiers (jusqu’à 4 Mo) sont stockés dans PostgreSQL, ils ne dépendent donc pas du disque éphémère de l’hébergeur. Cette limite réduit les échecs de téléversement sur Vercel, dont la taille maximale des requêtes est limitée.

Le chargement de `.env` est automatique avec `npm start`. Si la connexion échoue, le serveur affiche l’erreur et ne bascule pas silencieusement vers le stockage JSON.

Les mots de passe des clients sont stockés sous forme de dérivés cryptographiques salés, et non en clair. Le mot de passe de l’équipe est fourni par variable d’environnement et n’est pas enregistré dans ce fichier. Ne publiez aucun mot de passe avec le code.

## Tests

```powershell
npm test
```

## Mise en ligne

Pour déployer sur Vercel, liez ce dossier du projet à votre dépôt GitHub et importez-le dans Vercel. La configuration `vercel.json` envoie les requêtes à la fonction Node `api/index.js`, qui sert aussi les fichiers de `public/`. Dans **Project Settings → Environment Variables**, ajoutez `DATABASE_URL`, `FUNDORA_STAFF_NAME` et `FUNDORA_STAFF_PASSWORD`, puis redéployez. Ne téléversez pas `.env` : ce fichier contient des secrets et est exclu de Git. Utilisez une base PostgreSQL gérée. Si vous conservez une sauvegarde de `data/fundora.json`, protégez-en l’accès.

Vercel exécute des fonctions sans serveur persistant. Les comptes, messages, pièces jointes et sessions d’authentification sont stockés dans PostgreSQL ; le disque local ne sert pas de stockage durable. Le cookie de session est envoyé avec les requêtes de même origine, y compris les téléversements. N’utilisez pas le serveur de développement comme hébergement de production à grande échelle.

La boîte de réception s’actualise automatiquement toutes les quelques secondes. La connexion utilise un cookie protégé contre l’accès JavaScript, valable jusqu’à sept jours. Sur Vercel, les sessions persistantes sont enregistrées dans la table `user_sessions`.

Les messages affichent **Envoyé** puis **Lu** quand le destinataire consulte la conversation. Un message n’est marqué comme lu que lorsque la conversation est ouverte dans un onglet visible.
