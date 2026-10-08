import { Schema, model, InferSchemaType } from "mongoose";
const schema = new Schema({
  nomUtilisateur: {
    type: String,
    lowercase: true,
    trim: true,
    required: true,
    unique: true,
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    required: true,
    unique: true,
  },
  mdp: { type: String, required: true },
  date: { type: Date, default: Date.now },
});
export type UtilisateurData = InferSchemaType<typeof schema>;
export default model("Utilisateur", schema);
