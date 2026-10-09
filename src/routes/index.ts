import { authenticatedUser } from "../types";
import { Router } from "express";
const router = Router();
import { authentifie, assurerAuthentification } from "../config/auth";
import Score from "../models/Score";
router.get("/", (_req, res) => res.render("accueil"));
router.get("/duel", (_req, res) => res.redirect("/salon"));
router.use(["/jouer", "/connexion", "/inscription"], (req, _res, next) => {
  const target = req.query.next;
  if (target === "/dessin/lobby" || target === "/salon")
    req.session.returnTo = target;
  next();
});
router.get("/jouer", (req, res) => {
  if (
    req.app.identities.resolve(
      req.sessionID,
      req.user,
      req.session.guest,
      req.session.cookie.expires?.getTime(),
    )
  )
    return res.redirect(req.session.returnTo || "/salon");
  res.render("jouer");
});
router.get("/connexion", authentifie, (req, res) => res.render("connexion"));
router.get("/inscription", authentifie, (req, res) =>
  res.render("inscription"),
);
router.get("/stats", assurerAuthentification, async (req, res) => {
  // Le nom couvre aussi les scores historiques sans identifiant utilisateur.
  const filter = {
    $or: [
      { monJoueurId: authenticatedUser(req)._id },
      {
        monJoueurId: { $exists: false },
        monNom: authenticatedUser(req).nomUtilisateur,
      },
    ],
  };
  const [lesScores, meilleurScore, total] = await Promise.all([
    Score.find(filter).sort({ date: -1 }).limit(100),
    Score.find(filter).sort({ monScore: -1 }).limit(1),
    Score.countDocuments(filter),
  ]);
  res.render("statsJoueur", { lesScores, meilleurScore, total });
});
router.get("/profil", assurerAuthentification, (req, res) =>
  res.render("profil"),
);
export default router;
