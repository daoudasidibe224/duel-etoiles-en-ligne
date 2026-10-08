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
import { activeBonus, stageAt, STAGES } from "../shared/progression";
import { accessEnded, element, canvasElement } from "./dom";
const client: Socket<ServerEvents, ClientEvents> = io("/jeu", {
  transports: ["websocket"],
});
const room = location.pathname.split("/").pop(),
  canvas = canvasElement("gameCanvas"),
  ctx = canvas.getContext("2d");
if (!ctx) throw new Error("Le navigateur ne prend pas en charge le canvas.");
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
  frame = 0;
  score = 0;
  kind: Player["kind"] = "account";
  bonus: Player["bonus"];
  usedStages: number[] = [];
  x: number;
  y = 433;
  state: PlayerState = {
    runningLeft: false,
    runningRight: false,
    idLeft: false,
    idRight: true,
    dead: false,
  };
  constructor(
    readonly id: string,
    readonly name: string,
    readonly color: string,
    x: number,
  ) {
    this.x = x;
  }
  update(context: CanvasRenderingContext2D) {
    const speed = activeBonus(this)?.kind === "sprint" ? 7.5 : 5;
    if (this.state.runningRight) this.x = Math.min(915, this.x + speed);
    else if (this.state.runningLeft) this.x = Math.max(0, this.x - speed);
    this.frame = (this.frame + 1) % 96;
    const moving = this.state.runningLeft || this.state.runningRight;
    const step = moving ? (Math.floor(this.frame / 12) % 2) * 3 : 0;
    context.save();
    context.translate(this.x, this.y);
    context.fillStyle = this.color;
    context.fillRect(6, 0, 33, 22);
    context.fillRect(4, 24, 37, 21);
    context.fillRect(0, 27, 5, 17);
    context.fillRect(40, 27, 5, 17);
    context.fillRect(8, 44, 11, 13 - step);
    context.fillRect(26, 44, 11, 10 + step);
    context.fillStyle = "#080b08";
    context.fillRect(10, 5, 25, 11);
    context.fillRect(12, 30, 21, 6);
    context.fillStyle = "#f5ffe8";
    const look = this.state.idLeft ? -2 : 2;
    context.fillRect(14 + look, 8, 4, 4);
    context.fillRect(25 + look, 8, 4, 4);
    context.fillRect(19, 24, 7, 3);
    context.restore();
  }
}
const collecting = new Set<string>();
const bonusRequests = new Map<
  number,
  { id: string; kind: "sprint" | "multiplier" }
>();
let bonusPending = false;
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
  element("bonus-status").textContent = active
    ? `${active.kind === "sprint" ? "Accélération" : "Points doublés"} · ${Math.max(0, Math.ceil((active.expiresAt - Date.now()) / 1000))} s`
    : self?.usedStages.includes(phase)
      ? "Charge utilisée. La prochaine étape recharge le bonus."
      : "Une charge disponible pour cette étape.";
  for (const id of ["bonus-sprint", "bonus-multiplier"]) {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement)
      button.disabled =
        !running ||
        bonusPending ||
        Boolean(active) ||
        Boolean(self?.usedStages.includes(phase));
  }
  const opponent = others.values().next().value;
  element("self-name").textContent = self?.name || "Vous";
  element("self-score").textContent = String(self?.score || 0);
  element("other-name").textContent = opponent?.name || "Second joueur";
  element("other-score").textContent = String(opponent?.score || 0);
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
  if (!running || !ctx) return;
  if (users < 2) {
    finish();
    return;
  }
  ctx.fillStyle = "#080e0a";
  ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = "#263421";
  for (let x = 0; x < 960; x += 48)
    for (let y = 0; y < 490; y += 48) ctx.fillRect(x, y, 1, 1);
  ctx.strokeStyle = "#294125";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 350);
  for (let i = 0; i < 13; i++) {
    const x = i * 80,
      top = 315 - (i % 3) * 50;
    ctx.lineTo(x, top);
    ctx.lineTo(x + 50, top);
    ctx.lineTo(x + 50, 395);
  }
  ctx.lineTo(960, 395);
  ctx.stroke();
  ctx.fillStyle = "#788559";
  for (const [x, y] of [
    [80, 65],
    [245, 145],
    [390, 60],
    [670, 120],
    [830, 55],
    [540, 205],
  ] as const) {
    ctx.fillRect(x, y, 5, 1);
    ctx.fillRect(x + 2, y - 2, 1, 5);
  }
  ctx.strokeStyle = "#bcf36e";
  ctx.beginPath();
  ctx.moveTo(0, 490);
  ctx.lineTo(960, 490);
  ctx.stroke();
  ctx.fillStyle = "rgba(0,0,0,.7)";
  ctx.fillRect(0, 490, 960, 50);
  self?.update(ctx);
  for (const runner of others.values()) runner.update(ctx);
  for (const star of stars) {
    if (collecting.has(star.id)) continue;
    const y = ((Date.now() - star.bornAt) / 1000) * star.speed;
    if (y > 535) continue;
    ctx.fillStyle = "#ffe94c";
    ctx.shadowColor = "#ffe94c";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const angle = (i * Math.PI) / 5 - Math.PI / 2,
        r = i % 2 ? 4 : 9;
      ctx.lineTo(star.x + Math.cos(angle) * r, y + Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    if (
      self &&
      star.x + 9 > self.x &&
      star.x - 9 < self.x + 45 &&
      y + 9 > self.y &&
      y - 9 < self.y + 57
    ) {
      collecting.add(star.id);
      client
        .timeout(5000)
        .emit(
          "score",
          { starId: star.id, roundId: currentRound?.id, sequence: sequence++ },
          (timeout: Error | null, error?: string) => {
            if (!timeout && !error) tone(880, 0.08);
            else if (timeout) collecting.delete(star.id);
          },
        );
    }
  }
  ctx.fillStyle = "#fff";
  ctx.font = "17px Arial";
  ctx.textAlign = "left";
  ctx.fillText(`${self?.name || ""} : ${self?.score || 0}`, 12, 521);
  ctx.textAlign = "center";
  ctx.fillText(
    `${Math.floor(remaining / 60)
      .toString()
      .padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}`,
    480,
    521,
  );
  ctx.textAlign = "right";
  for (const runner of others.values())
    ctx.fillText(`${runner.name} : ${runner.score}`, 948, 521);
  animation = requestAnimationFrame(draw);
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
client.on("accessEnded", accessEnded);
client.on("connect", () =>
  client.emit("join", { room }, (error) => {
    if (error) {
      status.textContent = error;
      start.classList.add("cacher");
    }
  }),
);
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
      self.usedStages = player.usedStages;
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
    if (runner) runner.score = player.score;
  }
  remaining = 0;
  updateHud();
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
  if (direction === "left") {
    self.state.runningLeft = pressed;
    self.state.idLeft = true;
    self.state.idRight = false;
  } else {
    self.state.runningRight = pressed;
    self.state.idRight = true;
    self.state.idLeft = false;
  }
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
});

for (const kind of ["sprint", "multiplier"] as const)
  element(`bonus-${kind}`).addEventListener("click", () => {
    if (!currentRound || !running || bonusPending) return;
    const stage = stageAt(currentRound);
    let request = bonusRequests.get(stage);
    if (!request || request.kind !== kind) {
      request = { id: crypto.randomUUID(), kind };
      bonusRequests.set(stage, request);
    }
    bonusPending = true;
    updateHud();
    client
      .timeout(5000)
      .emit(
        "activateBonus",
        { ...request, roundId: currentRound.id, stage },
        (timeout: Error | null, error?: string) => {
          bonusPending = false;
          updateHud();
          element("bonus-feedback").textContent = timeout
            ? "Bonus non confirmé. Réessayez avec la connexion rétablie."
            : error || "Bonus activé.";
        },
      );
  });
