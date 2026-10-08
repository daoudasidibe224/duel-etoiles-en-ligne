import type { Message } from "../../shared/contracts";
export const generateMessage = (
  nomUtilisateur: string,
  text: string,
): Message => ({ nomUtilisateur, text, heureDenvoi: Date.now() });
