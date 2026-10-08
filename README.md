# Duel d’étoiles en ligne

Un jeu d’arcade à deux joueurs, avec des salons en temps réel, une discussion générale et un historique de scores. Ouvrez une partie, attendez un second joueur et lancez une manche de 90 secondes. Les étoiles ramassées font monter le score.

## Fonctionnalités

- Inscription, connexion, déconnexion et modification du pseudo.
- Salons limités à deux joueurs, mis à jour en direct.
- Départ contrôlé par le premier joueur et fermeture des salons abandonnés.
- Déplacement au clavier ou avec les commandes tactiles, invitation par lien et contrôle du son.
- Discussion générale : liste des joueurs connectés, messages limités à 1 000 caractères et affichage sécurisé du texte.
- Historique des 100 dernières parties, meilleur score et nombre de parties enregistrées.
- Interface adaptée au mobile, navigation au clavier et champs de formulaire étiquetés.

## Stack

Node.js 22.16 ou supérieur, Express 5, Pug 3, Socket.IO 4, MongoDB avec Mongoose 9, Passport 0.7 et Bulma 1. Les sessions sont stockées dans MongoDB avec `connect-mongo`. Le serveur et les clients utilisent TypeScript strict. Canvas affiche la partie ; esbuild compile les scripts du navigateur. Les contrats Zod contrôlent les événements entrants sur le serveur et le client.

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
| `npm run css-build` | Copier la feuille Bulma installée vers les fichiers publics |
| `npm run test:e2e` | Vérifier les parcours desktop et mobile dans Chromium |
| `npm test` | Exécuter les tests d’intégration HTTP, comptes et Socket.IO |
| `npm run build` | Compiler serveur, clients et CSS |
| `npm run typecheck` | Vérifier les types stricts |
| `npm run lint` | Vérifier le code TypeScript |
| `npm run check` | Vérifier le lint, les types, la compilation et les tests |

Les tests utilisent une vraie instance MongoDB temporaire via `mongodb-memory-server`. Le premier lancement télécharge le binaire MongoDB et nécessite un accès réseau. Ils vérifient les accès protégés, les formulaires, les comptes, les profils, la limite de deux joueurs, les événements invalides, l’enregistrement des scores et la discussion. La CI exécute les contrôles et les parcours navigateur sous Node.js 22.

## Configuration et limites

`PORT` vaut 5000 par défaut. En production, utilisez HTTPS et `NODE_ENV=production` : le cookie de session exige alors une connexion sécurisée. Si l’application est derrière un proxy de confiance, `TRUST_PROXY=1` permet de reconnaître HTTPS. N’activez cette option que si ce proxy contrôle réellement les connexions entrantes.

Les salons et les messages restent en mémoire ; un redémarrage les efface. Les comptes, les sessions et les scores restent dans MongoDB. Cette application convient à une seule instance de serveur. Elle n’utilise pas d’adaptateur Socket.IO partagé.

Le moteur de jeu calcule les collisions et les scores dans le navigateur. Les événements et les valeurs sont contrôlés côté serveur, mais les résultats ne constituent pas un classement compétitif protégé contre la triche. Les étoiles sont générées localement par chaque joueur. Les sprites et les sons historiques sont conservés ; leur présence dans le dépôt ne vaut pas autorisation de redistribution commerciale.

Les anciens scores sans identifiant de compte restent associés au pseudo historique. Si ce pseudo change, ils ne suivent pas le compte. Les nouveaux scores utilisent l’identifiant du joueur.

Les tests navigateur démarrent leur propre serveur et MongoDB locale temporaire. Avant leur premier lancement : `npx playwright install chromium`. Ils utilisent un port libre et écrivent les captures dans `test-results/`.
