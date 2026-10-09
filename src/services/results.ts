import Score from "../models/Score";
import RoundResult from "../models/RoundResult";
import { roundSchema, playerSchema } from "../../shared/contracts";
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
          {
            upsert: true,
            runValidators: true,
            writeConcern: { w: "majority", j: true },
            maxTimeMS: 5000,
          },
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
  const task = (async () => {
    await RoundResult.updateOne(
      { _id: round.id },
      {
        $setOnInsert: {
          round: structuredClone(round),
          players: structuredClone(players),
        },
      },
      {
        upsert: true,
        writeConcern: { w: "majority", j: true },
        maxTimeMS: 5000,
      },
    );
    const durable = await RoundResult.findById(round.id).lean();
    if (!durable) throw new Error("Résultat introuvable.");
    await persistRound(
      roundSchema.parse(durable.round),
      playerSchema.array().length(2).parse(durable.players),
    );
    await RoundResult.updateOne(
      { _id: round.id },
      { $set: { saved: true, savedAt: new Date() } },
      { writeConcern: { w: "majority", j: true }, maxTimeMS: 5000 },
    );
  })();
  pending.set(round.id, task);
  try {
    await task;
  } finally {
    pending.delete(round.id);
  }
}

export async function recoverResults() {
  for (const result of await RoundResult.find({ saved: false }).lean()) {
    await saveRound(
      roundSchema.parse(result.round),
      playerSchema.array().length(2).parse(result.players),
    );
  }
}
