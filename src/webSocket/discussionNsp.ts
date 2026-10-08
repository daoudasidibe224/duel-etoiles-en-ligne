import ChatMessage from "../models/ChatMessage";
import { chatInputSchema } from "../../shared/contracts";
import { generateMessage } from "./socketMsg";
import { socketUser, type GameNamespace } from "../types";
export default function discussion(namespace: GameNamespace) {
  const users = new Map<
    string,
    { id: string; nomUtilisateur: string; connections: Set<string> }
  >();
  const lastMessage = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  const publish = () =>
    namespace.emit("roomData", {
      utilisateurs: [...users.values()].map(({ id, nomUtilisateur }) => ({
        id,
        nomUtilisateur,
      })),
    });
  namespace.on("connection", (socket) => {
    const account = socketUser(socket);
    socket.on("join", async (_payload, callback) => {
      let user = users.get(account.id);
      if (!user) {
        user = {
          id: account.id,
          nomUtilisateur: account.nomUtilisateur,
          connections: new Set(),
        };
        users.set(account.id, user);
      }
      if (!user.connections.has(socket.id)) {
        user.connections.add(socket.id);
        publish();
        try {
          const history = await ChatMessage.find()
            .sort({ heureDenvoi: -1 })
            .limit(50);
          for (const message of history.reverse())
            socket.emit("message", {
              id: message.messageId,
              nomUtilisateur: message.nomUtilisateur,
              text: message.text,
              heureDenvoi: message.heureDenvoi,
            });
          socket.emit(
            "message",
            generateMessage("Accueil", `Bienvenue ${user.nomUtilisateur} !`),
          );
        } catch {
          if (typeof callback === "function")
            return callback("La discussion est indisponible. Réessayez.");
        }
      }
      if (typeof callback === "function") callback();
    });
    socket.on("envoyerMessage", async (payload, callback) => {
      const reply = (error?: string) => {
        if (typeof callback === "function") {
          if (error) callback(error);
          else callback();
        }
      };
      const user = users.get(account.id),
        message = chatInputSchema.safeParse(payload);
      if (!user?.connections.has(socket.id) || !message.success)
        return reply(
          "Le message doit contenir de 1 à 1 000 caractères et un identifiant valide.",
        );
      const key = `${account.id}:${message.data.id}`;
      const send = async () => {
        const existing = await ChatMessage.findOne({
          userId: account.id,
          messageId: message.data.id,
        });
        if (existing) {
          if (existing.text !== message.data.text)
            throw new Error(
              "Ce message a déjà été envoyé avec un autre texte.",
            );
          return;
        }
        if (Date.now() - (lastMessage.get(account.id) ?? 0) < 500)
          throw new Error(
            "Attendez un instant avant d’envoyer un autre message.",
          );
        lastMessage.set(account.id, Date.now());
        const content = generateMessage(
          user.nomUtilisateur,
          message.data.text,
          message.data.id,
        );
        await ChatMessage.create({
          userId: account.id,
          messageId: content.id,
          nomUtilisateur: content.nomUtilisateur,
          text: content.text,
          heureDenvoi: content.heureDenvoi,
        });
        namespace.emit("message", content);
      };
      try {
        const running = pending.get(key);
        if (running) {
          await running;
          const existing = await ChatMessage.findOne({
            userId: account.id,
            messageId: message.data.id,
          });
          if (existing?.text !== message.data.text)
            return reply("Ce message a déjà été envoyé avec un autre texte.");
        } else {
          const task = send();
          pending.set(key, task);
          try {
            await task;
          } finally {
            pending.delete(key);
          }
        }
        reply();
      } catch (error) {
        reply(
          error instanceof Error && /instant|autre texte/.test(error.message)
            ? error.message
            : "Le message n’a pas pu être enregistré. Réessayez.",
        );
      }
    });
    socket.on("disconnect", () => {
      const user = users.get(account.id);
      user?.connections.delete(socket.id);
      if (!user?.connections.size) {
        users.delete(account.id);
        lastMessage.delete(account.id);
      }
      publish();
    });
  });
}
