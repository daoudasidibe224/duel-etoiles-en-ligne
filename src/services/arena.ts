import { randomUUID } from "node:crypto";
import type { BonusInput, Player, Round } from "../../shared/contracts";
import { activeBonus, stageAt, STAGES } from "../../shared/progression";
export class Arena {
  private timer: ReturnType<typeof setInterval>;
  private nextSpawn = 0;
  private spawned = 0;
  private claimed = new Map<string, string>();
  private grants = new Map<string, BonusInput>();
  constructor(
    private round: Round,
    private players: Player[],
    private publish: () => void,
  ) {
    this.tick();
    this.timer = setInterval(() => this.tick(), 100);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }
  private tick() {
    const now = Date.now();
    if (this.round.ended || now >= this.round.endsAt) return;
    const phase = stageAt(this.round, now),
      config = STAGES[phase] ?? STAGES[0];
    let changed = this.round.stage !== phase;
    this.round.stage = phase;
    const living = this.round.stars.filter(
      (star) => ((now - star.bornAt) / 1000) * star.speed <= 535,
    );
    changed ||= living.length !== this.round.stars.length;
    this.round.stars = living;
    for (const player of this.players)
      if (player.bonus && !activeBonus(player, now)) {
        delete player.bonus;
        changed = true;
      }
    if (now >= this.nextSpawn) {
      this.round.stars.push({
        id: randomUUID(),
        x: this.spawned++ === 0 ? 450 : 40 + Math.random() * 860,
        bornAt: now,
        speed: config.speed,
      });
      this.nextSpawn = now + config.interval;
      changed = true;
    }
    if (changed) this.publish();
  }
  activate(userId: string, request: BonusInput) {
    const player = this.players.find((value) => value.userId === userId),
      now = Date.now();
    if (
      !player ||
      this.round.ended ||
      now >= this.round.endsAt ||
      request.roundId !== this.round.id
    )
      throw new Error("Cette manche n’est plus active.");
    const key = `${userId}:${request.id}`,
      previous = this.grants.get(key);
    if (previous) {
      if (previous.kind !== request.kind || previous.stage !== request.stage)
        throw new Error("Ce bonus a déjà été utilisé autrement.");
      this.publish();
      return;
    }
    if (request.stage !== stageAt(this.round, now))
      throw new Error(
        "Cette étape est terminée. Choisissez le bonus de l’étape actuelle.",
      );
    if (player.usedStages.includes(request.stage))
      throw new Error("Votre charge a déjà été utilisée pour cette étape.");
    if (activeBonus(player, now))
      throw new Error("Attendez la fin du bonus en cours.");
    player.usedStages.push(request.stage);
    player.bonus = {
      kind: request.kind,
      stage: request.stage,
      expiresAt: Math.min(this.round.endsAt, now + 8000),
    };
    this.grants.set(key, request);
    this.publish();
  }
  collect(userId: string, starId: string) {
    const player = this.players.find((value) => value.userId === userId),
      now = Date.now();
    if (!player || this.round.ended || now >= this.round.endsAt)
      throw new Error("Cette manche n’est plus active.");
    if (this.claimed.get(starId) === userId) return 0;
    const star = this.round.stars.find((value) => value.id === starId);
    if (!star)
      throw new Error("Cette étoile a déjà été ramassée ou a disparu.");
    const y = ((now - star.bornAt) / 1000) * star.speed;
    if (y < 414 || y > 505) throw new Error("L’étoile n’est pas à portée.");
    this.claimed.set(starId, userId);
    this.round.stars = this.round.stars.filter((value) => value.id !== starId);
    const points = activeBonus(player, now)?.kind === "multiplier" ? 2 : 1;
    player.score += points;
    this.publish();
    return points;
  }
}
