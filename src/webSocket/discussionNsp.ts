import { z } from "zod";
import { generateMessage } from "./socketMsg";
import { socketUser, type GameNamespace } from "../types";
export default function discussion(namespace: GameNamespace) {
  const users = new Map<string, { id: string; nomUtilisateur: string }>();
  const publish = () =>
    namespace.emit("roomData", { utilisateurs: [...users.values()] });
  namespace.on("connection", (socket) => {
    let lastMessage = 0;
    socket.on("join", (_payload, callback) => {
      if (!users.has(socket.id)) {
        const user = {
          id: socket.id,
          nomUtilisateur: socketUser(socket).nomUtilisateur,
        };
        users.set(socket.id, user);
        socket.emit(
          "message",
          generateMessage("Accueil", `Bienvenue ${user.nomUtilisateur} !`),
        );
        publish();
      }
      if (typeof callback === "function") callback();
    });
    socket.on("envoyerMessage", (payload, callback) => {
      const reply = (error?: string) => {
        if (typeof callback === "function") {
          if (error) callback(error);
          else callback();
        }
      };
      const user = users.get(socket.id),
        message = z.string().trim().min(1).max(1000).safeParse(payload);
      if (!user || !message.success)
        return reply("Le message doit contenir de 1 à 1 000 caractères.");
      if (Date.now() - lastMessage < 500)
        return reply("Attendez un instant avant d’envoyer un autre message.");
      lastMessage = Date.now();
      namespace.emit(
        "message",
        generateMessage(user.nomUtilisateur, message.data),
      );
      reply();
    });
    socket.on("disconnect", () => {
      users.delete(socket.id);
      publish();
    });
  });
}
