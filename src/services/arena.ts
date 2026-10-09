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
  itemTimeAtY,
  jumpOffset,
  JUMP_DURATION_MS,
  PILOT_CONTACT_TOP,
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
    Pick<PlayerState, "runningLeft" | "runningRight"> & { jumping?: boolean }
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
      delete player.jumpStartedAt;
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
    state: Pick<PlayerState, "runningLeft" | "runningRight"> & {
      jumping?: boolean;
    },
    sequence?: number,
  ) {
    // Apply elapsed movement under the previous input before replacing it.
    this.tick();
    if (this.round.ended || this.clock() >= this.round.endsAt) return;
    const wasJumping = this.movement.get(userId)?.jumping === true;
    this.movement.set(userId, state);
    const player = this.players.find((value) => value.userId === userId);
    if (player) {
      if (
        state.jumping &&
        !wasJumping &&
        (player.jumpStartedAt === undefined ||
          this.lastTick >= player.jumpStartedAt + JUMP_DURATION_MS)
      ) {
        player.jumpStartedAt = this.lastTick;
      }
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
    const from = Math.min(now, this.lastTick);
    const paths = new Map<string, (at: number) => number>();
    this.lastTick = now;
    const phase = stageAt(this.round, now),
      config = STAGES[phase];
    let changed = this.round.stage !== phase;
    this.round.stage = phase;
    const living = this.round.stars.filter((item) =>
      item.kind === "barrier"
        ? from < itemTimeAtY(item, 460, this.round) + 3000
        : itemY(item, from, this.round) <= 535,
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
    }
    if (now >= this.nextSpawn && this.round.stars.length < 20) {
      const index = this.spawned++;
      this.round.stars.push({
        id: randomUUID(),
        kind: PATTERN[index % PATTERN.length],
        x: index === 0 ? 450 : 40 + this.random() * 860,
        bornAt: now,
        speed: STAGES[0].speed,
      });
      this.nextSpawn = now + config.interval;
      changed = true;
    }
    // One shared object, one winner. Nearest robot wins; alternate ties rather than favouring the host.
    for (const item of [...this.round.stars]) {
      const candidates = this.players
        .map((player) => ({
          player,
          contact: this.contactDistance(
            player,
            paths.get(player.userId)!,
            item,
            from,
            now,
          ),
        }))
        .filter((candidate) => candidate.contact !== undefined);
      candidates.sort(
        (a, b) =>
          a.contact!.distance - b.contact!.distance ||
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
        this.apply(candidates[0].player, item, now, candidates[0].contact!.at);
        changed = true;
      }
    }
    this.round.stars = this.round.stars.filter((item) =>
      item.kind === "barrier"
        ? now < itemTimeAtY(item, 460, this.round) + 3000
        : itemY(item, now, this.round) <= 535,
    );
    for (const player of this.players) {
      if (player.bonus && !activeBonus(player, now)) {
        delete player.bonus;
        changed = true;
      }
      if (player.slowedUntil && player.slowedUntil <= now) {
        delete player.slowedUntil;
        changed = true;
      }
    }
    if (changed) this.publish();
  }
  private contactDistance(
    player: Player,
    positionAt: (at: number) => number,
    item: Star,
    from: number,
    now: number,
  ) {
    const enter = Math.max(from, item.bornAt);
    const exit = Math.min(
      now,
      item.kind === "barrier"
        ? itemTimeAtY(item, 460, this.round) + 3000
        : itemTimeAtY(item, 505, this.round),
    );
    if (enter > exit) return undefined;
    // Within these boundaries both vertical trajectories are quadratic and x is monotonic.
    const boundaries = [
      ...new Set(
        [
          enter,
          exit,
          this.round.startedAt,
          this.round.endsAt,
          player.jumpStartedAt,
          player.jumpStartedAt === undefined
            ? undefined
            : player.jumpStartedAt + JUMP_DURATION_MS,
          player.bonus?.expiresAt,
          player.slowedUntil,
          item.kind === "barrier"
            ? itemTimeAtY(item, 460, this.round)
            : undefined,
        ].filter(
          (at): at is number => at !== undefined && at >= enter && at <= exit,
        ),
      ),
    ].sort((a, b) => a - b);
    const heightAt = (at: number) =>
      itemY(item, at, this.round) + jumpOffset(player, at);
    let best: { distance: number; at: number } | undefined;
    const check = (start: number, end: number) => {
      const height = heightAt((start + end) / 2);
      if (height < PILOT_CONTACT_TOP - 1e-7 || height > 505 + 1e-7) return;
      const left = Math.min(positionAt(start), positionAt(end)) + 22.5;
      const right = Math.max(positionAt(start), positionAt(end)) + 22.5;
      const distance = Math.max(left - item.x, item.x - right, 0);
      const magnetic =
        ["star", "gold"].includes(item.kind) &&
        activeBonus(player, start)?.kind === "magnet";
      if (
        distance <= (magnetic ? 95 : 43) &&
        (!best || distance < best.distance)
      ) {
        const radius = magnetic ? 95 : 43;
        let at = start;
        if (Math.abs(positionAt(start) + 22.5 - item.x) > radius) {
          // Find the first horizontal overlap inside this vertical contact interval.
          const movingRight = positionAt(end) >= positionAt(start);
          const edge = item.x + (movingRight ? -radius : radius);
          let low = start,
            high = end;
          for (let iteration = 0; iteration < 40; iteration++) {
            const middle = (low + high) / 2;
            if (positionAt(middle) + 22.5 < edge === movingRight) low = middle;
            else high = middle;
          }
          at = high;
        }
        best = { distance, at };
      }
    };
    // Split at exact roots of head/feet contact; no samples can skip a fast object.
    for (let index = 1; index < boundaries.length; index++) {
      const start = boundaries[index - 1],
        end = boundaries[index];
      const y0 = heightAt(start),
        ym = heightAt((start + end) / 2),
        y1 = heightAt(end);
      const a = 2 * (y1 + y0 - 2 * ym),
        b = y1 - y0 - a;
      const cuts = [0, 1];
      for (const edge of [PILOT_CONTACT_TOP, 505]) {
        const c = y0 - edge;
        if (Math.abs(a) < 1e-7) {
          if (Math.abs(b) > 1e-7) cuts.push(-c / b);
        } else {
          const discriminant = b * b - 4 * a * c;
          if (discriminant >= 0) {
            cuts.push(
              (-b - Math.sqrt(discriminant)) / (2 * a),
              (-b + Math.sqrt(discriminant)) / (2 * a),
            );
          }
        }
      }
      const times = cuts
        .filter((part) => part >= 0 && part <= 1)
        .sort((a, b) => a - b)
        .map((part) => start + part * (end - start));
      for (let cut = 1; cut < times.length; cut++)
        check(times[cut - 1], times[cut]);
    }
    if (enter === exit) check(enter, exit);
    return best;
  }
  private inReach(player: Player, item: Star, now: number) {
    const distance = Math.abs(player.x + 22.5 - item.x);
    const magnetic =
      ["star", "gold"].includes(item.kind) &&
      activeBonus(player, now)?.kind === "magnet";
    return (
      distance <= (magnetic ? 95 : 43) &&
      itemY(item, now, this.round) + jumpOffset(player, now) >=
        PILOT_CONTACT_TOP &&
      itemY(item, now, this.round) + jumpOffset(player, now) <= 505
    );
  }
  private apply(player: Player, item: Star, now: number, contactAt = now) {
    this.claimed.set(item.id, player.userId);
    this.round.stars = this.round.stars.filter((value) => value.id !== item.id);
    const bonus = activeBonus(player, contactAt),
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
        text = "Bouclier : obstacle bloqué";
      } else {
        good = false;
        if (item.kind === "slime") {
          player.slowedUntil = Math.min(this.round.endsAt, now + 4000);
          text = "Vitesse ÷2 · 4 s";
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
