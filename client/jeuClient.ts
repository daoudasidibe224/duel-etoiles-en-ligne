import { io, type Socket } from "socket.io-client";
import {
  gameRoomSchema,
  movementSchema,
  scoreSchema,
  type ServerEvents,
  type ClientEvents,
  type PlayerState,
} from "../shared/contracts";
import { element, canvasElement } from "./dom";
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
const mario = new Image(),
  luigi = new Image();
mario.src = "/sprites/mario.png";
luigi.src = "/sprites/luigi.png";
const music = new Audio("/sons/Heat.ogg"),
  hit = new Audio("/sons/Sound-006.wav");
music.loop = true;
music.muted = true;
hit.muted = true;
class Runner {
  score = 0;
  x: number;
  y = 433;
  frame = 0;
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
    readonly sprite: HTMLImageElement,
    x: number,
  ) {
    this.x = x;
  }
  update(context: CanvasRenderingContext2D) {
    if (this.state.runningRight) this.x = Math.min(915, this.x + 5);
    else if (this.state.runningLeft) this.x = Math.max(0, this.x - 5);
    this.frame = (this.frame + 1) % 96;
    const offset = this.state.runningRight
      ? 180
      : this.state.runningLeft
        ? 270
        : this.state.idLeft
          ? 90
          : 0;
    if (this.sprite.complete && this.sprite.naturalWidth)
      context.drawImage(
        this.sprite,
        offset,
        Math.floor(this.frame / 6) * 113.9,
        90,
        113.9,
        this.x,
        this.y,
        45,
        57,
      );
  }
}
interface Star {
  x: number;
  y: number;
  life: number;
}
const others = new Map<string, Runner>();
let self: Runner | undefined,
  stars: Star[] = [],
  running = false,
  remaining = 90,
  frame = 0,
  timer: ReturnType<typeof setInterval> | undefined,
  users = 0;
function updateHud() {
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
  music.pause();
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
  status.textContent = "Enregistrement du score…";
  client
    .timeout(5000)
    .emit(
      "scoreFinDeJeu",
      { monScore: self.score, scoreAutreJoueur: opponent.score },
      (timeout: Error | null, error?: string) => {
        status.textContent = timeout
          ? "Connexion interrompue. Le score n’a pas été confirmé."
          : error ||
            "Score enregistré. Retrouvez cette partie dans vos scores.";
      },
    );
}
function draw() {
  if (!running || !ctx) return;
  if (users < 2) {
    finish();
    return;
  }
  ctx.clearRect(0, 0, 960, 540);
  ctx.fillStyle = "rgba(0,0,0,.7)";
  ctx.fillRect(0, 490, 960, 50);
  self?.update(ctx);
  for (const runner of others.values()) runner.update(ctx);
  frame++;
  if (frame % 150 === 0)
    stars.push({ x: 20 + Math.random() * 920, y: 0, life: 60 });
  stars = stars.filter((star) => {
    if (star.y < 475) star.y += 2.5;
    else star.life--;
    ctx.fillStyle = "#ffe94c";
    ctx.shadowColor = "#ffe94c";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const angle = (i * Math.PI) / 5 - Math.PI / 2,
        r = i % 2 ? 4 : 9;
      ctx.lineTo(star.x + Math.cos(angle) * r, star.y + Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    if (
      self &&
      star.x + 9 > self.x &&
      star.x - 9 < self.x + 45 &&
      star.y + 9 > self.y &&
      star.y - 9 < self.y + 57
    ) {
      self.score++;
      updateHud();
      client.emit("score", { score: self.score });
      hit.currentTime = 0;
      void hit.play().catch(() => {});
      return false;
    }
    return star.life > 0;
  });
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
  requestAnimationFrame(draw);
}
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
  status.textContent =
    "Connexion interrompue. Revenez aux salons pour rejouer.";
});
client.on("roomData", (payload) => {
  const parsed = gameRoomSchema.safeParse(payload);
  if (!parsed.success) return;
  const players = parsed.data.utilisateurs;
  users = players.length;
  const count = document.querySelector(".nbJoueur"),
    host = players[0];
  if (count)
    count.textContent =
      users < 2
        ? `${users}/2 joueurs. Invitez un ami pour jouer.`
        : `2/2 joueurs. ${host?.nomUtilisateur} peut lancer la partie.`;
  start.classList.toggle("cacher", users !== 2 || host?.id !== client.id);
  for (const [id] of others)
    if (!players.some((player) => player.id === id)) others.delete(id);
  for (const player of players) {
    if (player.id === client.id) {
      self ??= new Runner(player.id, player.nomUtilisateur, mario, 430);
    } else if (!others.has(player.id))
      others.set(
        player.id,
        new Runner(player.id, player.nomUtilisateur, luigi, 530),
      );
  }
  updateHud();
  if (running && users < 2) finish();
});
client.on("init", () => {
  if (running || !self) return;
  remaining = 90;
  stars = [];
  frame = 0;
  self.score = 0;
  running = true;
  menu.style.display = "none";
  end.style.display = "none";
  status.textContent = "La partie a commencé.";
  void music.play().catch(() => {});
  draw();
  timer = setInterval(() => {
    remaining--;
    updateHud();
    if (remaining <= 0) finish();
  }, 1000);
});
client.on("score", (payload) => {
  const parsed = scoreSchema.safeParse(payload);
  if (!parsed.success) return;
  const runner = others.get(parsed.data.id);
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
  client.emit("deplacementMonJoueur", { etat: self.state });
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
element("terminer").addEventListener("click", () => {
  location.href = "/salon";
});
element("sound-toggle").addEventListener("click", () => {
  const button = element("sound-toggle"),
    enabled = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = enabled ? "Couper le son" : "Activer le son";
  music.muted = !enabled;
  hit.muted = !enabled;
  if (enabled && running) void music.play().catch(() => {});
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
