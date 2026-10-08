import mongoose from "mongoose";
import type { Express } from "express";
export function registerHealth(app: Express) {
  app.get("/health/live", (_req, res) =>
    res.set("Cache-Control", "no-store").json({ status: "ok" }),
  );
  app.get("/health/ready", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const db = mongoose.connection.db;
      if (mongoose.connection.readyState !== 1 || !db)
        throw new Error("Base indisponible");
      await db.command({ ping: 1 }, { timeoutMS: 1500 });
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable", service: "database" });
    }
  });
}
