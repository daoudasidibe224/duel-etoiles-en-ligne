import { z } from "zod";
export const publicUserSchema = z.object({
  id: z.string(),
  nomUtilisateur: z.string(),
});
export const playerSchema = publicUserSchema.extend({
  userId: z.string(),
  room: z.string(),
});
export type Player = z.infer<typeof playerSchema>;
export const roomSchema = z.object({
  id: z.string(),
  nomProprietaire: z.string(),
  proprietaireId: z.string(),
  utilisateurs: z.array(playerSchema).max(2),
  createdAt: z.number(),
  started: z.boolean().optional(),
  startedAt: z.number().optional(),
});
export const roomsSchema = z.record(z.string(), roomSchema);
export type Rooms = z.infer<typeof roomsSchema>;
export const stateSchema = z.object({
  runningRight: z.boolean(),
  runningLeft: z.boolean(),
  idLeft: z.boolean(),
  idRight: z.boolean(),
  dead: z.boolean(),
});
export type PlayerState = z.infer<typeof stateSchema>;
export const movementInputSchema = z.object({ etat: stateSchema.partial() });
export const movementSchema = z.object({ id: z.string(), etat: stateSchema });
export const scoreValueSchema = z.number().int().min(0).max(10000);
export const scoreInputSchema = z.object({ score: scoreValueSchema });
export const scoreSchema = scoreInputSchema.extend({ id: z.string() });
export const resultSchema = z.object({
  monScore: scoreValueSchema,
  scoreAutreJoueur: scoreValueSchema,
});
export const joinSchema = z.object({ room: z.string().uuid() });
export const gameRoomSchema = z.object({
  room: z.string(),
  utilisateurs: z.array(playerSchema),
});
export const chatRoomSchema = z.object({
  utilisateurs: z.array(publicUserSchema),
});
export const messageSchema = z.object({
  nomUtilisateur: z.string(),
  text: z.string(),
  heureDenvoi: z.number(),
});
export type Message = z.infer<typeof messageSchema>;
export type Ack = (error?: string) => void;
// Les entrées externes restent unknown jusqu'à leur validation dans le gestionnaire.
export interface ClientEvents {
  join: (payload: unknown, callback: Ack) => void;
  afficherBtnPlay: () => void;
  startGame: () => void;
  deplacementMonJoueur: (payload: unknown) => void;
  score: (payload: unknown) => void;
  scoreFinDeJeu: (payload: unknown, callback: Ack) => void;
  envoyerMessage: (payload: unknown, callback: Ack) => void;
}
export interface ServerEvents {
  majSalonDeJeu: (rooms: Rooms) => void;
  roomData: (
    payload: z.infer<typeof gameRoomSchema> | z.infer<typeof chatRoomSchema>,
  ) => void;
  afficherBtnPlay: (id: string) => void;
  init: () => void;
  etoiles: () => void;
  deplacementMonJoueur: (payload: z.infer<typeof movementSchema>) => void;
  score: (payload: z.infer<typeof scoreSchema>) => void;
  message: (payload: Message) => void;
}
