// Test host reproducing the shared-site contract of La Salle de jeux: one
// "run.sid" session (Mongo store), guests and accounts owned by the host,
// handshake-only session middleware on the shared Socket.IO server, then
// attachDrawing before the host 404 handler.
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import session, { type Session, type Store } from "express-session";
import MongoStore from "connect-mongo";
import mongoose from "mongoose";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { attachDrawing, type DrawingRequest } from "../../server/integration";
import type { Timing } from "../../server/game";

interface StoredGuest {
  id: string;
  name: string;
  expiresAt: number;
}
type HostSession = Session & {
  testGuest?: StoredGuest;
  testAccount?: string;
  testCsrf?: string;
};
function hostSession(request: { session: Session }) {
  return request.session as HostSession;
}
const accounts = new Map<string, { id: string; name: string }>();

export function createHost(
  options: { timing?: Timing; store?: Store; secret?: string } = {},
) {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 16 * 1024,
    allowRequest: (req, done) => {
      try {
        done(
          null,
          !req.headers.origin ||
            new URL(req.headers.origin).host === req.headers.host,
        );
      } catch {
        done(null, false);
      }
    },
  });
  const store =
    options.store ??
    MongoStore.create({
      client: mongoose.connection.getClient(),
      collectionName: "sessions",
    });
  const sessions = session({
    name: "run.sid",
    secret: options.secret ?? "drawing-host-fixture-secret-at-least-32-chars",
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 24 * 3600000 },
  });
  const revoked = new Set<string>();
  app.use(express.json({ limit: "16kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(sessions);
  // Like the shared site, every session keeps a CSRF token for its forms.
  app.use((req, _res, next) => {
    hostSession(req).testCsrf ??= randomBytes(32).toString("hex");
    next();
  });
  const handshakeOnly =
    (middleware: RequestHandler) =>
    (
      req: Request & { _query: Record<string, unknown> },
      res: Response,
      next: NextFunction,
    ) => (req._query.sid === undefined ? middleware(req, res, next) : next());
  io.engine.use(handshakeOnly(sessions));
  const resolveIdentity = (request: DrawingRequest) => {
    const now = Date.now();
    const expires = request.session.cookie.expires?.getTime();
    if (revoked.has(request.sessionID) || !expires || expires <= now) return;
    const stored = hostSession(request);
    if (stored.testAccount) {
      const account = accounts.get(stored.testAccount);
      return account
        ? { ...account, kind: "account" as const, expiresAt: expires }
        : undefined;
    }
    const guest = stored.testGuest;
    if (!guest || guest.expiresAt <= now) return;
    return {
      id: guest.id,
      name: guest.name,
      kind: "guest" as const,
      expiresAt: Math.min(guest.expiresAt, expires),
    };
  };
  const save = (req: Request) =>
    new Promise<void>((resolve, reject) =>
      req.session.save((error) => (error ? reject(error) : resolve())),
    );
  app.get("/test/sid", (req, res) => {
    res.json({ sid: req.sessionID });
  });
  // Equivalent of /utilisateur/invite: the guest id never changes on rename.
  app.post("/test/guest", async (req, res) => {
    const stored = hostSession(req);
    const name = String(req.body?.name ?? "");
    const ttl = Number(req.body?.ttlMs ?? 8 * 3600000);
    if (stored.testAccount) {
      res.status(409).json({ error: "Compte connecté." });
      return;
    }
    if (stored.testGuest && stored.testGuest.expiresAt > Date.now()) {
      stored.testGuest.name = name;
      drawing.rename({ id: stored.testGuest.id, kind: "guest" }, name);
    } else {
      if (stored.testGuest) drawing.endSession(req.sessionID);
      stored.testGuest = {
        id: randomBytes(12).toString("hex"),
        name,
        expiresAt: Date.now() + ttl,
      };
    }
    await save(req);
    res.json({ ok: true });
  });
  // Simulates the host guest-expiry timer, which releases drawing seats.
  app.post("/test/expire-guest", async (req, res) => {
    const stored = hostSession(req);
    if (stored.testGuest) stored.testGuest.expiresAt = Date.now() - 1;
    await save(req);
    drawing.endSession(req.sessionID);
    res.json({ ok: true });
  });
  // Equivalent of a passport login: revoke the old session, then regenerate.
  app.post("/test/login", async (req, res) => {
    const email = String(req.body?.email ?? "");
    const existing = accounts.get(email);
    const account = existing ?? {
      id: randomBytes(12).toString("hex"),
      name: String(req.body?.name ?? "Joueur"),
    };
    accounts.set(email, account);
    revoked.add(req.sessionID);
    drawing.endSession(req.sessionID);
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((error) => (error ? reject(error) : resolve())),
    );
    hostSession(req).testAccount = email;
    await save(req);
    res.json({ ok: true });
  });
  // Form logout used by the drawing header, as /utilisateur/deconnexion.
  app.post("/test/logout-form", (req, res, next) => {
    if (req.body?._csrf !== hostSession(req).testCsrf) {
      res.status(403).send("Le formulaire a expiré.");
      return;
    }
    revoked.add(req.sessionID);
    drawing.endSession(req.sessionID);
    req.session.destroy((error) => {
      if (error) {
        next(error);
        return;
      }
      res.clearCookie("run.sid");
      res.redirect("/dessin/lobby");
    });
  });
  app.post("/test/logout", (req, res, next) => {
    revoked.add(req.sessionID);
    drawing.endSession(req.sessionID);
    req.session.destroy((error) => {
      if (error) {
        next(error);
        return;
      }
      res.clearCookie("run.sid");
      res.json({ ok: true });
    });
  });
  const drawing = attachDrawing({
    app,
    server,
    io,
    resolveIdentity,
    logout: (req) => {
      const csrf = hostSession(req).testCsrf;
      return csrf ? { action: "/test/logout-form", csrf } : undefined;
    },
    publicDirectory: path.resolve(__dirname, "../../public"),
    timing: options.timing,
  });
  // Host infrastructure probe: Mongo only, the game state is informative.
  app.get("/health", async (_req, res) => {
    let ready = mongoose.connection.readyState === 1;
    if (ready)
      try {
        await mongoose.connection.db?.command({ ping: 1 }, { timeoutMS: 1500 });
      } catch {
        ready = false;
      }
    res
      .status(ready ? 200 : 503)
      .json({
        status: ready ? "ok" : "unavailable",
        game: drawing.rooms.status,
      });
  });
  app.use((_req, res) => res.status(404).send("Page introuvable"));
  return {
    app,
    server,
    io,
    store,
    drawing,
    rooms: drawing.rooms,
    async close() {
      await drawing.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}
export type Host = ReturnType<typeof createHost>;
