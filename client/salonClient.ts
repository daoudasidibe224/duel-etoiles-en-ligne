import { io, type Socket } from "socket.io-client";
import {
  roomsSchema,
  type ServerEvents,
  type ClientEvents,
} from "../shared/contracts";
import { element } from "./dom";
const client: Socket<ServerEvents, ClientEvents> = io();
const list = document.querySelector(".partieDisponible"),
  status = element("connection-status");
if (!list) throw new Error("Liste des salons introuvable");
client.on("connect", () => {
  status.textContent = "En ligne";
  client.emit("join", {}, () => {});
});
client.on("disconnect", () => {
  status.textContent = "Connexion interrompue";
});
client.on("connect_error", () => {
  status.textContent = "Connexion impossible. Rechargez la page.";
});
client.on("majSalonDeJeu", (payload) => {
  const parsed = roomsSchema.safeParse(payload);
  if (!parsed.success) {
    status.textContent = "La liste des salons est indisponible.";
    return;
  }
  list.replaceChildren();
  const rooms = Object.values(parsed.data).filter(
    (room) => room.utilisateurs.length < 2 && !room.started,
  );
  if (!rooms.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("h3");
    title.textContent = "La piste est libre.";
    const text = document.createElement("p");
    text.textContent =
      "Aucune partie en attente. Ouvrez votre salon et invitez un ami.";
    empty.append(title, text);
    list.append(empty);
  }
  for (const room of rooms) {
    const row = document.createElement("article");
    row.className = "room-row";
    const title = document.createElement("p");
    title.textContent = `Salon de ${room.nomProprietaire}`;
    const count = document.createElement("span");
    count.textContent = `${room.utilisateurs.length}/2 joueurs`;
    const link = document.createElement("a");
    link.className = "button is-outlined";
    link.href = `/salon/salonDeJeu/${encodeURIComponent(room.id)}`;
    link.textContent = "Rejoindre →";
    row.append(title, count, link);
    list.append(row);
  }
});
