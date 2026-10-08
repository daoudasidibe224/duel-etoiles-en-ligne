const { spawn } = require("node:child_process");
const children = [
  spawn(process.execPath, [require.resolve("tsx/cli"), "watch", "server.ts"], {
    stdio: "inherit",
  }),
  spawn(process.execPath, ["scripts/build-client.js", "--watch"], {
    stdio: "inherit",
  }),
];
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
for (const child of children)
  child.on("exit", (code) => {
    if (!closing && code) {
      close();
      process.exitCode = code;
    }
  });
