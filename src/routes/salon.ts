import { gameUser, sessionId } from "../types";
import { randomUUID } from "node:crypto";
import { Router } from "express";
const router = Router();
import { assurerJeu } from "../config/auth";
router.use(assurerJeu);
router.get("/", (req, res) =>
  res.render("salon", {
    salons: req.app.salons,
    recoveredRoom: Object.values(req.app.salons).find(
      (room) =>
        room.recoveryNotice &&
        (room.proprietaireId === gameUser(req).id ||
          room.utilisateurs.some(
            (player) => player.userId === gameUser(req).id,
          )),
    ),
  }),
);
router.get("/discussion&jeu", (req, res) => res.render("discussionForm"));
router.post("/salonDeJeu/room", async (req, res) => {
  if (req.app.roomJournal && !req.app.roomJournal.available)
    return res
      .status(503)
      .render("erreur", {
        titre: "Les salons reprennent",
        message:
          "Une mise à jour du serveur est en cours. Votre salon reste réservé ; réessayez après la reprise.",
      });
  const create = async () => {
    const salons = req.app.salons;
    const userId = gameUser(req).id;
    const current = Object.values(salons).find(
      (room) =>
        room.proprietaireId === userId ||
        room.utilisateurs.some((player) => player.userId === userId),
    );
    if (current) return res.redirect(`/salon/salonDeJeu/${current.id}`);
    if (Object.keys(salons).length >= 100)
      return res
        .status(429)
        .send("Tous les salons sont occupés. Réessayez plus tard.");
    const room = randomUUID();
    salons[room] = {
      id: room,
      nomProprietaire: gameUser(req).nomUtilisateur,
      proprietaireId: gameUser(req).id,
      utilisateurs: [],
      createdAt: Date.now(),
    };
    req.app.roomSessions.set(room, sessionId(req));
    await req.app.roomJournal?.sync(salons, undefined, req.app.roomSessions);
    res.redirect(`/salon/salonDeJeu/${room}`);
  };
  if (req.app.roomJournal) await req.app.roomJournal.run(create);
  else await create();
});
router.get("/salonDeJeu/:room", (req, res) => {
  const salon = req.app.salons[req.params.room];
  if (
    !salon &&
    req.app.roomJournal?.pending &&
    /^[a-f0-9-]{36}$/i.test(req.params.room)
  )
    return res.render("jeu", {
      room: req.params.room,
      nomDuSalon: "Salon en reprise",
    });
  if (!salon)
    return res.status(404).render("erreur", {
      titre: "Salon fermé",
      message:
        req.app.roomJournal?.reason(req.params.room) ??
        "Cette partie est terminée ou le salon n’existe plus.",
    });
  if (
    (salon.utilisateurs.length >= 2 || salon.started) &&
    !salon.utilisateurs.some((player) => player.userId === gameUser(req).id)
  )
    return res.status(409).render("erreur", {
      titre: "Salon complet",
      message: "Deux joueurs ont déjà rejoint cette partie.",
    });
  res.render("jeu", { room: salon.id, nomDuSalon: salon.nomProprietaire });
});
export default router;
