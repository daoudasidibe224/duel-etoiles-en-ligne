import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    _id: { type: String, required: true },
    round: { type: Schema.Types.Mixed, required: true },
    players: { type: Schema.Types.Mixed, required: true },
    saved: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    savedAt: Date,
  },
  { versionKey: false },
);
schema.index(
  { savedAt: 1 },
  { expireAfterSeconds: 86400, partialFilterExpression: { saved: true } },
);
export default model("RoundResult", schema);
