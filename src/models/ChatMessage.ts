import { Schema, model } from "mongoose";
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  messageId: { type: String, required: true },
  nomUtilisateur: { type: String, required: true },
  text: { type: String, required: true, maxlength: 1000 },
  heureDenvoi: { type: Number, required: true },
});
schema.index({ userId: 1, messageId: 1 }, { unique: true });
schema.index({ heureDenvoi: -1 });
export default model("ChatMessage", schema);
