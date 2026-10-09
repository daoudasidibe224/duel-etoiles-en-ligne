import { socketUser, type GameNamespace } from "../types";
import type { Rooms } from "../../shared/contracts";
import type { RoomJournal } from "../services/roomJournal";
export default function lobby(
  namespace: GameNamespace,
  salons: Rooms,
  roomSessions: Map<string, string>,
  journal?: RoomJournal,
) {
  namespace.on("connection", (socket) => {
    socket.emit("identity", socketUser(socket).id);
    return socket.on("join", (_payload, callback) => {
      const clean = async () => {
        for (const [id, salon] of Object.entries(salons))
          if (
            !salon.utilisateurs.length &&
            !salon.recoveryNotice &&
            Date.now() - salon.createdAt > 600000
          ) {
            delete salons[id];
            roomSessions.delete(id);
          }
        await journal?.sync(salons);
        socket.emit("majSalonDeJeu", salons);
        if (typeof callback === "function") callback();
      };
      void (journal ? journal.run(clean) : clean()).catch(() => {
        if (typeof callback === "function")
          callback(
            journal?.pending
              ? "Une mise à jour du serveur est en cours. Vos salons restent réservés ; la reprise sera automatique."
              : "La liste des salons est indisponible.",
          );
      });
    });
  });
}
