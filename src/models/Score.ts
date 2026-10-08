import { Schema, model, InferSchemaType } from "mongoose";
const schema = new Schema({
  matchId: { type: String },
  monJoueurId: { type: Schema.Types.ObjectId, required: true },
  monNom: { type: String, required: true, trim: true },
  monScore: { type: Number, required: true, min: 0, max: 10000 },
  nomUtilisateurAutreJoueur: { type: String, required: true },
  scoreAutreJoueur: { type: Number, required: true, min: 0, max: 10000 },
  date: { type: Date, default: Date.now },
});
schema.index(
  { matchId: 1, monJoueurId: 1 },
  { unique: true, partialFilterExpression: { matchId: { $type: "string" } } },
);
export type ScoreData = InferSchemaType<typeof schema>;
export default model("Score", schema);
