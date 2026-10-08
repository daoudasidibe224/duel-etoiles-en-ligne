import type { GameServer } from "../types";
import type { Rooms } from "../../shared/contracts";
import discussion from "./discussionNsp";
import lobby from "./salonNsp";
import game from "./jeuNsp";
export default function registerSockets({
  io,
  salons,
}: {
  io: GameServer;
  salons: Rooms;
}) {
  discussion(io.of("/discussion"));
  lobby(io.of("/"), salons);
  game(io.of("/jeu"), io.of("/"), salons);
}
