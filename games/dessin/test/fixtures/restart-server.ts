import mongoose from "mongoose";
import { createHost } from "./host";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI requis.");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const host = createHost({
    timing: {
      chooseMs: 30000,
      countdownMs: 400,
      drawMs: 30000,
      revealMs: Number(process.env.TEST_REVEAL_MS || 30000),
      recoveryMs: 30000,
      leaseMs: 1000,
      leasePollMs: 50,
    },
  });
  host.server.listen(Number(process.env.TEST_PORT || 0), "127.0.0.1", () => {
    const address = host.server.address();
    if (address && typeof address === "object")
      process.send?.({ port: address.port });
  });
  process.once("SIGTERM", async () => {
    await host.close();
    if ("close" in host.store) await host.store.close();
    await mongoose.disconnect();
    process.exit(0);
  });
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
