import { randomUUID } from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { io as connect, type Socket } from "socket.io-client";
import { z } from "zod";
import {
  movementSchema,
  messageSchema,
  gameRoomSchema,
  roundSchema,
} from "../shared/contracts";
import { createApp } from "../src/app";
import Utilisateur from "../src/models/Utilisateur";
import ChatMessage from "../src/models/ChatMessage";
import Score from "../src/models/Score";
import MongoStore from "connect-mongo";
let mongo: MongoMemoryServer,
  server: ReturnType<typeof createApp>["server"],
  app: ReturnType<typeof createApp>["app"],
  io: ReturnType<typeof createApp>["io"],
  address: string;
const sockets: Socket[] = [];
let store: MongoStore;
function socketEvent<T>(
  client: Socket,
  event: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Événement absent : ${event}`)),
      5000,
    );
    client.once(event, (...values: unknown[]) => {
      clearTimeout(timer);
      try {
        resolve(schema.parse(values[0]));
      } catch (error) {
        reject(error);
      }
    });
  });
}
const token = (html: string) => {
  const value = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(value);
  return value;
};
async function register(name: string) {
  const agent = request.agent(app);
  const page = await agent.get("/inscription");
  const response = await agent
    .post("/utilisateur/inscription")
    .type("form")
    .send({
      _csrf: token(page.text),
      nomUtilisateur: name,
      email: `${name}@example.test`,
      mdp: "abcdefgh1234",
      mdp2: "abcdefgh1234",
    });
  assert.equal(response.status, 302);
  const cookie = response.headers["set-cookie"][0].split(";")[0];
  return { agent, cookie };
}
async function socket(namespace: string, cookie: string) {
  const client = connect(address + namespace, {
    extraHeaders: { Cookie: cookie },
    transports: ["websocket"],
    forceNew: true,
  });
  sockets.push(client);
  await socketEvent(client, "connect", z.undefined());
  return client;
}
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 1000 });
  await Promise.all([Utilisateur.init(), Score.init(), ChatMessage.init()]);
  store = MongoStore.create({ client: mongoose.connection.getClient() });
  ({ app, server, io } = createApp({
    secret: "a".repeat(48),
    store,
    gameOptions: { durationMs: 600, reconnectMs: 150 },
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${(() => {
    const value = server.address();
    if (!value || typeof value === "string")
      throw new Error("Adresse serveur absente");
    return value.port;
  })()}`;
});
after(async () => {
  sockets.forEach((client) => client.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await store.close();
  await mongoose.disconnect();
  await mongo.stop();
});
test("accès protégé, erreurs et protection des formulaires", async () => {
  assert.equal(
    (await request(app).get("/salon")).headers.location,
    "/connexion",
  );
  assert.equal(
    (await request(app).get("/salon/salonDeJeu/missing")).status,
    302,
  );
  assert.equal((await request(app).get("/inexistant")).status, 404);
  assert.equal(
    (await request(app).post("/utilisateur/inscription").send({})).status,
    403,
  );
  const anonymous = connect(address + "/jeu", {
    transports: ["websocket"],
    forceNew: true,
  });
  const error = await socketEvent(
    anonymous,
    "connect_error",
    z.instanceof(Error),
  );
  assert.match(error.message, /Connexion/);
  anonymous.disconnect();
});
test("inscription, normalisation, validation et connexion", async () => {
  const agent = request.agent(app);
  const page = await agent.get("/inscription");
  assert.equal(
    (
      await agent
        .post("/utilisateur/inscription")
        .type("form")
        .send({
          _csrf: token(page.text),
          nomUtilisateur: "<script>",
          email: "bad",
          mdp: "abc",
          mdp2: "abc",
        })
    ).status,
    422,
  );
  await register("ALICE");
  const user = await Utilisateur.findOne({ nomUtilisateur: "alice" });
  assert.ok(user);
  assert.notEqual(user.mdp, "abcdefgh1234");
  const login = request.agent(app);
  const loginPage = await login.get("/connexion");
  assert.equal(
    (
      await login
        .post("/utilisateur/connexion")
        .type("form")
        .send({
          _csrf: token(loginPage.text),
          email: "ALICE@EXAMPLE.TEST",
          mdp: "abcdefgh1234",
        })
    ).headers.location,
    "/salon",
  );
});
test("un joueur ne peut modifier le profil d’un autre", async () => {
  const { agent } = await register("profiltest");
  const victim = await Utilisateur.findOne({ nomUtilisateur: "alice" });
  assert.ok(victim);
  const profile = await agent.get("/profil");
  await agent
    .post("/utilisateur/editer-profil")
    .type("form")
    .send({
      _csrf: token(profile.text),
      idUtilisateur: victim.id,
      nouveauNomUtilisateur: "modifie",
    });
  assert.equal(
    (await Utilisateur.findById(victim.id))?.nomUtilisateur,
    "alice",
  );
  assert.ok(await Utilisateur.exists({ nomUtilisateur: "modifie" }));
});
test("une place par compte : doublons, reprise, changement de salon, départs et autorisations", async () => {
  const a = await register("joueur_a"),
    b = await register("joueur_b"),
    c = await register("joueur_c");
  const open = async (agent: ReturnType<typeof request.agent>) => {
    const page = await agent.get("/salon");
    const response = await agent
      .post("/salon/salonDeJeu/room")
      .type("form")
      .send({ _csrf: token(page.text) });
    const id = response.headers.location.split("/").pop();
    assert.ok(id);
    return id;
  };
  const room = await open(a.agent),
    otherRoom = await open(c.agent);
  const first = await socket("/jeu", a.cookie),
    second = await socket("/jeu", a.cookie);
  assert.match(await first.emitWithAck("join", null), /invalide/);
  assert.equal(await first.emitWithAck("join", { room }), undefined);
  const replaced = socketEvent(first, "replaced", z.undefined());
  assert.equal(await second.emitWithAck("join", { room }), undefined);
  await replaced;
  assert.equal(first.connected, false);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(
      await Promise.all(
        Array.from({ length: 4 }, () => second.emitWithAck("join", { room })),
      ),
      Array(4).fill(undefined),
    );
    assert.equal(app.salons[room].utilisateurs.length, 1);
  }
  assert.match(
    await second.emitWithAck("join", { room: otherRoom }),
    /salon actuel/,
  );
  assert.equal(app.salons[otherRoom].utilisateurs.length, 0);
  assert.equal(await open(a.agent), room);
  const guest = await socket("/jeu", b.cookie),
    outsider = await socket("/jeu", c.cookie);
  assert.equal(await guest.emitWithAck("join", { room }), undefined);
  assert.match(await outsider.emitWithAck("join", { room }), /complet/);
  assert.equal((await a.agent.get(`/salon/salonDeJeu/${room}`)).status, 200);
  assert.equal((await c.agent.get(`/salon/salonDeJeu/${room}`)).status, 409);
  guest.disconnect();
  const resumed = await socket("/jeu", b.cookie);
  assert.equal(await resumed.emitWithAck("join", { room }), undefined);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(app.salons[room].utilisateurs.length, 2);
  assert.equal(
    new Set(app.salons[room].utilisateurs.map((player) => player.userId)).size,
    2,
  );
  let starts = 0;
  resumed.on("init", () => starts++);
  outsider.emit("startGame");
  resumed.emit("startGame");
  const initialized = socketEvent(resumed, "init", roundSchema);
  for (let i = 0; i < 5; i++) second.emit("startGame");
  const round = await initialized;
  assert.match(
    await second.emitWithAck("scoreFinDeJeu", { roundId: round.id }),
    /encore en cours/,
  );
  let movements = 0,
    scores = 0;
  resumed.on("deplacementMonJoueur", () => movements++);
  resumed.on("score", () => scores++);
  const moved = socketEvent(resumed, "deplacementMonJoueur", movementSchema);
  second.emit("deplacementMonJoueur", {
    roundId: round.id,
    sequence: 2,
    id: "forged",
    etat: { runningRight: true },
  });
  assert.equal((await moved).id, app.salons[room].proprietaireId);
  second.emit("deplacementMonJoueur", {
    roundId: round.id,
    sequence: 1,
    etat: { runningLeft: true },
  });
  second.emit("deplacementMonJoueur", {
    roundId: round.id,
    sequence: 2,
    etat: { runningLeft: true },
  });
  second.emit("deplacementMonJoueur", {
    roundId: randomUUID(),
    sequence: 3,
    etat: { runningLeft: true },
  });
  outsider.emit("score", { roundId: round.id, sequence: 1, score: 1 });
  second.emit("score", { roundId: round.id, sequence: 2, score: 1 });
  second.emit("score", { roundId: round.id, sequence: 2, score: 1 });
  second.emit("score", { roundId: round.id, sequence: 1, score: 2 });
  second.emit("score", { roundId: round.id, sequence: 3, score: 500 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(starts, 1);
  assert.equal(movements, 1);
  assert.equal(scores, 1);
  const refresh = await socket("/jeu", b.cookie);
  const resumeInit = socketEvent(refresh, "init", roundSchema);
  assert.equal(await refresh.emitWithAck("join", { room }), undefined);
  assert.equal((await resumeInit).id, round.id);
  assert.equal(app.salons[room].utilisateurs.length, 2);
  const ended = socketEvent(second, "roundEnded", gameRoomSchema);
  await ended;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.salons[room].round?.ended, true);
  for (let i = 0; i < 4; i++) {
    assert.equal(
      await second.emitWithAck("scoreFinDeJeu", { roundId: round.id }),
      undefined,
    );
    second.emit("startGame");
    second.emit("score", { roundId: round.id, sequence: 100 + i, score: 2 });
  }
  const results = await Score.find({ matchId: round.id });
  assert.equal(results.length, 2);
  assert.equal(
    results.find((value) => value.monNom === "joueur_a")?.monScore,
    1,
  );
  assert.equal(
    results.find((value) => value.monNom === "joueur_a")
      ?.nomUtilisateurAutreJoueur,
    "joueur_b",
  );
  const closed = socketEvent(refresh, "roomClosed", z.string());
  assert.equal(await second.emitWithAck("leave"), undefined);
  await closed;
  assert.equal(await second.emitWithAck("leave"), undefined);
  assert.equal(app.salons[room], undefined);
  assert.match(
    await refresh.emitWithAck("scoreFinDeJeu", { roundId: round.id }),
    /invalide/,
  );
  assert.equal(
    await refresh.emitWithAck("join", { room: otherRoom }),
    undefined,
  );
  assert.equal(await refresh.emitWithAck("leave"), undefined);
  assert.equal(await refresh.emitWithAck("leave"), undefined);
  assert.equal(app.salons[otherRoom], undefined);
  outsider.disconnect();
  second.disconnect();
  refresh.disconnect();
});
test("une coupure expirée libère le propriétaire et ferme le salon", async () => {
  const a = await register("expiry_owner"),
    b = await register("expiry_guest");
  const page = await a.agent.get("/salon");
  const response = await a.agent
    .post("/salon/salonDeJeu/room")
    .type("form")
    .send({ _csrf: token(page.text) });
  const room = response.headers.location.split("/").pop();
  assert.ok(room);
  const owner = await socket("/jeu", a.cookie),
    guest = await socket("/jeu", b.cookie);
  await owner.emitWithAck("join", { room });
  await guest.emitWithAck("join", { room });
  const closed = socketEvent(guest, "roomClosed", z.string());
  owner.disconnect();
  await closed;
  assert.equal(app.salons[room], undefined);
  assert.match(await guest.emitWithAck("join", { room }), /fermé/);
  guest.disconnect();
});
test("départs pendant une manche, salon encore fermé et déconnexion du propriétaire", async () => {
  const ownerAccount = await register("depart_owner"),
    guestAccount = await register("depart_guest"),
    outsideAccount = await register("depart_outside");
  const owner = await socket("/jeu", ownerAccount.cookie),
    guest = await socket("/jeu", guestAccount.cookie),
    outsider = await socket("/jeu", outsideAccount.cookie);
  const open = async () => {
    const page = await ownerAccount.agent.get("/salon");
    const response = await ownerAccount.agent
      .post("/salon/salonDeJeu/room")
      .type("form")
      .send({ _csrf: token(page.text) });
    const room = response.headers.location.split("/").pop();
    assert.ok(room);
    return room;
  };
  const room = await open();
  await owner.emitWithAck("join", { room });
  await guest.emitWithAck("join", { room });
  const started = socketEvent(owner, "init", roundSchema);
  owner.emit("startGame");
  const round = await started;
  const ended = socketEvent(owner, "roundEnded", gameRoomSchema);
  await guest.emitWithAck("leave");
  await ended;
  assert.equal(await guest.emitWithAck("leave"), undefined);
  assert.equal(app.salons[room].utilisateurs.length, 1);
  assert.equal(app.salons[room].round?.ended, true);
  assert.match(await outsider.emitWithAck("join", { room }), /en cours/);
  assert.equal(
    await owner.emitWithAck("scoreFinDeJeu", { roundId: round.id }),
    undefined,
  );
  assert.equal(await Score.countDocuments({ matchId: round.id }), 2);
  await owner.emitWithAck("leave");
  const another = await open();
  await owner.emitWithAck("join", { room: another });
  await guest.emitWithAck("join", { room: another });
  const restarted = socketEvent(guest, "init", roundSchema);
  owner.emit("startGame");
  const nextRound = await restarted;
  const closed = socketEvent(guest, "roomClosed", z.string());
  const profile = await ownerAccount.agent.get("/profil");
  await ownerAccount.agent
    .post("/utilisateur/deconnexion")
    .type("form")
    .send({ _csrf: token(profile.text) });
  await closed;
  assert.equal(app.salons[another], undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await Score.countDocuments({ matchId: nextRound.id }), 2);
  guest.disconnect();
  outsider.disconnect();
});
test("discussion liée à la session et messages bornés", async () => {
  const a = await register("chat_a"),
    b = await register("chat_b");
  const one = await socket("/discussion", a.cookie),
    two = await socket("/discussion", b.cookie);
  await one.emitWithAck("join", { nomUtilisateur: "forged" });
  await two.emitWithAck("join", {});
  const message = socketEvent(two, "message", messageSchema);
  assert.equal(
    await one.emitWithAck("envoyerMessage", {
      id: randomUUID(),
      text: "<img src=x onerror=alert(1)>",
    }),
    undefined,
  );
  assert.equal((await message).nomUtilisateur, "chat_a");
  assert.match(
    await one.emitWithAck("envoyerMessage", {
      id: randomUUID(),
      text: "x".repeat(1001),
    }),
    /caractères/,
  );
  assert.match(await one.emitWithAck("envoyerMessage", {}), /caractères/);
  const duplicate = await socket("/discussion", a.cookie);
  const presence = socketEvent(
    two,
    "roomData",
    gameRoomSchema.omit({ room: true, round: true }).extend({
      utilisateurs: z.array(
        z.object({ id: z.string(), nomUtilisateur: z.string() }),
      ),
    }),
  );
  await duplicate.emitWithAck("join", {});
  assert.equal(
    (await presence).utilisateurs.filter(
      (user) => user.nomUtilisateur === "chat_a",
    ).length,
    1,
  );
  await new Promise((resolve) => setTimeout(resolve, 550));
  const payload = { id: randomUUID(), text: "message unique" };
  let deliveries = 0;
  two.on("message", (value: unknown) => {
    if (messageSchema.parse(value).id === payload.id) deliveries++;
  });
  assert.equal(await one.emitWithAck("envoyerMessage", payload), undefined);
  assert.equal(
    await duplicate.emitWithAck("envoyerMessage", payload),
    undefined,
  );
  assert.equal(await one.emitWithAck("envoyerMessage", payload), undefined);
  assert.equal(deliveries, 1);
  assert.equal(await ChatMessage.countDocuments({ messageId: payload.id }), 1);
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 5 }, () =>
        duplicate.emitWithAck("envoyerMessage", payload),
      ),
    ),
    Array(5).fill(undefined),
  );
  assert.equal(await ChatMessage.countDocuments({ messageId: payload.id }), 1);
  assert.match(
    await duplicate.emitWithAck("envoyerMessage", {
      ...payload,
      text: "autre",
    }),
    /autre texte/,
  );
  const page = await a.agent.get("/profil");
  assert.equal(
    (
      await a.agent
        .post("/utilisateur/deconnexion")
        .type("form")
        .send({ _csrf: token(page.text) })
    ).headers.location,
    "/connexion",
  );
  assert.equal((await a.agent.get("/profil")).status, 302);
});

test("comptes, sessions et scores persistent dans une nouvelle instance", async () => {
  const account = await register("persistant");
  const user = await Utilisateur.findOne({ nomUtilisateur: "persistant" });
  assert.ok(user);
  await Score.create({
    monJoueurId: user._id,
    monNom: user.nomUtilisateur,
    monScore: 7,
    nomUtilisateurAutreJoueur: "adversaire",
    scoreAutreJoueur: 4,
  });
  const fresh = createApp({ secret: "a".repeat(48), store });
  try {
    const profile = await request(fresh.app)
      .get("/profil")
      .set("Cookie", account.cookie);
    assert.equal(profile.status, 200);
    assert.match(profile.text, /persistant/);
    const stats = await request(fresh.app)
      .get("/stats")
      .set("Cookie", account.cookie);
    assert.equal(stats.status, 200);
    assert.match(stats.text, /adversaire/);
  } finally {
    await new Promise<void>((resolve) => fresh.io.close(() => resolve()));
  }
});

test("une base indisponible affiche une erreur sans valider de sauvegarde", async () => {
  const account = await register("indisponible");
  sockets.forEach((client) => client.disconnect());
  await mongo.stop();
  const response = await request(app)
    .get("/stats")
    .set("Cookie", account.cookie)
    .timeout(7000);
  assert.equal(response.status, 500);
  assert.match(response.text, /Une erreur est survenue/);
});
