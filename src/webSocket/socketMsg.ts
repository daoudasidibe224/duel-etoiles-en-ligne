import { randomUUID } from "node:crypto";
import type { Message } from "../../shared/contracts";
export const generateMessage = (
  nomUtilisateur: string,
  text: string,
  id: string = randomUUID(),
): Message => ({ id, nomUtilisateur, text, heureDenvoi: Date.now() });
