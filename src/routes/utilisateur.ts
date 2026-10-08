import { authenticatedUser } from "../types";
import express from "express";
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
      ? body.nomUtilisateur.trim().toLowerCase()
      : "";
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
  if (mdp !== mdp2) erreurs.mdp2 = "Les mots de passe ne correspondent pas.";
  if (typeof mdp !== "string" || Object.keys(erreurs).length)
    return res
      .status(422)
      .render("inscription", { erreurs, nomUtilisateur, email });
  try {
    if (await Utilisateur.exists({ $or: [{ email }, { nomUtilisateur }] }))
      return res.status(409).render("inscription", {
        erreurs: { compte: "Cet email ou ce pseudo est déjà utilisé." },
        nomUtilisateur,
        email,
      });
    const utilisateur = await Utilisateur.create({
      nomUtilisateur,
      email,
      mdp: await bcrypt.hash(mdp, 12),
    });
    req.login(utilisateur, (error) =>
      error ? next(error) : res.redirect("/salon"),
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
router.post("/connexion", authLimit, (req, res, next) => {
  if (typeof req.body?.email !== "string" || typeof req.body?.mdp !== "string")
    return res.status(422).send("Saisissez un email et un mot de passe.");
  passport.authenticate("local", {
    successRedirect: "/salon",
    failureRedirect: "/connexion",
    failureFlash: true,
  })(req, res, next);
});
router.post("/deconnexion", (req, res, next) => {
  for (const namespace of ["/", "/jeu", "/discussion"].map((name) =>
    req.app.io.of(name),
  )) {
    for (const socket of namespace.sockets.values())
      if (socket.request.sessionID === req.sessionID) socket.disconnect(true);
  }
  req.logout((error) => {
    if (error) return next(error);
    req.session.destroy((err) =>
      err ? next(err) : res.redirect("/connexion"),
    );
  });
});
export default router;
