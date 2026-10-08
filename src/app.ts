import { registerHealth } from "./health";
import { IdentityAuthority } from "./services/identities";
import { sessionId } from "./types";
import type { SocketData } from "./types";
import path from "node:path";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import { createServer } from "node:http";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import passport from "passport";
import session from "express-session";
import flash from "connect-flash";
import { Server } from "socket.io";
import configurePassport from "./config/passport";
import registerSockets from "./webSocket/indexSocket";
import indexRoutes from "./routes/index";
import userRoutes from "./routes/utilisateur";
import roomRoutes from "./routes/salon";
import type { ClientEvents, ServerEvents } from "../shared/contracts";
import { z } from "zod";
import "./types";
export function createApp({
  secret,
  store,
  gameOptions,
  guestDurationMs,
  sessionDurationMs,
}: {
  secret: string;
  store?: session.Store;
  gameOptions?: { durationMs?: number; reconnectMs?: number };
  guestDurationMs?: number;
  sessionDurationMs?: number;
}) {
  if (!secret || secret.length < 32)
    throw new Error(
      "Un secret de session de 32 caractères minimum est nécessaire",
    );
  const app = express();
  const server = createServer(app);
  const io = new Server<
    ClientEvents,
    ServerEvents,
    Record<string, never>,
    SocketData
  >(server, {
    maxHttpBufferSize: 16 * 1024,
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      try {
        callback(null, !origin || new URL(origin).host === req.headers.host);
      } catch {
        callback(null, false);
      }
    },
  });
  app.disable("x-powered-by");
  registerHealth(app);
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          upgradeInsecureRequests:
            process.env.NODE_ENV === "production" ? [] : null,
        },
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  const sessionMiddleware = session({
    name: "run.sid",
    secret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: sessionDurationMs ?? 24 * 60 * 60 * 1000,
    },
  });
  configurePassport(passport);
  const initialize = passport.initialize();
  const authenticate = passport.session();
  app.use(sessionMiddleware, initialize, authenticate, flash());
  const handshakeOnly =
    (middleware: RequestHandler) =>
    (
      req: Request & { _query: Record<string, unknown> },
      res: Response,
      next: NextFunction,
    ) => (req._query.sid === undefined ? middleware(req, res, next) : next());
  io.engine.use(handshakeOnly(sessionMiddleware));
  io.engine.use(handshakeOnly(initialize));
  io.engine.use(handshakeOnly(authenticate));
  app.identities = new IdentityAuthority(guestDurationMs, (id, sessionId) => {
    app.releasePlayer(id, sessionId);
    for (const name of ["/", "/jeu", "/discussion"])
      for (const socket of io.of(name).sockets.values()) {
        if (
          socket.request.sessionID === sessionId &&
          socket.data.identity?.id === id
        ) {
          socket.emit(
            "accessEnded",
            "La session invitée a expiré. Choisissez un pseudo pour rejouer.",
          );
          socket.disconnect(true);
        }
      }
  });
  app.io = io;
  app.salons = Object.create(null);
  app.roomSessions = new Map();
  app.releasePlayer = registerSockets({
    io,
    salons: app.salons,
    gameOptions,
    roomSessions: app.roomSessions,
  });
  const authorizeSocket: Parameters<ReturnType<typeof io.of>["use"]>[0] = (
    socket,
    next,
  ) => {
    const req = socket.request;
    const sessionValue = "session" in req ? req.session : undefined;
    const stored = z
      .object({
        guest: z.unknown().optional(),
        cookie: z.object({ expires: z.coerce.date() }),
      })
      .safeParse(sessionValue);
    const identity = stored.success
      ? app.identities.resolve(
          req.sessionID,
          req.user,
          stored.data.guest,
          stored.data.cookie.expires.getTime(),
        )
      : undefined;
    if (!identity)
      return next(new Error("Connexion ou session invitée nécessaire"));
    socket.data.identity = identity;
    const endAccess = () => {
      socket.emit(
        "accessEnded",
        identity.kind === "guest"
          ? "La session invitée a expiré. Choisissez un pseudo pour rejouer."
          : "Votre session de compte a expiré. Reconnectez-vous pour continuer.",
      );
      socket.disconnect(true);
    };
    socket.use((_packet, done) => {
      if (!app.identities.current(req.sessionID, identity)) {
        endAccess();
        return done(new Error("Session expirée"));
      }
      done();
    });
    if (identity.expiresAt) {
      const timer = setTimeout(
        endAccess,
        Math.max(0, (identity.expiresAt ?? 0) - Date.now()),
      );
      timer.unref();
      socket.once("disconnect", () => clearTimeout(timer));
    }
    next();
  };
  for (const name of ["/", "/jeu", "/discussion"])
    io.of(name).use(authorizeSocket);
  const publicDirectory = path.resolve(
    __dirname,
    existsSync(path.join(__dirname, "../public"))
      ? "../public"
      : "../../public",
  );
  app.set("views", path.join(publicDirectory, "views"));
  app.set("view engine", "pug");
  for (const [url, folder] of Object.entries({
    images: "assets/images",
    js: "js",
    styles: "assets/styles",
    fonts: "assets/fonts",
  })) {
    app.use(`/${url}`, express.static(path.join(publicDirectory, folder)));
  }
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  function canonical(req: express.Request) {
    const identity = app.identities.resolve(
      req.sessionID,
      req.user,
      req.session.guest,
      req.session.cookie.expires?.getTime(),
    );
    return {
      key: identity
        ? crypto
            .createHmac("sha256", secret)
            .update(sessionId(req))
            .digest("hex")
        : "visitor",
      identity: identity ? `${identity.kind}:${identity.id}` : "visitor",
      expiresAt: identity?.expiresAt ?? 0,
    };
  }
  app.get("/session", (req, res) => {
    res.set("Cache-Control", "no-store").json(canonical(req));
  });
  app.use((req, res, next) => {
    if (!req.session.csrfToken)
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.utilisateur = req.user;
    res.locals.joueur = app.identities.resolve(
      req.sessionID,
      req.user,
      req.session.guest,
      req.session.cookie.expires?.getTime(),
    );
    res.locals.sessionState = canonical(req);
    res.locals.currentPath = req.path;
    res.locals.authCompact = ["/jouer", "/connexion", "/inscription"].includes(
      req.path,
    );
    for (const name of ["msg_succes", "msg_erreur", "error"])
      res.locals[name] = req.flash(name);
    if (
      req.method === "POST" &&
      (!z.object({ _csrf: z.string() }).safeParse(req.body).success ||
        req.body._csrf !== req.session.csrfToken)
    )
      return res.status(403).send("Le formulaire a expiré. Rechargez la page.");
    next();
  });
  app.use("/", indexRoutes);
  app.use("/utilisateur", userRoutes);
  app.use("/salon", roomRoutes);
  app.use((req, res) =>
    res.status(404).render("erreur", {
      titre: "Page introuvable",
      message: "Ce lien ne mène à aucune page du jeu.",
    }),
  );
  const onError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    console.error(error instanceof Error ? error.message : "Erreur inconnue");
    res.status(500).render("erreur", {
      titre: "Une erreur est survenue",
      message: "Réessayez dans quelques instants.",
    });
  };
  app.use(onError);
  return { app, server, io };
}
