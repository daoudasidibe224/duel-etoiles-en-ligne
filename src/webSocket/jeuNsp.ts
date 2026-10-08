import Score from "../models/Score";
import { socketUser, type GameNamespace } from "../types";
import {
  joinSchema,
  movementInputSchema,
  scoreInputSchema,
  resultSchema,
  type Player,
  type Rooms,
  type PlayerState,
} from "../../shared/contracts";
export default function game(
  jeuNsp: GameNamespace,
  salonNsp: GameNamespace,
  salons: Rooms,
) {
  jeuNsp.on("connection", (socket) => {
    let utilisateur: Player | undefined;
    let saved = false;
    socket.on("join", (payload, callback) => {
      const reply = (error?: string) => {
        if (typeof callback === "function") {
          if (error) callback(error);
          else callback();
        }
      };
      if (utilisateur) return reply("Vous avez déjà rejoint une partie.");
      const parsed = joinSchema.safeParse(payload);
      if (!parsed.success) return reply("Salon invalide.");
      const salon = salons[parsed.data.room],
        user = socketUser(socket);
      if (
        !salon ||
        salon.started ||
        salon.utilisateurs.length >= 2 ||
        salon.utilisateurs.some((player) => player.userId === user.id)
      )
        return reply("Salon fermé, complet ou déjà rejoint.");
      utilisateur = {
        id: socket.id,
        userId: user.id,
        nomUtilisateur: user.nomUtilisateur,
        room: salon.id,
      };
      salon.utilisateurs.push(utilisateur);
      socket.join(salon.id);
      jeuNsp
        .to(salon.id)
        .emit("roomData", { room: salon.id, utilisateurs: salon.utilisateurs });
      salonNsp.emit("majSalonDeJeu", salons);
      reply();
    });
    socket.on("afficherBtnPlay", () => {
      const salon = utilisateur && salons[utilisateur.room];
      if (salon?.utilisateurs.length === 2)
        jeuNsp
          .to(salon.utilisateurs[0].id)
          .emit("afficherBtnPlay", salon.utilisateurs[0].id);
    });
    socket.on("startGame", () => {
      if (!utilisateur) return;
      const salon = salons[utilisateur.room];
      if (
        !salon ||
        salon.started ||
        salon.utilisateurs.length !== 2 ||
        salon.utilisateurs[0].id !== socket.id
      )
        return;
      salon.started = true;
      salon.startedAt = Date.now();
      jeuNsp.to(utilisateur.room).emit("init");
    });
    socket.on("deplacementMonJoueur", (payload) => {
      const parsed = movementInputSchema.safeParse(payload);
      if (!utilisateur || !salons[utilisateur.room]?.started || !parsed.success)
        return;
      const input = parsed.data.etat;
      const etat: PlayerState = {
        runningRight: input.runningRight === true,
        runningLeft: input.runningLeft === true,
        idLeft: input.idLeft === true,
        idRight: input.idRight === true,
        dead: input.dead === true,
      };
      socket
        .to(utilisateur.room)
        .emit("deplacementMonJoueur", { id: socket.id, etat });
    });
    socket.on("score", (payload) => {
      const parsed = scoreInputSchema.safeParse(payload);
      if (!utilisateur || !salons[utilisateur.room]?.started || !parsed.success)
        return;
      socket
        .to(utilisateur.room)
        .emit("score", { id: socket.id, score: parsed.data.score });
    });
    socket.on("scoreFinDeJeu", async (payload, callback) => {
      const reply = (error?: string) => {
        if (typeof callback === "function") {
          if (error) callback(error);
          else callback();
        }
      };
      const salon = utilisateur && salons[utilisateur.room],
        adversaire = salon?.utilisateurs.find((user) => user.id !== socket.id),
        parsed = resultSchema.safeParse(payload);
      if (
        !utilisateur ||
        !salon?.started ||
        saved ||
        !adversaire ||
        !parsed.success
      )
        return reply("Score invalide.");
      saved = true;
      try {
        await Score.create({
          monJoueurId: socketUser(socket).id,
          monNom: utilisateur.nomUtilisateur,
          monScore: parsed.data.monScore,
          nomUtilisateurAutreJoueur: adversaire.nomUtilisateur,
          scoreAutreJoueur: parsed.data.scoreAutreJoueur,
        });
        reply();
      } catch {
        saved = false;
        reply("Le score n’a pas pu être enregistré.");
      }
    });
    socket.on("disconnect", () => {
      if (!utilisateur) return;
      const salon = salons[utilisateur.room];
      if (!salon) return;
      salon.utilisateurs = salon.utilisateurs.filter(
        (user) => user.id !== socket.id,
      );
      jeuNsp.to(utilisateur.room).emit("roomData", {
        room: utilisateur.room,
        utilisateurs: salon.utilisateurs,
      });
      if (!salon.utilisateurs.length) delete salons[utilisateur.room];
      salonNsp.emit("majSalonDeJeu", salons);
    });
  });
}
