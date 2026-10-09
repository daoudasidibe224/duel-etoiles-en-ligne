import type { Player, Round, Star } from "./contracts";
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
export function itemY(item: Star, now = Date.now()) {
  const y = ((now - item.bornAt) / 1000) * item.speed;
  return item.kind === "barrier" ? Math.min(460, y) : y;
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
