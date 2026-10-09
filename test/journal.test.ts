import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import MongoStore from "connect-mongo";
import request from "supertest";
import { createApp } from "../src/app";
import { RoomJournal } from "../src/services/roomJournal";
import { io as connect } from "socket.io-client";

test(
  "journal réel : créations HTTP concurrentes, arrêt du propriétaire du verrou, sockets et sonde",
  { timeout: 20000 },
  async () => {
    const mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 1000 });
    const journal = await RoomJournal.open({ leaseMs: 3000 });
    const store = MongoStore.create({
      client: mongoose.connection.getClient(),
    });
    const instance = createApp({
      secret: "journal-test-".repeat(4),
      store,
      roomJournal: journal,
    });
    await new Promise<void>((resolve) =>
      instance.server.listen(0, "127.0.0.1", resolve),
    );
    const address = instance.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const agent = request.agent(base);
    const csrf = (html: string) => {
      const value = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(value);
      return value;
    };
    let socket: ReturnType<typeof connect> | undefined;
    try {
      await assert.rejects(RoomJournal.open({ waitMs: 50 }), /instance Duel/);
      const form = await agent.get("/jouer");
      const entered = await agent
        .post("/utilisateur/invite")
        .type("form")
        .send({ _csrf: csrf(form.text), nomUtilisateur: "journal_guest" });
      assert.equal(entered.status, 302);
      const cookie = entered.headers["set-cookie"][0].split(";")[0];
      const lobby = await agent.get("/salon");
      const responses = await Promise.all(
        Array.from({ length: 12 }, () =>
          agent
            .post("/salon/salonDeJeu/room")
            .type("form")
            .send({ _csrf: csrf(lobby.text) }),
        ),
      );
      assert.ok(responses.every((response) => response.status === 302));
      assert.equal(
        new Set(responses.map((response) => response.headers.location)).size,
        1,
      );
      const room = responses[0].headers.location.split("/").pop();
      const doc = await mongoose.connection.db
        ?.collection<{ _id: string; entries: Record<string, unknown> }>(
          "roomjournals",
        )
        .findOne({ _id: "arena" });
      assert.ok(doc);
      assert.equal(Object.keys(doc.entries).length, 1);
      socket = connect(base + "/jeu", {
        transports: ["websocket"],
        extraHeaders: { Cookie: cookie },
        forceNew: true,
        reconnection: false,
      });
      await new Promise<void>((resolve) =>
        socket?.once("connect", () => resolve()),
      );
      assert.equal(await socket.emitWithAck("join", { room }), undefined);
      const closed = new Promise<void>((resolve) =>
        socket?.once("disconnect", () => resolve()),
      );
      await mongoose.connection.db
        ?.collection<{ _id: string; entries: Record<string, unknown> }>(
          "roomjournals",
        )
        .updateOne(
          { _id: "arena" },
          { $set: { owner: "replacement", leaseUntil: Date.now() + 10000 } },
        );
      let executed = false;
      await assert.rejects(
        journal.run(() => {
          executed = true;
        }),
        /verrou/,
      );
      assert.equal(executed, false);
      await closed;
      assert.equal((await agent.get("/health/ready")).status, 503);
      const denied = await agent
        .post("/salon/salonDeJeu/room")
        .type("form")
        .send({ _csrf: csrf(lobby.text) });
      assert.equal(denied.status, 503);
      assert.equal(denied.headers.location, undefined);
    } finally {
      socket?.disconnect();
      await new Promise<void>((resolve) => instance.io.close(() => resolve()));
      await journal.close();
      await store.close();
      await mongoose.disconnect();
      await mongo.stop();
    }
  },
);
