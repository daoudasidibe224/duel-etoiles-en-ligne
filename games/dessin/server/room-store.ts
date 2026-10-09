import { randomUUID } from "node:crypto";
import mongoose, { type Connection } from "mongoose";
import { snapshotSchema, type Snapshot } from "../shared/contracts";

export interface SavedSeat {
  sessionId: string;
  room: string;
}
interface StoredRoom {
  _id: string;
  state: Snapshot;
  expiresAt: Date;
}
interface Manifest {
  _id: string;
  owner: string;
  leaseUntil: Date;
  rooms: Record<string, string>;
  seats: Record<string, SavedSeat>;
}
export interface LeaseTiming {
  leaseMs?: number;
  leasePollMs?: number;
}
// Drawing owns its collections and lease, separate from the Duel journal.
export interface StoreLocation {
  connection?: Connection;
  snapshots?: string;
  runtime?: string;
}

// Immutable snapshots are published by one atomic, fenced manifest update.
// A stopped or superseded writer cannot alter a published room or seat.
export class RoomStore {
  private readonly owner = randomUUID();
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly onLost: () => void;
  private heartbeat?: NodeJS.Timeout;
  private acquiringCancelled = false;
  private owned = false;
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  private rooms: Record<string, string> = {};
  private readonly location: Required<StoreLocation>;
  healthy = true;
  constructor(
    onLost: () => void,
    timing: LeaseTiming = {},
    location: StoreLocation = {},
  ) {
    this.onLost = onLost;
    this.leaseMs = timing.leaseMs ?? 15000;
    this.pollMs = timing.leasePollMs ?? 250;
    this.location = {
      connection: location.connection ?? mongoose.connection,
      snapshots: location.snapshots ?? "dessin_room_snapshots",
      runtime: location.runtime ?? "dessin_runtime",
    };
  }
  private get snapshots() {
    return this.location.connection.collection<StoredRoom>(
      this.location.snapshots,
    );
  }
  private get manifests() {
    return this.location.connection.collection<Manifest>(this.location.runtime);
  }
  private get fence() {
    return {
      _id: "hub",
      owner: this.owner,
      $expr: { $gt: ["$leaseUntil", "$$NOW"] },
    };
  }
  private get renewal() {
    return [
      {
        $set: {
          owner: this.owner,
          leaseUntil: {
            $dateAdd: {
              startDate: "$$NOW",
              unit: "millisecond",
              amount: this.leaseMs,
            },
          },
        },
      },
    ];
  }
  private lose() {
    if (this.failed) return;
    this.failed = true;
    this.healthy = false;
    this.owned = false;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.onLost();
  }
  private scheduleHeartbeat() {
    if (!this.owned || this.failed) return;
    this.heartbeat = setTimeout(
      async () => {
        try {
          const renewed = await this.manifests.updateOne(
            this.fence,
            this.renewal,
            { maxTimeMS: 3000, writeConcern: { w: "majority", j: true } },
          );
          if (renewed.matchedCount !== 1)
            throw new Error("Bail du moteur perdu.");
          this.scheduleHeartbeat();
        } catch {
          this.lose();
        }
      },
      Math.max(50, Math.floor(this.leaseMs / 3)),
    );
    this.heartbeat.unref();
  }
  async assertOwner() {
    if (!this.owned || this.failed)
      throw new Error("Le serveur ne contrôle plus le jeu. Reconnectez-vous.");
    try {
      if (
        !(await this.manifests.findOne(this.fence, {
          projection: { _id: 1 },
          maxTimeMS: 3000,
        }))
      )
        throw new Error("Bail du moteur perdu.");
    } catch {
      this.lose();
      throw new Error("Le serveur ne contrôle plus le jeu. Reconnectez-vous.");
    }
  }
  async load() {
    await this.snapshots.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
    // Capture candidates before acquiring the lease. A later owner can only
    // publish fresh UUIDs, so a delayed cleanup cannot delete its new snapshot.
    const candidates = await this.snapshots
      .find({}, { projection: { _id: 1 } })
      .toArray();
    try {
      await this.manifests.updateOne(
        { _id: "hub" },
        {
          $setOnInsert: {
            owner: "",
            leaseUntil: new Date(0),
            rooms: {},
            seats: {},
          },
        },
        { upsert: true, maxTimeMS: 3000 },
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === 11000))
        throw error;
    }
    let manifest: Manifest | null = null;
    while (!this.acquiringCancelled) {
      manifest = await this.manifests.findOneAndUpdate(
        { _id: "hub", $expr: { $lte: ["$leaseUntil", "$$NOW"] } },
        this.renewal,
        {
          returnDocument: "after",
          maxTimeMS: 3000,
          writeConcern: { w: "majority", j: true },
        },
      );
      if (manifest) break;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    if (!manifest || this.acquiringCancelled)
      throw new Error("Reprise du moteur annulée.");
    this.owned = true;
    this.rooms = manifest.rooms;
    this.scheduleHeartbeat();
    const records = await this.snapshots
      .find({
        _id: { $in: Object.values(manifest.rooms) },
        expiresAt: { $gt: new Date() },
      })
      .toArray();
    const states = records.map((raw) => snapshotSchema.parse(raw.state));
    const liveIds = new Set(records.map((record) => record._id));
    this.rooms = Object.fromEntries(
      Object.entries(manifest.rooms).filter(([, id]) => liveIds.has(id)),
    );
    const seats = new Map(
      Object.entries(manifest.seats).filter(
        ([, seat]) => seat.room in this.rooms,
      ),
    );
    const normalized = await this.manifests.updateOne(
      this.fence,
      { $set: { rooms: this.rooms, seats: Object.fromEntries(seats) } },
      { maxTimeMS: 3000, writeConcern: { w: "majority", j: true } },
    );
    if (normalized.matchedCount !== 1)
      throw new Error("Bail du moteur perdu pendant la restauration.");
    // No new engine command runs before this collection. The former owner is
    // fenced out of the manifest, even if a delayed insert finishes afterward.
    const referenced = new Set(Object.values(manifest.rooms));
    const orphanIds = candidates
      .map((record) => record._id)
      .filter((id) => !referenced.has(id));
    if (orphanIds.length)
      await this.snapshots.deleteMany(
        { _id: { $in: orphanIds } },
        { maxTimeMS: 3000 },
      );
    return { rooms: states, seats };
  }
  save(
    name: string,
    state: Snapshot | undefined,
    members: Map<string, SavedSeat>,
  ) {
    const captured = Object.fromEntries(
      [...members].map(([id, seat]) => [
        id,
        { sessionId: seat.sessionId, room: seat.room },
      ]),
    );
    const snapshot = state && structuredClone(state);
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        await this.assertOwner();
        const previous = this.rooms[name];
        const next = { ...this.rooms };
        if (snapshot) {
          const id = randomUUID();
          await this.snapshots.insertOne(
            {
              _id: id,
              state: snapshot,
              expiresAt: new Date(Date.now() + 86400000),
            },
            {
              maxTimeMS: 3000,
              writeConcern: { w: "majority", j: true },
            },
          );
          next[name] = id;
        } else delete next[name];
        try {
          if (this.failed || !this.owned)
            throw new Error("Le moteur a perdu son bail.");
          const committed = await this.manifests.updateOne(
            this.fence,
            { $set: { rooms: next, seats: captured } },
            {
              maxTimeMS: 3000,
              writeConcern: { w: "majority", j: true },
            },
          );
          if (committed.matchedCount !== 1)
            throw new Error("Bail du moteur perdu avant sauvegarde.");
        } catch (error) {
          this.lose();
          throw error;
        }
        this.rooms = next;
        // Only the previous reference is deleted, after successful publication.
        // Unknown outcomes retain their candidate for TTL/acquisition cleanup.
        if (previous)
          await this.snapshots
            .deleteOne({ _id: previous }, { maxTimeMS: 3000 })
            .catch(() => {});
      });
    this.tail = pending;
    void pending.catch(() => {
      this.lose();
    });
    return pending;
  }
  async flush() {
    await this.tail;
  }
  cancelAcquisition() {
    this.acquiringCancelled = true;
  }
  async release() {
    this.acquiringCancelled = true;
    this.owned = false;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    await this.manifests
      .updateOne(
        { _id: "hub", owner: this.owner },
        {
          $set: { owner: "", leaseUntil: new Date(0) },
        },
        { maxTimeMS: 3000, writeConcern: { w: "majority", j: true } },
      )
      .catch(() => {});
  }
}
