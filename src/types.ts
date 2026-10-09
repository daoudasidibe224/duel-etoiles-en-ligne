import type { Identity, Guest, IdentityAuthority } from "./services/identities";
import type { Request } from "express";
import type { Namespace, Server, Socket } from "socket.io";
import type { ClientEvents, ServerEvents, Rooms } from "../shared/contracts";
export type SocketData = { identity?: Identity };
export type GameServer = Server<
  ClientEvents,
  ServerEvents,
  Record<string, never>,
  SocketData
>;
export type GameNamespace = Namespace<
  ClientEvents,
  ServerEvents,
  Record<string, never>,
  SocketData
>;
export type GameSocket = Socket<
  ClientEvents,
  ServerEvents,
  Record<string, never>,
  SocketData
>;
declare global {
  namespace Express {
    interface User {
      id: string;
      _id: import("mongoose").Types.ObjectId;
      nomUtilisateur: string;
      email: string;
      mdp: string;
    }
  }
}
declare module "express-session" {
  interface SessionData {
    csrfToken?: string;
    guest?: Guest;
    returnTo?: string;
  }
}
declare module "express-serve-static-core" {
  interface Application {
    io: GameServer;
    salons: Rooms;
    identities: IdentityAuthority;
    releasePlayer: (id: string, sessionId?: string) => Promise<void>;
    roomSessions: Map<string, string>;
    roomJournal?: import("./services/roomJournal").RoomJournal;
    releaseDrawingSession?: (sessionId: string) => Promise<void>;
    renameDrawingPlayer?: (id: string, name: string) => void;
  }
}
declare module "http" {
  interface IncomingMessage {
    user?: Express.User;
    sessionID?: string;
  }
}
export function authenticatedUser(req: Request): Express.User {
  if (!req.user) throw new Error("Connexion nécessaire");
  return req.user;
}
export function gameUser(req: Request): Identity {
  const user = req.app.identities.resolve(
    req.sessionID,
    req.user,
    req.session.guest,
    req.session.cookie.expires?.getTime(),
  );
  if (!user) throw new Error("Accès au jeu nécessaire");
  return user;
}
export function socketUser(socket: GameSocket): Identity {
  if (!socket.data.identity) throw new Error("Accès au jeu nécessaire");
  return socket.data.identity;
}
export function sessionId(req: Request): string {
  if (!req.sessionID) throw new Error("Session absente");
  return req.sessionID;
}
export async function revokeAccess(req: Request) {
  req.app.identities.revoke(sessionId(req));
  await req.app.releaseDrawingSession?.(sessionId(req));
  const ids = new Set(
    [req.user?.id, req.session.guest?.id].filter((id): id is string =>
      Boolean(id),
    ),
  );
  for (const id of ids) await req.app.releasePlayer(id, req.sessionID);
  for (const name of ["/", "/jeu", "/discussion", "/dessin"]) {
    for (const socket of req.app.io.of(name).sockets.values()) {
      if (socket.request.sessionID === req.sessionID) {
        socket.emit(
          "accessEnded",
          "Cette session a été fermée. Reprenez l’accès au jeu pour continuer.",
        );
        socket.disconnect(true);
      }
    }
  }
}
