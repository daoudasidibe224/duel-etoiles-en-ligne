import "dotenv/config";
import type { Socket } from "node:net";
import mongoose from "mongoose";
import MongoStore from "connect-mongo";
import { RoomJournal } from "./src/services/roomJournal";
import Score from "./src/models/Score";
import { recoverResults } from "./src/services/results";
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
  const roomJournal = RoomJournal.prepare();
  const { server, io, drawing } = createApp({
    secret: process.env.SECRET,
    store,
    roomJournal,
    enableDrawing: true,
  });
  const retry = setInterval(() => {
    if (roomJournal.available) void recoverResults().catch(() => {});
  }, 5000);
  retry.unref();
  void (async () => {
    await Score.init();
    await roomJournal.activate();
    await recoverResults().catch(() => {});
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
    void close().catch((failure) => console.error(failure.message));
  });
  server.listen(port, "0.0.0.0", () =>
    console.log(`La Salle de jeux est disponible sur http://localhost:${port}`),
  );
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(retry);
    try {
      await drawing?.rooms.close();
      await roomJournal.close();
    } finally {
      const deadline = setTimeout(() => {
        for (const socket of connections) socket.destroy();
      }, 5000);
      deadline.unref();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      clearTimeout(deadline);
      try {
        await store.close();
      } finally {
        await mongoose.disconnect();
      }
    }
  }
  roomJournal.onUnavailable = () => {
    process.exitCode = 1;
    void close().catch((error) => console.error(error.message));
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
if (require.main === module)
  start().catch(async (error) => {
    console.error(error.message);
    await mongoose.disconnect();
    process.exitCode = 1;
  });
