import { randomInt, randomUUID } from "node:crypto";
import type {
  Identity,
  Player,
  Stroke,
  Snapshot,
  Phase,
  Message,
  RoundRecord,
} from "../shared/contracts";
const words = [
  "chat",
  "montagne",
  "vélo",
  "parapluie",
  "guitare",
  "pizza",
  "fusée",
  "château",
  "papillon",
  "couronne",
  "poisson",
  "soleil",
  "robot",
  "pomme",
  "clé",
  "bateau",
  "cactus",
  "train",
  "lunettes",
  "cerise",
  "tortue",
  "maison",
  "étoile",
  "banane",
];
export interface Timing {
  graceMs?: number;
  recoveryMs?: number;
  leaseMs?: number;
  leasePollMs?: number;
  chooseMs?: number;
  countdownMs?: number;
  drawMs?: number;
  revealMs?: number;
}
export class GameRoom {
  readonly name: string;
  turn = randomUUID();
  players = new Map<string, Player>();
  host = "";
  drawer = "";
  phase: Phase = "waiting";
  round = 0;
  rounds = 2;
  deadline = 0;
  history: Stroke[] = [];
  messages: Message[] = [];
  gallery: RoundRecord[] = [];
  private redoStack: Stroke[][] = [];
  private word = "";
  private choices: string[] = [];
  private queue: string[] = [];
  private timer?: NodeJS.Timeout;
  private serial = 0;
  private seconds = 60;
  private timing: Timing;
  private changed: () => void;
  constructor(name: string, changed: () => void, timing: Timing = {}) {
    this.name = name;
    this.changed = changed;
    this.timing = timing;
  }
  canJoin(id: string) {
    if (this.players.has(id)) return;
    if (this.players.size >= 10)
      throw new Error("Ce salon est complet (10 joueurs).");
    if (!["waiting", "finished"].includes(this.phase))
      throw new Error("Une partie est en cours. Attendez la prochaine.");
  }
  join(user: Identity) {
    this.canJoin(user.id);
    const existing = this.players.get(user.id);
    if (existing) {
      const renamed = existing.name !== user.name;
      existing.name = user.name;
      if (renamed) this.changed();
      if (!existing.connected) {
        existing.connected = true;
        this.changed();
      }
      return;
    }
    this.players.set(user.id, {
      ...user,
      score: 0,
      connected: true,
      guessed: false,
    });
    if (!this.host) this.host = user.id;
    this.message(user.name + " rejoint le salon.");
    this.changed();
  }
  disconnect(id: string) {
    const player = this.players.get(id);
    if (player) {
      player.connected = false;
      this.changed();
    }
  }
  leave(id: string) {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    this.queue = this.queue.filter((item) => item !== id);
    if (this.host === id) this.host = this.players.keys().next().value || "";
    this.message(player.name + " quitte le salon.");
    if (
      this.players.size < 2 &&
      !["waiting", "finished"].includes(this.phase)
    ) {
      this.cancel();
      this.phase = "waiting";
      this.deadline = 0;
      this.drawer = "";
      this.word = "";
      this.choices = [];
    } else if (
      this.drawer === id &&
      ["drawing", "choosing", "countdown"].includes(this.phase)
    )
      this.reveal();
    this.changed();
  }
  start(id: string, rounds: number, seconds: number) {
    if (id !== this.host) throw new Error("Seul l’hôte peut démarrer.");
    if (!["waiting", "finished"].includes(this.phase))
      throw new Error("La partie est déjà en cours.");
    if (
      this.players.size < 2 ||
      [...this.players.values()].some((player) => !player.connected)
    )
      throw new Error("Il faut au moins deux joueurs connectés.");
    if (
      !Number.isInteger(rounds) ||
      rounds < 1 ||
      rounds > 5 ||
      !Number.isInteger(seconds) ||
      seconds < 30 ||
      seconds > 120
    )
      throw new Error("Réglages de partie invalides.");
    this.rounds = rounds;
    this.seconds = seconds;
    this.round = 0;
    this.queue = [];
    for (const player of this.players.values()) player.score = 0;
    this.next();
  }
  choose(id: string, word: string) {
    if (
      id !== this.drawer ||
      this.phase !== "choosing" ||
      !this.choices.includes(word)
    )
      throw new Error("Choisissez un mot proposé pendant votre tour.");
    this.word = word;
    this.choices = [];
    const begin = () => {
      this.phase = "drawing";
      this.schedule(this.timing.drawMs ?? this.seconds * 1000, () =>
        this.reveal(),
      );
      this.changed();
    };
    const countdown = this.timing.countdownMs ?? 3000;
    if (countdown === 0) begin();
    else {
      this.phase = "countdown";
      this.schedule(countdown, begin);
      this.changed();
    }
  }
  draw(id: string, stroke: Stroke) {
    this.mustDraw(id);
    if (this.history.length >= 20000)
      throw new Error("Toile pleine. Effacez ou annulez un trait.");
    this.redoStack = [];
    this.history.push(stroke);
  }
  undo(id: string) {
    this.mustDraw(id);
    const last = this.history.at(-1)?.id;
    if (last) {
      this.redoStack.push(this.history.filter((stroke) => stroke.id === last));
      this.redoStack = this.redoStack.slice(-100);
      this.history = this.history.filter((stroke) => stroke.id !== last);
    }
    this.changed();
  }
  redo(id: string) {
    this.mustDraw(id);
    const strokes = this.redoStack.at(-1);
    if (!strokes?.length) throw new Error("Aucun trait à rétablir.");
    if (this.history.length + strokes.length > 20000)
      throw new Error("Toile pleine.");
    this.redoStack.pop();
    this.history.push(...strokes);
    this.changed();
  }
  skip(id: string) {
    if (
      id !== this.drawer ||
      !["choosing", "countdown", "drawing"].includes(this.phase)
    )
      throw new Error("Seul le dessinateur peut passer pendant son tour.");
    this.reveal();
  }
  clear(id: string) {
    this.mustDraw(id);
    this.history = [];
    this.redoStack = [];
    this.changed();
  }
  chat(id: string, text: string) {
    const player = this.players.get(id);
    if (!player) throw new Error("Rejoignez le salon.");
    if (["choosing", "countdown", "drawing"].includes(this.phase))
      throw new Error(
        "La discussion reprend après la manche. Utilisez le champ réponse si vous devinez.",
      );
    this.messages.push({
      id: ++this.serial,
      name: player.name,
      text,
      system: false,
    });
    this.messages = this.messages.slice(-100);
    this.changed();
  }
  guess(id: string, text: string) {
    const player = this.players.get(id);
    if (!player) throw new Error("Rejoignez le salon.");
    if (this.phase !== "drawing" || Date.now() >= this.deadline)
      throw new Error(
        "Les réponses sont ouvertes uniquement pendant le dessin.",
      );
    if (id === this.drawer)
      throw new Error("Gardez le mot secret : vous dessinez ce tour.");
    if (player.guessed) throw new Error("Vous avez déjà trouvé.");
    const normalize = (value: string) =>
      value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, "");
    if (normalize(text) === normalize(this.word)) {
      if (id === this.drawer) throw new Error("Gardez le mot secret.");
      if (player.guessed) throw new Error("Vous avez déjà trouvé.");
      player.guessed = true;
      player.score +=
        100 + Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
      const drawer = this.players.get(this.drawer);
      if (drawer) drawer.score += 50;
      this.message(player.name + " a trouvé le mot !");
      if (
        [...this.players.values()]
          .filter((item) => item.id !== this.drawer)
          .every((item) => item.guessed)
      )
        this.reveal();
      else this.changed();
    } else {
      this.messages.push({
        id: ++this.serial,
        name: player.name,
        text,
        system: false,
      });
      this.messages = this.messages.slice(-100);
      this.changed();
    }
  }
  snapshot(id: string): Snapshot {
    const reveal = this.phase === "reveal" || this.phase === "finished";
    return {
      room: this.name,
      turn: this.turn,
      host: this.host,
      drawer: this.drawer,
      phase: this.phase,
      round: this.round,
      rounds: this.rounds,
      deadline: this.deadline,
      hint: this.word ? this.word.replace(/[\p{L}\p{N}]/gu, "_") : "",
      ...(reveal || (id === this.drawer && this.phase === "drawing")
        ? { word: this.word }
        : {}),
      ...(id === this.drawer && this.phase === "choosing"
        ? { choices: this.choices }
        : {}),
      players: [...this.players.values()].map((player) => ({ ...player })),
      history: this.history,
      messages: this.messages,
      gallery: this.gallery,
      canUndo:
        id === this.drawer &&
        this.phase === "drawing" &&
        this.history.length > 0,
      canRedo:
        id === this.drawer &&
        this.phase === "drawing" &&
        this.redoStack.length > 0,
    };
  }
  // Recovery deliberately cancels timed play: an elapsed deadline must never
  // award points or advance a new turn while everyone is reconnecting.
  durableSnapshot(): Snapshot {
    return structuredClone({ ...this.snapshot(""), word: this.word });
  }
  static recover(state: Snapshot, changed: () => void, timing: Timing = {}) {
    const room = new GameRoom(state.room, changed, timing);
    room.players = new Map(
      state.players.map((player) => [
        player.id,
        {
          ...player,
          connected: false,
          guessed: false,
        },
      ]),
    );
    room.host = room.players.has(state.host)
      ? state.host
      : room.players.keys().next().value || "";
    room.rounds = state.rounds;
    room.history = state.history;
    room.messages = state.messages;
    room.gallery = state.gallery;
    room.serial = Math.max(0, ...room.messages.map((message) => message.id));
    const interrupted = !["waiting", "finished"].includes(state.phase);
    room.phase = state.phase === "finished" ? "finished" : "waiting";
    room.round = room.phase === "finished" ? state.round : 0;
    if (room.phase === "finished") room.word = state.word || "";
    if (["countdown", "drawing"].includes(state.phase)) {
      room.gallery.push({
        id: state.turn,
        round: state.round,
        drawer:
          state.players.find((player) => player.id === state.drawer)?.name ||
          "Joueur parti",
        word: state.word || "Tour interrompu",
        guessed: state.players
          .filter((player) => player.guessed)
          .map((player) => player.name),
        history: structuredClone(state.history),
      });
      room.trimGallery();
    }
    room.message(
      interrupted
        ? "Le serveur a redémarré. La partie est interrompue ; les scores et les dessins sont conservés. L’hôte pourra lancer une nouvelle partie après les reconnexions."
        : "Le serveur a redémarré. Le salon est conservé ; chaque joueur peut reprendre sa place.",
    );
    return room;
  }
  close() {
    this.cancel();
  }
  private mustDraw(id: string) {
    if (
      id !== this.drawer ||
      this.phase !== "drawing" ||
      Date.now() >= this.deadline
    )
      throw new Error("Seul le dessinateur peut modifier la toile.");
  }
  private next() {
    this.turn = randomUUID();
    this.cancel();
    if (!this.queue.length) {
      this.round++;
      if (this.round > this.rounds) {
        this.round = this.rounds;
        this.phase = "finished";
        this.deadline = 0;
        this.message("Partie terminée. Une revanche ?");
        this.changed();
        return;
      }
      this.queue = [...this.players.keys()];
    }
    this.drawer = this.queue.shift() || "";
    this.history = [];
    this.redoStack = [];
    this.word = "";
    this.phase = "choosing";
    for (const player of this.players.values()) player.guessed = false;
    const shuffled = [...words];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    this.choices = shuffled.slice(0, 3);
    this.schedule(this.timing.chooseMs ?? 10000, () =>
      this.choose(this.drawer, this.choices[0]),
    );
    this.changed();
  }
  private reveal() {
    if (!["choosing", "countdown", "drawing"].includes(this.phase)) return;
    this.gallery.push({
      id: this.turn,
      round: this.round,
      drawer: this.players.get(this.drawer)?.name || "Joueur parti",
      word: this.word || "Mot non choisi",
      guessed: [...this.players.values()]
        .filter((player) => player.guessed)
        .map((player) => player.name),
      history: this.history.map((stroke) => ({ ...stroke })),
    });
    this.gallery = this.gallery.slice(-6);
    this.trimGallery();
    this.phase = "reveal";
    this.choices = [];
    this.message(
      this.word ? "Le mot était : " + this.word : "Tour interrompu.",
    );
    this.schedule(this.timing.revealMs ?? 3500, () => this.next());
    this.changed();
  }
  private trimGallery() {
    this.gallery = this.gallery.slice(-6);
    while (
      this.gallery.length > 1 &&
      this.gallery.reduce((sum, round) => sum + round.history.length, 0) > 30000
    )
      this.gallery.shift();
  }
  private message(text: string) {
    this.messages.push({
      id: ++this.serial,
      name: "Le salon",
      text,
      system: true,
    });
    this.messages = this.messages.slice(-100);
  }
  private cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(ms: number, callback: () => void) {
    this.cancel();
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(callback, ms);
    this.timer.unref();
  }
}
