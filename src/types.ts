import type { Request } from "express";
import type { Namespace, Server, Socket } from "socket.io";
import type { ClientEvents, ServerEvents, Rooms } from "../shared/contracts";
export type GameServer = Server<ClientEvents, ServerEvents>;
export type GameNamespace = Namespace<ClientEvents, ServerEvents>;
export type GameSocket = Socket<ClientEvents, ServerEvents>;
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
  }
}
declare module "express-serve-static-core" {
  interface Application {
    io: GameServer;
    salons: Rooms;
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
export function socketUser(socket: GameSocket): Express.User {
  if (!socket.request.user) throw new Error("Connexion nécessaire");
  return socket.request.user;
}
