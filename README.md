# Duel d’étoiles en ligne

Un jeu d’arcade à deux joueurs, avec des salons en temps réel, une discussion générale et un historique de scores. Ouvrez une partie, attendez un second joueur et lancez une manche de 90 secondes. Les étoiles ramassées font monter le score.

## Fonctionnalités

- Inscription avec email et mot de passe, pseudo facultatif proposé automatiquement, visibilité du mot de passe et déconnexion qui révoque la session.
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

Ouvrez [http://localhost:5000](http://localhost:5000). Créez deux comptes dans deux navigateurs ou deux profils distincts pour jouer. Le serveur refuse de démarrer si la configuration manque ou si MongoDB est inaccessible.

## Scripts

| Commande | Usage |
| --- | --- |
| `npm start` | Démarrer le serveur |
| `npm run dev` | Relancer le serveur et recompiler les clients lors des modifications |
| `npm run test:e2e` | Vérifier les parcours desktop et mobile dans Chromium |
| `npm test` | Exécuter les tests d’intégration HTTP, comptes et Socket.IO |
| `npm run build` | Compiler le serveur et les clients |
| `npm run typecheck` | Vérifier les types stricts |
| `npm run lint` | Vérifier le code TypeScript |
| `npm run check` | Vérifier le lint, les types, la compilation et les tests |

Les tests utilisent une vraie instance MongoDB temporaire via `mongodb-memory-server`. Le premier lancement télécharge le binaire MongoDB et nécessite un accès réseau. Ils vérifient les accès protégés, les formulaires, les comptes, les profils, l’unicité des places, les reconnexions, les départs répétés, les événements anciens ou désordonnés, les résultats uniques, la progression, les étoiles partagées, les bonus rejoués après reprise et la discussion sans doublon. Les parcours Chromium jouent une manche complète avec deux comptes, ouvrent des onglets du même compte et reprennent une partie après une coupure réseau suivie d’un rechargement. La CI exécute les contrôles et les parcours navigateur sous Node.js 22.

## Règles de connexion et de manche

Un compte occupe un seul salon et une seule place. Ouvrir la même partie dans un autre onglet transfère la connexion vers cet onglet ; l’ancien cesse de jouer. Un autre salon est refusé tant que le joueur n’a pas quitté le précédent. Le bouton « Quitter la partie » libère la place immédiatement ; le départ ou la déconnexion du compte propriétaire ferme le salon. Un départ met fin à la manche en cours et conserve les points déjà confirmés. Une coupure réserve la place pendant 12 secondes pour permettre la reprise. Au-delà, elle compte comme un départ.

Le serveur crée un identifiant de manche, fixe sa fin à 90 secondes et accepte un seul départ. La reprise conserve cet identifiant, l’échéance et les scores confirmés. Les mouvements et les points portent un identifiant de manche et une séquence : les doublons, les anciennes séquences et les événements après la fin sont ignorés. Chaque étoile identifiée rapporte un point, ou deux sous le bonus multiplicateur. Le serveur vérifie sa disponibilité et son instant de passage à hauteur du robot, puis la retire pour les deux joueurs. Les résultats sont enregistrés par le serveur pour les deux comptes, avec un index MongoDB unique par manche et joueur. Une nouvelle tentative ne crée pas une seconde ligne.

Chaque étape offre une charge personnelle, utilisable une seule fois. Les bonus ne se cumulent pas et s’arrêtent après 8 secondes ou à la fin de la manche. Une charge inutilisée ne se reporte pas. Le serveur conserve les étapes consommées et l’échéance du bonus lors d’une reprise ; rejouer son identifiant n’ajoute ni charge ni durée.

Les envois de discussion possèdent un identifiant. Réessayer un envoi conserve cet identifiant et évite un second message ; un index MongoDB unique par compte et identifiant empêche sa republication, y compris après une reconnexion. Les 50 derniers messages sont chargés à l’ouverture de la discussion. La présence dans la discussion compte les comptes distincts, même avec plusieurs onglets.

## Interface et fontes

L’interface prend la forme d’une borne arcade : panneaux à angles coupés, lignes de salon, journal de discussion et HUD distinct du canvas. Press Start 2P et Chakra Petch sont servis localement. Les fichiers et leurs licences SIL Open Font License proviennent du [répertoire officiel Google Fonts](https://github.com/google/fonts) et figurent dans `public/assets/fonts/`.

## Configuration et limites

`PORT` vaut 5000 par défaut. En production, utilisez HTTPS et `NODE_ENV=production` : le cookie de session exige alors une connexion sécurisée. Si l’application est derrière un proxy de confiance, `TRUST_PROXY=1` permet de reconnaître HTTPS. N’activez cette option que si ce proxy contrôle réellement les connexions entrantes.

Les salons et les manches en cours restent en mémoire ; un redémarrage les efface. Les messages de discussion restent dans MongoDB. Les comptes, les sessions et les scores restent dans MongoDB. Si la sauvegarde d’un score échoue, la page affiche l’erreur et permet une nouvelle tentative tant que le salon reste ouvert ; aucun résultat n’est annoncé comme enregistré avant confirmation. Les manches non enregistrées ne sont pas récupérées après une fermeture du salon ou un redémarrage. Cette application convient à une seule instance de serveur. Elle n’utilise pas d’adaptateur Socket.IO partagé.

Le navigateur calcule les déplacements et détecte les collisions. Le serveur génère les étoiles communes, leurs échéances, les bonus et les scores ; il refuse les ramassages anticipés, les étoiles absentes, les répétitions et les événements après la fin. Il ne vérifie pas la position horizontale du robot : un client modifié peut réclamer une étoile à portée temporelle sans être dessous. Les résultats ne constituent donc pas un classement compétitif protégé contre la triche. Les personnages pixel et le décor sont dessinés par Canvas ; les sons utilisent des oscillateurs Web Audio. Les anciennes images et pistes audio aux droits non établis ont été retirées.

Les anciens scores sans identifiant de compte restent associés au pseudo historique. Si ce pseudo change, ils ne suivent pas le compte. Les nouveaux scores utilisent l’identifiant du joueur.

Les tests navigateur démarrent leur propre serveur et MongoDB locale temporaire. Avant leur premier lancement : `npx playwright install chromium`. Ils utilisent un port libre et écrivent les captures dans `test-results/`.
