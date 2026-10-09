import { io, type Socket } from "socket.io-client";
import {
  gameRoomSchema,
  movementSchema,
  scoreSchema,
  roundSchema,
  type Round,
  type Star,
  type Player,
  type ServerEvents,
  type ClientEvents,
  type PlayerState,
} from "../shared/contracts";
import {
  activeBonus,
  BONUS_NAMES,
  stageAt,
  STAGES,
  runnerSpeed,
} from "../shared/progression";
import { ArenaRenderer } from "./arenaRenderer";
import { smoothPosition } from "./motion";
import { accessEnded, bindSessionResume, element, canvasElement } from "./dom";
const client: Socket<ServerEvents, ClientEvents> = io("/jeu", {
  transports: ["websocket"],
});
const room = location.pathname.split("/").pop();
let canvas = canvasElement("gameCanvas");
let renderer: ArenaRenderer | undefined;
let lastFrame = 0;
const status = element("game-status"),
  start = element("btnDepart"),
  menu = element("menuDepart"),
  end = element("finPartie");
let audio: AudioContext | undefined;
let soundEnabled = false;
let soundTimer: ReturnType<typeof setInterval> | undefined;
function tone(frequency: number, length = 0.08) {
  if (!soundEnabled || !audio || audio.state !== "running") return;
  const oscillator = audio.createOscillator(),
    volume = audio.createGain();
  oscillator.type = "square";
  oscillator.frequency.value = frequency;
  volume.gain.setValueAtTime(0.025, audio.currentTime);
  volume.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + length);
  oscillator.connect(volume).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + length);
  oscillator.onended = () => {
    oscillator.disconnect();
    volume.disconnect();
  };
}
function playMusic() {
  clearInterval(soundTimer);
  if (!soundEnabled || !running) return;
  const notes = [220, 330, 440, 330, 262, 392, 523, 392];
  let note = 0;
  soundTimer = setInterval(() => {
    tone(notes[note % notes.length] ?? 220, 0.12);
    note++;
  }, 600);
}
class Runner {
  score = 0;
  kind: "account" | "guest" = "account";
  bonus: Player["bonus"];
  slowedUntil: number | undefined;
  feedback: Player["feedback"];
  x: number;
  targetX: number;
  local = false;
  sampledAt = Date.now();
  state: PlayerState = {
    runningLeft: false,
    runningRight: false,
    idLeft: false,
    idRight: true,
    dead: false,
  };
  constructor(
    public id: string,
    public name: string,
    public color: string,
    x: number,
  ) {
    this.x = x;
    this.targetX = x;
  }
  update(dt: number) {
    const direction =
      Number(this.state.runningRight) - Number(this.state.runningLeft);
    this.x = smoothPosition(
      { ...this, direction, speed: runnerSpeed(this) },
      dt,
      Date.now(),
    );
  }
}
const others = new Map<string, Runner>();
let self: Runner | undefined,
  stars: Star[] = [],
  running = false,
  remaining = 90,
  timer: ReturnType<typeof setInterval> | undefined,
  users = 0,
  playerId = "",
  currentRound: Round | undefined,
  sequence = 0,
  animation: number | undefined,
  replaced = false;
function updateHud() {
  const phase = currentRound ? stageAt(currentRound) : 0;
  const active = self && activeBonus(self);
  element("stage-name").textContent =
    `Étape ${phase + 1} / 3 · ${(STAGES[phase] ?? STAGES[0]).name}`;
  element("stage-progress").setAttribute(
    "max",
    String(
      currentRound ? (currentRound.endsAt - currentRound.startedAt) / 1000 : 90,
    ),
  );
  element("stage-progress").setAttribute(
    "value",
    String(
      currentRound
        ? Math.min(
            (currentRound.endsAt - currentRound.startedAt) / 1000,
            (Date.now() - currentRound.startedAt) / 1000,
          )
        : 0,
    ),
  );
  element("bonus-status").textContent = currentRound?.ended
    ? "Manche terminée."
    : active
      ? `${BONUS_NAMES[active.kind]} · ${Math.ceil((active.expiresAt - Date.now()) / 1000)} s`
      : "Ramassez un bonus : son effet démarre tout seul.";
  if (
    currentRound?.ended ||
    (self?.feedback && Date.now() - self.feedback.at > 3000)
  )
    element("bonus-feedback").textContent = "";
  if (self && (self.slowedUntil ?? 0) > Date.now())
    element("bonus-status").textContent +=
      ` · Ralenti ${Math.ceil((self.slowedUntil! - Date.now()) / 1000)} s`;
  const waiting = !currentRound;
  element("arena-waiting").hidden = !waiting;
  canvas.hidden = waiting;
  element("waiting-title").textContent =
    users < 2 ? "En attente du second joueur" : "Tout le monde est prêt";
  element("waiting-description").textContent =
    users < 2
      ? "Copiez l’invitation pour partager cette arène."
      : "Le propriétaire du salon peut lancer la manche.";
  element("timer-label").textContent = waiting
    ? "Durée prévue"
    : "Temps restant";
  element("game-hud").setAttribute(
    "aria-label",
    waiting ? "Joueurs et durée prévue" : "Scores et temps restant",
  );
  if (waiting) element("countdown").removeAttribute("role");
  else element("countdown").setAttribute("role", "timer");
  element("self-name").textContent = self?.name || "Vous";
  element("self-score").textContent = String(self?.score || 0);
  element("self-player").setAttribute(
    "data-tone",
    self?.color === "#bcf36e" ? "mint" : "amber",
  );
  const opponent = [...others.values()][0];
  element("other-player").setAttribute(
    "data-tone",
    opponent?.color === "#ffbf47" ? "amber" : "mint",
  );
  element("other-name").textContent = opponent?.name || "Place libre";
  const opponentScore = element("other-score");
  opponentScore.textContent = opponent ? String(opponent.score) : "—";
  opponentScore.setAttribute(
    "aria-label",
    opponent ? `Score de ${opponent.name}` : "En attente du second joueur",
  );
  opponentScore.parentElement?.classList.toggle("is-empty", !opponent);
  element("countdown").textContent =
    `${Math.floor(remaining / 60)}:${(remaining % 60).toString().padStart(2, "0")}`;
}
function stop() {
  running = false;
  clearInterval(timer);
  if (animation !== undefined) cancelAnimationFrame(animation);
  clearInterval(soundTimer);
  if (self) {
    self.state.runningLeft = false;
    self.state.runningRight = false;
  }
}
function finish() {
  if (!self) return;
  menu.style.display = "none";
  start.classList.add("cacher");
  stop();
  end.style.display = "block";
  const opponent = others.values().next().value;
  if (!opponent) {
    element("resultat").textContent = "L’autre joueur a quitté la partie.";
    return;
  }
  element("resultat").textContent =
    self.score === opponent.score
      ? "Égalité, belle partie !"
      : self.score > opponent.score
        ? "Vous avez gagné !"
        : `${opponent.name} a gagné.`;
  element("monScore").textContent = `Votre score : ${self.score}`;
  element("autreScore").textContent = `${opponent.name} : ${opponent.score}`;
  status.textContent =
    self.kind === "guest"
      ? "Partie terminée. Votre score invité reste visible ici."
      : currentRound?.saved
        ? "Score enregistré. Retrouvez cette partie dans vos scores."
        : currentRound?.saveError || "Enregistrement du score…";
  element("retry-score").classList.toggle(
    "cacher",
    self.kind === "guest" || !currentRound?.saveError,
  );
}
function draw() {
  if (!running) return;
  if (users < 2) {
    finish();
    return;
  }
  const now = Date.now(),
    dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  renderArena(dt, now);
  animation = requestAnimationFrame(draw);
}
function renderArena(dt = 0, now = Date.now()) {
  const runners = [self, ...others.values()].filter(
    (runner): runner is Runner => Boolean(runner),
  );
  runners.forEach((runner) => runner.update(dt));
  renderer ??= new ArenaRenderer(canvas, element("renderer-notice"));
  canvas = renderer.canvas;
  renderer.render(
    runners.map((runner) => ({
      ...runner,
      moving: runner.state.runningLeft || runner.state.runningRight,
      local: runner.local,
      facing: runner.state.idLeft ? -1 : 1,
    })),
    stars,
    now,
  );
}
client.on("identity", (id) => {
  playerId = id;
});
client.on("replaced", () => {
  replaced = true;
  stop();
  status.textContent =
    "Cette partie est ouverte dans un autre onglet. Votre place y a été transférée.";
  start.classList.add("cacher");
});
client.on("roomClosed", (reason) => {
  stop();
  start.classList.add("cacher");
  status.textContent = reason;
});
bindSessionResume(client);
client.on("accessEnded", accessEnded);
const joinRoom = () =>
  client.emit("join", { room }, (error) => {
    if (error) {
      status.textContent = error;
      start.classList.add("cacher");
    }
  });
client.on("connect", joinRoom);
client.on("engineReady", () => {
  if (!replaced) joinRoom();
});
client.on("connect_error", () => {
  status.textContent = "Connexion impossible. Rechargez la page.";
});
client.on("disconnect", () => {
  stop();
  if (!replaced)
    status.textContent =
      "Connexion interrompue. Reprise automatique pendant 12 secondes…";
});
client.on("roomData", (payload) => {
  const parsed = gameRoomSchema.safeParse(payload);
  if (!parsed.success) return;
  const players = parsed.data.utilisateurs;
  element("room-recovery").textContent = parsed.data.recoveryNotice ?? "";
  element("room-recovery").hidden = !parsed.data.recoveryNotice;
  if (!parsed.data.round && parsed.data.recoveryNotice) {
    stop();
    currentRound = undefined;
    stars = [];
    renderer?.render([], []);
    remaining = 90;
    menu.style.display = "block";
    end.style.display = "none";
    status.textContent =
      "Salon restauré. En attente du départ de la nouvelle manche.";
    for (const runner of [self, ...others.values()])
      if (runner) {
        runner.x = runner.id === parsed.data.ownerId ? 430 : 530;
        runner.state = {
          runningLeft: false,
          runningRight: false,
          idLeft: false,
          idRight: true,
          dead: false,
        };
      }
  }
  if (parsed.data.round) {
    stars = parsed.data.round.stars;
    if (currentRound?.id === parsed.data.round.id)
      currentRound = parsed.data.round;
  }
  users = players.length;
  const count = document.querySelector(".nbJoueur"),
    host =
      players.find((player) => player.userId === parsed.data.ownerId) ??
      players[0];
  if (count)
    count.textContent =
      users < 2
        ? `${users}/2 joueurs. Invitez un ami pour jouer.`
        : `2/2 joueurs. ${host?.nomUtilisateur} peut lancer la partie.`;
  start.classList.toggle(
    "cacher",
    users !== 2 || host?.userId !== playerId || Boolean(parsed.data.round),
  );
  for (const [id] of others)
    if (!players.some((player) => player.id === id)) others.delete(id);
  for (const player of players) {
    if (player.userId === playerId) {
      self ??= new Runner(
        player.id,
        player.nomUtilisateur,
        player.userId === parsed.data.ownerId ? "#ffbf47" : "#bcf36e",
        player.userId === parsed.data.ownerId ? 430 : 530,
      );
      self.score = player.score;
      self.kind = player.kind;
      self.bonus = player.bonus;
      self.local = true;
      self.targetX = player.x;
      self.sampledAt = Date.now();
      self.slowedUntil = player.slowedUntil;
      if (player.feedback?.id !== self.feedback?.id && player.feedback) {
        element("bonus-feedback").textContent = player.feedback.text;
        element("bonus-feedback").setAttribute(
          "data-good",
          String(player.feedback.good),
        );
        tone(player.feedback.good ? 880 : 180, 0.1);
      }
      self.feedback = player.feedback;
    } else if (!others.has(player.id))
      others.set(
        player.id,
        new Runner(
          player.id,
          player.nomUtilisateur,
          player.userId === parsed.data.ownerId ? "#ffbf47" : "#bcf36e",
          player.userId === parsed.data.ownerId ? 430 : 530,
        ),
      );
  }
  for (const player of players) {
    const other = others.get(player.id);
    if (other) {
      other.score = player.score;
      other.bonus = player.bonus;
      other.targetX = player.x;
      other.slowedUntil = player.slowedUntil;
      other.feedback = player.feedback;
    }
  }
  updateHud();
});
client.on("init", (payload) => {
  const parsed = roundSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.ended ||
    !self ||
    (running && currentRound?.id === parsed.data.id)
  )
    return;
  stop();
  currentRound = parsed.data;
  remaining = Math.max(0, Math.ceil((currentRound.endsAt - Date.now()) / 1000));
  stars = parsed.data.stars;
  running = true;
  lastFrame = 0;
  self.x = self.targetX;
  menu.style.display = "none";
  end.style.display = "none";
  updateHud();
  status.textContent = "La partie a commencé.";
  playMusic();
  draw();
  timer = setInterval(() => {
    remaining = Math.max(
      0,
      Math.ceil(((currentRound?.endsAt ?? Date.now()) - Date.now()) / 1000),
    );
    updateHud();
    if (remaining <= 0) stop();
  }, 250);
});
client.on("roundEnded", (payload) => {
  const parsed = gameRoomSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.round?.ended) return;
  currentRound = parsed.data.round;
  for (const player of parsed.data.utilisateurs) {
    if (player.userId !== playerId && !others.has(player.id))
      others.set(
        player.id,
        new Runner(
          player.id,
          player.nomUtilisateur,
          player.userId === parsed.data.ownerId ? "#ffbf47" : "#bcf36e",
          player.userId === parsed.data.ownerId ? 430 : 530,
        ),
      );
    const runner = player.userId === playerId ? self : others.get(player.id);
    if (runner) {
      runner.score = player.score;
      runner.x = player.x;
      runner.targetX = player.x;
    }
  }
  remaining = 0;
  stars = [];
  updateHud();
  renderArena();
  finish();
});
client.on("score", (payload) => {
  const parsed = scoreSchema.safeParse(payload);
  if (!parsed.success) return;
  if (parsed.data.roundId !== currentRound?.id) return;
  const runner =
    parsed.data.id === playerId ? self : others.get(parsed.data.id);
  if (runner) runner.score = parsed.data.score;
  updateHud();
});
client.on("deplacementMonJoueur", (payload) => {
  const parsed = movementSchema.safeParse(payload);
  if (!parsed.success) return;
  const runner = others.get(parsed.data.id);
  if (runner) runner.state = parsed.data.etat;
});
function move(direction: "left" | "right", pressed: boolean) {
  if (!self || !running) return;
  if (
    (direction === "left"
      ? self.state.runningLeft
      : self.state.runningRight) === pressed
  )
    return;
  if (direction === "left") {
    self.state.runningLeft = pressed;
    self.state.idLeft = true;
    self.state.idRight = false;
  } else {
    self.state.runningRight = pressed;
    self.state.idRight = true;
    self.state.idLeft = false;
  }
  if (pressed) self.sampledAt = Date.now();
  client.emit("deplacementMonJoueur", {
    etat: self.state,
    roundId: currentRound?.id,
    sequence: sequence++,
  });
}
for (const type of ["keydown", "keyup"])
  document.addEventListener(type, (event) => {
    if (
      !(event instanceof KeyboardEvent) ||
      !["ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    move(event.key === "ArrowLeft" ? "left" : "right", type === "keydown");
  });
for (const [id, direction] of [
  ["move-left", "left"],
  ["move-right", "right"],
] as const) {
  const button = element(id);
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (
      event instanceof PointerEvent &&
      button.hasPointerCapture(event.pointerId) === false
    ) {
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        /* Un événement simulé peut ne pas avoir de pointeur actif. */
      }
    }
    move(direction, true);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    button.addEventListener(type, () => move(direction, false));
}
window.addEventListener("blur", () => {
  move("left", false);
  move("right", false);
});
window.addEventListener("resize", () => {
  if (!running && currentRound && renderer) renderArena();
});
start.addEventListener("click", () => client.emit("startGame"));
function leaveGame() {
  client.timeout(3000).emit("leave", () => {
    location.href = "/salon";
  });
}
element("terminer").addEventListener("click", leaveGame);
element("leave-game").addEventListener("click", leaveGame);
element("retry-score").addEventListener("click", () => {
  status.textContent = "Enregistrement du score…";
  client
    .timeout(5000)
    .emit(
      "scoreFinDeJeu",
      { roundId: currentRound?.id },
      (timeout: Error | null, error?: string) => {
        status.textContent = timeout
          ? "Connexion interrompue. Réessayez."
          : error ||
            "Score enregistré. Retrouvez cette partie dans vos scores.";
        element("retry-score").classList.toggle("cacher", !timeout && !error);
      },
    );
});
element("sound-toggle").addEventListener("click", () => {
  const button = element("sound-toggle"),
    enabled = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = enabled ? "Couper le son" : "Activer le son";
  soundEnabled = enabled;
  if (enabled) {
    audio ??= new AudioContext();
    void audio.resume().then(playMusic);
  } else clearInterval(soundTimer);
});
element("share-room").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    status.textContent = "Invitation copiée. Envoyez ce lien au second joueur.";
  } catch {
    status.textContent = `Copiez ce lien pour inviter un ami : ${location.href}`;
  }
});
window.addEventListener("load", () => {
  element("chargement").style.display = "none";
  element("airDeJeu").style.display = "block";
});
window.addEventListener("pagehide", () => {
  stop();
  client.disconnect();
  renderer?.dispose();
});
