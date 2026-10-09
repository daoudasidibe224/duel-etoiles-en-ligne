# Duel d’étoiles en ligne

[Essayer la démo publique](https://duel-etoiles-en-ligne.onrender.com). Le premier chargement peut prendre environ une minute après la mise en veille du service gratuit.

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

Les tests utilisent une vraie instance MongoDB temporaire via `mongodb-memory-server`. Le premier lancement télécharge le binaire MongoDB et nécessite un accès réseau. Ils vérifient les accès protégés, les formulaires, les comptes, les profils, l’unicité des places, les reconnexions, les départs répétés, les événements anciens ou désordonnés, les résultats uniques, la progression, les étoiles partagées, les bonus rejoués après reprise et la discussion sans doublon. Les parcours Chromium jouent une manche complète avec deux comptes, ouvrent des onglets du même compte et reprennent une partie après une coupure réseau suivie d’un rechargement. Un parcours de redémarrage arrête brutalement le vrai processus serveur en attente puis à chacune des trois étapes. Il vérifie le même identifiant de salon et les deux places restaurées, les annulations dans Chromium et Socket.IO, les identités invitée et compte conservées, la reprise du résultat terminé, la coexistence d’un ancien moteur et d’un nouveau HTTP en attente, puis l’arrêt de l’ancien et le rattachement automatique. Il couvre aussi le refus d’une instance bloquante, la perte du verrou et un résultat partiellement enregistré repris sans doublon. Un second parcours crée deux véritables invités sans compte, teste une manche de 9 secondes, les reprises, la conversion en compte, les accès refusés, l’expiration et la navigation entre onglets. La CI exécute les contrôles et les parcours navigateur sous Node.js 22.

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

Un journal MongoDB conserve les salons et les réservations de session avant leur confirmation. Au redémarrage, un salon d’attente retrouve son invitation, son propriétaire et ses places. Une manche interrompue est annulée explicitement, sans résultat partiel ; son salon revient en attente, avec scores et charges remis à zéro. Les deux joueurs peuvent lancer une nouvelle manche dans ce même salon. L’écran et le lobby expliquent la reprise. Les résultats déjà terminés restent accessibles sur leur invitation, y compris pour les invités.

Une réservation restaurée respecte l’échéance de son accès : 8 heures pour les invités, 24 heures pour les comptes. Les sessions révoquées ne récupèrent aucune place. Un salon restauré expire au plus tard 24 heures après sa création. Après une nouvelle connexion, la réserve habituelle de 12 secondes s’applique aux coupures. Les salons vides jamais repris sont aussi nettoyés après 10 minutes ; une reprise après redémarrage conserve le salon jusqu’à l’échéance de son accès. Les avis de fermeture restent disponibles jusqu’à 24 heures, dans une limite de 2 000 salons fermés.

À la fin d’une manche, le serveur conserve d’abord un résultat identifié dans MongoDB, puis écrit les scores des comptes. Si cette seconde écriture échoue, la page affiche l’erreur et permet une nouvelle tentative. Le serveur réessaie automatiquement toutes les cinq secondes et au démarrage, même si le salon a fermé. L’index unique par manche et compte protège les reprises et les écritures concurrentes. Un résultat n’est annoncé comme enregistré qu’après confirmation. Une fin survenue pendant une indisponibilité complète de MongoDB ne peut pas être récupérée sans son journal. Les résultats invités conservés pour la reprise restent temporaires ; ils ne deviennent pas des scores de compte. Les résultats déjà enregistrés dans ce journal temporaire sont supprimés par un index TTL de 24 heures ; les résultats encore à réessayer n’expirent pas.

Un seul moteur détient le verrou MongoDB d’une base. Son bail dure 15 secondes et se renouvelle toutes les cinq secondes. Chaque mutation vérifie sa propriété ; les écritures du journal sont aussi conditionnées par ce verrou. La fin est d’abord validée dans ce journal, puis son résultat est enregistré : le redémarrage couvre aussi une coupure entre ces deux écritures. Une perte de verrou ou de base coupe les connexions de jeu et entraîne l’arrêt du serveur de production. Les comptes, sessions, messages et résultats restent dans MongoDB. Le serveur attend une reprise de cette base indépendante du disque du conteneur. L’application n’utilise pas d’adaptateur Socket.IO partagé.

Lors d’un déploiement, plusieurs processus HTTP peuvent coexister. Le nouveau sert les pages d’accès et attend le moteur sans délai limite pendant que l’ancien termine son service. La création, le rattachement et les actions de jeu restent refusés avec un message de mise à jour ; l’annuaire affiche cet état d’attente. Les paquets Socket.IO relisent la session MongoDB, ce qui refuse aussi une session fermée sur un autre processus. La fermeture du moteur précède celle des connexions HTTP, dont l’attente résiduelle est bornée à cinq secondes. Après l’arrêt de l’ancien ou l’expiration de son bail, le nouveau reprend les salons et avertit les navigateurs, qui retentent leur rattachement automatiquement. Une seconde instance lancée en mode de test bloquant est refusée si le verrou n’est pas libéré dans le délai demandé.

Le navigateur calcule les déplacements et détecte les collisions. Le serveur génère les étoiles communes, leurs échéances, les bonus et les scores ; il refuse les ramassages anticipés, les étoiles absentes, les répétitions et les événements après la fin. Il ne vérifie pas la position horizontale du robot : un client modifié peut réclamer une étoile à portée temporelle sans être dessous. Les résultats ne constituent donc pas un classement compétitif protégé contre la triche. Les personnages pixel et le décor sont dessinés par Canvas ; les sons utilisent des oscillateurs Web Audio. Les anciennes images et pistes audio aux droits non établis ont été retirées.

Les anciens scores sans identifiant de compte restent associés au pseudo historique. Si ce pseudo change, ils ne suivent pas le compte. Les nouveaux scores utilisent l’identifiant du joueur.

Les tests navigateur démarrent leur propre serveur et MongoDB locale temporaire. Avant leur premier lancement : `npx playwright install chromium`. Ils utilisent un port libre et écrivent les captures dans `test-results/`.

## Exécution dans un conteneur

Le [dépôt public](https://github.com/daoudasidibe224/duel-etoiles-en-ligne) garde le serveur HTTP et Socket.IO dans le même processus. Le Dockerfile compile TypeScript puis installe uniquement les dépendances d’exécution ; le processus tourne avec l’utilisateur non privilégié `node`.

```sh
docker build -t duel-etoiles-en-ligne .
docker run --rm --env-file .env -e NODE_ENV=production -p 5000:5000 duel-etoiles-en-ligne
```

Ce conteneur attend une base MongoDB accessible depuis son réseau. `localhost` dans l’URI désigne le conteneur, pas votre ordinateur. Le port interne suit `PORT`, compris entre 1 et 65535. `GET /health/live` vérifie le processus ; `GET /health/ready` vérifie MongoDB et le moteur exclusif ; il renvoie 503 si l’un est indisponible. `GET /health/deploy` vérifie uniquement l’infrastructure MongoDB et indique séparément `engine: waiting`, `ready` ou `unavailable`. Ces sondes ne créent pas de session. La CI construit aussi l’image.

Pour une publication, configurez `SECRET`, `MONGODB_URI`, `NODE_ENV=production` et le port demandé par l’hébergeur. Servez les pages et Socket.IO sous la même origine HTTPS, avec un proxy qui accepte la mise à niveau WebSocket. Le serveur refuse un handshake navigateur provenant d’une autre origine ; aucune ouverture CORS générale n’est nécessaire. Activez `TRUST_PROXY=1` uniquement derrière un proxy de confiance. La configuration du cookie sécurisé ne doit pas être désactivée en production.

La base doit offrir un stockage durable indépendant du disque du conteneur. Une offre qui met le processus en veille ou le redémarre interrompt les connexions. Le journal annule les manches interrompues explicitement et permet de retrouver les résultats déjà terminés. L’image seule ne fournit ni base distante ni domaine ni certificat ; le service de démonstration Render Free est déployé avec une base Atlas M0 dédiée. Une seule instance applicative est nécessaire avec l’architecture actuelle.

## Préparation Render gratuit

`render.yaml` décrit un service Docker gratuit, en région Francfort, sur la branche `improve/public-2026-10`. La sonde de promotion est `/health/deploy` et les déploiements automatiques sont désactivés. Au moment de créer le Blueprint, renseignez `SECRET` et `MONGODB_URI` dans Render : les valeurs `sync: false` ne contiennent aucun secret dans Git. Aucun service, abonnement ni compte cloud n’est créé par ce fichier.

Utilisez une base MongoDB Atlas Free (anciennement M0), séparée du stockage Render. Ce cluster fournit un replica set et un stockage limité à 512 Mo ; il convient à une démonstration avec des données modestes. Choisissez une base propre à l’application, un utilisateur limité à cette base et autorisez les adresses de sortie de votre service dans l’accès réseau Atlas. L’URI doit indiquer la base et conserver TLS. Les sessions, comptes, messages et scores restent ainsi dans MongoDB. [Configuration des clusters Atlas](https://www.mongodb.com/docs/atlas/manage-clusters/).

Render Free partage 750 heures d’instances par mois entre les services d’un même espace. Une instance se met en veille après 15 minutes sans trafic entrant, puis redémarre à la prochaine demande ; son disque est éphémère. La veille, un redéploiement ou un redémarrage ferme les connexions. MongoDB conserve les avis d’annulation, les résultats terminés et les résultats à réessayer. Gardez une seule instance Duel : la présence et le moteur ne sont pas partagés entre plusieurs serveurs. Un nouveau processus attend la libération du moteur, même après la promotion HTTP ; `/health/ready` reste 503 pendant cette attente. Aucun dispositif ne contourne la veille. [Limites Render Free](https://render.com/docs/free), [WebSockets sur Render](https://render.com/docs/websocket), [référence du Blueprint](https://render.com/docs/blueprint-spec).

La démonstration est publiée sur l’URL HTTPS indiquée en haut de ce README, avec les secrets privés et les droits MongoDB dédiés. Les parcours invités, les places exclusives, la reconnexion et une manche de 90 secondes ont été vérifiés sur le service public.
