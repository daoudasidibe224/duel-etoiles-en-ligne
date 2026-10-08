import { authenticatedUser } from "../types";
import { randomUUID } from "node:crypto";
import { Router } from "express";
const router = Router();
import { assurerAuthentification } from "../config/auth";
router.use(assurerAuthentification);
router.get("/", (req, res) => res.render("salon", { salons: req.app.salons }));
router.get("/discussion&jeu", (req, res) => res.render("discussionForm"));
router.post("/salonDeJeu/room", (req, res) => {
  const salons = req.app.salons;
  if (Object.keys(salons).length >= 100)
    return res
      .status(429)
      .send("Tous les salons sont occupés. Réessayez plus tard.");
  const room = randomUUID();
  salons[room] = {
    id: room,
    nomProprietaire: authenticatedUser(req).nomUtilisateur,
    proprietaireId: authenticatedUser(req).id,
    utilisateurs: [],
    createdAt: Date.now(),
  };
  res.redirect(`/salon/salonDeJeu/${room}`);
});
router.get("/salonDeJeu/:room", (req, res) => {
  const salon = req.app.salons[req.params.room];
  if (!salon)
    return res.status(404).render("erreur", {
      titre: "Salon fermé",
      message: "Cette partie est terminée ou le salon n’existe plus.",
    });
  if (salon.utilisateurs.length >= 2)
    return res.status(409).render("erreur", {
      titre: "Salon complet",
      message: "Deux joueurs ont déjà rejoint cette partie.",
    });
  res.render("jeu", { room: salon.id, nomDuSalon: salon.nomProprietaire });
});
export default router;
