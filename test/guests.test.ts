import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import MongoStore from "connect-mongo";
import request from "supertest";
import { io as connect, type Socket } from "socket.io-client";
import { z } from "zod";
import { createApp } from "../src/app";
import User from "../src/models/Utilisateur";
import Score from "../src/models/Score";
import ChatMessage from "../src/models/ChatMessage";
import { roundSchema, gameRoomSchema } from "../shared/contracts";
let mongo: MongoMemoryServer,
  store: MongoStore,
  main: ReturnType<typeof createApp>;
const servers: ReturnType<typeof createApp>[] = [],
  clients: Socket[] = [];
const token = (html: string) => {
  const value = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(value);
  return value;
};
function event<T>(
  socket: Socket,
  name: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Événement absent : ${name}`)),
      5000,
    );
    socket.once(name, (...args: unknown[]) => {
      clearTimeout(timer);
      try {
        resolve(schema.parse(args[0]));
      } catch (error) {
        reject(error);
      }
    });
  });
}
async function start(
  options: {
    guestDurationMs?: number;
    sessionDurationMs?: number;
    gameOptions?: { durationMs?: number; reconnectMs?: number };
  } = {},
) {
  const instance = createApp({
    secret: "g".repeat(48),
    store,
    gameOptions: { durationMs: 600, reconnectMs: 200 },
    ...options,
  });
  await new Promise<void>((resolve) =>
    instance.server.listen(0, "127.0.0.1", resolve),
  );
  servers.push(instance);
  return instance;
}
function base(instance = main) {
  const value = instance.server.address();
  assert.ok(value && typeof value !== "string");
  return `http://127.0.0.1:${value.port}`;
}
async function socket(cookie: string, instance = main) {
  const client = connect(base(instance) + "/jeu", {
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie },
    forceNew: true,
  });
  clients.push(client);
  const id = event(client, "identity", z.string());
  await event(client, "connect", z.undefined());
  return { client, id: await id };
}
async function denied(cookie: string, instance = main) {
  const client = connect(base(instance) + "/jeu", {
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie },
    forceNew: true,
  });
  clients.push(client);
  const message = await event(client, "connect_error", z.instanceof(Error));
  client.disconnect();
  return message.message;
}
async function guest(name: string, instance = main) {
  const agent = request.agent(instance.app),
    page = await agent.get("/jouer");
  const response = await agent
    .post("/utilisateur/invite")
    .type("form")
    .send({
      _csrf: token(page.text),
      nomUtilisateur: name,
      id: "forged",
      userId: "forged",
    });
  assert.equal(response.status, 302);
  return { agent, cookie: response.headers["set-cookie"][0].split(";")[0] };
}
async function account(name: string, instance = main) {
  const agent = request.agent(instance.app),
    page = await agent.get("/inscription");
  const response = await agent
    .post("/utilisateur/inscription")
    .type("form")
    .send({
      _csrf: token(page.text),
      email: `${name}@example.test`,
      nomUtilisateur: name,
      mdp: "Password1234",
    });
  assert.equal(response.status, 302);
  return { agent, cookie: response.headers["set-cookie"][0].split(";")[0] };
}
async function open(agent: ReturnType<typeof request.agent>) {
  const page = await agent.get("/salon");
  const response = await agent
    .post("/salon/salonDeJeu/room")
    .type("form")
    .send({ _csrf: token(page.text) });
  assert.equal(response.status, 302);
  const id = response.headers.location.split("/").pop();
  assert.ok(id);
  return id;
}
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([User.init(), Score.init(), ChatMessage.init()]);
  store = MongoStore.create({ client: mongoose.connection.getClient() });
  main = await start();
});
after(async () => {
  clients.forEach((client) => client.disconnect());
  for (const instance of servers)
    await new Promise<void>((resolve) => instance.io.close(() => resolve()));
  await store.close();
  await mongoose.disconnect();
  await mongo.stop();
});

test("entrée invitée : validation, CSRF, identité serveur stable et aucune inscription", async () => {
  assert.equal(
    (
      await request(main.app)
        .post("/utilisateur/invite")
        .send({ nomUtilisateur: "guest" })
    ).status,
    403,
  );
  const agent = request.agent(main.app),
    page = await agent.get("/jouer"),
    csrf = token(page.text);
  assert.equal(
    (
      await agent
        .post("/utilisateur/invite")
        .type("form")
        .send({ _csrf: csrf, nomUtilisateur: "<script>" })
    ).status,
    422,
  );
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      agent
        .post("/utilisateur/invite")
        .type("form")
        .send({ _csrf: csrf, nomUtilisateur: "same_name", id: "victim" }),
    ),
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    Array(5).fill(302),
  );
  const cookie = responses[0]?.headers["set-cookie"][0].split(";")[0];
  assert.ok(cookie);
  const a = await socket(cookie),
    b = await socket(cookie);
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[a-f0-9]{24}$/);
  assert.notEqual(a.id, "victim");
  assert.equal(await User.countDocuments(), 0);
  const other = await guest("same_name"),
    c = await socket(other.cookie);
  assert.notEqual(a.id, c.id);
  assert.equal((await agent.get("/profil")).headers.location, "/connexion");
  assert.equal((await agent.get("/stats")).headers.location, "/connexion");
  const repeat = await agent.get("/salon");
  assert.match(repeat.text, /same_name/);
  assert.equal(
    (
      await agent
        .post("/utilisateur/invite")
        .type("form")
        .send({ _csrf: token(repeat.text), nomUtilisateur: "different" })
    ).status,
    409,
  );
  assert.match(await denied("run.sid=forged"), /nécessaire/);
  for (const value of [a, b, c]) value.client.disconnect();
});

test("invités : une place, reprise, salon plein, événements uniques et absence de score durable", async () => {
  const a = await guest("guest_owner"),
    b = await guest("guest_partner"),
    c = await guest("guest_outside");
  const room = await open(a.agent),
    another = await open(c.agent);
  const one = await socket(a.cookie),
    twin = await socket(a.cookie),
    two = await socket(b.cookie),
    outside = await socket(c.cookie);
  assert.equal(await one.client.emitWithAck("join", { room }), undefined);
  const replaced = event(one.client, "replaced", z.undefined());
  assert.equal(await twin.client.emitWithAck("join", { room }), undefined);
  await replaced;
  one.client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(main.app.salons[room]?.utilisateurs.length, 1);
  await Promise.all(
    Array.from({ length: 5 }, () => twin.client.emitWithAck("join", { room })),
  );
  assert.equal(main.app.salons[room]?.utilisateurs.length, 1);
  assert.match(
    await twin.client.emitWithAck("join", { room: another }),
    /actuel/,
  );
  await two.client.emitWithAck("join", { room });
  assert.match(await outside.client.emitWithAck("join", { room }), /complet/);
  const initialized = event(twin.client, "init", roundSchema);
  let starts = 0;
  two.client.on("init", () => starts++);
  for (let i = 0; i < 5; i++) twin.client.emit("startGame");
  const round = await initialized;
  const ended = event(twin.client, "roundEnded", gameRoomSchema);
  const bonus = {
    id: randomUUID(),
    roundId: round.id,
    kind: "multiplier",
    stage: 0,
  };
  assert.equal(
    await twin.client.emitWithAck("activateBonus", bonus),
    "Les bonus s’activent automatiquement en les ramassant.",
  );
  assert.equal(
    await twin.client.emitWithAck("activateBonus", bonus),
    "Les bonus s’activent automatiquement en les ramassant.",
  );
  const resume = await socket(b.cookie);
  await resume.client.emitWithAck("join", { room });
  two.client.disconnect();
  assert.equal(main.app.salons[room]?.utilisateurs.length, 2);
  assert.match(
    await outside.client.emitWithAck("score", {
      roundId: round.id,
      sequence: 1,
      starId: round.stars[0]?.id,
    }),
    /absent/,
  );
  await ended;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(starts, 1);
  assert.equal(
    await twin.client.emitWithAck("scoreFinDeJeu", { roundId: round.id }),
    undefined,
  );
  assert.equal(await Score.countDocuments({ matchId: round.id }), 0);
  assert.equal(await twin.client.emitWithAck("leave"), undefined);
  assert.equal(await twin.client.emitWithAck("leave"), undefined);
  assert.equal(main.app.salons[room], undefined);
  outside.client.disconnect();
  resume.client.disconnect();
  twin.client.disconnect();
});

test("passer d’invité à compte ferme l’ancienne place sans transfert ni rejeu autorisé", async () => {
  const owner = await guest("convert_owner"),
    partner = await guest("convert_partner");
  const room = await open(owner.agent);
  const a = await socket(owner.cookie),
    b = await socket(partner.cookie);
  await a.client.emitWithAck("join", { room });
  await b.client.emitWithAck("join", { room });
  const started = event(a.client, "init", roundSchema);
  a.client.emit("startGame");
  const round = await started;
  const form = await owner.agent.get("/inscription");
  const ended = event(a.client, "accessEnded", z.string());
  const signed = await owner.agent
    .post("/utilisateur/inscription")
    .type("form")
    .send({
      _csrf: token(form.text),
      email: "converted@example.test",
      mdp: "Password1234",
    });
  assert.equal(signed.status, 302);
  await ended;
  assert.equal(main.app.salons[room], undefined);
  assert.match(await denied(owner.cookie), /nécessaire/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await Score.countDocuments({ matchId: round.id }), 0);
  const cookie = signed.headers["set-cookie"][0].split(";")[0],
    fresh = await socket(cookie);
  assert.notEqual(fresh.id, a.id);
  const next = await open(owner.agent);
  await fresh.client.emitWithAck("join", { room: next });
  a.client.disconnect();
  assert.equal(main.app.salons[next]?.utilisateurs.length, 1);
  assert.equal(main.app.salons[next]?.utilisateurs[0]?.kind, "account");
  await fresh.client.emitWithAck("leave");
  fresh.client.disconnect();
  b.client.disconnect();
});

test("logout invité hors ligne révoque le cookie et libère immédiatement la place", async () => {
  const owner = await guest("logout_guest"),
    room = await open(owner.agent),
    ws = await socket(owner.cookie);
  await ws.client.emitWithAck("join", { room });
  ws.client.disconnect();
  const page = await owner.agent.get("/salon"),
    left = await owner.agent
      .post("/utilisateur/deconnexion")
      .type("form")
      .send({ _csrf: token(page.text) });
  assert.equal(left.headers.location, "/jouer");
  assert.equal(main.app.salons[room], undefined);
  assert.match(await denied(owner.cookie), /nécessaire/);
});

test("expiration invitée libère une place hors ligne et une identité restaurée depuis Mongo", async () => {
  const instance = await start({
      guestDurationMs: 1000,
      gameOptions: { durationMs: 600, reconnectMs: 5000 },
    }),
    owner = await guest("expiry_guest", instance),
    room = await open(owner.agent),
    ws = await socket(owner.cookie, instance);
  await ws.client.emitWithAck("join", { room });
  ws.client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(instance.app.salons[room], undefined);
  assert.match(await denied(owner.cookie, instance), /nécessaire/);
  const restoredGuest = await guest("restore_guest", instance),
    fresh = await start({ guestDurationMs: 1000 });
  const page = await request(fresh.app)
    .get("/salon")
    .set("Cookie", restoredGuest.cookie);
  assert.equal(page.status, 200);
  const opened = await request(fresh.app)
    .post("/salon/salonDeJeu/room")
    .set("Cookie", restoredGuest.cookie)
    .type("form")
    .send({ _csrf: token(page.text) });
  const pending = opened.headers.location.split("/").pop();
  assert.ok(pending);
  assert.ok(fresh.app.salons[pending]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(fresh.app.salons[pending], undefined);
  assert.match(await denied(restoredGuest.cookie, fresh), /nécessaire/);
});

test("compte : expiration active et logout d’une ancienne session ne détruit pas la nouvelle place", async () => {
  const expiry = await start({
      sessionDurationMs: 1400,
      gameOptions: { reconnectMs: 5000, durationMs: 600 },
    }),
    short = await account("short_account", expiry),
    room = await open(short.agent),
    active = await socket(short.cookie, expiry);
  await active.client.emitWithAck("join", { room });
  const ended = event(active.client, "accessEnded", z.string());
  assert.match(await ended, /compte.*expiré/);
  assert.equal(expiry.app.salons[room], undefined);
  assert.match(await denied(short.cookie, expiry), /nécessaire/);
  const offline = await account("offline_account", expiry),
    offlineRoom = await open(offline.agent),
    offlineSocket = await socket(offline.cookie, expiry);
  await offlineSocket.client.emitWithAck("join", { room: offlineRoom });
  offlineSocket.client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(expiry.app.salons[offlineRoom], undefined);
  const first = await account("cross_session"),
    old = await socket(first.cookie),
    firstRoom = await open(first.agent);
  await old.client.emitWithAck("join", { room: firstRoom });
  const secondAgent = request.agent(main.app),
    login = await secondAgent.get("/connexion"),
    response = await secondAgent
      .post("/utilisateur/connexion")
      .type("form")
      .send({
        _csrf: token(login.text),
        email: "cross_session@example.test",
        mdp: "Password1234",
      });
  assert.equal(response.status, 302);
  const second = await socket(response.headers["set-cookie"][0].split(";")[0]);
  const disconnected = event(old.client, "disconnect", z.string());
  await second.client.emitWithAck("join", { room: firstRoom });
  await disconnected;
  assert.equal(old.client.connected, false);
  const logout = await first.agent.get("/profil");
  await first.agent
    .post("/utilisateur/deconnexion")
    .type("form")
    .send({ _csrf: token(logout.text) });
  old.client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(main.app.salons[firstRoom]?.utilisateurs.length, 1);
  assert.equal(second.client.connected, true);
  assert.match(await denied(first.cookie), /nécessaire/);
  await second.client.emitWithAck("leave");
  second.client.disconnect();
});

test("une partie mixte enregistre uniquement le score du compte, sans doubler les résultats", async () => {
  const owner = await account("mixed_owner"),
    partner = await guest("mixed_guest"),
    room = await open(owner.agent),
    a = await socket(owner.cookie),
    b = await socket(partner.cookie);
  await a.client.emitWithAck("join", { room });
  await b.client.emitWithAck("join", { room });
  const initialized = event(a.client, "init", roundSchema);
  a.client.emit("startGame");
  const round = await initialized;
  const ended = event(a.client, "roundEnded", gameRoomSchema);
  await ended;
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (let i = 0; i < 4; i++)
    assert.equal(
      await b.client.emitWithAck("scoreFinDeJeu", { roundId: round.id }),
      undefined,
    );
  const scores = await Score.find({ matchId: round.id });
  assert.equal(scores.length, 1);
  assert.equal(scores[0]?.monJoueurId.toString(), a.id);
  assert.equal(scores[0]?.nomUtilisateurAutreJoueur, "mixed_guest");
  await a.client.emitWithAck("leave");
  a.client.disconnect();
  b.client.disconnect();
});

test("discussion invitée : message persistant unique, présence unique et session révoquée", async () => {
  const instance = await start(),
    user = await guest("chat_guest", instance);
  const connectChat = async () => {
    const client = connect(base(instance) + "/discussion", {
      transports: ["websocket"],
      extraHeaders: { Cookie: user.cookie },
      forceNew: true,
    });
    clients.push(client);
    await event(client, "connect", z.undefined());
    await client.emitWithAck("join", {});
    return client;
  };
  const one = await connectChat(),
    two = await connectChat(),
    id = randomUUID();
  const before = await User.countDocuments();
  assert.deepEqual(
    await Promise.all([
      one.emitWithAck("envoyerMessage", {
        id,
        text: "Bonjour depuis une session invitée",
      }),
      two.emitWithAck("envoyerMessage", {
        id,
        text: "Bonjour depuis une session invitée",
      }),
    ]),
    [undefined, undefined],
  );
  assert.equal(await ChatMessage.countDocuments({ messageId: id }), 1);
  assert.equal(await User.countDocuments(), before);
  const changed = await two.emitWithAck("envoyerMessage", {
    id,
    text: "autre texte",
  });
  assert.match(String(changed), /déjà/);
  const page = await user.agent.get("/salon");
  await user.agent
    .post("/utilisateur/deconnexion")
    .type("form")
    .send({ _csrf: token(page.text) });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(one.connected, false);
  assert.equal(two.connected, false);
  assert.match(await denied(user.cookie, instance), /nécessaire/);
});
