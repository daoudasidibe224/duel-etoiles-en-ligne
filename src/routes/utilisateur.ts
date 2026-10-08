import { authenticatedUser, revokeAccess, sessionId } from "../types";
import express from "express";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import passport from "passport";
import { rateLimit } from "express-rate-limit";
import Utilisateur from "../models/Utilisateur";
import { assurerAuthentification } from "../config/auth";
const router = express.Router();
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Trop de tentatives. Réessayez dans quelques minutes.",
});
const validName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9_-]{3,24}$/i.test(value.trim());
router.post("/inscription", authLimit, async (req, res, next) => {
  const body: Record<string, unknown> =
    req.body && typeof req.body === "object" ? req.body : {};
  const nomUtilisateur =
    typeof body.nomUtilisateur === "string"
      ? body.nomUtilisateur.trim().toLowerCase() ||
        `joueur_${randomUUID().slice(0, 8)}`
      : `joueur_${randomUUID().slice(0, 8)}`;
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const { mdp, mdp2 } = body;
  const erreurs: Record<string, string> = {};
  if (!validName(nomUtilisateur))
    erreurs.nomUtilisateur =
      "Choisissez un pseudo de 3 à 24 lettres, chiffres, tirets ou tirets bas.";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    erreurs.email = "Saisissez une adresse email valide.";
  if (typeof mdp !== "string" || mdp.length < 8 || Buffer.byteLength(mdp) > 72)
    erreurs.mdp = "Utilisez au moins 8 caractères et au maximum 72 octets.";
  if (mdp2 !== undefined && mdp !== mdp2)
    erreurs.mdp2 = "Les mots de passe ne correspondent pas.";
  if (typeof mdp !== "string" || Object.keys(erreurs).length)
    return res
      .status(422)
      .render("inscription", { erreurs, nomUtilisateur, email });
  try {
    const existing = await Utilisateur.findOne({
      $or: [{ email }, { nomUtilisateur }],
    });
    if (existing)
      return res.status(409).render("inscription", {
        erreurs:
          existing.email === email
            ? { email: "Cet email est déjà utilisé." }
            : { nomUtilisateur: "Ce pseudo est déjà utilisé." },
        nomUtilisateur,
        email,
      });
    const utilisateur = await Utilisateur.create({
      nomUtilisateur,
      email,
      mdp: await bcrypt.hash(mdp, 12),
    });
    const target = req.session.returnTo || "/salon";
    revokeAccess(req);
    req.login(utilisateur, (error) =>
      error ? next(error) : res.redirect(target),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 11000)
      return res.status(409).render("inscription", {
        erreurs: { compte: "Cet email ou ce pseudo est déjà utilisé." },
        nomUtilisateur,
        email,
      });
    next(error);
  }
});
router.post(
  "/editer-profil",
  assurerAuthentification,
  async (req, res, next) => {
    const nomUtilisateur = req.body?.nouveauNomUtilisateur;
    if (!validName(nomUtilisateur)) {
      req.flash(
        "msg_erreur",
        "Le pseudo doit contenir de 3 à 24 lettres, chiffres, tirets ou tirets bas.",
      );
      return res.redirect("/profil");
    }
    try {
      // L'identité vient de la session, jamais d'un champ du formulaire.
      await Utilisateur.findByIdAndUpdate(
        authenticatedUser(req).id,
        { nomUtilisateur: nomUtilisateur.trim().toLowerCase() },
        { runValidators: true },
      );
      req.flash("msg_succes", "Votre pseudo a été modifié.");
      res.redirect("/profil");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 11000) {
        req.flash("msg_erreur", "Ce pseudo est déjà pris.");
        return res.redirect("/profil");
      }
      next(error);
    }
  },
);
router.post("/invite", authLimit, async (req, res, next) => {
  if (req.user) return res.redirect("/salon");
  const pseudo =
    typeof req.body?.nomUtilisateur === "string"
      ? req.body.nomUtilisateur.trim().toLowerCase()
      : "";
  if (!validName(pseudo))
    return res
      .status(422)
      .render("jouer", {
        nomUtilisateur: pseudo,
        erreurs: {
          pseudo: "Choisissez 3 à 24 lettres, chiffres, tirets ou tirets bas.",
        },
      });
  try {
    if (req.session.guest && req.session.guest.expiresAt <= Date.now())
      req.app.releasePlayer(req.session.guest.id, req.sessionID);
    req.session.guest = req.app.identities.enter(
      sessionId(req),
      req.session.guest,
      pseudo,
    );
    const target = req.session.returnTo || "/salon";
    delete req.session.returnTo;
    req.session.save((error) => (error ? next(error) : res.redirect(target)));
  } catch (error) {
    return res
      .status(409)
      .render("jouer", {
        nomUtilisateur: pseudo,
        erreurs: {
          session:
            error instanceof Error ? error.message : "Session indisponible.",
        },
      });
  }
});
router.post("/connexion", authLimit, (req, res, next) => {
  if (typeof req.body?.email !== "string" || typeof req.body?.mdp !== "string")
    return res
      .status(422)
      .render("connexion", {
        erreurs: { form: "Saisissez un email et un mot de passe." },
      });
  passport.authenticate(
    "local",
    (error: unknown, user: Express.User | false | null, info: unknown) => {
      if (error) return next(error);
      if (!user) {
        const message =
          info &&
          typeof info === "object" &&
          "message" in info &&
          typeof info.message === "string"
            ? info.message
            : "Email ou mot de passe incorrect.";
        req.flash("error", message);
        return res.redirect("/connexion");
      }
      const target = req.session.returnTo || "/salon";
      revokeAccess(req);
      req.login(user, (err) => (err ? next(err) : res.redirect(target)));
    },
  )(req, res, next);
});
router.post("/deconnexion", (req, res, next) => {
  revokeAccess(req);
  req.logout((error) => {
    if (error) return next(error);
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie("run.sid");
      res.redirect("/jouer");
    });
  });
});
export default router;
