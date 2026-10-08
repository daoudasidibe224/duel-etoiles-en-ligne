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
  movementSequence: number;
  scoreSequence: number;
  expiry?: ReturnType<typeof setTimeout>;
}
export default function game(
  namespace: GameNamespace,
  lobby: GameNamespace,
  rooms: Rooms,
  options: { durationMs?: number; reconnectMs?: number } = {},
) {
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
  });
  const resultSnapshot = (room: Rooms[string]) => ({
    ...snapshot(room),
    utilisateurs: room.round
      ? (participants.get(room.round.id) ?? room.utilisateurs)
      : room.utilisateurs,
  });
  const publish = (room: Rooms[string]) => {
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
    namespace.to(room.id).emit("roundEnded", resultSnapshot(room));
    try {
      await saveRound(round, participants.get(round.id) ?? room.utilisateurs);
      round.saved = true;
    } catch {
      round.saved = false;
      round.saveError =
        "Le score n’a pas pu être enregistré. Réessayez lorsque la connexion revient.";
    }
    namespace.to(room.id).emit("roundEnded", resultSnapshot(room));
  };
  const remove = (member: Membership) => {
    clearTimeout(member.expiry);
    const room = rooms[member.player.room];
    members.delete(member.player.userId);
    if (!room) return;
    // Capture des participants avant toute suppression pour conserver un résultat cohérent.
    void end(room);
    if (room.proprietaireId === member.player.userId) {
      namespace
        .to(room.id)
        .emit("roomClosed", "Le propriétaire a quitté le salon.");
      for (const player of room.utilisateurs) {
        const other = members.get(player.userId);
        clearTimeout(other?.expiry);
        members.delete(player.userId);
      }
      namespace.in(room.id).socketsLeave(room.id);
      if (room.round) participants.delete(room.round.id);
      delete rooms[room.id];
    } else {
      room.utilisateurs = room.utilisateurs.filter(
        (player) => player.userId !== member.player.userId,
      );
      if (!room.utilisateurs.length) {
        if (room.round) participants.delete(room.round.id);
        delete rooms[room.id];
      } else publish(room);
    }
    lobby.emit("majSalonDeJeu", rooms);
  };
  namespace.on("connection", (socket: GameSocket) => {
    const user = socketUser(socket);
    socket.emit("identity", user.id);
    const active = () => {
      const member = members.get(user.id);
      return member?.socketId === socket.id ? member : undefined;
    };
    socket.on("join", (payload, callback) => {
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
      if (previous && previous.player.room !== parsed.data.room)
        return reply(
          "Quittez votre salon actuel avant de rejoindre une autre partie.",
        );
      if (
        !room ||
        (!previous && (room.started || room.utilisateurs.length >= 2))
      )
        return reply("Salon fermé, complet ou partie en cours.");
      if (previous) {
        clearTimeout(previous.expiry);
        if (previous.socketId !== socket.id) {
          const old = namespace.sockets.get(previous.socketId);
          previous.socketId = socket.id;
          previous.movementSequence = -1;
          previous.scoreSequence = -1;
          old?.emit("replaced");
          old?.disconnect();
        }
        socket.join(room.id);
        publish(room);
        if (room.round && !room.round.ended) socket.emit("init", room.round);
        if (room.round?.ended) socket.emit("roundEnded", resultSnapshot(room));
        return reply();
      }
      for (const [id, pending] of Object.entries(rooms)) {
        if (
          id !== room.id &&
          pending.proprietaireId === user.id &&
          !pending.utilisateurs.length
        )
          delete rooms[id];
      }
      const player: Player = {
        id: user.id,
        userId: user.id,
        nomUtilisateur: user.nomUtilisateur,
        room: room.id,
        score: 0,
        usedStages: [],
      };
      members.set(user.id, {
        player,
        socketId: socket.id,
        movementSequence: -1,
        scoreSequence: -1,
      });
      room.utilisateurs.push(player);
      socket.join(room.id);
      publish(room);
      reply();
    });
    socket.on("leave", (callback) => {
      const member = active();
      if (member) {
        remove(member);
        socket.leave(member.player.room);
      }
      if (typeof callback === "function") callback();
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
            !namespace.sockets.has(members.get(player.userId)?.socketId ?? ""),
        )
      )
        return;
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
      arenas.set(
        room.id,
        new Arena(room.round, room.utilisateurs, () =>
          namespace.to(room.id).emit("roomData", snapshot(room)),
        ),
      );
      const timer = setTimeout(() => {
        void end(room);
      }, duration);
      timer.unref();
      timers.set(room.id, timer);
      namespace.to(room.id).emit("init", room.round);
      publish(room);
    });
    socket.on("deplacementMonJoueur", (payload) => {
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
    socket.on("activateBonus", (payload, callback) => {
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
    });
    socket.on("score", (payload, callback) => {
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
          namespace
            .to(member.player.room)
            .emit("score", {
              id: user.id,
              score: member.player.score,
              roundId: round.id,
            });
        reply();
      } catch (error) {
        reply(error instanceof Error ? error.message : "Étoile indisponible.");
      }
    });
    socket.on("scoreFinDeJeu", async (payload, callback) => {
      const parsed = resultSchema.safeParse(payload),
        member = active();
      const room = member && rooms[member.player.room],
        round = room?.round;
      if (!parsed.success || !round?.ended || parsed.data.roundId !== round.id)
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
    });
    socket.on("disconnect", (reason) => {
      const member = active();
      if (!member) return;
      if (
        reason === "server namespace disconnect" ||
        reason === "forced server close"
      ) {
        remove(member);
        return;
      }
      // Le remplacement d'une ancienne connexion ne libère jamais la nouvelle place.
      member.expiry = setTimeout(() => {
        if (active() === member) remove(member);
      }, grace);
      member.expiry.unref();
    });
  });
}
