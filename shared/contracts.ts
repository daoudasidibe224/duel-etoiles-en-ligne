import { z } from "zod";
export const publicUserSchema = z.object({
  id: z.string(),
  nomUtilisateur: z.string(),
});
export const playerSchema = publicUserSchema.extend({
  userId: z.string(),
  room: z.string(),
  score: z.number().int().nonnegative().default(0),
});
export type Player = z.infer<typeof playerSchema>;
export const roundSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.number(),
  endsAt: z.number(),
  ended: z.boolean(),
  saved: z.boolean(),
  saveError: z.string().optional(),
});
export type Round = z.infer<typeof roundSchema>;
export const roomSchema = z.object({
  id: z.string(),
  nomProprietaire: z.string(),
  proprietaireId: z.string(),
  utilisateurs: z.array(playerSchema).max(2),
  createdAt: z.number(),
  started: z.boolean().optional(),
  startedAt: z.number().optional(),
  round: roundSchema.optional(),
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
export const actionSchema = z.object({
  roundId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
});
export const movementInputSchema = actionSchema.extend({
  etat: stateSchema.partial(),
});
export const movementSchema = z.object({ id: z.string(), etat: stateSchema });
export const scoreValueSchema = z.number().int().min(0).max(10000);
export const scoreInputSchema = actionSchema.extend({
  score: scoreValueSchema,
});
export const scoreSchema = z.object({
  id: z.string(),
  score: scoreValueSchema,
  roundId: z.string().uuid(),
});
export const resultSchema = z.object({
  roundId: z.string().uuid(),
});
export const joinSchema = z.object({ room: z.string().uuid() });
export const gameRoomSchema = z.object({
  room: z.string(),
  utilisateurs: z.array(playerSchema).max(2),
  ownerId: z.string().optional(),
  round: roundSchema.optional(),
});
export const chatRoomSchema = z.object({
  utilisateurs: z.array(publicUserSchema),
});
export const messageSchema = z.object({
  id: z.string().uuid(),
  nomUtilisateur: z.string(),
  text: z.string(),
  heureDenvoi: z.number(),
});
export const chatInputSchema = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(1).max(1000),
});
export type Message = z.infer<typeof messageSchema>;
export type Ack = (error?: string) => void;
// Les entrées externes restent unknown jusqu'à leur validation dans le gestionnaire.
export interface ClientEvents {
  join: (payload: unknown, callback: Ack) => void;
  leave: (callback: Ack) => void;
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
  identity: (userId: string) => void;
  replaced: () => void;
  roomClosed: (reason: string) => void;
  roundEnded: (payload: z.infer<typeof gameRoomSchema>) => void;
  init: (round: Round) => void;
  etoiles: () => void;
  deplacementMonJoueur: (payload: z.infer<typeof movementSchema>) => void;
  score: (payload: z.infer<typeof scoreSchema>) => void;
  message: (payload: Message) => void;
}
