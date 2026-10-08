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
}: {
  secret: string;
  store?: session.Store;
}) {
  if (!secret || secret.length < 32)
    throw new Error(
      "Un secret de session de 32 caractères minimum est nécessaire",
    );
  const app = express();
  const server = createServer(app);
  const io = new Server<ClientEvents, ServerEvents>(server, {
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
      maxAge: 24 * 60 * 60 * 1000,
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
  const authorizeSocket: Parameters<ReturnType<typeof io.of>["use"]>[0] = (
    socket,
    next,
  ) => (socket.request.user ? next() : next(new Error("Connexion nécessaire")));
  for (const name of ["/", "/jeu", "/discussion"])
    io.of(name).use(authorizeSocket);
  app.io = io;
  app.salons = Object.create(null);
  registerSockets({ io, salons: app.salons });
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
    sons: "assets/sons",
    sprites: "assets/sprites",
    tilesets: "assets/tilesets",
    styles: "assets/styles",
  })) {
    app.use(`/${url}`, express.static(path.join(publicDirectory, folder)));
  }
  app.use((req, res, next) => {
    if (!req.session.csrfToken)
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.utilisateur = req.user;
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
