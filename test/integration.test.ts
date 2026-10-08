import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { io as connect, type Socket } from "socket.io-client";
import { z } from "zod";
import { movementSchema, messageSchema } from "../shared/contracts";
import { createApp } from "../src/app";
import Utilisateur from "../src/models/Utilisateur";
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
  await Promise.all([Utilisateur.init(), Score.init()]);
  store = MongoStore.create({ client: mongoose.connection.getClient() });
  ({ app, server, io } = createApp({ secret: "a".repeat(48), store }));
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
test("salon à deux, événements malformés, score lié au compte et nettoyage", async () => {
  const a = await register("joueur_a"),
    b = await register("joueur_b"),
    c = await register("joueur_c");
  const lobby = await a.agent.get("/salon");
  const response = await a.agent
    .post("/salon/salonDeJeu/room")
    .type("form")
    .send({ _csrf: token(lobby.text), room: "__proto__" });
  assert.match(response.headers.location, /salonDeJeu\/[a-f0-9-]+$/);
  const room = response.headers.location.split("/").pop();
  assert.ok(room);
  const one = await socket("/jeu", a.cookie),
    two = await socket("/jeu", b.cookie),
    three = await socket("/jeu", c.cookie);
  one.emit("startGame");
  assert.match(await one.emitWithAck("join", null), /invalide/);
  assert.match(
    await one.emitWithAck("join", { room: "__proto__" }),
    /invalide/,
  );
  assert.match(await one.emitWithAck("scoreFinDeJeu", null), /invalide/);
  assert.equal(await one.emitWithAck("join", { room }), undefined);
  assert.equal(await two.emitWithAck("join", { room }), undefined);
  assert.match(await three.emitWithAck("join", { room }), /complet/);
  assert.equal((await c.agent.get(response.headers.location)).status, 409);
  const init = socketEvent(two, "init", z.undefined());
  one.emit("startGame");
  await init;
  const moved = socketEvent(two, "deplacementMonJoueur", movementSchema);
  one.emit("deplacementMonJoueur", {
    id: "forged",
    etat: { runningRight: true },
  });
  assert.equal((await moved).id, one.id);
  assert.match(
    await one.emitWithAck("scoreFinDeJeu", {
      monScore: -5,
      scoreAutreJoueur: 1,
    }),
    /invalide/,
  );
  assert.equal(
    await one.emitWithAck("scoreFinDeJeu", {
      monNom: "forged",
      monScore: 8,
      scoreAutreJoueur: 5,
      nomUtilisateurAutreJoueur: "forged",
    }),
    undefined,
  );
  assert.match(
    await one.emitWithAck("scoreFinDeJeu", {
      monScore: 8,
      scoreAutreJoueur: 5,
    }),
    /invalide/,
  );
  const score = await Score.findOne({ monNom: "joueur_a" });
  assert.ok(score);
  assert.equal(score.nomUtilisateurAutreJoueur, "joueur_b");
  assert.equal(
    String(score.monJoueurId),
    String((await Utilisateur.findOne({ nomUtilisateur: "joueur_a" }))?._id),
  );
  assert.equal((await a.agent.get("/stats")).status, 200);
  one.disconnect();
  two.disconnect();
  three.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.salons[room], undefined);
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
    await one.emitWithAck("envoyerMessage", "<img src=x onerror=alert(1)>"),
    undefined,
  );
  assert.equal((await message).nomUtilisateur, "chat_a");
  assert.match(
    await one.emitWithAck("envoyerMessage", "x".repeat(1001)),
    /caractères/,
  );
  assert.match(await one.emitWithAck("envoyerMessage", {}), /caractères/);
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
