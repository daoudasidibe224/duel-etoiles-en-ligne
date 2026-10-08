# Duel d’étoiles en ligne

Un jeu d’arcade à deux joueurs, avec des salons en temps réel, une discussion générale et un historique de scores pour les comptes. Ouvrez une partie, attendez un second joueur et lancez une manche de 90 secondes. Les étoiles ramassées font monter le score.

## Fonctionnalités

- Accès principal par pseudo, sans inscription : identité générée par le serveur, session invitée de 8 heures et score visible en fin de partie.
- Compte facultatif pour conserver les résultats ; inscription avec email et mot de passe, pseudo facultatif proposé automatiquement, visibilité du mot de passe et déconnexion qui révoque la session.
- Salons limités à deux joueurs, mis à jour en direct.
- Départ réservé au propriétaire, minuterie serveur et fermeture des salons abandonnés.
- Trois étapes de 30 secondes : vitesse et fréquence des étoiles augmentent.
- Une charge de bonus par étape : accélération de 50 % ou points doublés pendant 8 secondes.
- Étoiles communes aux deux joueurs, distribuées par le serveur et consommées une seule fois.
- Déplacement au clavier ou avec les commandes tactiles, invitation par lien et contrôle du son.
- Discussion générale : liste des joueurs connectés, messages limités à 1 000 caractères et affichage sécurisé du texte.
- Historique des 100 dernières parties, meilleur score et nombre de parties enregistrées.
- Interface adaptée au mobile, navigation au clavier et champs de formulaire étiquetés.

## Stack

Node.js 22.16 ou supérieur, Express 5, Pug 3, Socket.IO 4, MongoDB avec Mongoose 9, Passport 0.7 et CSS natif. Les sessions sont stockées dans MongoDB avec `connect-mongo`. Le serveur et les clients utilisent TypeScript strict. Canvas affiche la partie ; esbuild compile les scripts du navigateur. Les contrats Zod contrôlent les événements entrants sur le serveur et le client.

## Installation

MongoDB 8 convient au développement local. Vous pouvez aussi utiliser une instance compatible accessible par une URI MongoDB. Aucune base ni aucun compte n’est fourni dans le dépôt.

```sh
npm ci
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copiez la valeur générée dans `SECRET` et renseignez `MONGODB_URI`. Le secret doit contenir au moins 32 caractères. Ensuite :

```sh
npm run build
npm start
```

Ouvrez [http://localhost:5000](http://localhost:5000). Choisissez un pseudo dans deux navigateurs ou deux profils distincts pour jouer sans compte. Créez un compte si vous souhaitez conserver vos scores. Le serveur refuse de démarrer si la configuration manque ou si MongoDB est inaccessible.

## Scripts

| Commande            | Usage                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `npm start`         | Démarrer le serveur                                                  |
| `npm run dev`       | Relancer le serveur et recompiler les clients lors des modifications |
| `npm run test:e2e`  | Vérifier les parcours desktop et mobile dans Chromium                |
| `npm test`          | Exécuter les tests d’intégration HTTP, comptes et Socket.IO          |
| `npm run build`     | Compiler le serveur et les clients                                   |
| `npm run typecheck` | Vérifier les types stricts                                           |
| `npm run lint`      | Vérifier le code TypeScript                                          |
| `npm run check`     | Vérifier le lint, les types, la compilation et les tests             |

Les tests utilisent une vraie instance MongoDB temporaire via `mongodb-memory-server`. Le premier lancement télécharge le binaire MongoDB et nécessite un accès réseau. Ils vérifient les accès protégés, les formulaires, les comptes, les profils, l’unicité des places, les reconnexions, les départs répétés, les événements anciens ou désordonnés, les résultats uniques, la progression, les étoiles partagées, les bonus rejoués après reprise et la discussion sans doublon. Les parcours Chromium jouent une manche complète avec deux comptes, ouvrent des onglets du même compte et reprennent une partie après une coupure réseau suivie d’un rechargement. Un second parcours crée deux véritables invités sans compte, teste une manche de 9 secondes, les reprises, la conversion en compte, les accès refusés, l’expiration et la navigation entre onglets. La CI exécute les contrôles et les parcours navigateur sous Node.js 22.

## Règles de connexion et de manche

Une identité invitée ou un compte occupe un seul salon et une seule place. Le pseudo ne prouve pas l’identité : le serveur crée un identifiant aléatoire, conservé dans une session MongoDB et un cookie signé HTTP-only. Une session invitée dure 8 heures ; plusieurs onglets du même navigateur partagent cette identité. Deux personnes peuvent utiliser le même pseudo avec des identités distinctes. Ouvrir la même partie dans un autre onglet transfère la connexion vers cet onglet ; l’ancien cesse de jouer. Un autre salon est refusé tant que le joueur n’a pas quitté le précédent. Le bouton « Quitter la partie » libère la place immédiatement ; le départ ou la déconnexion du compte propriétaire ferme le salon. Un départ met fin à la manche en cours et conserve les points déjà confirmés. Une coupure réserve la place pendant 12 secondes pour permettre la reprise. Au-delà, elle compte comme un départ.

Le serveur crée un identifiant de manche, fixe sa fin à 90 secondes et accepte un seul départ. La reprise conserve cet identifiant, l’échéance et les scores confirmés. Les mouvements et les points portent un identifiant de manche et une séquence : les doublons, les anciennes séquences et les événements après la fin sont ignorés. Chaque étoile identifiée rapporte un point, ou deux sous le bonus multiplicateur. Le serveur vérifie sa disponibilité et son instant de passage à hauteur du robot, puis la retire pour les deux joueurs. Les résultats sont enregistrés par le serveur uniquement pour les joueurs avec un compte, avec un index MongoDB unique par manche et joueur. Une nouvelle tentative ne crée pas une seconde ligne.

Chaque étape offre une charge personnelle, utilisable une seule fois. Les bonus ne se cumulent pas et s’arrêtent après 8 secondes ou à la fin de la manche. Une charge inutilisée ne se reporte pas. Le serveur conserve les étapes consommées et l’échéance du bonus lors d’une reprise ; rejouer son identifiant n’ajoute ni charge ni durée.

Les envois de discussion possèdent un identifiant. Réessayer un envoi conserve cet identifiant et évite un second message ; un index MongoDB unique par identité et identifiant empêche sa republication, y compris après une reconnexion. Les 50 derniers messages sont chargés à l’ouverture de la discussion. La présence dans la discussion compte les identités distinctes, même avec plusieurs onglets.

Les invités jouent avec les mêmes étapes et bonus. Leur résultat n’est pas enregistré dans l’historique ; créer un compte ne transfère pas les points précédents. La connexion ou la création d’un compte ferme l’ancienne session invitée et sa place. La sortie révoque le cookie et toutes ses connexions, sans libérer une place reprise par une autre session plus récente du même compte. Les sessions de compte durent 24 heures ; les sockets et la réserve de reprise s’arrêtent à l’échéance de leur accès.

La fin normale d’une session renvoie vers l’entrée avec un avis discret. Une coupure ou une indisponibilité du serveur affiche un état de connexion et une tentative manuelle, sans prétendre que le compte a expiré. Un socket repris dans un autre onglet ne se reconnecte pas automatiquement pour reprendre la place.

Les pages relisent l’accès courant à l’activation de l’onglet, à l’expiration et lors d’un changement de session diffusé entre onglets. Elles remplacent les anciens menus et contenus. Une vérification périodique complète cette synchronisation ; une coupure réseau garde la page et ne valide aucune opération. Une saisie privée non envoyée est conservée dans le stockage de l’onglet, sans mot de passe ni jeton, et restaurée seulement pour la même identité sur le même formulaire. Fermer l’onglet supprime cette copie locale.

## Interface et fontes

L’interface réunit un lobby avec aperçu de l’arène, création de salon et liste des parties. Dans la manche, les scores encadrent la minuterie ; les bonus et les règles restent à côté de l’arène sur ordinateur et sous les commandes sur mobile. La navigation sépare les commandes de jeu et l’accès du joueur. Press Start 2P et Chakra Petch sont servis localement. Les fichiers et leurs licences SIL Open Font License proviennent du [répertoire officiel Google Fonts](https://github.com/google/fonts) et figurent dans `public/assets/fonts/`.

## Configuration et limites

`PORT` vaut 5000 par défaut. En production, utilisez HTTPS et `NODE_ENV=production` : le cookie de session exige alors une connexion sécurisée. Si l’application est derrière un proxy de confiance, `TRUST_PROXY=1` permet de reconnaître HTTPS. N’activez cette option que si ce proxy contrôle réellement les connexions entrantes.

Les salons et les manches en cours restent en mémoire ; un redémarrage les efface. Les messages de discussion, y compris ceux des invités, restent dans MongoDB avec leur pseudo au moment de l’envoi. Les comptes, les sessions et les scores restent dans MongoDB. Si la sauvegarde d’un score échoue, la page affiche l’erreur et permet une nouvelle tentative tant que le salon reste ouvert ; aucun résultat n’est annoncé comme enregistré avant confirmation. Les manches non enregistrées ne sont pas récupérées après une fermeture du salon ou un redémarrage. Cette application convient à une seule instance de serveur. Elle n’utilise pas d’adaptateur Socket.IO partagé.

Le navigateur calcule les déplacements et détecte les collisions. Le serveur génère les étoiles communes, leurs échéances, les bonus et les scores ; il refuse les ramassages anticipés, les étoiles absentes, les répétitions et les événements après la fin. Il ne vérifie pas la position horizontale du robot : un client modifié peut réclamer une étoile à portée temporelle sans être dessous. Les résultats ne constituent donc pas un classement compétitif protégé contre la triche. Les personnages pixel et le décor sont dessinés par Canvas ; les sons utilisent des oscillateurs Web Audio. Les anciennes images et pistes audio aux droits non établis ont été retirées.

Les anciens scores sans identifiant de compte restent associés au pseudo historique. Si ce pseudo change, ils ne suivent pas le compte. Les nouveaux scores utilisent l’identifiant du joueur.

Les tests navigateur démarrent leur propre serveur et MongoDB locale temporaire. Avant leur premier lancement : `npx playwright install chromium`. Ils utilisent un port libre et écrivent les captures dans `test-results/`.

## Exécution dans un conteneur

Le [dépôt public](https://github.com/daoudasidibe224/duel-etoiles-en-ligne) garde le serveur HTTP et Socket.IO dans le même processus. Le Dockerfile compile TypeScript puis installe uniquement les dépendances d’exécution ; le processus tourne avec l’utilisateur non privilégié `node`.

```sh
docker build -t duel-etoiles-en-ligne .
docker run --rm --env-file .env -e NODE_ENV=production -p 5000:5000 duel-etoiles-en-ligne
```

Ce conteneur attend une base MongoDB accessible depuis son réseau. `localhost` dans l’URI désigne le conteneur, pas votre ordinateur. Le port interne suit `PORT`, compris entre 1 et 65535. `GET /health/live` vérifie le processus ; `GET /health/ready` vérifie MongoDB et renvoie 503 si la base est indisponible. Ces sondes ne créent pas de session. La CI construit aussi l’image.

Pour une publication, configurez `SECRET`, `MONGODB_URI`, `NODE_ENV=production` et le port demandé par l’hébergeur. Servez les pages et Socket.IO sous la même origine HTTPS, avec un proxy qui accepte la mise à niveau WebSocket. Le serveur refuse un handshake navigateur provenant d’une autre origine ; aucune ouverture CORS générale n’est nécessaire. Activez `TRUST_PROXY=1` uniquement derrière un proxy de confiance. La configuration du cookie sécurisé ne doit pas être désactivée en production.

La base doit offrir un stockage durable indépendant du disque du conteneur. Une offre qui met le processus en veille ou le redémarre interrompt les salons et les manches en mémoire. L’image seule ne fournit ni base distante ni domaine ni certificat ; un Blueprint Render est préparé, mais aucun service distant n’a été créé. Une seule instance applicative est nécessaire avec l’architecture actuelle.

## Préparation Render gratuit

`render.yaml` décrit un service Docker gratuit, en région Francfort, sur la branche `improve/public-2026-10`. La sonde est `/health/ready` et les déploiements automatiques sont désactivés. Au moment de créer le Blueprint, renseignez `SECRET` et `MONGODB_URI` dans Render : les valeurs `sync: false` ne contiennent aucun secret dans Git. Aucun service, abonnement ni compte cloud n’est créé par ce fichier.

Utilisez une base MongoDB Atlas Free (anciennement M0), séparée du stockage Render. Ce cluster fournit un replica set et un stockage limité à 512 Mo ; il convient à une démonstration avec des données modestes. Choisissez une base propre à l’application, un utilisateur limité à cette base et autorisez les adresses de sortie de votre service dans l’accès réseau Atlas. L’URI doit indiquer la base et conserver TLS. Les sessions, comptes, messages et scores restent ainsi dans MongoDB. [Configuration des clusters Atlas](https://www.mongodb.com/docs/atlas/manage-clusters/).

Render Free partage 750 heures d’instances par mois entre les services d’un même espace. Une instance se met en veille après 15 minutes sans trafic entrant, puis redémarre à la prochaine demande ; son disque est éphémère. La veille, un redéploiement ou un redémarrage ferme les connexions et efface les manches en mémoire. Gardez une seule instance Duel : la présence et les salons ne sont pas partagés entre plusieurs serveurs. Aucun dispositif ne contourne la veille. [Limites Render Free](https://render.com/docs/free), [WebSockets sur Render](https://render.com/docs/websocket), [référence du Blueprint](https://render.com/docs/blueprint-spec).

La publication effective attend la connexion du fournisseur, la configuration de MongoDB et des secrets, puis une vérification sur l’URL HTTPS réelle. Les tests locaux du conteneur ne prouvent pas qu’un service distant est déjà disponible.
