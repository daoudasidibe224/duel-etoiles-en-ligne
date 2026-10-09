import type { GameServer } from "../types";
import type { Rooms } from "../../shared/contracts";
import discussion from "./discussionNsp";
import lobby from "./salonNsp";
import game from "./jeuNsp";
export default function registerSockets({
  io,
  salons,
  gameOptions,
  roomSessions,
  roomJournal,
}: {
  io: GameServer;
  salons: Rooms;
  gameOptions?: { durationMs?: number; reconnectMs?: number };
  roomSessions: Map<string, string>;
  roomJournal?: import("../services/roomJournal").RoomJournal;
}) {
  discussion(io.of("/discussion"));
  lobby(io.of("/"), salons, roomSessions, roomJournal);
  return game(
    io.of("/jeu"),
    io.of("/"),
    salons,
    gameOptions,
    roomSessions,
    roomJournal,
  );
}
