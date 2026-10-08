import Score from "../models/Score";
import type { Player, Round } from "../../shared/contracts";
async function persistRound(round: Round, players: Player[]): Promise<void> {
  if (players.length !== 2) throw new Error("Résultat incomplet.");
  await Promise.all(
    players
      .filter((player) => player.kind === "account")
      .map((player) => {
        const opponent = players.find(
          (value) => value.userId !== player.userId,
        );
        if (!opponent)
          throw new Error("Deux joueurs distincts sont nécessaires.");
        return Score.updateOne(
          { matchId: round.id, monJoueurId: player.userId },
          {
            $setOnInsert: {
              monNom: player.nomUtilisateur,
              monScore: player.score,
              nomUtilisateurAutreJoueur: opponent.nomUtilisateur,
              scoreAutreJoueur: opponent.score,
            },
          },
          { upsert: true, runValidators: true },
        );
      }),
  );
}

const pending = new Map<string, Promise<void>>();
export async function saveRound(
  round: Round,
  players: Player[],
): Promise<void> {
  const existing = pending.get(round.id);
  if (existing) return existing;
  const task = persistRound(round, players);
  pending.set(round.id, task);
  try {
    await task;
  } finally {
    pending.delete(round.id);
  }
}
