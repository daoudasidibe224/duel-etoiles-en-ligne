import mongoose from "mongoose";
import type { Express } from "express";
export function registerHealth(app: Express) {
  app.get("/health/live", (_req, res) =>
    res.set("Cache-Control", "no-store").json({ status: "ok" }),
  );
  const probe =
    (requireEngine: boolean) =>
    async (
      _req: import("express").Request,
      res: import("express").Response,
    ) => {
      res.set("Cache-Control", "no-store");
      try {
        if (requireEngine && app.roomJournal && !app.roomJournal.available)
          throw new Error("Moteur de salons indisponible");
        const db = mongoose.connection.db;
        if (mongoose.connection.readyState !== 1 || !db)
          throw new Error("Base indisponible");
        await db.command({ ping: 1 }, { timeoutMS: 1500 });
        res.json({
          status: requireEngine ? "ready" : "infrastructure-ready",
          engine: app.roomJournal?.available
            ? "ready"
            : app.roomJournal?.pending
              ? "waiting"
              : "unavailable",
        });
      } catch {
        res.status(503).json({
          status: "unavailable",
          service:
            requireEngine && app.roomJournal && !app.roomJournal.available
              ? "engine"
              : "database",
        });
      }
    };
  app.get("/health/ready", probe(true));
  app.get("/health/deploy", probe(false));
}
