import { recentRooms, forgetRooms } from "./recents";
import { io } from "socket.io-client";
import {
  directorySchema,
  readySchema,
  resultSchema,
  type Directory,
} from "../shared/contracts";
import { roomName, type Identity } from "../shared/contracts";
import { element, field, showError } from "./dom";
import { base } from "./api";
export async function mountLobby(user: Identity) {
  element("welcome", HTMLElement).textContent = "Bienvenue, " + user.name;
  const rooms = recentRooms(user.id);
  element("recent-rooms", HTMLElement).hidden = !rooms.length;
  element("recent-links", HTMLElement).replaceChildren(
    ...rooms.map((name) => {
      const link = document.createElement("a");
      link.className = "secondary";
      link.href = base + "/room?room=" + encodeURIComponent(name);
      link.textContent = name;
      return link;
    }),
  );
  element("forget-rooms", HTMLButtonElement).addEventListener("click", () => {
    try {
      forgetRooms(user.id);
      element("recent-rooms", HTMLElement).hidden = true;
    } catch {
      showError(
        "lobby-error",
        "Le navigateur ne peut pas modifier les salons récents.",
      );
    }
  });
  const directory = element("room-directory", HTMLElement),
    search = element("room-search", HTMLInputElement),
    status = element("directory-status", HTMLElement);
  let roomsState: Directory = [];
  let directoryReady = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const labels = {
    waiting: "En attente",
    choosing: "Choix du mot",
    countdown: "Départ imminent",
    drawing: "Partie en cours",
    reveal: "Fin de manche",
    finished: "Partie terminée",
  };
  const renderRooms = () => {
    if (!directoryReady) return;
    const shown = roomsState.filter((room) =>
      room.name
        .toLocaleLowerCase("fr")
        .includes(search.value.toLocaleLowerCase("fr")),
    );
    status.textContent = roomsState.length
      ? roomsState.length +
        " salon" +
        (roomsState.length > 1 ? "s" : "") +
        " · mise à jour en direct"
      : "Aucun salon ouvert. Créez le premier et invitez un ami.";
    directory.replaceChildren(
      ...shown.map((room) => {
        const card = document.createElement("article"),
          heading = document.createElement("h3"),
          phase = document.createElement("p"),
          people = document.createElement("p"),
          link = document.createElement("a");
        card.className = "room-card";
        heading.textContent = room.name;
        phase.className = "room-phase";
        phase.textContent =
          room.count === room.capacity ? "Complet" : labels[room.phase];
        people.className = "room-people";
        people.textContent =
          room.count +
          " / " +
          room.capacity +
          " joueurs · " +
          room.participants
            .map(
              (person) =>
                person.name + (person.connected ? "" : " (reconnexion)"),
            )
            .join(", ");
        link.className = "secondary";
        link.textContent = room.current
          ? "Reprendre ma place"
          : room.joinable
            ? "Rejoindre"
            : room.reason;
        if (room.joinable)
          link.href = base + "/room?room=" + encodeURIComponent(room.name);
        else {
          link.setAttribute("aria-disabled", "true");
          link.removeAttribute("href");
        }
        card.append(phase, heading, people, link);
        return card;
      }),
    );
    if (roomsState.length && !shown.length) {
      const empty = document.createElement("p");
      empty.textContent = "Aucun salon ne correspond à votre recherche.";
      directory.append(empty);
    }
  };
  search.addEventListener("input", renderRooms);
  try {
    const response = await fetch(base + "/api/rooms", { cache: "no-store" });
    if (!response.ok) throw new Error("Les salons ne sont pas disponibles.");
    roomsState = directorySchema.parse(await response.json());
    directoryReady = true;
    renderRooms();
  } catch {
    status.textContent =
      "Le serveur reprend les salons. Nouvelle tentative en cours…";
    showError(
      "directory-error",
      "Impossible de charger les salons. La reconnexion réessaiera automatiquement.",
    );
  }
  const socket = io(base, { transports: ["websocket", "polling"] });
  socket.on("directory", (data: unknown) => {
    const parsed = directorySchema.safeParse(data);
    if (parsed.success) {
      roomsState = parsed.data;
      directoryReady = true;
      showError("directory-error", "");
      renderRooms();
    }
  });
  socket.on("ready", (data: unknown) => {
    const ready = readySchema.safeParse(data);
    if (!ready.success) return;
    socket
      .timeout(5000)
      .emit(
        "directory",
        { epoch: ready.data.epoch, sequence: 1, turn: "", data: null },
        (error: Error | null, response: unknown) => {
          const result = resultSchema.safeParse(response);
          if (error || !result.success || !result.data.ok)
            showError(
              "directory-error",
              "La liste des salons ne répond pas. Réessayez la connexion.",
            );
        },
      );
  });
  socket.on("disconnect", () => {
    status.textContent =
      "Connexion interrompue · salons affichés au dernier état connu";
  });
  socket.on("server-paused", () => {
    status.textContent = "Le serveur reprend les salons. Reconnexion en cours.";
    directoryReady = false;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => socket.connect(), 1000);
  });
  socket.on(
    "connect_error",
    (error: Error & { data?: { retryable?: boolean } }) => {
      showError(
        "directory-error",
        "Connexion aux salons indisponible. Nouvelle tentative en cours…",
      );
      if (error.data?.retryable) {
        directoryReady = false;
        status.textContent =
          "Le serveur reprend les salons. Nouvelle tentative en cours…";
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => socket.connect(), 1000);
      }
    },
  );
  addEventListener(
    "pagehide",
    () => {
      if (retryTimer) clearTimeout(retryTimer);
      socket.disconnect();
    },
    { once: true },
  );
  const form = element("lobby-form", HTMLFormElement);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!directoryReady) {
      showError(
        "lobby-error",
        "Le serveur reprend les salons. Réessayez dans un instant.",
      );
      return;
    }
    const result = roomName.safeParse(field(form, "room"));
    if (!result.success) {
      showError(
        "lobby-error",
        "Choisissez un nom de 2 à 24 caractères : lettres, chiffres, espaces ou tirets.",
      );
      return;
    }
    location.assign(base + "/room?room=" + encodeURIComponent(result.data));
  });
}
