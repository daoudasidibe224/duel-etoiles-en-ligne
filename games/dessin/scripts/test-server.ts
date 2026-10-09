import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createHost } from "../test/fixtures/host";

// Browser test server: the drawing module inside a host that follows the
// shared-site contract (sessions, guests, accounts, logout form).
async function main() {
  const database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
  const host = createHost({
    timing: { chooseMs: 30000, drawMs: 30000, revealMs: 5000 },
  });
  await host.rooms.ready;
  host.server.listen(Number(process.env.TEST_PORT || 4415), "127.0.0.1");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await host.close();
      if ("close" in host.store) await host.store.close();
      await mongoose.disconnect();
      await database.stop();
      process.exit(0);
    });
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
