import { randomUUID } from "node:crypto";
import mongoose, { Schema, model } from "mongoose";
import { z } from "zod";
import RoundResult from "../models/RoundResult";
import { saveRound } from "./results";
import {
  roundSchema,
  playerSchema,
  roomSchema,
  type Rooms,
} from "../../shared/contracts";

export const reservationSchema = z.object({
  sessionId: z.string(),
  expiresAt: z.number(),
});
export type Reservation = z.infer<typeof reservationSchema>;
const entrySchema = z.object({
  room: roomSchema,
  reservations: z.record(z.string(), reservationSchema).default({}),
  closedAt: z.number().optional(),
  reason: z.string().optional(),
});
const entriesSchema = z.record(z.string(), entrySchema);
const schema = new Schema(
  {
    _id: String,
    owner: String,
    leaseUntil: Number,
    entries: { type: Schema.Types.Mixed, default: {} },
  },
  { versionKey: false },
);
const Journal = model("RoomJournal", schema);
const durable = {
  writeConcern: { w: "majority" as const, j: true },
  maxTimeMS: 5000,
};
const waitingNotice =
  "Le serveur a redémarré. Votre salon et ses places ont été restaurés. Rejoignez-le pour reprendre.";
const cancelledNotice =
  "Le serveur a redémarré. La manche interrompue a été annulée sans résultat partiel. Votre salon est conservé ; les deux joueurs peuvent lancer une nouvelle manche.";

/** Durable rooms, explicit interrupted-round cancellation, and one fenced engine. */
export class RoomJournal {
  private owner = randomUUID();
  private entries: z.infer<typeof entriesSchema> = {};
  readonly restored: Rooms = Object.create(null);
  readonly reservations = new Map<string, Reservation>();
  readonly ownerSessions = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private healthy = true;
  private validUntil = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private leaseMs: number) {}
  private pendingState = true;
  private stopped = false;
  private lostNotified = false;
  onUnavailable?: () => void;
  private resolveReady!: () => void;
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  static prepare({ leaseMs = 15000 } = {}) {
    return new RoomJournal(leaseMs);
  }
  static async open({ leaseMs = 15000, waitMs = 20000 } = {}) {
    const journal = RoomJournal.prepare({ leaseMs });
    await journal.activate({ waitMs });
    return journal;
  }
  async activate({ waitMs = Infinity } = {}) {
    const leaseMs = this.leaseMs;
    await Journal.updateOne(
      { _id: "arena" },
      { $setOnInsert: { leaseUntil: 0, entries: {} } },
      { upsert: true, ...durable },
    );
    const deadline = Date.now() + waitMs;
    let value;
    do {
      value = await Journal.findOneAndUpdate(
        { _id: "arena", leaseUntil: { $lte: Date.now() } },
        {
          $set: { owner: this.owner, leaseUntil: Date.now() + leaseMs },
        },
        { returnDocument: "after", ...durable },
      ).lean();
      if (value) break;

      if (this.stopped) throw new Error("Démarrage arrêté.");
      if (Date.now() >= deadline)
        throw new Error(
          "Une instance Duel utilise déjà cette base. Attendez son arrêt avant de démarrer.",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (!value);
    this.validUntil = Date.now() + leaseMs;
    this.healthy = true;
    this.lostNotified = false;
    this.entries = entriesSchema.parse(value.entries);
    for (const entry of Object.values(this.entries)) {
      if (entry.closedAt) continue;
      for (const [id, reservation] of Object.entries(entry.reservations)) {
        const session = await mongoose.connection.db
          ?.collection<{ _id: string; session: string; expires: Date }>(
            "sessions",
          )
          .findOne({ _id: reservation.sessionId });
        const access =
          session &&
          z
            .object({
              cookie: z.object({ expires: z.coerce.date() }),
              guest: z
                .object({ id: z.string(), expiresAt: z.number() })
                .optional(),
              passport: z.object({ user: z.string() }).optional(),
            })
            .safeParse(JSON.parse(session.session));
        if (
          !access ||
          !access.success ||
          (access.data.guest?.id ?? access.data.passport?.user) !== id
        ) {
          reservation.expiresAt = 0;
          continue;
        }
        reservation.expiresAt = Math.min(
          reservation.expiresAt,
          access.data.cookie.expires.getTime(),
          access.data.guest?.expiresAt ?? Infinity,
        );
      }
      const owner = entry.reservations[entry.room.proprietaireId];
      if (
        entry.room.createdAt <= Date.now() - 86400000 ||
        (owner && owner.expiresAt <= Date.now())
      ) {
        entry.closedAt = Date.now();
        entry.reason =
          "L’accès du propriétaire ou la durée de conservation du salon a expiré.";
        continue;
      }
      const result =
        entry.room.round &&
        (await RoundResult.findById(entry.room.round.id).lean());
      if (result) {
        entry.room.round = {
          ...roundSchema.parse(result.round),
          ended: true,
          saved: result.saved === true,
        };
        entry.room.utilisateurs = playerSchema
          .array()
          .length(2)
          .parse(result.players);
        if (result.saved) delete entry.room.round.saveError;
      } else if (entry.room.round?.ended) {
        try {
          await saveRound(entry.room.round, entry.room.utilisateurs);
          entry.room.round.saved = true;
          delete entry.room.round.saveError;
        } catch {
          entry.room.round.saved = false;
          entry.room.round.saveError =
            "Le résultat est conservé. Son enregistrement sera réessayé.";
        }
      } else {
        if (entry.room.round)
          entry.room.interruptedRoundId = entry.room.round.id;
        entry.room.recoveryNotice = entry.room.round
          ? cancelledNotice
          : waitingNotice;
        delete entry.room.round;
        delete entry.room.startedAt;
        entry.room.started = false;
        entry.room.utilisateurs = entry.room.utilisateurs
          .filter(
            (player) =>
              !entry.reservations[player.userId] ||
              entry.reservations[player.userId].expiresAt > Date.now(),
          )
          .map((player) => {
            const reset = { ...player, score: 0, usedStages: [] };
            delete reset.bonus;
            delete reset.slowedUntil;
            delete reset.jumpStartedAt;
            delete reset.feedback;
            reset.x = 430;
            return reset;
          });
      }
      this.restored[entry.room.id] = structuredClone(entry.room);
      for (const player of entry.room.utilisateurs)
        this.reservations.set(
          player.userId,
          entry.reservations[player.userId] ?? {
            sessionId: "",
            expiresAt: entry.room.createdAt + 86400000,
          },
        );
      if (owner) {
        this.ownerSessions.set(entry.room.id, owner.sessionId);
        this.reservations.set(entry.room.proprietaireId, owner);
      }
    }
    await this.persist();
    this.pendingState = false;
    this.healthy = true;
    this.resolveReady();
  }
  monitor(onLost: () => void) {
    this.timer = setInterval(
      () => {
        if ((this.pendingState && !this.validUntil) || this.stopped) return;
        void (async () => {
          if (!this.healthy || Date.now() >= this.validUntil)
            throw new Error("Journal indisponible.");
          const result = await Journal.updateOne(
            this.fence(),
            { $set: { leaseUntil: Date.now() + this.leaseMs } },
            durable,
          );
          if (!result.matchedCount)
            throw new Error("Le verrou du serveur a expiré.");
          this.validUntil = Date.now() + this.leaseMs;
        })().catch(async () => {
          if (this.lostNotified) return;
          this.lostNotified = true;
          this.healthy = false;
          onLost();
          this.onUnavailable?.();
          await Journal.updateOne(
            { _id: "arena", owner: this.owner },
            { $set: { leaseUntil: 0 } },
            durable,
          ).catch(() => {});
        });
      },
      Math.max(100, this.leaseMs / 3),
    );
    this.timer.unref();
  }
  private fence() {
    return { _id: "arena", owner: this.owner, leaseUntil: { $gt: Date.now() } };
  }
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      if (!this.available)
        throw new Error(
          this.pending
            ? "Une mise à jour du serveur est en cours. Votre salon reste réservé ; la reprise sera automatique."
            : "La sauvegarde des salons est indisponible.",
        );
      try {
        if (!(await Journal.exists(this.fence())))
          throw new Error("Le verrou du serveur a expiré.");
      } catch (error) {
        this.healthy = false;
        throw error;
      }
      return operation();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async sync(
    rooms: Rooms,
    reservations?: Map<string, Reservation>,
    owners?: Map<string, string>,
  ) {
    for (const entry of Object.values(this.entries))
      if (!entry.closedAt && !rooms[entry.room.id]) {
        entry.closedAt = Date.now();
        entry.reason = "Le propriétaire a quitté le salon.";
      }
    for (const room of Object.values(rooms)) {
      const saved = this.entries[room.id]?.reservations ?? {};
      const current: Record<string, Reservation> = {};
      for (const id of new Set([
        room.proprietaireId,
        ...room.utilisateurs.map((player) => player.userId),
      ])) {
        const value = reservations?.get(id) ?? saved[id];
        if (value) current[id] = value;
      }
      const ownerSession = owners?.get(room.id);
      if (ownerSession && !current[room.proprietaireId])
        current[room.proprietaireId] = {
          sessionId: ownerSession,
          expiresAt: room.createdAt + 86400000,
        };
      this.entries[room.id] = {
        room: structuredClone(room),
        reservations: structuredClone(current),
      };
    }
    await this.persist();
  }
  private async persist() {
    const cutoff = Date.now() - 86400000;
    for (const [id, entry] of Object.entries(this.entries))
      if (entry.closedAt && entry.closedAt < cutoff) delete this.entries[id];
    const closed = Object.entries(this.entries)
      .filter(([, entry]) => entry.closedAt)
      .sort((a, b) => (b[1].closedAt ?? 0) - (a[1].closedAt ?? 0));
    for (const [id] of closed.slice(2000)) delete this.entries[id];
    try {
      const result = await Journal.updateOne(
        this.fence(),
        {
          $set: {
            entries: this.entries,
            leaseUntil: Date.now() + this.leaseMs,
          },
        },
        durable,
      );
      if (!result.matchedCount)
        throw new Error("Le verrou du serveur a expiré.");
      this.validUntil = Date.now() + this.leaseMs;
    } catch (error) {
      this.healthy = false;
      throw error;
    }
  }
  get pending() {
    return this.pendingState && !this.stopped;
  }
  get available() {
    return (
      !this.stopped &&
      !this.pendingState &&
      this.healthy &&
      Date.now() < this.validUntil
    );
  }
  reason(room: string) {
    const entry = this.entries[room];
    return entry?.closedAt && entry.closedAt > Date.now() - 86400000
      ? entry.reason
      : undefined;
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.queue;
    await Journal.updateOne(
      { _id: "arena", owner: this.owner },
      { $set: { leaseUntil: 0 } },
      durable,
    );
    this.healthy = false;
  }
}
