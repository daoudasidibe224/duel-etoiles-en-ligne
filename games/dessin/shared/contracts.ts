import { z } from "zod";
export const identity = z.object({ id: z.string(), name: z.string() });
export type Identity = z.infer<typeof identity>;
export const strokeSchema = z.object({
  id: z.string().min(1).max(64),
  shape: z.enum(["line", "rectangle", "ellipse"]).optional(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  px: z.number().min(0).max(1),
  py: z.number().min(0).max(1),
  color: z.enum([
    "#1f3b63",
    "#df6151",
    "#4c966f",
    "#e9b44c",
    "#7859a4",
    "#ffffff",
  ]),
  width: z.number().min(1).max(30),
});
export type Stroke = z.infer<typeof strokeSchema>;
export const roomName = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(
    /^[\p{L}\p{N} _-]+$/u,
    "Le salon utilise des lettres, chiffres, espaces ou tirets.",
  );
export const phaseSchema = z.enum([
  "waiting",
  "choosing",
  "countdown",
  "drawing",
  "reveal",
  "finished",
]);
export type Phase = z.infer<typeof phaseSchema>;
export const directorySchema = z.array(
  z.object({
    name: roomName,
    phase: phaseSchema,
    count: z.number().int().min(0).max(10),
    capacity: z.literal(10),
    participants: z.array(
      z.object({ name: z.string(), connected: z.boolean() }),
    ),
    joinable: z.boolean(),
    reason: z.string(),
    current: z.boolean(),
  }),
);
export type Directory = z.infer<typeof directorySchema>;
export const playerSchema = identity.extend({
  score: z.number(),
  connected: z.boolean(),
  guessed: z.boolean(),
});
export type Player = z.infer<typeof playerSchema>;
export const messageSchema = z.object({
  id: z.number(),
  name: z.string(),
  text: z.string(),
  system: z.boolean(),
});
export type Message = z.infer<typeof messageSchema>;
export const roundRecord = z.object({
  id: z.uuid(),
  round: z.number().int(),
  drawer: z.string(),
  word: z.string(),
  guessed: z.array(z.string()),
  history: z.array(strokeSchema),
});
export type RoundRecord = z.infer<typeof roundRecord>;
export const snapshotSchema = z.object({
  room: z.string(),
  turn: z.uuid(),
  host: z.string(),
  drawer: z.string(),
  phase: phaseSchema,
  round: z.number(),
  rounds: z.number(),
  deadline: z.number(),
  hint: z.string(),
  word: z.string().optional(),
  choices: z.array(z.string()).optional(),
  players: z.array(playerSchema),
  history: z.array(strokeSchema),
  messages: z.array(messageSchema),
  gallery: z.array(roundRecord),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const resultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type Result = z.infer<typeof resultSchema>;
export const identityKind = z.enum(["account", "guest"]);
export type IdentityKind = z.infer<typeof identityKind>;
// Shared site session as seen by the drawing pages. Accounts and guests come
// only from the host site; the drawing game never stores credentials.
export const sessionSchema = z.object({
  user: identity.nullable(),
  kind: identityKind.nullable(),
  logout: z.object({ action: z.string(), csrf: z.string() }).nullable(),
});
export type SessionState = z.infer<typeof sessionSchema>;
export const readySchema = z.object({ epoch: z.uuid() });
export const commandSchema = z.object({
  epoch: z.uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  turn: z.string(),
  data: z.unknown(),
});
export type Command = z.infer<typeof commandSchema>;
