const mongoose = require("mongoose"),
  MongoStore = require("connect-mongo").default;
const { createApp } = require("../dist/src/app"),
  { RoomJournal } = require("../dist/src/services/roomJournal"),
  { recoverResults } = require("../dist/src/services/results");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const journal = RoomJournal.prepare({ leaseMs: 1200 }),
    store = MongoStore.create({ client: mongoose.connection.getClient() });
  const { server, io } = createApp({
    secret: process.env.SECRET,
    store,
    roomJournal: journal,
    gameOptions: { durationMs: Number(process.env.GAME_DURATION || 6000), reconnectMs: 12000 },
  });
  server.listen(Number(process.env.PORT), "127.0.0.1", () =>
    console.log("HTTP"),
  );
  journal
    .activate({ waitMs: process.env.WAIT_ENGINE === "1" ? Infinity : 2000 })
    .then(async () => {
      await recoverResults();
      console.log("READY");
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
  const connections = new Set();
  server.on("connection", socket => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  process.on("SIGTERM", async () => {
    await journal.close();
    const deadline = setTimeout(() => {
      for (const socket of connections) socket.destroy();
    }, 500);
    await new Promise((resolve) => io.close(resolve));
    clearTimeout(deadline);
    await store.close();
    await mongoose.disconnect();
    process.exit(0);
  });
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
