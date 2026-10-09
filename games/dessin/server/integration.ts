import express, {
  Router,
  type ErrorRequestHandler,
  type Express,
  type Request,
} from "express";
import path from "node:path";
import type { Server as HttpServer } from "node:http";
import { z } from "zod";
import type { Connection } from "mongoose";
import mongoose from "mongoose";
import {
  RoomHub,
  type DrawNamespace,
  type DrawingRequest,
  type ExternalIdentity,
} from "./sockets";
import type { Timing } from "./game";
import type { SessionState } from "../shared/contracts";

export type {
  DrawingRequest,
  ExternalIdentity,
  IdentityResolver,
} from "./sockets";
export interface DrawingOptions {
  app: Express;
  /** Kept for the host contract; the drawing game uses the shared `io`. */
  server?: HttpServer;
  /** Socket.IO server already holding the session handshake middleware. */
  io: { of(name: string): unknown };
  /** Canonical identity of the shared site, for HTTP and socket requests. */
  resolveIdentity(
    request: DrawingRequest,
  ): ExternalIdentity | undefined | Promise<ExternalIdentity | undefined>;
  /** Directory holding index.html, style.css, fonts and the app.js bundle. */
  publicDirectory: string;
  /** Optional logout form for the shared site (POST action and CSRF value). */
  logout?(request: Request): { action: string; csrf: string } | undefined;
  timing?: Timing;
  connection?: Connection;
  collections?: { snapshots?: string; runtime?: string };
}
export const drawingNamespace = "/dessin";

export function attachDrawing(options: DrawingOptions) {
  const namespace = options.io.of(drawingNamespace) as DrawNamespace;
  const connection = options.connection ?? mongoose.connection;
  const rooms = new RoomHub(
    namespace,
    (request) => options.resolveIdentity(request),
    options.timing,
    { connection, ...options.collections },
  );
  namespace.use(async (socket, next) => {
    try {
      await rooms.assertAvailable();
    } catch {
      next(
        Object.assign(
          new Error("Le serveur reprend les salons. Reconnexion en cours."),
          { data: { retryable: true } },
        ),
      );
      return;
    }
    try {
      socket.data.user = await rooms.authenticate(socket.request);
      next();
    } catch {
      next(
        new Error(
          "Choisissez un pseudo ou connectez-vous pour rejoindre un salon.",
        ),
      );
    }
  });
  namespace.on("connection", (socket) => rooms.attach(socket));

  const readiness = async () => {
    let ready = false;
    try {
      await rooms.assertAvailable();
      ready = connection.readyState === 1;
    } catch {}
    return { ready, status: ready ? rooms.status : "unavailable" };
  };
  const page = path.join(options.publicDirectory, "index.html");
  const router = Router();
  const api = Router();
  api.get("/session", async (req, res) => {
    let state: SessionState = { user: null, kind: null, logout: null };
    try {
      const user = await rooms.authenticate(req);
      state = {
        user: { id: user.id, name: user.name },
        kind: user.kind,
        logout: options.logout?.(req) ?? null,
      };
    } catch {}
    res.set("Cache-Control", "no-store").json(state);
  });
  api.get("/rooms", async (req, res) => {
    try {
      await rooms.assertAvailable();
    } catch {
      res.status(503).json({
        error: "Le serveur reprend les salons. Réessayez dans un instant.",
      });
      return;
    }
    try {
      const user = await rooms.authenticate(req);
      res.set("Cache-Control", "no-store").json(rooms.directory(user.id));
    } catch {
      res.status(401).json({
        error: "Choisissez un pseudo ou connectez-vous pour voir les salons.",
      });
    }
  });
  api.get("/health", async (_req, res) => {
    const state = await readiness();
    res.status(state.ready ? 200 : 503).json({ status: state.status });
  });
  api.use((_req, res) => {
    res.status(404).json({ error: "Adresse introuvable." });
  });
  const apiErrors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(error instanceof z.ZodError ? 400 : 500).json({
      error: "Une erreur est survenue. Réessayez.",
    });
  };
  api.use(apiErrors);
  router.use("/api", api);
  router.use(
    "/assets",
    express.static(options.publicDirectory, { index: false }),
  );
  router.get("/", (_req, res) => res.redirect("/dessin/lobby"));
  router.get(["/lobby", "/room"], (_req, res) => {
    res.set("Cache-Control", "no-store").sendFile(page);
  });
  options.app.use(drawingNamespace, router);

  return {
    rooms,
    namespace,
    ready: rooms.ready,
    readiness,
    /** Ends drawing seats and sockets of a session closed by the host site. */
    endSession: (sessionId: string) => rooms.endSession(sessionId),
    /** Propagates a host profile rename (identity as given by the resolver). */
    rename: (
      identity: { id: string; kind: "account" | "guest" },
      name: string,
    ) => rooms.renameIdentity(identity.kind + ":" + identity.id, name),
    close: () => rooms.close(),
  };
}
export type DrawingAttachment = ReturnType<typeof attachDrawing>;
