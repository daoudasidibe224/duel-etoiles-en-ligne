import type { Player, Round, Star } from "./contracts";
export const PILOT_CONTACT_TOP = 402;
export const JUMP_DURATION_MS = 700;
export const JUMP_HEIGHT = 110;
export function jumpOffset(
  player: Pick<Player, "jumpStartedAt">,
  now = Date.now(),
) {
  if (player.jumpStartedAt === undefined) return 0;
  const progress = (now - player.jumpStartedAt) / JUMP_DURATION_MS;
  return progress <= 0 || progress >= 1
    ? 0
    : 4 * JUMP_HEIGHT * progress * (1 - progress);
}
export const STAGES = [
  { name: "Échauffement", speed: 140, interval: 1100 },
  { name: "Pluie cosmique", speed: 175, interval: 850 },
  { name: "Dernière rafale", speed: 210, interval: 650 },
] as const;
export function stageAt(
  round: Pick<Round, "startedAt" | "endsAt">,
  now = Date.now(),
) {
  return Math.min(
    2,
    Math.max(
      0,
      Math.floor(
        ((now - round.startedAt) / (round.endsAt - round.startedAt)) * 3,
      ),
    ),
  );
}
export const BONUS_NAMES = {
  sprint: "Vitesse +50 %",
  multiplier: "Points ×2",
  shield: "Bouclier",
  magnet: "Aimant",
} as const;
type RoundTiming = Pick<Round, "startedAt" | "endsAt">;
export function itemFallScale(round: RoundTiming, now = Date.now()) {
  return (
    1 +
    1.5 *
      Math.max(
        0,
        Math.min(
          1,
          (now - round.startedAt) / Math.max(1, round.endsAt - round.startedAt),
        ),
      )
  );
}
// The primitive integrates the changing velocity, including phase boundaries.
function fallPrimitive(elapsed: number, duration: number) {
  if (elapsed <= 0) return elapsed;
  if (elapsed >= duration) return 1.75 * duration + 2.5 * (elapsed - duration);
  return elapsed + (0.75 * elapsed * elapsed) / duration;
}
export function itemY(item: Star, now = Date.now(), round?: RoundTiming) {
  const travel = round
    ? fallPrimitive(
        now - round.startedAt,
        Math.max(1, round.endsAt - round.startedAt),
      ) -
      fallPrimitive(
        item.bornAt - round.startedAt,
        Math.max(1, round.endsAt - round.startedAt),
      )
    : now - item.bornAt;
  const y = Math.max(0, travel / 1000) * item.speed;
  return item.kind === "barrier" ? Math.min(460, y) : y;
}
export function itemTimeAtY(item: Star, y: number, round?: RoundTiming) {
  if (!round) return item.bornAt + (y / item.speed) * 1000;
  const duration = Math.max(1, round.endsAt - round.startedAt);
  const target =
    fallPrimitive(item.bornAt - round.startedAt, duration) +
    (y / item.speed) * 1000;
  const elapsed =
    target <= 0
      ? target
      : target >= 1.75 * duration
        ? duration + (target - 1.75 * duration) / 2.5
        : (2 * target) / (1 + Math.sqrt(1 + (3 * target) / duration));
  return round.startedAt + elapsed;
}
export function runnerSpeed(
  player: Pick<Player, "bonus" | "slowedUntil">,
  now = Date.now(),
) {
  return (
    550 *
    (activeBonus(player, now)?.kind === "sprint" ? 1.5 : 1) *
    ((player.slowedUntil ?? 0) > now ? 0.5 : 1)
  );
}
// Integrate effect expiry inside the interval, including delayed render/server ticks.
export function runnerTravel(
  player: Pick<Player, "bonus" | "slowedUntil">,
  from: number,
  to: number,
) {
  if (to <= from) return 0;
  const boundaries = [from, to, player.bonus?.expiresAt, player.slowedUntil]
    .filter((at): at is number => at !== undefined && at >= from && at <= to)
    .sort((a, b) => a - b);
  let distance = 0;
  for (let index = 1; index < boundaries.length; index++) {
    distance +=
      runnerSpeed(player, boundaries[index - 1]) *
      ((boundaries[index] - boundaries[index - 1]) / 1000);
  }
  return distance;
}
export function activeBonus(player: Pick<Player, "bonus">, now = Date.now()) {
  return player.bonus && player.bonus.expiresAt > now
    ? player.bonus
    : undefined;
}
