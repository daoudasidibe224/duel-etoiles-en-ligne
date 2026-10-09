import { io } from "socket.io-client";
import {
  roomName,
  readySchema,
  snapshotSchema,
  strokeSchema,
  resultSchema,
  type Identity,
  type Snapshot,
} from "../shared/contracts";
import { rememberRoom } from "./recents";
import { DrawingBoard, roundCanvas, downloadCanvas } from "./canvas";
import { element, field, showError } from "./dom";
import { base } from "./api";
export function mountGame(user: Identity) {
  const name = roomName.safeParse(
    new URLSearchParams(location.search).get("room"),
  );
  if (!name.success) {
    location.replace(base + "/lobby");
    return;
  }
  element("room-title", HTMLElement).textContent = name.data;
  const socket = io(base, { transports: ["websocket", "polling"] });
  let snapshot: Snapshot | undefined;
  let epoch = "";
  let sequence = 0;
  let replaced = false;
  let choiceKey = "";
  let galleryKey = "";
  let paused = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const retryConnection = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => socket.connect(), 1000);
  };
  const command = (
    event: string,
    data: unknown,
    done?: () => void,
    settled?: () => void,
  ) => {
    if (!socket.connected) {
      showError("game-error", "La connexion au salon est interrompue.");
      return;
    }
    socket
      .timeout(5000)
      .emit(
        event,
        { epoch, sequence: ++sequence, turn: snapshot?.turn || "", data },
        (error: Error | null, result: unknown) => {
          const parsed = resultSchema.safeParse(result);
          if (error || !parsed.success)
            showError("game-error", "Le salon ne répond pas. Réessayez.");
          else if (!parsed.data.ok)
            showError("game-error", parsed.data.error || "Demande impossible.");
          else {
            showError("game-error", "");
            done?.();
          }
          settled?.();
        },
      );
  };
  const board = new DrawingBoard(
    element("drawing", HTMLCanvasElement),
    (stroke) => command("draw", stroke),
  );
  socket.on("connect", () => {
    element("network", HTMLElement).textContent =
      "Connexion au salon en cours…";
  });
  socket.on("ready", (data: unknown) => {
    const ready = readySchema.safeParse(data);
    if (!ready.success) return;
    epoch = ready.data.epoch;
    sequence = 0;
    replaced = false;
    paused = false;
    command("join", name.data, () => {
      element("network", HTMLElement).textContent = "Connecté au salon";
      if (!rememberRoom(user.id, name.data))
        element("game-notice", HTMLElement).textContent =
          "Ce navigateur ne peut pas retenir les salons récents.";
    });
  });
  socket.on("replaced", (message: unknown) => {
    replaced = true;
    element("resume", HTMLButtonElement).hidden = false;
    showError(
      "game-error",
      typeof message === "string"
        ? message
        : "Votre place a été reprise ailleurs.",
    );
  });
  socket.on("session-ended", (message: unknown) => {
    // The shared site may be regenerating the session (login, logout):
    // a short pause lets its new cookie arrive before reloading.
    showError(
      "game-error",
      typeof message === "string" ? message : "Votre session a changé.",
    );
    setTimeout(() => location.replace(base + "/lobby"), 1000);
  });
  socket.on("server-paused", () => {
    paused = true;
    epoch = "";
    showError(
      "game-error",
      "Le serveur reprend les salons. Reconnexion en cours.",
    );
    retryConnection();
  });
  socket.on("disconnect", () => {
    element("network", HTMLElement).textContent = paused
      ? "Le serveur reprend les salons. Reconnexion en cours."
      : replaced
        ? "Votre identité joue dans un autre onglet. Rechargez pour reprendre la place."
        : "Connexion interrompue. Reconnexion en cours…";
    board.enabled = false;
    element("drawing-tools", HTMLFieldSetElement).disabled = true;
    element("start", HTMLButtonElement).disabled = true;
  });
  socket.on(
    "connect_error",
    (error: Error & { data?: { retryable?: boolean } }) => {
      element("network", HTMLElement).textContent =
        "Connexion au salon impossible.";
      showError("game-error", error.message);
      if (error.data?.retryable) {
        paused = true;
        retryConnection();
      }
    },
  );
  socket.on("problem", (message: unknown) =>
    showError(
      "game-error",
      typeof message === "string" ? message : "Demande impossible.",
    ),
  );
  socket.on("stroke", (data: unknown) => {
    const stroke = strokeSchema.safeParse(data);
    if (stroke.success) {
      board.add(stroke.data);
      element("canvas-actions", HTMLElement).hidden = false;
      element("export", HTMLButtonElement).hidden = false;
      if (board.enabled) {
        element("undo", HTMLButtonElement).disabled = false;
        element("redo", HTMLButtonElement).disabled = true;
      }
    }
  });
  socket.on("snapshot", (data: unknown) => {
    const parsed = snapshotSchema.safeParse(data);
    if (!parsed.success) {
      showError("game-error", "Le salon a envoyé une réponse invalide.");
      return;
    }
    snapshot = parsed.data;
    render(snapshot);
  });
  function render(state: Snapshot) {
    const drawer = state.players.find((player) => player.id === state.drawer),
      drawing = user.id === state.drawer && state.phase === "drawing";
    board.enabled = drawing;
    element("toolbar", HTMLElement).hidden = !drawing;
    board.replace(state.history);
    element("drawing-tools", HTMLFieldSetElement).disabled = !drawing;
    element("undo", HTMLButtonElement).disabled = !state.canUndo;
    element("redo", HTMLButtonElement).disabled = !state.canRedo;
    element("skip-turn", HTMLButtonElement).hidden =
      user.id !== state.drawer ||
      !["choosing", "countdown", "drawing"].includes(state.phase);
    element("export", HTMLButtonElement).hidden = state.history.length === 0;
    element("canvas-actions", HTMLElement).hidden =
      state.history.length === 0 &&
      element("skip-turn", HTMLButtonElement).hidden;
    const nextGallery = state.gallery.map((round) => round.id).join(",");
    if (nextGallery !== galleryKey) {
      galleryKey = nextGallery;
      element("gallery-count", HTMLElement).textContent = String(
        state.gallery.length,
      );
      element("gallery", HTMLElement).replaceChildren(
        ...state.gallery
          .slice()
          .reverse()
          .map((round) => {
            const item = document.createElement("article"),
              title = document.createElement("h3"),
              detail = document.createElement("p"),
              download = document.createElement("button");
            title.textContent = round.word;
            detail.textContent =
              "Tour " +
              round.round +
              " · " +
              round.drawer +
              " · " +
              (round.guessed.length
                ? round.guessed.join(", ") + " a trouvé"
                : "Personne n’a trouvé");
            const canvas = roundCanvas(round.history);
            canvas.setAttribute("aria-label", "Dessin : " + round.word);
            download.type = "button";
            download.className = "secondary";
            download.textContent = "Exporter cette manche";
            download.addEventListener("click", () =>
              downloadCanvas(canvas, "manche-" + round.round + ".png"),
            );
            item.append(title, canvas, detail, download);
            return item;
          }),
      );
    }

    element("player-count", HTMLElement).textContent =
      state.players.length + " / 10";
    const players = state.players
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((player) => {
        const li = document.createElement("li"),
          avatar = document.createElement("span"),
          info = document.createElement("span"),
          score = document.createElement("b");
        avatar.className = "avatar";
        avatar.textContent = player.name.slice(0, 1).toUpperCase();
        const strong = document.createElement("strong"),
          detail = document.createElement("small");
        strong.textContent =
          player.name + (player.id === user.id ? " (vous)" : "");
        detail.textContent = !player.connected
          ? "Reconnexion…"
          : state.phase === "finished"
            ? "Partie terminée"
            : state.phase === "waiting"
              ? player.id === state.host
                ? "Hôte"
                : "Prêt à jouer"
              : player.guessed
                ? "Mot trouvé !"
                : state.phase === "choosing"
                  ? player.id === state.drawer
                    ? "Choisit le mot"
                    : "Attend le choix"
                  : state.phase === "countdown"
                    ? "Se prépare"
                    : state.phase === "drawing"
                      ? player.id === state.drawer
                        ? "Dessine"
                        : "Devine"
                      : "Manche terminée";
        info.append(strong, detail);
        score.textContent = String(player.score);
        li.append(avatar, info, score);
        return li;
      });
    element("players", HTMLElement).replaceChildren(...players);
    const disconnected = state.players.some((player) => !player.connected);
    const labels = {
      waiting:
        state.players.length < 2
          ? "En attente d’un autre joueur"
          : disconnected
            ? "Un joueur se reconnecte"
            : "Prêts · départ par l’hôte",
      countdown: "À vos crayons · départ imminent",
      choosing: (drawer?.name || "Un joueur") + " choisit un mot",
      drawing: drawing
        ? "À vous de dessiner !"
        : (drawer?.name || "Un joueur") + " dessine",
      reveal: "Le mot est révélé",
      finished: "Partie terminée !",
    };
    element("phase", HTMLElement).textContent = labels[state.phase];
    const me = state.players.find((player) => player.id === user.id),
      guessing =
        state.phase === "drawing" && user.id !== state.drawer && !me?.guessed;
    const answerForm = element("answer-form", HTMLFormElement),
      chatForm = element("chat-form", HTMLFormElement);
    answerForm.hidden = !guessing;
    chatForm.hidden = ["choosing", "countdown", "drawing"].includes(
      state.phase,
    );
    element("answer-status", HTMLElement).textContent =
      state.phase === "countdown"
        ? "La manche commence dans quelques secondes. Les réponses et le dessin sont encore fermés."
        : state.phase === "choosing"
          ? "Le dessinateur choisit son mot. Les réponses ouvriront ensuite."
          : state.phase === "drawing"
            ? drawing
              ? "À vous de dessiner. Gardez le mot secret."
              : me?.guessed
                ? "Bien trouvé ! Attendez la fin de la manche."
                : "Proposez votre réponse pendant le dessin."
            : "La discussion est ouverte. Les réponses attendent la prochaine manche.";
    element("round", HTMLElement).textContent = state.round
      ? "Tour " + state.round + " / " + state.rounds
      : "";
    element("word", HTMLElement).textContent = state.choices
      ? "Choisissez votre mot"
      : state.word ||
        (state.hint
          ? state.hint.split("").join(" ")
          : state.phase === "finished"
            ? "Bravo à toute la bande !"
            : state.phase === "countdown"
              ? "Préparez-vous !"
              : state.phase === "choosing"
                ? "Le mot se prépare…"
                : state.players.length < 2
                  ? "Invitez un ami pour commencer."
                  : disconnected
                    ? "Un joueur revient. Gardons sa place."
                    : user.id === state.host
                      ? "La bande est prête. Lancez la partie !"
                      : "La bande est prête. L’hôte donne le départ.");
    element("canvas-note", HTMLElement).hidden =
      state.history.length > 0 || drawing;
    element("canvas-note", HTMLElement).textContent =
      state.phase === "drawing"
        ? "Regardez les traits et proposez votre réponse."
        : "La toile vous attend.";
    const key = state.choices?.join(",") || "";
    if (key !== choiceKey) {
      choiceKey = key;
      element("choices", HTMLElement).replaceChildren(
        ...(state.choices || []).map((word) => {
          const button = document.createElement("button");
          button.className = "secondary";
          button.textContent = word;
          button.addEventListener("click", () => command("choose", word));
          return button;
        }),
      );
    }
    const canStart =
      user.id === state.host && ["waiting", "finished"].includes(state.phase);
    element("start-form", HTMLFormElement).hidden = !canStart;
    element("start", HTMLButtonElement).disabled =
      state.players.length < 2 ||
      state.players.some((player) => !player.connected);
    element("waiting-note", HTMLElement).hidden = ![
      "waiting",
      "finished",
    ].includes(state.phase);
    element("waiting-note", HTMLElement).textContent =
      state.players.length < 2
        ? "Invitez au moins un ami pour lancer la partie."
        : disconnected
          ? "En attente de la reconnexion. Le départ est suspendu."
          : canStart
            ? "Tout le monde est là ? Lancez la partie."
            : state.phase === "waiting"
              ? "L’hôte lancera la partie."
              : "Le prochain tour commencera automatiquement.";
    const messages = element("messages", HTMLElement),
      bottom =
        messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    messages.replaceChildren(
      ...state.messages.map((message) => {
        const p = document.createElement("p");
        p.className = message.system ? "system-message" : "";
        if (!message.system) {
          const strong = document.createElement("strong");
          strong.textContent = message.name + " ";
          p.append(strong);
        }
        p.append(document.createTextNode(message.text));
        return p;
      }),
    );
    if (bottom) messages.scrollTop = messages.scrollHeight;
    updateTimer();
  }
  function updateTimer() {
    const left = snapshot?.deadline
      ? Math.max(0, Math.ceil((snapshot.deadline - Date.now()) / 1000))
      : null;
    element("timer", HTMLElement).textContent =
      left === null
        ? "—"
        : Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  }
  const tick = setInterval(updateTimer, 250);
  const start = element("start-form", HTMLFormElement);
  start.addEventListener("submit", (event) => {
    event.preventDefault();
    command("start", {
      rounds: Number(field(start, "rounds")),
      seconds: Number(field(start, "seconds")),
    });
  });
  for (const [formId, eventName, inputId] of [
    ["chat-form", "chat", "guess"],
    ["answer-form", "guess", "answer"],
  ]) {
    const form = element(formId, HTMLFormElement);
    let pending = false;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = field(form, "message").trim();
      if (pending || form.hidden || !text || !socket.connected) return;
      pending = true;
      const submit = form.querySelector("button");
      if (submit) submit.disabled = true;
      command(
        eventName,
        text,
        () => {
          const input = element(inputId, HTMLInputElement);
          input.value = "";
          if (!form.hidden) input.focus();
        },
        () => {
          pending = false;
          if (submit) submit.disabled = false;
        },
      );
    });
  }
  element("undo", HTMLButtonElement).addEventListener("click", () =>
    command("undo", null),
  );
  element("redo", HTMLButtonElement).addEventListener("click", () =>
    command("redo", null),
  );
  element("skip-turn", HTMLButtonElement).addEventListener("click", () => {
    if (confirm("Passer ce tour et révéler le mot ?")) command("skip", null);
  });
  element("drawing-tool", HTMLSelectElement).addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (
        target instanceof HTMLSelectElement &&
        ["pen", "line", "rectangle", "ellipse"].includes(target.value)
      ) {
        if (
          target.value === "line" ||
          target.value === "rectangle" ||
          target.value === "ellipse"
        )
          board.tool = target.value;
        else board.tool = "pen";
      }
    },
  );
  element("clear", HTMLButtonElement).addEventListener("click", () => {
    if (confirm("Effacer toute la toile ?")) command("clear", null);
  });
  element("color", HTMLSelectElement).addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement) {
      const parsed = strokeSchema.shape.color.safeParse(target.value);
      if (parsed.success) board.color = parsed.data;
    }
  });
  element("resume", HTMLButtonElement).addEventListener("click", () =>
    location.reload(),
  );
  const swatches = [
    ...document.querySelectorAll<HTMLButtonElement>("button[data-color]"),
  ];
  const selectColor = (value: string) => {
    const parsed = strokeSchema.shape.color.safeParse(value);
    if (!parsed.success) return;
    board.color = parsed.data;
    element("color", HTMLSelectElement).value = parsed.data;
    for (const button of swatches)
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.color === parsed.data),
      );
  };
  for (const button of swatches)
    button.addEventListener("click", () =>
      selectColor(button.dataset.color || ""),
    );
  element("color", HTMLSelectElement).addEventListener("change", () =>
    selectColor(element("color", HTMLSelectElement).value),
  );
  element("width", HTMLInputElement).addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) board.width = Number(target.value);
  });
  element("export", HTMLButtonElement).addEventListener("click", () => {
    board.export();
    element("game-notice", HTMLElement).textContent = "Le dessin PNG est prêt.";
  });
  element("invite", HTMLButtonElement).addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      element("game-notice", HTMLElement).textContent = "Lien du salon copié.";
      element("invite", HTMLButtonElement).textContent = "Invitation copiée !";
    } catch {
      showError(
        "game-error",
        "Copiez le lien du salon dans la barre d’adresse.",
      );
    }
  });
  element("leave", HTMLButtonElement).addEventListener("click", () =>
    command("leave", null, () => location.assign(base + "/lobby")),
  );
  addEventListener("pagehide", () => {
    if (retryTimer) clearTimeout(retryTimer);
    clearInterval(tick);
    board.close();
    socket.disconnect();
  });
}
