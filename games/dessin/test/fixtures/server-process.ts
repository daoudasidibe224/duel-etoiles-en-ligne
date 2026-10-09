import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";

export class ServerProcess {
  child?: ChildProcess;
  base = "";
  private port = 0;
  async start(uri: string, revealMs = 30000, waitForEngine = true) {
    const child = fork(path.join(__dirname, "restart-server.ts"), [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        MONGODB_URI: uri,
        TEST_REVEAL_MS: String(revealMs),
        TEST_PORT: String(this.port),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    let output = "";
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Démarrage du serveur dépassé : " + output)),
        20000,
      );
      child.once("message", (message: unknown) => {
        clearTimeout(timeout);
        if (
          message &&
          typeof message === "object" &&
          "port" in message &&
          typeof message.port === "number"
        )
          resolve(message.port);
        else reject(new Error("Adresse du serveur absente."));
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error("Serveur arrêté : " + code + " " + output));
      });
      child.once("error", reject);
    });
    this.base = "http://127.0.0.1:" + port;
    this.port = port;
    if (waitForEngine) {
      const until = Date.now() + 20000;
      let ready = false;
      while (Date.now() < until) {
        try {
          ready = (await fetch(this.base + "/dessin/api/health")).ok;
        } catch {}
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!ready) throw new Error("Moteur non prêt : " + output);
    }
    return this.base;
  }
  async kill(signal: NodeJS.Signals = "SIGKILL") {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill(signal);
    await ended;
  }
}
