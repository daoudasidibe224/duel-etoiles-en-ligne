import "dotenv/config";
import mongoose from "mongoose";
import MongoStore from "connect-mongo";
import { createApp } from "./src/app";

export async function start() {
  if (!process.env.MONGODB_URI)
    throw new Error("MONGODB_URI doit être configuré dans .env");
  if (!process.env.SECRET || process.env.SECRET.length < 32)
    throw new Error("SECRET doit contenir au moins 32 caractères");
  const port = Number(process.env.PORT ?? 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT doit être un entier de 1 à 65535");
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  const store = MongoStore.create({
    client: mongoose.connection.getClient(),
    collectionName: "sessions",
  });
  const { server, io } = createApp({ secret: process.env.SECRET, store });
  server.listen(port, "0.0.0.0", () =>
    console.log(`Jeu disponible sur http://localhost:${port}`),
  );
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    io.close();
    await store.close();
    await mongoose.disconnect();
  }
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
if (require.main === module)
  start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
