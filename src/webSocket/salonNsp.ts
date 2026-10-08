import type { GameNamespace } from "../types";
import type { Rooms } from "../../shared/contracts";
export default function lobby(namespace: GameNamespace, salons: Rooms) {
  namespace.on("connection", (socket) =>
    socket.on("join", (_payload, callback) => {
      for (const [id, salon] of Object.entries(salons))
        if (!salon.utilisateurs.length && Date.now() - salon.createdAt > 600000)
          delete salons[id];
      socket.emit("majSalonDeJeu", salons);
      if (typeof callback === "function") callback();
    }),
  );
}
