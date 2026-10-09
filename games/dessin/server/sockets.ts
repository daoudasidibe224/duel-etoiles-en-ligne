import type { Namespace, Socket } from "socket.io";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Session, SessionData } from "express-session";
import { GameRoom, type Timing } from "./game";
import {
  commandSchema,
  roomName,
  strokeSchema,
  type Identity,
  type IdentityKind,
  type Result,
} from "../shared/contracts";
import { RoomStore, type StoreLocation } from "./room-store";
// Canonical identity supplied by the host site (account or guest).
export interface ExternalIdentity {
  id: string;
  name: string;
  kind: IdentityKind;
  expiresAt?: number;
}
// HTTP request or Socket.IO handshake request carrying the shared session.
export type DrawingRequest = IncomingMessage & {
  session: Session & Partial<SessionData>;
  sessionID: string;
};
export type IdentityResolver = (
  request: DrawingRequest,
) => ExternalIdentity | undefined | Promise<ExternalIdentity | undefined>;
export interface PlayerIdentity extends Identity {
  kind: IdentityKind;
  expiresAt?: number;
}
type DrawEvents = Record<
  string,
  (data: unknown, ack?: (result: Result) => void) => void
>;
type DrawData = { user: PlayerIdentity; room?: string; epoch: string };
export type DrawNamespace = Namespace<
  DrawEvents,
  Record<string, (data: unknown) => void>,
  Record<string, never>,
  DrawData
>;
type DrawSocket = Socket<
  DrawEvents,
  Record<string, (data: unknown) => void>,
  Record<string, never>,
  DrawData
>;
interface Membership {
  sessionId: string;
  room: string;
  socket: string;
  epoch: string;
}
const sessionEnded =
  "Votre session a expiré ou a été fermée. Reprenez l’accès à la Salle de jeux pour continuer.";
function sessionOf(request: IncomingMessage) {
  return request as Partial<DrawingRequest> & IncomingMessage;
}
export class RoomHub {
  readonly rooms = new Map<string, GameRoom>();
  private io: DrawNamespace;
  private resolveIdentity: IdentityResolver;
  private timing: Timing;
  private members = new Map<string, Membership>();
  private departure = new Map<string, NodeJS.Timeout>();
  private persistence: RoomStore;
  private failed = false;
  private closing = false;
  private commandQueue = Promise.resolve();
  initialized = false;
  readonly ready: Promise<void>;
  get healthy() {
    return this.initialized && this.persistence.healthy && !this.closing;
  }
  get status() {
    return this.closing || this.failed
      ? "unavailable"
      : this.healthy
        ? "ready"
        : "waiting";
  }
  constructor(
    io: DrawNamespace,
    resolveIdentity: IdentityResolver,
    timing: Timing = {},
    location: StoreLocation = {},
  ) {
    this.io = io;
    this.resolveIdentity = resolveIdentity;
    this.timing = timing;
    this.persistence = new RoomStore(() => this.stopEngine(), timing, location);
    this.ready = this.restore();
    void this.ready.catch(() => {
      this.stopEngine();
      void this.persistence.release();
    });
  }
  private stopEngine() {
    if (this.failed) return;
    this.failed = true;
    for (const timer of this.departure.values()) clearTimeout(timer);
    this.departure.clear();
    for (const room of this.rooms.values()) room.close();
    this.io.emit(
      "server-paused",
      "Le serveur reprend les salons. Reconnexion en cours.",
    );
    this.io.disconnectSockets(true);
  }
  async assertAvailable() {
    if (!this.healthy)
      throw new Error(
        "Le serveur reprend les salons. Réessayez dans un instant.",
      );
    await this.persistence.assertOwner();
  }
  private async restore() {
    const saved = await this.persistence.load();
    for (const state of saved.rooms) {
      state.players = state.players.filter(
        (player) => saved.seats.get(player.id)?.room === state.room,
      );
      if (!state.players.length) continue;
      const room = GameRoom.recover(
        state,
        () => this.broadcast(state.room),
        this.timing,
      );
      this.rooms.set(room.name, room);
      for (const player of room.players.values()) {
        const seat = saved.seats.get(player.id);
        if (!seat) continue;
        const member = { ...seat, socket: "", epoch: "" };
        this.members.set(player.id, member);
        this.scheduleDeparture(
          player.id,
          member,
          this.timing.recoveryMs ?? 15 * 60 * 1000,
        );
      }
    }
    for (const room of this.rooms.values()) this.persist(room.name);
    await this.persistence.flush();
    this.initialized = true;
  }
  private persist(name: string) {
    const pending = this.persistence.save(
      name,
      this.rooms.get(name)?.durableSnapshot(),
      this.members,
    );
    void pending.catch(() => {
      if (!this.closing)
        this.io.emit(
          "problem",
          "Le salon ne peut pas être sauvegardé. Attendez le rétablissement de la connexion au serveur.",
        );
    });
    return pending;
  }
  async authenticate(request: IncomingMessage): Promise<PlayerIdentity> {
    const shared = sessionOf(request);
    const resolved =
      shared.session && shared.sessionID
        ? await this.resolveIdentity(request as DrawingRequest)
        : undefined;
    if (
      !resolved ||
      (resolved.expiresAt !== undefined && resolved.expiresAt <= Date.now())
    )
      throw new Error("Connexion ou session invitée nécessaire.");
    return {
      // Kinds stay separate: a guest id can never match an account id.
      id: resolved.kind + ":" + resolved.id,
      name: resolved.name.trim().slice(0, 24) || "Joueur",
      kind: resolved.kind,
      expiresAt: resolved.expiresAt,
    };
  }
  // Reloads the shared session, then asks the host for its canonical identity.
  async revalidate(socket: DrawSocket) {
    const request = sessionOf(socket.request);
    const session = request.session;
    if (!session) throw new Error("Session absente.");
    await new Promise<void>((resolve, reject) =>
      session.reload((error: unknown) => (error ? reject(error) : resolve())),
    );
    const current = await this.authenticate(socket.request);
    if (current.id !== socket.data.user.id || !socket.connected)
      throw new Error("Session remplacée.");
    socket.data.user.name = current.name;
    socket.data.user.expiresAt = current.expiresAt;
    return current;
  }
  private endAccess(socket: DrawSocket) {
    this.depart(socket, true);
    socket.emit("session-ended", sessionEnded);
    socket.disconnect(true);
  }
  // Called by the host when a session logs out, expires or changes identity.
  endSession(sessionId: string, keepIdentity?: string) {
    this.reconcileSession(sessionId, keepIdentity);
  }
  reconcileSession(sessionId: string, keepIdentity?: string) {
    for (const [id, member] of this.members)
      if (member.sessionId === sessionId && id !== keepIdentity)
        this.remove(id, member);
    for (const socket of this.io.sockets.values()) {
      if (
        sessionOf(socket.request).sessionID === sessionId &&
        socket.data.user?.id !== keepIdentity
      ) {
        socket.emit("session-ended", sessionEnded);
        socket.disconnect(true);
      }
    }
  }
  renameIdentity(id: string, rawName: string) {
    const name = rawName.trim().slice(0, 24);
    if (!name) return;
    const member = this.members.get(id);
    const room = member && this.rooms.get(member.room);
    const player = room?.players.get(id);
    if (player && room) {
      player.name = name;
      this.broadcast(room.name);
    }
    for (const socket of this.io.sockets.values())
      if (socket.data.user?.id === id) socket.data.user.name = name;
  }
  attach(socket: DrawSocket) {
    let pendingCommands = 0;
    let expiry: NodeJS.Timeout | undefined;
    const watchExpiry = () => {
      clearTimeout(expiry);
      const until = socket.data.user.expiresAt;
      if (until === undefined || !socket.connected) return;
      expiry = setTimeout(
        () => {
          this.revalidate(socket).then(watchExpiry, () => {
            if (socket.connected) this.endAccess(socket);
          });
        },
        Math.min(2 ** 31 - 1, Math.max(0, until - Date.now())),
      );
      expiry.unref();
    };
    socket.once("disconnect", () => clearTimeout(expiry));
    watchExpiry();
    socket.data.epoch = randomUUID();
    let watermark = 0;
    const completed = new Map<
      number,
      { fingerprint: string; result: Result }
    >();
    const rates = new Map<string, { at: number; count: number }>();
    const room = () => {
      const member = this.members.get(socket.data.user.id),
        current = member && this.rooms.get(member.room);
      if (
        !member ||
        member.socket !== socket.id ||
        member.epoch !== socket.data.epoch ||
        !current?.players.has(socket.data.user.id)
      )
        throw new Error(
          "Cet onglet ne contrôle aucun salon. Rejoignez-le pour reprendre votre place.",
        );
      return current;
    };
    const act = (
      event: string,
      maximum: number,
      action: (data: unknown) => void,
    ) =>
      socket.on(event, (data, ack) => {
        const parsed = commandSchema.safeParse(data);
        const reject = (error: string) => {
          const result = { ok: false, error };
          if (typeof ack === "function") ack(result);
          else socket.emit("problem", error);
        };
        if (!parsed.success) {
          reject("Demande invalide.");
          return;
        }
        if (!socket.connected || parsed.data.epoch !== socket.data.epoch) {
          reject("Commande issue d’une ancienne connexion.");
          return;
        }
        if (pendingCommands >= 64) {
          reject("Trop de commandes en attente. Réessayez dans un instant.");
          return;
        }
        pendingCommands++;
        this.commandQueue = this.commandQueue
          .then(async () => {
            let sequence: number | undefined;
            let fingerprint = "";
            let result: Result;
            let accepted = false;
            try {
              await this.ready;
              if (this.closing)
                throw new Error("Le serveur redémarre. Reconnectez-vous.");
              await this.persistence.assertOwner();
              if (!socket.connected)
                throw new Error("Connexion remplacée ou fermée.");
              try {
                await this.revalidate(socket);
              } catch {
                this.endAccess(socket);
                throw new Error(sessionEnded);
              }
              const packet = commandSchema.parse(data);
              sequence = packet.sequence;
              fingerprint = JSON.stringify([event, packet.turn, packet.data]);
              if (packet.epoch !== socket.data.epoch)
                throw new Error("Commande issue d’une ancienne connexion.");
              if (!["join", "leave", "directory"].includes(event)) room();
              if (packet.sequence <= watermark) {
                const previous = completed.get(packet.sequence);
                if (!previous || previous.fingerprint !== fingerprint)
                  throw new Error("Commande ancienne ou désordonnée.");
                if (typeof ack === "function") ack(previous.result);
                return;
              }
              watermark = packet.sequence;
              accepted = true;
              if (
                !["join", "directory"].includes(event) &&
                (event !== "leave" ||
                  this.members.get(socket.data.user.id)?.socket ===
                    socket.id) &&
                packet.turn !== room().turn
              )
                throw new Error(
                  "Ce tour est terminé. La commande n’a pas été appliquée.",
                );
              const now = Date.now(),
                rate = rates.get(event);
              if (!rate || now - rate.at >= 1000)
                rates.set(event, { at: now, count: 1 });
              else if (++rate.count > maximum)
                throw new Error("Un peu plus lentement, s’il vous plaît.");
              if (!this.healthy)
                throw new Error(
                  "Le jeu est temporairement indisponible. Reconnectez-vous.",
                );
              action(packet.data);
              await this.persistence.flush();
              result = { ok: true };
            } catch (error) {
              result = {
                ok: false,
                error:
                  error instanceof z.ZodError
                    ? "Demande invalide."
                    : error instanceof Error
                      ? error.message
                      : "Demande impossible.",
              };
            }
            if (accepted && sequence !== undefined) {
              completed.set(sequence, { fingerprint, result });
              if (completed.size > 256) {
                const oldest = completed.keys().next().value;
                if (oldest !== undefined) completed.delete(oldest);
              }
            }
            if (typeof ack === "function") ack(result);
            else if (!result.ok) socket.emit("problem", result.error);
          })
          .finally(() => {
            pendingCommands--;
          });
      });
    act("join", 5, (data) => this.join(socket, roomName.parse(data)));
    act("directory", 3, () => {
      void socket.join("directory");
      socket.emit("directory", this.directory(socket.data.user.id));
    });
    act("start", 5, (data) => {
      const settings = z
        .object({
          rounds: z.number().int().min(1).max(5),
          seconds: z.number().int().min(30).max(120),
        })
        .parse(data);
      room().start(socket.data.user.id, settings.rounds, settings.seconds);
    });
    act("choose", 5, (data) =>
      room().choose(socket.data.user.id, z.string().max(40).parse(data)),
    );
    act("draw", 240, (data) => {
      const current = room(),
        stroke = strokeSchema.parse(data);
      current.draw(socket.data.user.id, stroke);
      void this.persist(current.name)
        .then(() => {
          if (!this.healthy) return;
          for (const member of this.members.values())
            if (member.room === current.name && member.socket)
              this.io.sockets.get(member.socket)?.emit("stroke", stroke);
        })
        .catch(() => {});
    });
    act("undo", 5, () => room().undo(socket.data.user.id));
    act("clear", 5, () => room().clear(socket.data.user.id));
    act("redo", 5, () => room().redo(socket.data.user.id));
    act("skip", 3, () => room().skip(socket.data.user.id));
    act("chat", 2, (data) =>
      room().chat(
        socket.data.user.id,
        z.string().trim().min(1).max(200).parse(data),
      ),
    );
    act("guess", 3, (data) =>
      room().guess(
        socket.data.user.id,
        z.string().trim().min(1).max(200).parse(data),
      ),
    );
    act("leave", 5, () => this.depart(socket, true));
    socket.on("disconnect", () => this.depart(socket, false));
    socket.emit("ready", { epoch: socket.data.epoch });
  }
  broadcast(name: string) {
    if (this.failed) return;
    const current = this.rooms.get(name);
    if (!current) return;
    const updates = [...this.members]
      .filter(([, member]) => member.room === name && member.socket)
      .map(([id, member]) => ({
        socket: member.socket,
        state: current.snapshot(id),
      }));
    void this.persist(name)
      .then(() => {
        if (!this.healthy) return;
        for (const update of updates)
          this.io.sockets.get(update.socket)?.emit("snapshot", update.state);
        this.broadcastDirectory();
      })
      .catch(() => {});
  }
  directory(id: string) {
    return [...this.rooms.values()].map((room) => {
      let reason = "";
      try {
        room.canJoin(id);
      } catch (error) {
        reason = error instanceof Error ? error.message : "Salon indisponible.";
      }
      return {
        name: room.name,
        phase: room.phase,
        count: room.players.size,
        capacity: 10 as const,
        participants: [...room.players.values()].map((player) => ({
          name: player.name,
          connected: player.connected,
        })),
        joinable: !reason,
        reason,
        current: room.players.has(id),
      };
    });
  }
  private broadcastDirectory() {
    for (const socket of this.io.sockets.values())
      if (socket.rooms.has("directory"))
        socket.emit("directory", this.directory(socket.data.user.id));
  }
  async close() {
    this.closing = true;
    this.persistence.cancelAcquisition();
    await this.ready.catch(() => {});
    await this.commandQueue;
    for (const timer of this.departure.values()) clearTimeout(timer);
    this.departure.clear();
    for (const room of this.rooms.values()) room.close();
    await this.persistence.flush().catch(() => {});
    await this.persistence.release();
  }
  private join(socket: DrawSocket, name: string) {
    const id = socket.data.user.id,
      previous = this.members.get(id);
    let target = this.rooms.get(name);
    if (target) target.canJoin(id);
    else if (this.rooms.size >= 100)
      throw new Error("Tous les salons sont occupés.");
    if (previous && previous.room !== name) this.remove(id, previous);
    if (!target) {
      target = new GameRoom(name, () => this.broadcast(name), this.timing);
      this.rooms.set(name, target);
    }
    const timer = this.departure.get(id);
    if (timer) clearTimeout(timer);
    this.departure.delete(id);
    this.members.set(id, {
      sessionId: sessionOf(socket.request).sessionID ?? "",
      room: name,
      socket: socket.id,
      epoch: socket.data.epoch,
    });
    socket.data.room = name;
    target.join(socket.data.user);
    if (previous?.socket && previous.socket !== socket.id) {
      const old = this.io.sockets.get(previous.socket);
      old?.emit("replaced", "Votre place a été reprise dans un autre onglet.");
      old?.disconnect(true);
    }
    this.broadcast(name);
  }
  private depart(socket: DrawSocket, immediate: boolean) {
    if (this.closing || this.failed) return;
    delete socket.data.room;
    const id = socket.data.user.id,
      member = this.members.get(id);
    if (
      !member ||
      member.socket !== socket.id ||
      member.epoch !== socket.data.epoch
    )
      return;
    const pending = this.departure.get(id);
    if (pending) clearTimeout(pending);
    this.departure.delete(id);
    if (immediate) {
      this.remove(id, member);
      return;
    }
    member.socket = "";
    this.rooms.get(member.room)?.disconnect(id);
    this.scheduleDeparture(id, member, this.timing.graceMs ?? 15000);
  }
  private scheduleDeparture(id: string, member: Membership, ms: number) {
    const timeout = setTimeout(() => {
      const active = this.members.get(id);
      if (active === member && !active.socket) this.remove(id, active);
    }, ms);
    timeout.unref();
    this.departure.set(id, timeout);
  }
  private remove(id: string, member: Membership) {
    if (this.members.get(id) !== member) return;
    this.members.delete(id);
    const timeout = this.departure.get(id);
    if (timeout) clearTimeout(timeout);
    this.departure.delete(id);
    const current = this.rooms.get(member.room);
    if (!current) return;
    current.leave(id);
    if (!current.players.size) {
      current.close();
      this.rooms.delete(member.room);
      this.persist(member.room);
      this.broadcastDirectory();
    }
  }
}
