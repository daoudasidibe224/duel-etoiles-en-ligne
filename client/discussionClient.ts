import { io, type Socket } from "socket.io-client";
import {
  chatRoomSchema,
  messageSchema,
  type ServerEvents,
  type ClientEvents,
} from "../shared/contracts";
import { element, inputElement } from "./dom";
const client: Socket<ServerEvents, ClientEvents> = io("/discussion");
const status = element("chat-status"),
  form = element("envoyerMessage"),
  input = inputElement("message"),
  button = form.querySelector("button"),
  chat = document.querySelector(".chatBox");
if (!button || !chat) throw new Error("Discussion introuvable");
let pending: { id: string; text: string } | undefined;
const seen = new Set<string>();
let sending = false;
client.on("connect", () => {
  status.textContent = "Vous êtes en ligne.";
  client.emit("join", {}, (error) => {
    if (error) status.textContent = error;
  });
});
client.on("disconnect", () => {
  status.textContent =
    "Connexion interrompue. Vos messages ne sont pas envoyés.";
});
client.on("connect_error", () => {
  status.textContent = "Connexion impossible. Rechargez la page.";
});
client.on("roomData", (payload) => {
  const data = chatRoomSchema.safeParse(payload);
  if (!data.success) return;
  const list = element("listeUtilisateurs");
  list.replaceChildren();
  for (const user of data.data.utilisateurs) {
    const row = document.createElement("p");
    row.textContent = user.nomUtilisateur;
    list.append(row);
  }
});
client.on("message", (payload) => {
  const parsed = messageSchema.safeParse(payload);
  if (!parsed.success) return;
  if (seen.has(parsed.data.id)) return;
  seen.add(parsed.data.id);
  if (seen.size > 200) {
    const first = seen.values().next().value;
    if (first) seen.delete(first);
  }
  const message = parsed.data,
    row = document.createElement("article"),
    info = document.createElement("p"),
    text = document.createElement("p");
  row.className = "chat-message";
  info.className = "chat-meta";
  info.textContent = `${message.nomUtilisateur} · ${new Date(message.heureDenvoi).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  text.textContent = message.text;
  row.append(info, text);
  chat.append(row);
  while (chat.children.length > 200) chat.firstChild?.remove();
  chat.scrollTop = chat.scrollHeight;
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (sending || !client.connected || !input.value.trim()) return;
  sending = true;
  if (!pending || pending.text !== input.value.trim())
    pending = { id: crypto.randomUUID(), text: input.value.trim() };
  button.disabled = true;
  client
    .timeout(5000)
    .emit(
      "envoyerMessage",
      pending,
      (timeout: Error | null, error?: string) => {
        sending = false;
        button.disabled = false;
        if (timeout || error) {
          status.textContent =
            error || "Le message n’a pas été envoyé. Réessayez.";
          return;
        }
        pending = undefined;
        input.value = "";
        status.textContent = "Message envoyé.";
        input.focus();
      },
    );
});
