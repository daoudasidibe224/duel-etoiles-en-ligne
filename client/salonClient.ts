import { io, type Socket } from "socket.io-client";
import {
  roomsSchema,
  type ServerEvents,
  type ClientEvents,
} from "../shared/contracts";
import { accessEnded, bindSessionResume, element } from "./dom";
const client: Socket<ServerEvents, ClientEvents> = io();
const list = document.querySelector(".partieDisponible"),
  createButton = document.querySelector<HTMLButtonElement>(
    ".lancerJeuForm button",
  ),
  status = element("connection-status");
if (!list) throw new Error("Liste des salons introuvable");
let ownId = "";
client.on("identity", (id) => {
  ownId = id;
});
bindSessionResume(client);
client.on("accessEnded", accessEnded);
function joinLobby() {
  status.textContent = "Reprise des salons…";
  status.dataset.state = "loading";
  if (createButton) createButton.disabled = true;
  client.emit("join", {}, (error) => {
    if (error) {
      status.textContent = error;
      status.dataset.state = "loading";
      if (createButton) createButton.disabled = true;
      const waiting = document.createElement("p");
      waiting.className = "notification";
      waiting.textContent = error;
      list?.replaceChildren(waiting);
    } else {
      status.textContent = "En ligne";
      status.dataset.state = "online";
      if (createButton) createButton.disabled = false;
    }
  });
}
client.on("connect", joinLobby);
client.on("engineReady", joinLobby);
client.on("disconnect", () => {
  status.textContent = "Hors ligne · reconnexion…";
  status.dataset.state = "offline";
  if (createButton) createButton.disabled = true;
});
client.on("connect_error", () => {
  status.textContent = "Connexion indisponible · nouvel essai…";
  status.dataset.state = "offline";
  if (createButton) createButton.disabled = true;
});
client.on("majSalonDeJeu", (payload) => {
  const parsed = roomsSchema.safeParse(payload);
  if (!parsed.success) {
    status.textContent = "La liste des salons est indisponible.";
    return;
  }
  list.replaceChildren();
  const rooms = Object.values(parsed.data).filter(
    (room) =>
      (room.utilisateurs.length < 2 && !room.started) ||
      room.proprietaireId === ownId ||
      room.utilisateurs.some((player) => player.userId === ownId),
  );
  if (!rooms.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("h3");
    title.textContent = "Aucun salon en attente";
    const text = document.createElement("p");
    text.textContent =
      "Créez le vôtre et partagez son invitation. Les salons disponibles apparaîtront ici.";
    empty.append(title, text);
    list.append(empty);
  }
  for (const room of rooms) {
    const row = document.createElement("article");
    row.className = "room-row";
    const title = document.createElement("p");
    title.className = "room-title";
    title.textContent = `Salon de ${room.nomProprietaire}`;
    const count = document.createElement("span");
    count.textContent = `${room.utilisateurs.length}/2 joueurs`;
    const link = document.createElement("a");
    link.className = "button is-outlined";
    link.href = `/salon/salonDeJeu/${encodeURIComponent(room.id)}`;
    link.textContent =
      room.proprietaireId === ownId ||
      room.utilisateurs.some((player) => player.userId === ownId)
        ? "Reprendre →"
        : "Rejoindre →";
    if (room.recoveryNotice) {
      const notice = document.createElement("p");
      notice.className = "room-recovery-note";
      notice.textContent = room.recoveryNotice;
      row.append(notice);
    }
    row.append(title, count, link);
    list.append(row);
  }
});
