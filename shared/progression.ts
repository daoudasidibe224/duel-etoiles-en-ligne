import type { Player, Round } from "./contracts";
export const STAGES = [
  { name: "Prise en main", speed: 140, interval: 1800 },
  { name: "Cadence", speed: 175, interval: 1400 },
  { name: "Dernière ligne droite", speed: 210, interval: 1000 },
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
export function activeBonus(player: Pick<Player, "bonus">, now = Date.now()) {
  return player.bonus && player.bonus.expiresAt > now
    ? player.bonus
    : undefined;
}
