import { randomUUID } from "node:crypto";
import type {
  BonusInput,
  Player,
  PlayerState,
  Round,
  Star,
} from "../../shared/contracts";
import {
  activeBonus,
  BONUS_NAMES,
  itemY,
  runnerTravel,
  stageAt,
  STAGES,
} from "../../shared/progression";
const PATTERN: Star["kind"][] = [
  "star",
  "sprint",
  "star",
  "meteor",
  "gold",
  "shield",
  "slime",
  "multiplier",
  "star",
  "barrier",
  "magnet",
  "meteor",
];
export class Arena {
  private timer: ReturnType<typeof setInterval>;
  private nextSpawn = 0;
  private spawned = 0;
  private lastTick: number;
  private claimed = new Map<string, string>();
  private movement = new Map<
    string,
    Pick<PlayerState, "runningLeft" | "runningRight">
  >();
  constructor(
    private round: Round,
    private players: Player[],
    private publish: () => void,
    private clock = Date.now,
    private random = Math.random,
  ) {
    this.lastTick = this.clock();
    for (const player of players) {
      player.movementSequence = -1;
      player.movementStartedAt = this.lastTick;
      player.sampledAt = this.lastTick;
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), 50);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }
  move(
    userId: string,
    state: Pick<PlayerState, "runningLeft" | "runningRight">,
    sequence?: number,
  ) {
    // Apply elapsed movement under the previous input before replacing it.
    this.tick();
    this.movement.set(userId, state);
    const player = this.players.find((value) => value.userId === userId);
    if (player) {
      player.movementSequence = sequence ?? -1;
      player.movementStartedAt = this.lastTick;
      player.sampledAt = this.lastTick;
      this.publish();
    }
  }
  halt(userId: string) {
    this.move(userId, { runningLeft: false, runningRight: false });
  }
  private tick() {
    const now = this.clock();
    if (this.round.ended || now >= this.round.endsAt) return;
    const dt = Math.min(0.25, Math.max(0, (now - this.lastTick) / 1000));
    const from = now - dt * 1000;
    const paths = new Map<string, (at: number) => number>();
    this.lastTick = now;
    const phase = stageAt(this.round, now),
      config = STAGES[phase];
    let changed = this.round.stage !== phase;
    this.round.stage = phase;
    const living = this.round.stars.filter((item) =>
      item.kind === "barrier"
        ? from < item.bornAt + (460 / item.speed) * 1000 + 3000
        : itemY(item, from) <= 535,
    );
    changed ||= living.length !== this.round.stars.length;
    this.round.stars = living;
    for (const player of this.players) {
      const state = this.movement.get(player.userId),
        oldX = player.x;
      const direction =
        Number(state?.runningRight === true) -
        Number(state?.runningLeft === true);
      const effects = { bonus: player.bonus, slowedUntil: player.slowedUntil };
      const positionAt = (at: number) =>
        Math.max(
          0,
          Math.min(915, oldX + direction * runnerTravel(effects, from, at)),
        );
      paths.set(player.userId, positionAt);
      player.x = positionAt(now);
      changed ||= player.x !== oldX;
      player.sampledAt = now;
      if (player.bonus && !activeBonus(player, now)) {
        delete player.bonus;
        changed = true;
      }
      if (player.slowedUntil && player.slowedUntil <= now) {
        delete player.slowedUntil;
        changed = true;
      }
    }
    if (now >= this.nextSpawn && this.round.stars.length < 20) {
      const index = this.spawned++;
      this.round.stars.push({
        id: randomUUID(),
        kind: PATTERN[index % PATTERN.length],
        x: index === 0 ? 450 : 40 + this.random() * 860,
        bornAt: now,
        speed: config.speed,
      });
      this.nextSpawn = now + config.interval;
      changed = true;
    }
    // One shared object, one winner. Nearest robot wins; alternate ties rather than favouring the host.
    for (const item of [...this.round.stars]) {
      const candidates = this.players
        .map((player) => ({
          player,
          distance: this.contactDistance(
            player,
            paths.get(player.userId)!,
            item,
            from,
            now,
          ),
        }))
        .filter((candidate) => candidate.distance !== undefined);
      candidates.sort(
        (a, b) =>
          a.distance! - b.distance! ||
          (this.spawned % 2
            ? this.players
            : [...this.players].reverse()
          ).indexOf(a.player) -
            (this.spawned % 2
              ? this.players
              : [...this.players].reverse()
            ).indexOf(b.player),
      );
      if (candidates[0]) {
        this.apply(candidates[0].player, item, now);
        changed = true;
      }
    }
    this.round.stars = this.round.stars.filter((item) =>
      item.kind === "barrier"
        ? now < item.bornAt + (460 / item.speed) * 1000 + 3000
        : itemY(item, now) <= 535,
    );
    if (changed) this.publish();
  }
  private contactDistance(
    player: Player,
    positionAt: (at: number) => number,
    item: Star,
    from: number,
    now: number,
  ) {
    // (490 - 330) / 53 ≈ 3 units: contact begins at the pilot's head.
    const enter = Math.max(from, item.bornAt + (330 / item.speed) * 1000);
    const exit = Math.min(
      now,
      item.kind === "barrier"
        ? item.bornAt + (460 / item.speed) * 1000 + 3000
        : item.bornAt + (505 / item.speed) * 1000,
    );
    if (enter > exit) return undefined;
    const left = Math.min(positionAt(enter), positionAt(exit)) + 22.5;
    const right = Math.max(positionAt(enter), positionAt(exit)) + 22.5;
    const distance = Math.max(left - item.x, item.x - right, 0);
    const magnetic =
      ["star", "gold"].includes(item.kind) &&
      activeBonus(player, now)?.kind === "magnet";
    return distance <= (magnetic ? 95 : 43) ? distance : undefined;
  }
  private inReach(player: Player, item: Star, now: number) {
    const distance = Math.abs(player.x + 22.5 - item.x);
    const magnetic =
      ["star", "gold"].includes(item.kind) &&
      activeBonus(player, now)?.kind === "magnet";
    return (
      distance <= (magnetic ? 95 : 43) &&
      itemY(item, now) >= 330 &&
      itemY(item, now) <= 505
    );
  }
  private apply(player: Player, item: Star, now: number) {
    this.claimed.set(item.id, player.userId);
    this.round.stars = this.round.stars.filter((value) => value.id !== item.id);
    const bonus = activeBonus(player, now),
      oldScore = player.score;
    let text = "",
      good = true;
    if (item.kind === "star" || item.kind === "gold") {
      const points =
        (item.kind === "gold" ? 3 : 1) * (bonus?.kind === "multiplier" ? 2 : 1);
      player.score += points;
      text = `+${points} ${points > 1 ? "points" : "point"}`;
    } else if (
      item.kind === "meteor" ||
      item.kind === "barrier" ||
      item.kind === "slime"
    ) {
      if (bonus?.kind === "shield") {
        delete player.bonus;
        text = "Bouclier : impact absorbé";
      } else {
        good = false;
        if (item.kind === "slime") {
          player.slowedUntil = Math.min(this.round.endsAt, now + 4000);
          text = "Ralenti · 4 s";
        } else {
          player.score = Math.max(
            0,
            player.score - (item.kind === "meteor" ? 3 : 2),
          );
          text =
            oldScore === player.score
              ? "Impact · score à zéro"
              : `−${oldScore - player.score} ${oldScore - player.score === 1 ? "point" : "points"}`;
        }
      }
    } else {
      player.bonus = {
        kind: item.kind,
        stage: this.round.stage,
        expiresAt: Math.min(this.round.endsAt, now + 8000),
      };
      text = `${BONUS_NAMES[item.kind]} ${item.kind === "sprint" ? "activée" : "activé"}`;
    }
    player.feedback = { id: randomUUID(), text, good, at: now };
    return player.score - oldScore;
  }
  activate(_userId: string, _request: BonusInput) {
    throw new Error("Les bonus s’activent automatiquement en les ramassant.");
  }
  collect(userId: string, starId: string) {
    const player = this.players.find((value) => value.userId === userId),
      now = this.clock();
    if (!player || this.round.ended || now >= this.round.endsAt)
      throw new Error("Cette manche n’est plus active.");
    if (this.claimed.get(starId) === userId) return 0;
    const item = this.round.stars.find((value) => value.id === starId);
    if (!item) throw new Error("Cet objet a déjà été ramassé ou a disparu.");
    if (!this.inReach(player, item, now))
      throw new Error("L’objet n’est pas à portée.");
    const points = this.apply(player, item, now);
    this.publish();
    return points;
  }
}
