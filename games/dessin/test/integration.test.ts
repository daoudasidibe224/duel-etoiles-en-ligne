import { GameRoom } from "../server/game";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { io as client, type Socket } from "socket.io-client";
import { z } from "zod";
import { createHost, type Host } from "./fixtures/host";
import {
  readySchema,
  directorySchema,
  sessionSchema,
  resultSchema,
  snapshotSchema,
  type Snapshot,
} from "../shared/contracts";
let database: MongoMemoryServer, application: Host, base: string;
const sockets: Socket[] = [];
const connections = new WeakMap<
  Socket,
  { epoch: string; sequence: number; turn: string }
>();
before(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
  application = createHost({
    timing: {
      countdownMs: 0,
      chooseMs: 30000,
      drawMs: 30000,
      revealMs: 10000,
      graceMs: 1000,
    },
  });
  await application.rooms.ready;
  await new Promise<void>((resolve) =>
    application.server.listen(0, "127.0.0.1", resolve),
  );
  const address = application.server.address();
  assert.ok(address && typeof address === "object");
  base = "http://127.0.0.1:" + address.port;
});
after(async () => {
  for (const socket of sockets) socket.disconnect();
  await application.close();
  if ("close" in application.store) await application.store.close();
  await mongoose.disconnect();
  await database.stop();
});
function cookieOf(response: request.Response) {
  const cookies: unknown = response.headers["set-cookie"];
  assert.ok(Array.isArray(cookies) && typeof cookies[0] === "string");
  return cookies[0].split(";")[0];
}
async function identityOf(agent: ReturnType<typeof request.agent>) {
  return sessionSchema.parse(
    (await agent.get("/dessin/api/session").expect(200)).body,
  );
}
// Accounts and guests are created by the host site, never by the game.
async function account(name: string, email: string) {
  const agent = request.agent(application.app);
  const response = await agent
    .post("/test/login")
    .send({ name, email })
    .expect(200);
  const current = await identityOf(agent);
  assert.ok(current.user);
  assert.equal(current.kind, "account");
  return { agent, cookie: cookieOf(response), user: current.user };
}
async function guestAccount(name: string, ttlMs?: number) {
  const agent = request.agent(application.app);
  const response = await agent
    .post("/test/guest")
    .send({ name, ttlMs })
    .expect(200);
  const current = await identityOf(agent);
  assert.ok(current.user);
  assert.equal(current.kind, "guest");
  return { agent, cookie: cookieOf(response), user: current.user };
}
async function sessionId(agent: ReturnType<typeof request.agent>) {
  return z
    .object({ sid: z.string() })
    .parse((await agent.get("/test/sid").expect(200)).body).sid;
}
async function socket(cookie?: string) {
  const socket = client(base + "/dessin", {
    transports: ["websocket"],
    autoConnect: false,
    extraHeaders: cookie ? { Cookie: cookie } : {},
  });
  sockets.push(socket);
  const ready = new Promise<void>((resolve, reject) => {
    socket.once("ready", (data: unknown) => {
      connections.set(socket, {
        epoch: readySchema.parse(data).epoch,
        sequence: 0,
        turn: "",
      });
      resolve();
    });
    socket.on("snapshot", (data: unknown) => {
      const state = connections.get(socket);
      if (state) state.turn = snapshotSchema.parse(data).turn;
    });
    socket.once("connect_error", reject);
  });
  socket.connect();
  await ready;
  return socket;
}
function packet(socket: Socket, data: unknown) {
  const state = connections.get(socket);
  assert.ok(state);
  return {
    epoch: state.epoch,
    sequence: ++state.sequence,
    turn: state.turn,
    data,
  };
}
function emit(socket: Socket, event: string, data: unknown) {
  return raw(socket, event, packet(socket, data));
}
function raw(socket: Socket, event: string, data: unknown) {
  return new Promise<z.infer<typeof resultSchema>>((resolve, reject) =>
    socket
      .timeout(3000)
      .emit(event, data, (error: Error | null, result: unknown) =>
        error ? reject(error) : resolve(resultSchema.parse(result)),
      ),
  );
}
function tracker(socket: Socket) {
  let snapshot: Snapshot | undefined;
  socket.on("snapshot", (data: unknown) => {
    snapshot = snapshotSchema.parse(data);
  });
  return () => snapshot;
}
async function waitFor<T>(
  read: () => T | undefined,
  predicate: (value: T) => boolean,
) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const value = read();
    if (value && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("État attendu non reçu.");
}
test("identité commune : session du site seule autorité, pages, ressources et aucune donnée sensible", async () => {
  const anonymous = await identityOf(request.agent(application.app));
  assert.deepEqual(anonymous, { user: null, kind: null, logout: null });
  await request(application.app).get("/dessin/api/rooms").expect(401);
  const visitor = await guestAccount("Camille");
  assert.match(visitor.user.id, /^guest:[0-9a-f]{24}$/);
  const raw = (await visitor.agent.get("/dessin/api/session").expect(200)).body;
  assert.deepEqual(Object.keys(raw).sort(), ["kind", "logout", "user"]);
  assert.equal(
    JSON.stringify(raw).includes(visitor.cookie.split("=")[1]),
    false,
  );
  await visitor.agent
    .post("/test/guest")
    .send({ name: "Camille bis" })
    .expect(200);
  const renamed = await identityOf(visitor.agent);
  assert.equal(renamed.user?.id, visitor.user.id);
  assert.equal(renamed.user?.name, "Camille bis");
  const alice = await account("Alice", "alice@example.fr");
  assert.match(alice.user.id, /^account:[0-9a-f]{24}$/);
  assert.notEqual(alice.user.id, visitor.user.id);
  const again = await account("Alice", "alice@example.fr");
  assert.equal(again.user.id, alice.user.id);
  const page = await request(application.app)
    .get("/dessin/lobby")
    .expect(200)
    .expect("Content-Type", /html/);
  assert.match(page.text, /\/dessin\/assets\/app\.js/);
  assert.match(page.text, /href="\/"/);
  await request(application.app).get("/dessin/room?room=Salon").expect(200);
  await request(application.app)
    .get("/dessin")
    .expect(302)
    .expect("Location", "/dessin/lobby");
  await request(application.app)
    .get("/dessin/assets/style.css")
    .expect(200)
    .expect("Content-Type", /css/);
  await request(application.app)
    .get("/dessin/assets/fonts/NunitoSans-Variable.ttf")
    .expect(200);
  const missing = await request(application.app)
    .get("/dessin/api/inconnu")
    .expect(404);
  assert.equal(typeof missing.body.error, "string");
  await request(application.app)
    .get("/dessin/server/integration.ts")
    .expect(404);
  await request(application.app)
    .get("/dessin/assets/../server/sockets.ts")
    .expect(404);
  await request(application.app).get("/dessin/api/health").expect(200);
  const restarted = createHost({ store: application.store });
  try {
    const persisted = sessionSchema.parse(
      (
        await request(restarted.app)
          .get("/dessin/api/session")
          .set("Cookie", alice.cookie)
          .expect(200)
      ).body,
    );
    assert.equal(persisted.user?.id, alice.user.id);
  } finally {
    await restarted.close();
  }
  const collections = (
    await mongoose.connection.db?.listCollections().toArray()
  )
    ?.map((entry) => entry.name)
    .sort();
  assert.ok(collections?.includes("dessin_runtime"));
  assert.equal(collections?.includes("users"), false);
  assert.equal(collections?.includes("guests"), false);
  assert.deepEqual(mongoose.modelNames(), []);
});
test("Socket.IO refuse les comptes absents et les origines étrangères", async () => {
  await assert.rejects(socket(), /Choisissez un pseudo/);
  // The host refuses foreign origins before the drawing namespace runs.
  const visitor = await guestAccount("Origine");
  const bad = client(base + "/dessin", {
    transports: ["websocket"],
    extraHeaders: {
      Origin: "https://malicious.example",
      Cookie: visitor.cookie,
    },
    reconnection: false,
    timeout: 1000,
  });
  sockets.push(bad);
  await assert.rejects(
    new Promise((resolve, reject) => {
      bad.once("connect", () => resolve(undefined));
      bad.once("connect_error", reject);
    }),
  );
});
test("salons isolés, identité serveur, mots, dessin, score, reconnexion et révocation", async () => {
  const alice = await account("Dessinateur", "drawer@example.fr"),
    bob = await account("Devineur", "guesser@example.fr"),
    charlie = await account("Autre", "other@example.fr");
  const a = await socket(alice.cookie),
    b = await socket(bob.cookie),
    c = await socket(charlie.cookie);
  const readA = tracker(a),
    readB = tracker(b),
    readC = tracker(c);
  assert.equal(
    (await emit(a, "join", { name: "Spoof", room: "Salon" })).ok,
    false,
  );
  assert.equal((await emit(a, "join", "Salon bleu")).ok, true);
  await emit(b, "join", "Salon bleu");
  await emit(c, "join", "Salon vert");
  const first = await waitFor(readB, (state) => state.players.length === 2);
  assert.equal(first.players[0].name, "Dessinateur");
  assert.equal(
    (await waitFor(readC, (state) => state.players.length === 1)).players
      .length,
    1,
  );
  assert.equal((await emit(b, "start", { rounds: 1, seconds: 30 })).ok, false);
  assert.equal((await emit(a, "start", { rounds: 100, seconds: 0 })).ok, false);
  await emit(a, "start", { rounds: 1, seconds: 30 });
  const choice = await waitFor(
    readA,
    (state) => state.phase === "choosing" && !!state.choices,
  );
  const word = choice.choices?.[0];
  assert.ok(word);
  assert.equal(
    (await waitFor(readB, (state) => state.phase === "choosing")).choices,
    undefined,
  );
  await emit(a, "choose", word);
  const hidden = await waitFor(readB, (state) => state.phase === "drawing");
  assert.equal(hidden.word, undefined);
  assert.ok(hidden.hint.includes("_"));
  const stroke = {
    id: "pointer",
    x: 0.3,
    y: 0.4,
    px: 0.2,
    py: 0.3,
    color: "#1f3b63",
    width: 10,
  };
  assert.equal((await emit(b, "draw", stroke)).ok, false);
  assert.equal((await emit(a, "draw", { ...stroke, x: 999 })).ok, false);
  const drawn = new Promise<unknown>((resolve) => b.once("stroke", resolve));
  await emit(a, "draw", stroke);
  assert.deepEqual(await drawn, stroke);
  assert.equal((await emit(b, "undo", null)).ok, false);
  await emit(a, "undo", null);
  await waitFor(readB, (state) => state.history.length === 0);
  await emit(a, "draw", stroke);
  b.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const reconnect = await socket(bob.cookie),
    readReconnect = tracker(reconnect);
  await emit(reconnect, "join", "Salon bleu");
  const restored = await waitFor(
    readReconnect,
    (state) => state.history.length === 1,
  );
  assert.equal(restored.players.length, 2);
  await emit(reconnect, "guess", word);
  const reveal = await waitFor(
    readReconnect,
    (state) => state.phase === "reveal",
  );
  assert.equal(reveal.word, word);
  assert.ok(
    (reveal.players.find((player) => player.id === bob.user.id)?.score || 0) >=
      100,
  );
  assert.equal(
    reveal.players.find((player) => player.id === alice.user.id)?.score,
    50,
  );
  assert.equal(readC()?.phase, "waiting");
  const loggedOut = new Promise<void>((resolve) =>
    a.once("disconnect", () => resolve()),
  );
  await alice.agent.post("/test/logout").send({}).expect(200);
  await loggedOut;
  await assert.rejects(socket(alice.cookie), /Choisissez un pseudo/);
});

test("un compte : reprise exclusive, commandes répétées/désordonnées, score unique et départ idempotent", async () => {
  const host = await account("Unique hôte", "unique-host@example.fr"),
    guest = await account("Unique invité", "unique-guest@example.fr");
  const original = await socket(host.cookie),
    b = await socket(guest.cookie);
  const readB = tracker(b);
  await emit(original, "join", "Salon unique");
  await emit(b, "join", "Salon unique");
  const first = await waitFor(readB, (state) => state.players.length === 2),
    initialMessages = first.messages.length;
  const replacement = await socket(host.cookie);
  const readA = tracker(replacement);
  const lost = new Promise<void>((resolve) =>
    original.once("disconnect", () => resolve()),
  );
  await emit(replacement, "join", "Salon unique");
  await lost;
  await emit(replacement, "join", "Salon unique");
  const unique = await waitFor(readA, (state) => state.players.length === 2);
  assert.equal(unique.messages.length, initialMessages);
  assert.equal(unique.host, host.user.id);
  assert.ok(unique.players.every((player) => player.connected));
  const start = packet(replacement, { rounds: 1, seconds: 30 });
  assert.equal((await raw(replacement, "start", start)).ok, true);
  assert.equal((await raw(replacement, "start", start)).ok, true);
  const choice = await waitFor(readA, (state) => state.phase === "choosing");
  assert.equal(choice.round, 1);
  assert.equal(
    (await raw(replacement, "chat", { ...start, data: "altéré" })).ok,
    false,
  );
  assert.equal((await raw(replacement, "start", start)).ok, true);
  const word = choice.choices?.[0];
  assert.ok(word);
  const choose = packet(replacement, word);
  await raw(replacement, "choose", choose);
  const drawing = await waitFor(readA, (state) => state.phase === "drawing");
  await raw(replacement, "choose", choose);
  assert.equal(readA()?.deadline, drawing.deadline);
  const stroke = {
    id: "unique-line",
    x: 0.4,
    y: 0.4,
    px: 0.2,
    py: 0.2,
    color: "#1f3b63",
    width: 10,
  };
  const draw = packet(replacement, stroke);
  await raw(replacement, "draw", draw);
  await raw(replacement, "draw", draw);
  assert.equal(application.rooms.rooms.get("Salon unique")?.history.length, 1);
  const message = packet(b, "une seule idée");
  await raw(b, "guess", message);
  await raw(b, "guess", message);
  const once = await waitFor(readB, (state) =>
    state.messages.some((item) => item.text === "une seule idée"),
  );
  assert.equal(
    once.messages.filter((item) => item.text === "une seule idée").length,
    1,
  );
  const state = connections.get(b);
  assert.ok(state);
  const old = { ...packet(b, "trop ancien"), sequence: 0 };
  assert.equal((await raw(b, "chat", old)).ok, false);
  const past = {
    ...packet(b, "ancienne connexion"),
    epoch: connections.get(original)?.epoch,
  };
  assert.equal((await raw(b, "chat", past)).ok, false);
  // Rate window ends before sending the winning answer.
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const guess = packet(b, word);
  await raw(b, "guess", guess);
  await raw(b, "guess", guess);
  const reveal = await waitFor(readB, (s) => s.phase === "reveal");
  assert.equal(reveal.players.find((p) => p.id === host.user.id)?.score, 50);
  assert.equal(
    reveal.messages.filter(
      (item) => item.text === "Unique invité a trouvé le mot !",
    ).length,
    1,
  );
  const points = reveal.players.find((p) => p.id === guest.user.id)?.score;
  assert.ok(points && points >= 100);
  // A connection in another tab takes over the drawing and scores without resetting them.
  const next = await socket(host.cookie),
    readNext = tracker(next);
  await emit(next, "join", "Salon unique");
  const resumed = await waitFor(readNext, (s) => s.phase === "reveal");
  assert.equal(resumed.history.length, 1);
  assert.equal(resumed.players.find((p) => p.id === host.user.id)?.score, 50);
  assert.equal(resumed.players.length, 2);
  assert.ok(resumed.players.every((p) => p.connected));
  const leave = packet(next, null);
  await raw(next, "leave", leave);
  await raw(next, "leave", leave);
  await emit(next, "leave", null);
  const remaining = await waitFor(readB, (s) => s.players.length === 1);
  assert.equal(remaining.host, guest.user.id);
  assert.equal(
    remaining.messages.filter(
      (item) => item.text === "Unique hôte quitte le salon.",
    ).length,
    1,
  );
  assert.equal((await emit(next, "chat", "absent")).ok, false);
  assert.equal(
    (
      await raw(b, "chat", {
        ...packet(b, "tour périmé"),
        turn: choice.turn + "-old",
      })
    ).ok,
    false,
  );
  await emit(b, "leave", null);
  assert.equal(application.rooms.rooms.has("Salon unique"), false);
});

test("deux sockets simultanés, un seul salon, reconnexion et expiration sans départ doublé", async () => {
  const owner = await account("Multionglet", "multi@example.fr"),
    friend = await account("Ami", "multi-friend@example.fr");
  const a = await socket(owner.cookie),
    duplicate = await socket(owner.cookie),
    b = await socket(friend.cookie);
  const readB = tracker(b);
  await emit(b, "join", "Salon simultané");
  await Promise.allSettled([
    emit(a, "join", "Salon simultané"),
    emit(duplicate, "join", "Salon simultané"),
  ]);
  await waitFor(readB, (s) => s.players.length === 2);
  assert.equal(application.rooms.rooms.get("Salon simultané")?.players.size, 2);
  const active = a.connected ? a : duplicate;
  assert.ok(active.connected);
  await emit(active, "join", "Autre salon unique");
  assert.equal(application.rooms.rooms.get("Salon simultané")?.players.size, 1);
  assert.equal(
    application.rooms.rooms.get("Autre salon unique")?.players.size,
    1,
  );
  active.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const restored = await socket(owner.cookie);
  const readRestored = tracker(restored);
  await emit(restored, "join", "Autre salon unique");
  await waitFor(
    readRestored,
    (s) => s.players.length === 1 && s.players[0].connected,
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(
    application.rooms.rooms.get("Autre salon unique")?.players.size,
    1,
  );
  restored.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(application.rooms.rooms.has("Autre salon unique"), false);
  assert.equal(application.rooms.rooms.get("Salon simultané")?.players.size, 1);
  await emit(b, "leave", null);
});

test("salon plein ou partie en cours : refus conserve la place actuelle, changement transfère l’hôte", async () => {
  const owners = [];
  for (let i = 0; i < 11; i++)
    owners.push(await account("Joueur " + i, `full-${i}@example.fr`));
  const clients = [];
  for (const owner of owners) clients.push(await socket(owner.cookie));
  for (let i = 0; i < 10; i++) await emit(clients[i], "join", "Salon complet");
  await emit(clients[10], "join", "Place conservée");
  assert.equal((await emit(clients[10], "join", "Salon complet")).ok, false);
  assert.equal(application.rooms.rooms.get("Salon complet")?.players.size, 10);
  assert.ok(
    application.rooms.rooms
      .get("Place conservée")
      ?.players.has(owners[10].user.id),
  );
  const lastRead = tracker(clients[9]);
  await emit(clients[0], "start", { rounds: 1, seconds: 30 });
  await waitFor(lastRead, (s) => s.phase === "choosing");
  assert.equal((await emit(clients[9], "leave", null)).ok, true);
  assert.equal((await emit(clients[10], "join", "Salon complet")).ok, false);
  assert.ok(
    application.rooms.rooms
      .get("Place conservée")
      ?.players.has(owners[10].user.id),
  );
  const obsolete = packet(clients[0], null);
  await emit(clients[0], "join", "Nouveau salon");
  assert.equal(
    application.rooms.rooms.get("Salon complet")?.host,
    owners[1].user.id,
  );
  assert.equal(application.rooms.rooms.get("Salon complet")?.players.size, 8);
  const delayed = { ...obsolete, sequence: packet(clients[0], null).sequence };
  assert.equal((await raw(clients[0], "leave", delayed)).ok, false);
  assert.ok(
    application.rooms.rooms
      .get("Nouveau salon")
      ?.players.has(owners[0].user.id),
  );
  for (const socket of clients) await emit(socket, "leave", null);
});

test("formes et rétablissement validés, reprise même compte et carnet révélé une seule fois", async () => {
  const host = await account("Formes", "shapes@example.fr"),
    guest = await account("Réponses", "shapes-guest@example.fr");
  const a = await socket(host.cookie),
    b = await socket(guest.cookie),
    readA = tracker(a),
    readB = tracker(b);
  await emit(a, "join", "Formes et carnet");
  await emit(b, "join", "Formes et carnet");
  await waitFor(readA, (state) => state.players.length === 2);
  await emit(a, "start", { rounds: 1, seconds: 30 });
  const chosen = await waitFor(readA, (state) => state.phase === "choosing");
  const word = chosen.choices?.[0];
  assert.ok(word);
  await emit(a, "choose", word);
  await waitFor(readB, (state) => state.phase === "drawing");
  assert.equal(readB()?.gallery.length, 0);
  const shape = {
    id: "rectangle",
    shape: "rectangle",
    x: 0.7,
    y: 0.8,
    px: 0.2,
    py: 0.3,
    color: "#4c966f",
    width: 12,
  };
  assert.equal((await emit(b, "draw", shape)).ok, false);
  assert.equal(
    (await emit(a, "draw", { ...shape, shape: "triangle" })).ok,
    false,
  );
  assert.equal((await emit(a, "draw", shape)).ok, true);
  await emit(a, "undo", null);
  await waitFor(readA, (state) => state.canRedo);
  assert.equal((await emit(b, "redo", null)).ok, false);
  const redo = packet(a, null);
  await raw(a, "redo", redo);
  await raw(a, "redo", redo);
  await waitFor(readA, (state) => state.history.length === 1);
  assert.equal(
    application.rooms.rooms.get("Formes et carnet")?.history.length,
    1,
  );
  const replacement = await socket(host.cookie),
    readReplacement = tracker(replacement);
  await emit(replacement, "join", "Formes et carnet");
  const resumed = await waitFor(
    readReplacement,
    (state) => state.history.length === 1,
  );
  assert.equal(resumed.players.length, 2);
  assert.equal(resumed.history[0].shape, "rectangle");
  assert.equal(resumed.canUndo, true);
  assert.equal((await emit(b, "skip", null)).ok, false);
  const skip = packet(replacement, null);
  await raw(replacement, "skip", skip);
  await raw(replacement, "skip", skip);
  const ended = await waitFor(readB, (state) => state.phase === "reveal");
  assert.equal(ended.gallery.length, 1);
  assert.equal(ended.gallery[0].word, word);
  assert.deepEqual(ended.gallery[0].history, [shape]);
  assert.equal(
    ended.players.find((player) => player.id === guest.user.id)?.score,
    0,
  );
  assert.equal(ended.gallery[0].id, chosen.turn);
  assert.equal((await emit(replacement, "redo", null)).ok, false);
  assert.equal((await emit(replacement, "draw", shape)).ok, false);
  await emit(replacement, "leave", null);
  await emit(b, "leave", null);
});

test("invités vrais WS : reprise unique, commandes dupliquées/périmées, pseudo stable, conversion et anciens accès révoqués", async () => {
  const visitor = await guestAccount("Invité WS"),
    friend = await account("Ami invité", "guest-friend@example.fr");
  const first = await socket(visitor.cookie),
    second = await socket(visitor.cookie),
    b = await socket(friend.cookie);
  const name = "Invités serveur";
  await Promise.all([emit(first, "join", name), emit(second, "join", name)]);
  await emit(b, "join", name);
  const current = application.rooms.rooms.get(name);
  assert.ok(current);
  assert.equal(current.players.size, 2);
  const active = first.connected ? first : second;
  const duplicate = packet(active, name);
  assert.equal((await raw(active, "join", duplicate)).ok, true);
  assert.equal((await raw(active, "join", duplicate)).ok, true);
  assert.equal(current.players.size, 2);
  await visitor.agent
    .post("/test/guest")
    .send({ name: "Nouveau crayon" })
    .expect(200);
  assert.equal(current.players.get(visitor.user.id)?.name, "Nouveau crayon");
  assert.equal((await identityOf(visitor.agent)).user?.id, visitor.user.id);
  await emit(active, "start", { rounds: 1, seconds: 30 });
  const choice = current.snapshot(visitor.user.id).choices?.[0];
  assert.ok(choice);
  await emit(active, "choose", choice);
  const chat = packet(b, choice);
  assert.equal((await raw(b, "guess", chat)).ok, true);
  assert.equal((await raw(b, "guess", chat)).ok, true);
  assert.equal(current.players.get(visitor.user.id)?.score, 50);
  const oldTurn = packet(active, null);
  oldTurn.turn = "expired";
  assert.equal((await raw(active, "clear", oldTurn)).ok, false);
  // Creating an account from a guest session revokes the guest place.
  await visitor.agent
    .post("/test/login")
    .send({ email: "converted@example.fr", name: "Converti" })
    .expect(200);
  assert.equal(current.players.has(visitor.user.id), false);
  assert.equal(current.players.size, 1);
  await assert.rejects(socket(visitor.cookie), /Choisissez un pseudo/);
  const fresh = await identityOf(visitor.agent);
  assert.equal(fresh.kind, "account");
  assert.notEqual(fresh.user?.id, visitor.user.id);
  const loginGuest = await guestAccount("Retour compte"),
    loginSocket = await socket(loginGuest.cookie);
  await emit(loginSocket, "join", "Conversion login");
  await loginGuest.agent
    .post("/test/login")
    .send({ email: "converted@example.fr" })
    .expect(200);
  assert.equal(application.rooms.rooms.has("Conversion login"), false);
  await assert.rejects(socket(loginGuest.cookie), /Choisissez un pseudo/);
  await emit(b, "leave", null);
});

test("sortie et expiration invités ferment la place immédiatement et refusent cookie/socket anciens", async () => {
  const visitor = await guestAccount("Sortie"),
    s = await socket(visitor.cookie);
  await emit(s, "join", "Sortie invitée");
  await visitor.agent.post("/test/logout").expect(200);
  assert.equal(application.rooms.rooms.has("Sortie invitée"), false);
  await assert.rejects(socket(visitor.cookie), /Choisissez un pseudo/);
  const expired = await guestAccount("Expire"),
    old = await socket(expired.cookie);
  await emit(old, "join", "Session expirée");
  const sid = await sessionId(expired.agent);
  await new Promise<void>((resolve, reject) =>
    application.store.destroy(sid, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  await assert.rejects(emit(old, "chat", "Interdit"));
  assert.equal(application.rooms.rooms.has("Session expirée"), false);
  await assert.rejects(socket(expired.cookie), /Choisissez un pseudo/);
  assert.equal((await identityOf(expired.agent)).user, null);
  // The host expiry date ends an idle socket without any command.
  const short = await guestAccount("Courte durée", 400),
    idle = await socket(short.cookie);
  const ended = new Promise<unknown>((resolve) =>
    idle.once("session-ended", resolve),
  );
  await emit(idle, "join", "Expiration sans commande");
  assert.match(String(await ended), /session/);
  await waitFor(
    () => (idle.connected ? undefined : true),
    () => true,
  );
  assert.equal(application.rooms.rooms.has("Expiration sans commande"), false);
});

test("rafale WS bornée : malformés, ancienne époque, file pleine, puis dessin autorisé", async () => {
  const visitor = await guestAccount("Rafale"),
    friend = await guestAccount("Crayon calme");
  const a = await socket(visitor.cookie),
    b = await socket(friend.cookie);
  await emit(a, "join", "Rafale bornée");
  await emit(b, "join", "Rafale bornée");
  await emit(a, "start", { rounds: 1, seconds: 30 });
  const current = application.rooms.rooms.get("Rafale bornée");
  assert.ok(current);
  const word = current.snapshot(visitor.user.id).choices?.[0];
  assert.ok(word);
  await emit(a, "choose", word);
  const wrongEpoch = packet(a, null);
  wrongEpoch.epoch = "00000000-0000-4000-8000-000000000000";
  const invalid = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      raw(a, "draw", i % 2 ? wrongEpoch : { forged: true }),
    ),
  );
  assert.ok(invalid.every((result) => !result.ok));
  assert.equal(current.history.length, 0);
  const burst = await Promise.all(
    Array.from({ length: 160 }, () => {
      const p = packet(a, null);
      p.turn = "obsolete";
      return raw(a, "clear", p);
    }),
  );
  assert.ok(burst.every((result) => !result.ok));
  assert.ok(burst.some((result) => result.error?.includes("en attente")));
  const stroke = {
    id: "valid-after-flood",
    x: 0.2,
    y: 0.2,
    px: 0.4,
    py: 0.5,
    width: 5,
    color: "#1f3b63",
  };
  assert.equal((await emit(a, "draw", stroke)).ok, true);
  assert.equal(current.history.length, 1);
  const replay = packet(a, stroke);
  assert.equal((await raw(a, "draw", replay)).ok, true);
  assert.equal((await raw(a, "draw", replay)).ok, true);
  assert.equal(current.history.length, 2);
  await emit(a, "leave", null);
  await emit(b, "leave", null);
});

test("handshake en attente après sortie : identité capturée ne peut jamais rejoindre", async () => {
  const visitor = await guestAccount("Handshake"),
    sid = await sessionId(visitor.agent);
  const original = application.rooms.authenticate.bind(application.rooms);
  let resume: () => void = () => {},
    signal: () => void = () => {};
  const held = new Promise<void>((resolve) => {
      resume = resolve;
    }),
    started = new Promise<void>((resolve) => {
      signal = resolve;
    });
  let pending = true;
  application.rooms.authenticate = async (incoming) => {
    const identity = await original(incoming);
    if (pending && "sessionID" in incoming && incoming.sessionID === sid) {
      pending = false;
      signal();
      await held;
    }
    return identity;
  };
  try {
    const connecting = socket(visitor.cookie);
    await started;
    await visitor.agent.post("/test/logout").expect(200);
    resume();
    const late = await connecting;
    await assert.rejects(emit(late, "join", "Jamais rejoint"));
    assert.equal(application.rooms.rooms.has("Jamais rejoint"), false);
    await assert.rejects(socket(visitor.cookie), /Choisissez un pseudo/);
  } finally {
    resume();
    application.rooms.authenticate = original;
  }
});

test("deux sessions même compte : logout ou login ancien ne retire jamais la place reprise", async () => {
  const owner = await account("Sessions", "sessions-takeover@example.fr"),
    friend = await guestAccount("Ami sessions");
  const old = await socket(owner.cookie),
    b = await socket(friend.cookie);
  await emit(old, "join", "Sessions indépendantes");
  await emit(b, "join", "Sessions indépendantes");
  const agent = request.agent(application.app);
  const response = await agent
    .post("/test/login")
    .send({ email: "sessions-takeover@example.fr" })
    .expect(200);
  const fresh = await socket(cookieOf(response));
  await emit(fresh, "join", "Sessions indépendantes");
  const current = application.rooms.rooms.get("Sessions indépendantes");
  assert.ok(current);
  assert.equal(current.players.size, 2);
  await emit(fresh, "start", { rounds: 1, seconds: 30 });
  const word = current.snapshot(owner.user.id).choices?.[0];
  assert.ok(word);
  await emit(fresh, "choose", word);
  await emit(b, "guess", word);
  assert.equal(current.players.get(owner.user.id)?.score, 50);
  await owner.agent.post("/test/logout").expect(200);
  assert.equal(fresh.connected, true);
  assert.equal(current.players.size, 2);
  assert.equal(current.players.get(owner.user.id)?.score, 50);
  assert.equal((await emit(fresh, "chat", "Encore ici")).ok, true);
  await assert.rejects(socket(owner.cookie), /Choisissez un pseudo/);
  const another = request.agent(application.app);
  await another
    .post("/test/login")
    .send({ email: "sessions-takeover@example.fr" })
    .expect(200);
  await another
    .post("/test/login")
    .send({ email: "sessions-takeover@example.fr" })
    .expect(200);
  assert.equal(current.players.size, 2);
  assert.equal(current.players.get(owner.user.id)?.score, 50);
  assert.equal(fresh.connected, true);
  await emit(fresh, "leave", null);
  await emit(b, "leave", null);
});

test("invité expiré : pseudo ne prolonge pas la durée, place libérée et nouvelle entrée ne récupère ni place ni points", async () => {
  const visitor = await guestAccount("Sept jours"),
    friend = await guestAccount("Ami expiry");
  const before = (await identityOf(visitor.agent)).user;
  await visitor.agent
    .post("/test/guest")
    .send({ name: "Nouveau pseudo" })
    .expect(200);
  assert.equal((await identityOf(visitor.agent)).user?.id, before?.id);
  const a = await socket(visitor.cookie),
    b = await socket(friend.cookie);
  await emit(a, "join", "Expiration fixe");
  await emit(b, "join", "Expiration fixe");
  await emit(a, "start", { rounds: 1, seconds: 30 });
  const room = application.rooms.rooms.get("Expiration fixe");
  assert.ok(room);
  const word = room.snapshot(visitor.user.id).choices?.[0];
  assert.ok(word);
  await emit(a, "choose", word);
  await emit(b, "guess", word);
  assert.equal(room.players.get(visitor.user.id)?.score, 50);
  await visitor.agent.post("/test/expire-guest").expect(200);
  assert.equal((await identityOf(visitor.agent)).user, null);
  await visitor.agent
    .post("/test/guest")
    .send({ name: "Repartir" })
    .expect(200);
  const fresh = await identityOf(visitor.agent);
  assert.ok(fresh.user);
  assert.notEqual(fresh.user.id, visitor.user.id);
  assert.equal(room.players.has(visitor.user.id), false);
  assert.equal(room.players.size, 1);
  const replacement = await socket(visitor.cookie);
  await emit(replacement, "join", "Expiration fixe");
  assert.equal(room.players.size, 2);
  assert.equal(room.players.get(fresh.user.id)?.score, 0);
  assert.equal(a.connected, false);
  await emit(replacement, "leave", null);
  await emit(b, "leave", null);
});

test("annuaire réel HTTP/WS, suivi des phases/capacités et réponses refusées hors manche", async () => {
  const host = await account("Annuaire hôte", "directory-host@example.fr"),
    friend = await account("Annuaire ami", "directory-friend@example.fr"),
    visitor = await account("Annuaire lecteur", "directory-read@example.fr");
  await request(application.app).get("/dessin/api/rooms").expect(401);
  const listing = await socket(visitor.cookie),
    a = await socket(host.cookie),
    b = await socket(friend.cookie);
  let entries: import("../shared/contracts").Directory | undefined;
  listing.on("directory", (data: unknown) => {
    entries = directorySchema.parse(data);
  });
  assert.equal((await emit(listing, "directory", null)).ok, true);
  assert.equal(
    [...application.rooms.rooms.values()].some((room) =>
      room.players.has(visitor.user.id),
    ),
    false,
  );
  const name = "Annuaire vivant";
  await emit(a, "join", name);
  await emit(b, "join", name);
  await waitFor(
    () => entries,
    (data) =>
      data.some(
        (room) => room.name === name && room.count === 2 && room.joinable,
      ),
  );
  const response = await request(application.app)
    .get("/dessin/api/rooms")
    .set("Cookie", visitor.cookie)
    .expect(200);
  assert.equal(
    directorySchema.parse(response.body).find((room) => room.name === name)
      ?.count,
    2,
  );
  assert.equal((await emit(b, "guess", "avant")).ok, false);
  assert.equal((await emit(b, "chat", "Bonjour")).ok, true);
  await emit(a, "start", { rounds: 1, seconds: 30 });
  await waitFor(
    () => entries,
    (data) =>
      data.some(
        (room) =>
          room.name === name && room.phase === "choosing" && !room.joinable,
      ),
  );
  assert.equal((await emit(b, "guess", "pendant choix")).ok, false);
  const current = application.rooms.rooms.get(name);
  assert.ok(current);
  const word = current.snapshot(host.user.id).choices?.[0];
  assert.ok(word);
  await emit(a, "choose", word);
  assert.equal((await emit(a, "guess", "n’importe quoi")).ok, false);
  assert.equal((await emit(b, "chat", word)).ok, false);
  const answer = packet(b, word);
  assert.equal((await raw(b, "guess", answer)).ok, true);
  assert.equal((await raw(b, "guess", answer)).ok, true);
  assert.equal(current.players.get(host.user.id)?.score, 50);
  assert.equal((await emit(b, "guess", word)).ok, false);
  await waitFor(
    () => entries,
    (data) =>
      data.some((room) => room.name === name && room.phase === "reveal"),
  );
  await emit(a, "leave", null);
  await emit(b, "leave", null);
  await waitFor(
    () => entries,
    (data) => !data.some((room) => room.name === name),
  );
  listing.disconnect();
});

test("vrais sockets : compte à rebours ferme les réponses/traits et le replay ne crée pas deux manches", async () => {
  const host = await guestAccount("Crayon départ"),
    friend = await guestAccount("Réponse départ");
  const name = "Départ contrôlé";
  const room = new GameRoom(name, () => application.rooms.broadcast(name), {
    countdownMs: 400,
    drawMs: 5000,
    revealMs: 5000,
  });
  application.rooms.rooms.set(name, room);
  const a = await socket(host.cookie),
    b = await socket(friend.cookie);
  const readA = tracker(a),
    readB = tracker(b);
  await emit(a, "join", name);
  await emit(b, "join", name);
  await emit(a, "start", { rounds: 1, seconds: 30 });
  const choosing = await waitFor(readA, (state) => state.phase === "choosing");
  const word = choosing.choices?.[0];
  assert.ok(word);
  const choose = packet(a, word);
  assert.equal((await raw(a, "choose", choose)).ok, true);
  await waitFor(readB, (state) => state.phase === "countdown");
  const deadline = room.deadline;
  assert.equal((await raw(a, "choose", choose)).ok, true);
  assert.equal(room.deadline, deadline);
  assert.equal((await emit(b, "guess", word)).ok, false);
  assert.equal(
    (
      await emit(a, "draw", {
        id: "early",
        x: 0.2,
        y: 0.2,
        px: 0.1,
        py: 0.1,
        color: "#1f3b63",
        width: 10,
      })
    ).ok,
    false,
  );
  assert.equal((await emit(b, "chat", word)).ok, false);
  assert.equal(room.history.length, 0);
  assert.equal(room.players.get(host.user.id)?.score, 0);
  const drawing = await waitFor(readA, (state) => state.phase === "drawing");
  assert.equal(drawing.word, word);
  const answer = packet(b, word);
  assert.equal((await raw(b, "guess", answer)).ok, true);
  assert.equal((await raw(b, "guess", answer)).ok, true);
  assert.equal(room.players.get(host.user.id)?.score, 50);
  assert.equal(room.gallery.length, 1);
  await emit(a, "leave", null);
  await emit(b, "leave", null);
});
