# Dessine et devine

Module de dessin de La Salle de jeux. Un joueur choisit un mot secret et le dessine, les autres le devinent. Le module tourne dans le serveur Node du site : même processus Express, même serveur Socket.IO, même session, mêmes comptes et invités.

## Ce que le module garde

- Salons de 2 à 10 joueurs, hôte, choix entre trois mots secrets, compte à rebours, manches et partie complète.
- Outils : crayon, ligne, rectangle, ellipse, six couleurs, épaisseur, annuler, rétablir, effacer, export PNG et carnet des manches.
- Scores calculés par le serveur, réponse masquée, discussion fermée pendant le dessin.
- Une identité, une place : reprise dans un autre onglet, reconnexion avec délai de grâce, commandes rejouées ou périmées refusées.
- Sauvegarde Mongo après chaque action, reprise après redémarrage brutal, bail exclusif pour qu’un seul processus pilote les salons.

## Identité

Le site est la seule autorité. Le module ne crée ni compte ni invité et ne stocke aucun mot de passe. À chaque requête HTTP et à chaque commande Socket.IO, il recharge la session partagée puis demande l’identité canonique à `resolveIdentity`. Les identifiants de joueur sont préfixés par leur type (`account:` ou `guest:`).

Les pages renvoient vers `/jouer?next=/dessin/lobby`, `/connexion`, `/inscription`, `/profil` et `/` (« Tous les jeux »).

## Intégration

```ts
import { attachDrawing } from "./games/dessin/server/integration";

const drawing = attachDrawing({
  app, // Express, sessions et passport déjà installés
  server, // facultatif
  io, // Socket.IO avec le middleware de session au handshake
  publicDirectory, // dossier games/dessin/public
  resolveIdentity: async (request) => ({ id, name, kind, expiresAt }),
  logout: (request) => ({ action: "/utilisateur/deconnexion", csrf }), // facultatif
});
// à placer avant le gestionnaire 404 du site
// déconnexion, expiration ou changement d’identité : drawing.endSession(sessionId)
// renommage : drawing.rename({ id, kind }, nom)
// arrêt : await drawing.rooms.close()
```

Routes : `/dessin` (redirection), `/dessin/lobby`, `/dessin/room?room=…`, `/dessin/api/session`, `/dessin/api/rooms`, `/dessin/api/health`, `/dessin/assets/*`. Espace Socket.IO : `/dessin` sur le chemin `/socket.io`.

Collections Mongo propres au module : `dessin_room_snapshots` et `dessin_runtime`. Le module ne déclare aucun modèle Mongoose.

## Développement

Les dépendances sont celles du dépôt racine. Utilisez Node 24.

```sh
cd games/dessin
npm run check        # TypeScript strict, serveur, client et tests
npm run lint
npm run build:client # public/app.js, non versionné
npm test             # règles du jeu, intégration HTTP/WebSocket, redémarrages Mongo
npm run test:e2e     # navigateur (Playwright)
```

Les tests utilisent un hôte de test (`test/fixtures/host.ts`) qui reproduit le contrat du site : session `run.sid` dans Mongo, invités, comptes, révocation et formulaire de déconnexion.
