import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Arena } from "../src/services/arena";
import { playerSchema, roundSchema, type Star } from "../shared/contracts";
import { itemY, runnerSpeed, PILOT_CONTACT_TOP } from "../shared/progression";
function fixture() {
  let now = 10000;
  const players = [
    playerSchema.parse({
      id: "a",
      userId: "a",
      nomUtilisateur: "Alice",
      room: "room",
      x: 430,
    }),
    playerSchema.parse({
      id: "b",
      userId: "b",
      nomUtilisateur: "Bob",
      room: "room",
      x: 730,
    }),
  ];
  const round = roundSchema.parse({
    id: randomUUID(),
    startedAt: now,
    endsAt: now + 90000,
    ended: false,
    saved: false,
    stars: [],
  });
  const arena = new Arena(
    round,
    players,
    () => {},
    () => now,
    () => 0.5,
  );
  arena.stop();
  round.stars = [];
  const item = (kind: Star["kind"], x = players[0].x + 22.5) => {
    const value: Star = {
      id: randomUUID(),
      kind,
      x,
      bornAt: now - (450 / 140) * 1000,
      speed: 140,
    };
    round.stars.push(value);
    return value;
  };
  const tick = (milliseconds = 50) => {
    now += milliseconds;
    arena.halt("b");
  };
  return { arena, players, round, item, tick, now: () => now };
}
test("les quatre bonus s’activent au contact, se remplacent et expirent", () => {
  const f = fixture();
  for (const kind of ["sprint", "multiplier", "shield", "magnet"] as const) {
    f.item(kind);
    f.tick();
    assert.equal(f.players[0].bonus?.kind, kind);
    assert.equal(f.players[0].bonus?.expiresAt, f.now() + 8000);
  }
  f.tick(8001);
  assert.equal(f.players[0].bonus, undefined);
  assert.throws(
    () =>
      f.arena.activate("a", {
        id: randomUUID(),
        roundId: f.round.id,
        stage: 0,
        kind: "sprint",
      }),
    /automatiquement/,
  );
});
test("étoiles dorées, multiplicateur et objets communs ne doublent pas les gains", () => {
  const f = fixture();
  f.item("multiplier");
  f.tick();
  const gold = f.item("gold");
  f.tick();
  assert.equal(f.players[0].score, 6);
  assert.equal(f.arena.collect("a", gold.id), 0);
  assert.throws(() => f.arena.collect("b", gold.id), /ramassé/);
  assert.equal(f.players[0].score, 6);
});
test("météorites et blocs retirent des points une seule fois, sans score négatif", () => {
  const f = fixture();
  f.players[0].score = 7;
  f.item("meteor");
  f.tick();
  assert.equal(f.players[0].score, 4);
  const block = f.item("barrier");
  f.tick();
  assert.equal(f.players[0].score, 2);
  f.tick();
  assert.equal(f.players[0].score, 2);
  assert.equal(f.arena.collect("a", block.id), 0);
  f.item("meteor");
  f.tick();
  assert.equal(f.players[0].score, 0);
  assert.equal(f.players[0].feedback?.good, false);
});
test("le bouclier absorbe un seul impact, y compris le ralentissement", () => {
  const f = fixture();
  f.players[0].score = 5;
  f.item("shield");
  f.tick();
  f.item("slime");
  f.tick();
  assert.equal(f.players[0].slowedUntil, undefined);
  assert.equal(f.players[0].bonus, undefined);
  assert.equal(f.players[0].score, 5);
  f.item("meteor");
  f.tick();
  assert.equal(f.players[0].score, 2);
});
test("ralentissement temporaire et accélération modifient la vitesse serveur", () => {
  const f = fixture();
  f.item("slime");
  f.tick();
  assert.equal(runnerSpeed(f.players[0], f.now()), 275);
  f.item("sprint");
  f.tick();
  assert.equal(runnerSpeed(f.players[0], f.now()), 412.5);
  f.tick(4001);
  assert.equal(runnerSpeed(f.players[0], f.now()), 825);
  const start = f.players[0].x;
  f.arena.move("a", { runningLeft: false, runningRight: true });
  f.tick(100);
  assert.equal(f.players[0].x, start + 82.5);
  f.arena.halt("a");
  const stopped = f.players[0].x;
  f.tick(100);
  assert.equal(f.players[0].x, stopped);
});
test("l’aimant élargit le ramassage des étoiles, sans attirer les dangers", () => {
  const f = fixture();
  f.item("magnet");
  f.tick();
  f.item("star", 530);
  f.item("meteor", 530);
  f.tick();
  assert.equal(f.players[0].score, 1);
  assert.equal(f.round.stars.length, 1);
});
test("un client éloigné ou anticipé ne peut réclamer aucun objet", () => {
  const f = fixture();
  const item = f.item("gold", 730);
  assert.throws(() => f.arena.collect("a", item.id), /portée/);
  const early = f.item("star");
  early.bornAt = f.now();
  assert.throws(() => f.arena.collect("a", early.id), /portée/);
  assert.equal(f.players[0].score, 0);
});
test("les obstacles atterrissent puis disparaissent, les manches terminées refusent les contacts", () => {
  const f = fixture();
  const item = f.item("barrier", 100);
  f.tick(2000);
  assert.equal(itemY(item, f.now()), 460);
  assert.ok(f.round.stars.includes(item));
  f.tick(1500);
  assert.ok(!f.round.stars.includes(item));
  const star = f.item("star");
  f.round.ended = true;
  assert.throws(() => f.arena.collect("a", star.id), /active/);
  assert.equal(f.players[0].score, 0);
});
test("le robot le plus proche reçoit l’objet quand les deux se chevauchent", () => {
  const f = fixture();
  f.players[1].x = 440;
  f.item("gold", 464);
  f.tick();
  assert.equal(f.players[0].score, 0);
  assert.equal(f.players[1].score, 3);
});

test("une traversée complète prend 1,67 s, puis gauche/droite et arrêt restent immédiats", () => {
  const f = fixture();
  f.players[0].x = 0;
  f.arena.move("a", { runningLeft: false, runningRight: true }, 0);
  for (let n = 0; n < 33; n++) {
    f.round.stars = [];
    f.tick();
  }
  assert.equal(f.players[0].x, 907.5);
  f.tick(14);
  assert.equal(f.players[0].x, 915);
  f.arena.move("a", { runningLeft: true, runningRight: false }, 1);
  f.tick();
  assert.equal(f.players[0].x, 887.5);
  f.arena.move("a", { runningLeft: true, runningRight: true }, 2);
  f.tick();
  assert.equal(f.players[0].x, 887.5);
  f.arena.move("a", { runningLeft: false, runningRight: false }, 3);
  f.tick();
  assert.equal(f.players[0].x, 887.5);
  assert.equal(f.players[0].movementSequence, 3);
  assert.equal(f.players[0].sampledAt, f.now());
});
test("l’expiration d’un sprint et du ralentissement garde la distance exacte pendant un tick", () => {
  const f = fixture();
  f.players[0].x = 0;
  f.players[0].bonus = { kind: "sprint", stage: 0, expiresAt: f.now() + 100 };
  f.players[0].slowedUntil = f.now() + 150;
  f.arena.move("a", { runningLeft: false, runningRight: true });
  f.tick(200);
  // 100 ms at 412.5, 50 ms at 275, then 50 ms at 550 units/s.
  assert.equal(f.players[0].x, 82.5);
  assert.equal(f.players[0].bonus, undefined);
  assert.equal(f.players[0].slowedUntil, undefined);
});
test("un sprint traverse un danger entre deux ticks retardés sans passer au travers", () => {
  const f = fixture();
  f.players[0].x = 100;
  f.players[0].score = 6;
  f.players[0].bonus = { kind: "sprint", stage: 0, expiresAt: f.now() + 8000 };
  const meteor = f.item("meteor", 222.5);
  f.arena.move("a", { runningLeft: false, runningRight: true });
  f.tick(250);
  assert.equal(f.players[0].x, 306.25);
  assert.equal(f.players[0].score, 3);
  assert.ok(!f.round.stars.includes(meteor));
  f.tick();
  assert.equal(f.players[0].score, 3);
});
test("la collision balayée respecte le moment où l’objet arrive à hauteur du robot", () => {
  const f = fixture();
  f.players[0].x = 100;
  f.players[0].score = 6;
  f.players[0].bonus = { kind: "sprint", stage: 0, expiresAt: f.now() + 8000 };
  const meteor = f.item("meteor", 122.5);
  meteor.bornAt = f.now() - ((PILOT_CONTACT_TOP - 20) / meteor.speed) * 1000;
  f.arena.move("a", { runningLeft: false, runningRight: true });
  f.tick(250);
  assert.equal(f.players[0].score, 6);
  assert.ok(f.round.stars.includes(meteor));
});

test("le contact commence à la tête de l’avatar réduit, à 402 unités de chute", () => {
  const f = fixture();
  const star = f.item("star");
  star.bornAt = f.now() - ((PILOT_CONTACT_TOP - 1) / star.speed) * 1000;
  assert.throws(() => f.arena.collect("a", star.id), /portée/);
  assert.equal(f.players[0].score, 0);
  f.tick(8);
  assert.equal(f.players[0].score, 1);
  assert.equal(f.arena.collect("a", star.id), 0);
});
