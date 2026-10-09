import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { io, type Socket } from "socket.io-client";
import {
  readySchema,
  resultSchema,
  snapshotSchema,
  sessionSchema,
  type Snapshot,
} from "../shared/contracts";
import { ServerProcess } from "./fixtures/server-process";

async function wait<T>(
  read: () => T | undefined,
  predicate: (value: T) => boolean,
) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const value = read();
    if (value && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("État attendu absent.");
}
async function guest(base: string, name: string) {
  const entered = await fetch(base + "/test/guest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  assert.equal(entered.status, 200);
  const cookie = entered.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const current = sessionSchema.parse(
    await (
      await fetch(base + "/dessin/api/session", { headers: { Cookie: cookie } })
    ).json(),
  );
  assert.ok(current.user);
  return { cookie, identity: current.user };
}
async function player(base: string, cookie: string) {
  const socket = io(base + "/dessin", {
    transports: ["websocket"],
    autoConnect: false,
    reconnection: false,
    extraHeaders: { Cookie: cookie },
  });
  let epoch = "",
    sequence = 0,
    state: Snapshot | undefined;
  socket.on("snapshot", (raw: unknown) => {
    state = snapshotSchema.parse(raw);
  });
  const ready = new Promise<void>((resolve, reject) => {
    socket.once("ready", (raw: unknown) => {
      epoch = readySchema.parse(raw).epoch;
      resolve();
    });
    socket.once("connect_error", reject);
  });
  socket.connect();
  await ready;
  const raw = (event: string, packet: unknown) =>
    new Promise<ReturnType<typeof resultSchema.parse>>((resolve, reject) => {
      socket
        .timeout(5000)
        .emit(event, packet, (error: Error | null, result: unknown) =>
          error ? reject(error) : resolve(resultSchema.parse(result)),
        );
    });
  const packet = (data: unknown) => ({
    epoch,
    sequence: ++sequence,
    turn: state?.turn || "",
    data,
  });
  return {
    socket,
    read: () => state,
    raw,
    packet,
    emit: (event: string, data: unknown) => raw(event, packet(data)),
  };
}

test(
  "arrêt brutal et vrai Mongo : toutes les phases, places uniques, scores conservés et commandes périmées",
  { timeout: 90000 },
  async (t) => {
    const database = await MongoMemoryServer.create();
    try {
      for (const phase of [
        "waiting",
        "choosing",
        "countdown",
        "drawing",
        "reveal",
        "finished",
      ] as const) {
        await t.test(phase, async () => {
          const server = new ServerProcess();
          const sockets: Socket[] = [];
          const uri = database.getUri("restart_" + phase);
          try {
            await server.start(uri, phase === "finished" ? 50 : 30000);
            const identities = await Promise.all([
              guest(server.base, "Hôte"),
              guest(server.base, "Devineur"),
              guest(server.base, "Ami"),
            ]);
            const players = await Promise.all(
              identities.map((identity) =>
                player(server.base, identity.cookie),
              ),
            );
            sockets.push(...players.map((player) => player.socket));
            const [a, b, c] = players;
            for (const connection of players)
              assert.equal(
                (await connection.emit("join", "Salon durable")).ok,
                true,
              );
            if (phase !== "waiting") {
              assert.equal(
                (await a.emit("start", { rounds: 1, seconds: 30 })).ok,
                true,
              );
              await wait(a.read, (s) => s.phase === "choosing");
            }
            if (["countdown", "drawing", "reveal"].includes(phase)) {
              const word = a.read()?.choices?.[0];
              assert.ok(word);
              await a.emit("choose", word);
              if (phase !== "countdown") {
                await wait(a.read, (s) => s.phase === "drawing");
                await a.emit("draw", {
                  id: "saved",
                  x: 0.5,
                  y: 0.5,
                  px: 0.1,
                  py: 0.1,
                  width: 5,
                  color: "#1f3b63",
                });
                const answer = b.packet(word);
                assert.equal((await b.raw("guess", answer)).ok, true);
                assert.equal((await b.raw("guess", answer)).ok, true);
                if (phase === "reveal") await c.emit("guess", word);
              }
            }
            if (phase === "finished") {
              for (const connection of players) {
                await wait(
                  connection.read,
                  (s) =>
                    s.phase === "choosing" &&
                    s.drawer ===
                      identities[players.indexOf(connection)].identity.id,
                );
                await connection.emit("skip", null);
              }
            }
            const before = await wait(a.read, (s) => s.phase === phase);
            const stale = a.packet("une ancienne commande");
            await server.kill(); // No graceful close or in-memory state shared with the new process.
            for (const socket of sockets) socket.disconnect();
            await server.start(uri);
            const directoryResponse = await fetch(
              server.base + "/dessin/api/rooms",
              {
                headers: { Cookie: identities[0].cookie },
              },
            );
            assert.equal(directoryResponse.status, 200);
            const directory: unknown = await directoryResponse.json();
            assert.ok(
              Array.isArray(directory) &&
                directory.some(
                  (entry: { name: string }) => entry.name === "Salon durable",
                ),
            );
            const restored = await Promise.all(
              identities.map((identity) =>
                player(server.base, identity.cookie),
              ),
            );
            sockets.push(...restored.map((connection) => connection.socket));
            for (const connection of restored)
              await connection.emit("join", "Salon durable");
            const after = await wait(restored[0].read, (s) =>
              s.players.every((p) => p.connected),
            );
            assert.equal(after.players.length, 3);
            assert.equal(after.host, before.host);
            assert.deepEqual(
              after.players.map((p) => p.score),
              before.players.map((p) => p.score),
            );
            assert.equal(
              after.phase,
              phase === "finished" ? "finished" : "waiting",
            );
            assert.equal(after.deadline, 0);
            assert.equal(after.drawer, "");
            assert.notEqual(after.turn, before.turn);
            assert.deepEqual(after.history, before.history);
            assert.ok(
              after.messages.some((message) =>
                /Le serveur a redémarré/.test(message.text),
              ),
            );
            assert.equal(after.choices, undefined);
            assert.equal((await restored[0].raw("chat", stale)).ok, false);
            assert.equal(
              (
                await restored[0].raw("chat", {
                  ...restored[0].packet("tour périmé"),
                  turn: before.turn,
                })
              ).ok,
              false,
            );
            assert.equal(
              (await restored[1].emit("guess", before.word || "chat")).ok,
              false,
            );
            if (phase === "drawing") {
              assert.equal(after.players[0].score, 50);
              assert.ok(after.players[1].score >= 100);
              assert.equal(after.gallery.length, 1);
            }
            // Concurrent takeover after recovery preserves exactly one seat and
            // rejects old disconnects; moving rooms deletes the original seat.
            const duplicate = await player(server.base, identities[0].cookie);
            const duplicate2 = await player(server.base, identities[0].cookie);
            sockets.push(duplicate.socket, duplicate2.socket);
            const joins = await Promise.all([
              duplicate.emit("join", "Salon durable"),
              duplicate2.emit("join", "Salon durable"),
            ]);
            assert.ok(joins.every((result) => result.ok));
            const active = duplicate.socket.connected ? duplicate : duplicate2;
            assert.equal((await active.emit("join", "Salon suivant")).ok, true);
            await wait(restored[1].read, (s) => s.players.length === 2);
            await server.kill();
            await server.start(uri);
            const final = await player(server.base, identities[0].cookie);
            sockets.push(final.socket);
            await final.emit("directory", null);
            const rooms = await fetch(server.base + "/dessin/api/rooms", {
              headers: { Cookie: identities[0].cookie },
            });
            const entries: Array<{
              name: string;
              current: boolean;
              count: number;
            }> = (await rooms.json()) as Array<{
              name: string;
              current: boolean;
              count: number;
            }>;
            assert.equal(entries.filter((room) => room.current).length, 1);
            assert.equal(
              entries.find((room) => room.current)?.name,
              "Salon suivant",
            );
            assert.equal(
              entries.find((room) => room.name === "Salon durable")?.count,
              2,
            );
          } finally {
            for (const socket of sockets) socket.disconnect();
            await server.kill();
          }
        });
      }
    } finally {
      await database.stop();
    }
  },
);

test(
  "bail fenced : deux processus pendant plus de 60 s, ancien moteur vivant, snapshots bornés et panne Mongo",
  { timeout: 120000 },
  async () => {
    const database = await MongoMemoryServer.create();
    const uri = database.getUri("lease_handoff");
    const first = new ServerProcess(),
      second = new ServerProcess(),
      third = new ServerProcess();
    const sockets: Socket[] = [];
    let native = await new mongoose.mongo.MongoClient(uri).connect();
    try {
      await first.start(uri);
      const identities = await Promise.all([
        guest(first.base, "Hôte bail"),
        guest(first.base, "Ami bail"),
        guest(first.base, "Témoin bail"),
      ]);
      const connections = await Promise.all(
        identities.map((entry) => player(first.base, entry.cookie)),
      );
      sockets.push(...connections.map((entry) => entry.socket));
      for (const connection of connections)
        await connection.emit("join", "Salon fenced");
      const [a, b, c] = connections;
      const waiting = await wait(a.read, (state) => state.players.length === 3);
      const snapshots = native
        .db()
        .collection<{ _id: string; state: Snapshot; expiresAt: Date }>(
          "dessin_room_snapshots",
        );
      const manifests = native
        .db()
        .collection<{ _id: string; owner: string }>("dessin_runtime");
      assert.equal(await snapshots.countDocuments(), 1);
      await snapshots.insertMany(
        [1, 2, 3].map((id) => ({
          _id: "orphan-" + id,
          state: waiting,
          expiresAt: new Date(Date.now() + 86400000),
        })),
      );
      await second.start(uri, 30000, false);
      const infra = await fetch(second.base + "/health");
      assert.equal(infra.status, 200);
      assert.equal(((await infra.json()) as { game: string }).game, "waiting");
      assert.equal(
        (await fetch(second.base + "/dessin/api/health")).status,
        503,
      );
      const denied = await fetch(second.base + "/dessin/api/rooms", {
        headers: { Cookie: identities[0].cookie },
      });
      assert.equal(denied.status, 503);
      assert.match(
        ((await denied.json()) as { error: string }).error,
        /reprend les salons/,
      );
      await assert.rejects(
        player(second.base, identities[0].cookie),
        /reprend les salons/,
      );
      // Render can keep the former process alive for 60 seconds after promotion.
      // The HTTP probe stays promotable; the waiting process never starts a game.
      await new Promise((resolve) => setTimeout(resolve, 62000));
      assert.equal(
        (await fetch(first.base + "/dessin/api/health")).status,
        200,
      );
      assert.equal((await fetch(second.base + "/health")).status, 200);
      assert.equal(
        (await fetch(second.base + "/dessin/api/health")).status,
        503,
      );
      const ownerBefore = (await manifests.findOne({ _id: "hub" }))?.owner;
      await a.emit("start", { rounds: 1, seconds: 30 });
      const word = (await wait(a.read, (state) => state.phase === "choosing"))
        .choices?.[0];
      assert.ok(word);
      await a.emit("choose", word);
      await wait(a.read, (state) => state.phase === "drawing");
      for (let i = 0; i < 40; i++)
        assert.equal(
          (
            await a.emit("draw", {
              id: "bounded-" + i,
              x: 0.5,
              y: 0.5,
              px: 0.1,
              py: 0.1,
              width: 5,
              color: "#1f3b63",
            })
          ).ok,
          true,
        );
      assert.equal(
        await snapshots.countDocuments({
          _id: { $nin: ["orphan-1", "orphan-2", "orphan-3"] },
        }),
        1,
      );
      await b.emit("guess", word);
      const before = await wait(a.read, (state) => state.players[1].guessed);
      assert.equal(before.players[0].score, 50);
      first.child?.kill("SIGSTOP"); // The old process is still alive, but cannot renew its lease.
      const late = c.emit("guess", word).catch(() => ({ ok: false }));
      const until = Date.now() + 5000;
      while (
        Date.now() < until &&
        !(await fetch(second.base + "/dessin/api/health")).ok
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        (await fetch(second.base + "/dessin/api/health")).status,
        200,
      );
      assert.notEqual(
        (await manifests.findOne({ _id: "hub" }))?.owner,
        ownerBefore,
      );
      first.child?.kill("SIGCONT");
      assert.equal((await late).ok, false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal((await fetch(first.base + "/health")).status, 200);
      assert.equal(
        (await fetch(first.base + "/dessin/api/health")).status,
        503,
      );
      assert.equal(
        connections.every((entry) => !entry.socket.connected),
        true,
      );
      const restored = await Promise.all(
        identities.map((entry) => player(second.base, entry.cookie)),
      );
      sockets.push(...restored.map((entry) => entry.socket));
      for (const connection of restored)
        await connection.emit("join", "Salon fenced");
      const after = await wait(restored[0].read, (state) =>
        state.players.every((entry) => entry.connected),
      );
      assert.equal(after.phase, "waiting");
      assert.equal(after.players.length, 3);
      assert.deepEqual(
        after.players.map((entry) => entry.score),
        before.players.map((entry) => entry.score),
      );
      assert.equal(after.history.length, 40);
      assert.equal(after.gallery.length, 1);
      assert.equal(await snapshots.countDocuments(), 1);
      assert.equal(await snapshots.indexExists("expiresAt_1"), true);
      // A real Mongo shutdown stops the engine. A new process after Mongo's
      // restart reads only the published state and cannot add a second bonus.
      await native.close();
      await database.stop({ doCleanup: false });
      const lossUntil = Date.now() + 10000;
      while (
        Date.now() < lossUntil &&
        restored.some((entry) => entry.socket.connected)
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        restored.every((entry) => !entry.socket.connected),
        true,
      );
      assert.equal(
        (await fetch(second.base + "/dessin/api/health")).status,
        503,
      );
      assert.equal((await fetch(second.base + "/health")).status, 503);
      await database.start(true);
      native = await new mongoose.mongo.MongoClient(uri).connect();
      await third.start(uri);
      const final = await player(third.base, identities[0].cookie);
      sockets.push(final.socket);
      await final.emit("join", "Salon fenced");
      const finalState = await wait(
        final.read,
        (state) => state.players.length === 3,
      );
      assert.deepEqual(
        finalState.players.map((entry) => entry.score),
        before.players.map((entry) => entry.score),
      );
      assert.equal(finalState.gallery.length, 1);
      assert.equal(
        await native.db().collection("dessin_room_snapshots").countDocuments(),
        1,
      );
    } finally {
      first.child?.kill("SIGCONT");
      for (const socket of sockets) socket.disconnect();
      await Promise.all([first.kill(), second.kill(), third.kill()]);
      await native.close();
      await database.stop();
    }
  },
);
