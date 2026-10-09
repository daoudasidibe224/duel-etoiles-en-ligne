import { randomUUID } from "node:crypto";
import { Arena } from "../services/arena";
import { saveRound } from "../services/results";
import { socketUser, type GameNamespace, type GameSocket } from "../types";
import {
  joinSchema,
  bonusInputSchema,
  movementInputSchema,
  scoreInputSchema,
  resultSchema,
  type Player,
  type Rooms,
  type PlayerState,
} from "../../shared/contracts";
interface Membership {
  player: Player;
  socketId: string;
  sessionId: string;
  expiresAt: number;
  movementSequence: number;
  scoreSequence: number;
  expiry?: ReturnType<typeof setTimeout>;
}
export default function game(
  namespace: GameNamespace,
  lobby: GameNamespace,
  rooms: Rooms,
  options: { durationMs?: number; reconnectMs?: number } = {},
  roomSessions = new Map<string, string>(),
  journal?: import("../services/roomJournal").RoomJournal,
) {
  let stopping = false;
  let tail: Promise<unknown> = Promise.resolve();
  const execute = (
    operation: () => unknown | Promise<unknown>,
    callback?: (error?: string) => void,
  ) => {
    const task = journal ? journal.run(operation) : tail.then(operation);
    tail = task.catch(() => {});
    return task
      .then(() => {})
      .catch(() => {
        const message = journal?.pending
          ? "Une mise à jour du serveur est en cours. Votre salon reste réservé ; la reprise sera automatique."
          : "La sauvegarde des salons est indisponible. Réessayez après la reconnexion.";
        if (typeof callback === "function") callback(message);
        if (!journal?.pending) namespace.emit("roomClosed", message);
      });
  };
  namespace.server.httpServer?.once("close", () => {
    stopping = true;
    for (const arena of arenas.values()) arena.stop();
    for (const timer of timers.values()) clearTimeout(timer);
    for (const member of members.values()) clearTimeout(member.expiry);
  });
  const arenas = new Map<string, Arena>();
  const members = new Map<string, Membership>();
  const participants = new Map<string, Player[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const duration = options.durationMs ?? 90_000;
  const grace = options.reconnectMs ?? 12_000;
  const snapshot = (room: Rooms[string]) => ({
    room: room.id,
    ownerId: room.proprietaireId,
    utilisateurs: room.utilisateurs,
    round: room.round,
    recoveryNotice: room.recoveryNotice,
    interruptedRoundId: room.interruptedRoundId,
  });
  const resultSnapshot = (room: Rooms[string]) => ({
    ...snapshot(room),
    utilisateurs: room.round
      ? (participants.get(room.round.id) ?? room.utilisateurs)
      : room.utilisateurs,
  });
  const sync = () =>
    journal?.sync(
      rooms,
      new Map(
        [...members].map(([id, member]) => [
          id,
          { sessionId: member.sessionId, expiresAt: member.expiresAt },
        ]),
      ),
      roomSessions,
    );
  if (journal)
    void journal.ready.then(() => {
      for (const room of Object.values(rooms)) {
        if (room.round?.ended)
          participants.set(
            room.round.id,
            room.utilisateurs.map((player) => ({ ...player })),
          );
        const lifetime = setTimeout(
          () => {
            void execute(async () => {
              if (rooms[room.id] !== room) return;
              const owner = members.get(room.proprietaireId);
              if (owner?.player.room === room.id) await remove(owner);
              else {
                delete rooms[room.id];
                roomSessions.delete(room.id);
                await sync();
                namespace
                  .to(room.id)
                  .emit(
                    "roomClosed",
                    "La durée de conservation du salon a expiré.",
                  );
              }
            });
          },
          Math.max(0, room.createdAt + 86400000 - Date.now()),
        );
        lifetime.unref();
        timers.set(`lifetime:${room.id}`, lifetime);
        const pendingOwner = journal.reservations.get(room.proprietaireId);
        if (
          pendingOwner &&
          !room.utilisateurs.some(
            (player) => player.userId === room.proprietaireId,
          )
        ) {
          const expiry = setTimeout(
            () => {
              void execute(async () => {
                if (
                  rooms[room.id] === room &&
                  roomSessions.get(room.id) === pendingOwner.sessionId &&
                  !room.utilisateurs.some(
                    (player) => player.userId === room.proprietaireId,
                  )
                ) {
                  delete rooms[room.id];
                  roomSessions.delete(room.id);
                  await sync();
                  lobby.emit("majSalonDeJeu", rooms);
                }
              });
            },
            Math.max(0, pendingOwner.expiresAt - Date.now()),
          );
          expiry.unref();
          timers.set(`pending:${room.id}`, expiry);
        }
        for (const player of room.utilisateurs) {
          const saved = journal.reservations.get(player.userId) ?? {
            sessionId: "",
            expiresAt: room.createdAt + 86400000,
          };
          const member: Membership = {
            player,
            socketId: "",
            sessionId: saved.sessionId,
            expiresAt: saved.expiresAt,
            movementSequence: -1,
            scoreSequence: -1,
          };
          members.set(player.userId, member);
          member.expiry = setTimeout(
            () => {
              if (members.get(player.userId) === member)
                void execute(() => remove(member));
            },
            Math.max(0, saved.expiresAt - Date.now()),
          );
          member.expiry.unref();
        }
      }
    });
  const publish = async (room: Rooms[string]) => {
    await sync();
    namespace.to(room.id).emit("roomData", snapshot(room));
    lobby.emit("majSalonDeJeu", rooms);
  };
  const end = async (room: Rooms[string]) => {
    const round = room.round;
    if (!round || round.ended) return;
    participants.set(
      round.id,
      room.utilisateurs.map((player) => ({ ...player })),
    );
    round.ended = true;
    arenas.get(room.id)?.stop();
    arenas.delete(room.id);
    clearTimeout(timers.get(room.id));
    timers.delete(room.id);
    // Commit the terminal snapshot under the engine fence before writing its outbox.
    round.saved = false;
    await sync();
    try {
      await saveRound(round, participants.get(round.id) ?? room.utilisateurs);
      round.saved = true;
    } catch {
      round.saved = false;
      round.saveError =
        "Le score n’a pas pu être enregistré. Réessayez lorsque la connexion revient.";
    }
    await sync();
    namespace.to(room.id).emit("roundEnded", resultSnapshot(room));
  };
  const remove = async (member: Membership) => {
    clearTimeout(member.expiry);
    const room = rooms[member.player.room];
    members.delete(member.player.userId);
    if (!room) return;
    if (room.proprietaireId === member.player.userId)
      for (const key of [`lifetime:${room.id}`, `pending:${room.id}`]) {
        clearTimeout(timers.get(key));
        timers.delete(key);
      }
    // Capture des participants avant toute suppression pour conserver un résultat cohérent.
    await end(room);
    if (room.proprietaireId === member.player.userId) {
      for (const player of room.utilisateurs) {
        const other = members.get(player.userId);
        clearTimeout(other?.expiry);
        members.delete(player.userId);
      }

      if (room.round) participants.delete(room.round.id);
      delete rooms[room.id];
      roomSessions.delete(room.id);
      await sync();
      namespace
        .to(room.id)
        .emit("roomClosed", "Le propriétaire a quitté le salon.");
      namespace.in(room.id).socketsLeave(room.id);
    } else {
      room.utilisateurs = room.utilisateurs.filter(
        (player) => player.userId !== member.player.userId,
      );
      if (!room.utilisateurs.length) {
        if (room.round) participants.delete(room.round.id);
        delete rooms[room.id];
        roomSessions.delete(room.id);
      } else await publish(room);
    }
    await sync();
    lobby.emit("majSalonDeJeu", rooms);
  };
  namespace.on("connection", (socket: GameSocket) => {
    const user = socketUser(socket);
    const sid = socket.request.sessionID;
    if (!sid) {
      socket.disconnect(true);
      return;
    }
    socket.emit("identity", user.id);
    const active = () => {
      const member = members.get(user.id);
      return member?.socketId === socket.id ? member : undefined;
    };
    socket.on("join", (payload, callback) => {
      void execute(async () => {
        const reply = (error?: string) => {
          if (typeof callback === "function") {
            if (error) callback(error);
            else callback();
          }
        };
        const parsed = joinSchema.safeParse(payload);
        if (!parsed.success) return reply("Salon invalide.");
        const room = rooms[parsed.data.room],
          previous = members.get(user.id);
        const restored =
          room?.round?.ended &&
          room.utilisateurs.find((player) => player.userId === user.id);
        if (previous && previous.player.room !== parsed.data.room)
          return reply(
            "Quittez votre salon actuel avant de rejoindre une autre partie.",
          );
        if (
          !room ||
          (!previous &&
            !restored &&
            (room.started || room.utilisateurs.length >= 2))
        )
          return reply(
            journal?.reason(parsed.data.room) ??
              "Salon fermé, complet ou partie en cours.",
          );
        if (previous) {
          clearTimeout(previous.expiry);
          if (previous.socketId !== socket.id) {
            const old = namespace.sockets.get(previous.socketId);
            previous.socketId = socket.id;
            previous.sessionId = sid;
            previous.expiresAt = user.expiresAt ?? Date.now() + 86400000;
            previous.movementSequence = -1;
            previous.scoreSequence = -1;
            old?.emit("replaced");
            old?.disconnect();
          }
          if (room.proprietaireId === user.id) roomSessions.set(room.id, sid);
          socket.join(room.id);
          await publish(room);
          if (room.round && !room.round.ended) socket.emit("init", room.round);
          if (room.round?.ended)
            socket.emit("roundEnded", resultSnapshot(room));
          return reply();
        }
        for (const [id, pending] of Object.entries(rooms)) {
          if (
            id !== room.id &&
            pending.proprietaireId === user.id &&
            !pending.utilisateurs.length
          ) {
            delete rooms[id];
            roomSessions.delete(id);
          }
        }
        const player: Player = restored || {
          id: user.id,
          userId: user.id,
          nomUtilisateur: user.nomUtilisateur,
          room: room.id,
          score: 0,
          usedStages: [],
          kind: user.kind,
        };
        members.set(user.id, {
          player,
          socketId: socket.id,
          sessionId: sid,
          expiresAt: user.expiresAt ?? Date.now() + 86400000,
          movementSequence: -1,
          scoreSequence: -1,
        });
        if (!restored) room.utilisateurs.push(player);
        if (room.proprietaireId === user.id) roomSessions.set(room.id, sid);
        socket.join(room.id);
        await publish(room);
        if (room.round?.ended) socket.emit("roundEnded", resultSnapshot(room));
        reply();
      }, callback);
    });
    socket.on("leave", (callback) => {
      void execute(async () => {
        const member = active();
        if (member) {
          await remove(member);
          socket.leave(member.player.room);
        }
        if (typeof callback === "function") callback();
      }, callback);
    });
    socket.on("afficherBtnPlay", () => {
      const member = active(),
        room = member && rooms[member.player.room];
      if (room?.utilisateurs.length === 2 && !room.started) {
        const host = members.get(room.proprietaireId);
        if (host)
          namespace.to(host.socketId).emit("afficherBtnPlay", host.player.id);
      }
    });
    socket.on("startGame", () => {
      void execute(async () => {
        const member = active(),
          room = member && rooms[member.player.room];
        if (
          !room ||
          room.started ||
          room.utilisateurs.length !== 2 ||
          room.proprietaireId !== user.id
        )
          return;
        // Une place en reprise ne peut pas lancer une manche.
        if (
          room.utilisateurs.some(
            (player) =>
              !namespace.sockets.has(
                members.get(player.userId)?.socketId ?? "",
              ),
          )
        )
          return;
        delete room.recoveryNotice;
        delete room.interruptedRoundId;
        room.started = true;
        room.startedAt = Date.now();
        room.round = {
          id: randomUUID(),
          startedAt: room.startedAt,
          endsAt: room.startedAt + duration,
          ended: false,
          saved: false,
          stars: [],
          stage: 0,
        };
        await publish(room);
        arenas.set(
          room.id,
          new Arena(room.round, room.utilisateurs, () =>
            namespace.to(room.id).emit("roomData", snapshot(room)),
          ),
        );
        const timer = setTimeout(() => {
          void execute(() => end(room));
        }, duration);
        timer.unref();
        timers.set(room.id, timer);
        namespace.to(room.id).emit("init", room.round);
      });
    });
    socket.on("deplacementMonJoueur", (payload) => {
      void execute(async () => {
        const parsed = movementInputSchema.safeParse(payload),
          member = active();
        const round = member && rooms[member.player.room]?.round;
        if (
          !parsed.success ||
          !member ||
          !round ||
          round.ended ||
          round.endsAt <= Date.now() ||
          parsed.data.roundId !== round.id ||
          parsed.data.sequence <= member.movementSequence
        )
          return;
        member.movementSequence = parsed.data.sequence;
        const input = parsed.data.etat;
        const etat: PlayerState = {
          runningRight: input.runningRight === true,
          runningLeft: input.runningLeft === true,
          idLeft: input.idLeft === true,
          idRight: input.idRight === true,
          dead: input.dead === true,
        };
        socket
          .to(member.player.room)
          .emit("deplacementMonJoueur", { id: user.id, etat });
      });
    });
    socket.on("activateBonus", (payload, callback) => {
      void execute(async () => {
        const parsed = bonusInputSchema.safeParse(payload),
          member = active();
        const arena = member && arenas.get(member.player.room);
        if (!parsed.success || !arena)
          return (
            typeof callback === "function" &&
            callback("Bonus invalide ou joueur absent.")
          );
        try {
          arena.activate(user.id, parsed.data);
          if (typeof callback === "function") callback();
        } catch (error) {
          if (typeof callback === "function")
            callback(
              error instanceof Error ? error.message : "Bonus indisponible.",
            );
        }
      }, callback);
    });
    socket.on("score", (payload, callback) => {
      void execute(async () => {
        const parsed = scoreInputSchema.safeParse(payload),
          member = active();
        const round = member && rooms[member.player.room]?.round,
          arena = member && arenas.get(member.player.room);
        const reply = (error?: string) => {
          if (typeof callback === "function") {
            if (error) callback(error);
            else callback();
          }
        };
        if (
          !parsed.success ||
          !member ||
          !arena ||
          !round ||
          round.ended ||
          round.endsAt <= Date.now() ||
          parsed.data.roundId !== round.id ||
          parsed.data.sequence <= member.scoreSequence
        )
          return reply("Événement invalide, ancien ou joueur absent.");
        try {
          const points = arena.collect(user.id, parsed.data.starId);
          member.scoreSequence = parsed.data.sequence;
          if (points)
            namespace.to(member.player.room).emit("score", {
              id: user.id,
              score: member.player.score,
              roundId: round.id,
            });
          reply();
        } catch (error) {
          reply(
            error instanceof Error ? error.message : "Étoile indisponible.",
          );
        }
      }, callback);
    });
    socket.on("scoreFinDeJeu", (payload, callback) => {
      void execute(async () => {
        const parsed = resultSchema.safeParse(payload),
          member = active();
        const room = member && rooms[member.player.room],
          round = room?.round;
        if (
          !parsed.success ||
          !round?.ended ||
          parsed.data.roundId !== round.id
        )
          return (
            typeof callback === "function" &&
            callback("Score invalide ou manche encore en cours.")
          );
        if (!round.saved && room) {
          try {
            await saveRound(
              round,
              participants.get(round.id) ?? room.utilisateurs,
            );
            round.saved = true;
            delete round.saveError;
          } catch {
            return (
              typeof callback === "function" &&
              callback("Le score n’a pas pu être enregistré.")
            );
          }
        }
        if (typeof callback === "function") callback();
      }, callback);
    });
    socket.on("disconnect", (reason) => {
      void execute(async () => {
        if (stopping || reason === "server shutting down") return;
        const member = active();
        if (!member) return;
        if (
          reason === "server namespace disconnect" ||
          reason === "forced server close"
        ) {
          await remove(member);
          return;
        }
        // Le remplacement d'une ancienne connexion ne libère jamais la nouvelle place.
        member.expiry = setTimeout(
          () => {
            if (active() === member) void execute(() => remove(member));
          },
          Math.max(
            0,
            Math.min(
              grace,
              (user.expiresAt ?? Date.now() + grace) - Date.now(),
            ),
          ),
        );
        member.expiry.unref();
      });
    });
  });
  return (id: string, sessionId?: string) => {
    return execute(async () => {
      const member = members.get(id);
      if (
        member &&
        (!sessionId || !member.sessionId || member.sessionId === sessionId)
      )
        await remove(member);
      for (const [key, room] of Object.entries(rooms)) {
        if (
          room.proprietaireId === id &&
          !room.utilisateurs.length &&
          (!sessionId ||
            !roomSessions.has(key) ||
            roomSessions.get(key) === sessionId)
        ) {
          delete rooms[key];
          roomSessions.delete(key);
        }
      }
      await sync();
      lobby.emit("majSalonDeJeu", rooms);
    });
  };
}
