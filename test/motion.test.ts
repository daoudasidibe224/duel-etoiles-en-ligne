import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { LocalMotion, smoothPosition } from "../client/motion";
import { playerSchema, roundSchema, type Player } from "../shared/contracts";
import {
  JUMP_DURATION_MS,
  JUMP_HEIGHT,
  jumpOffset,
  runnerSpeed,
} from "../shared/progression";
import { Arena } from "../src/services/arena";
const effects = {};
function snapshot(
  x: number,
  sequence: number,
  startedAt: number,
  sampledAt = startedAt,
) {
  return playerSchema.parse({
    id: "a",
    userId: "a",
    nomUtilisateur: "Alice",
    room: "r",
    x,
    movementSequence: sequence,
    movementStartedAt: startedAt,
    sampledAt,
  });
}
test("l’appui et le changement de direction prennent effet dès l’image suivante", () => {
  const motion = new LocalMotion(430, 1000);
  motion.input(1, 0, 1000, effects);
  assert.ok(
    Math.abs(motion.advance(1000 + 1000 / 60, effects) - (430 + 550 / 60)) <
      1e-8,
  );
  motion.input(-1, 1, 1050, effects);
  assert.ok(Math.abs(motion.advance(1100, effects) - 430) < 1e-8);
});
test("la vitesse de traversée reste identique à 30, 60 et 144 images/s", () => {
  for (const fps of [30, 60, 144]) {
    const motion = new LocalMotion(0, 0);
    motion.input(1, 0, 0, effects);
    let frame = 0;
    while (motion.x < 915) motion.advance((++frame * 1000) / fps, effects);
    const seconds = frame / fps;
    assert.ok(seconds >= 915 / 550 && seconds <= 915 / 550 + 1 / fps);
    assert.equal(motion.x, 915);
    motion.input(-1, 1, (frame * 1000) / fps, effects);
    assert.ok(motion.advance(((frame + 1) * 1000) / fps, effects) < 915);
  }
});
test("un arrêt ignore les anciens paquets en marche et sa confirmation ne provoque pas de rebond", () => {
  const motion = new LocalMotion(430, 1000);
  motion.input(1, 0, 1000, effects);
  motion.advance(1100, effects);
  // 75 ms one way, with a different server wall clock.
  motion.receive(snapshot(430, 0, 10075), 1150);
  motion.input(0, 1, 1200, effects);
  const stopped = motion.x;
  motion.receive(snapshot(512.5, 0, 10075, 10225), 1300);
  assert.equal(motion.advance(1350, effects), stopped);
  motion.receive(snapshot(540, 1, 10275), 1350);
  assert.ok(Math.abs(motion.x - 540) < 1e-8);
  motion.receive(snapshot(512.5, 0, 10075, 10225), 1400);
  assert.equal(motion.advance(1450, effects), 540);
});
test("une inversion reste réactive malgré les positions de la commande précédente", () => {
  const motion = new LocalMotion(430, 1000);
  motion.input(1, 0, 1000, effects);
  motion.advance(1150, effects);
  motion.receive(snapshot(430, 0, 10075), 1150);
  motion.input(-1, 1, 1200, effects);
  const before = motion.x;
  motion.receive(snapshot(512.5, 0, 10075, 10225), 1300);
  assert.ok(Math.abs(motion.advance(1300, effects) - (before - 55)) < 1e-8);
  motion.receive(snapshot(540, 1, 10275), 1350);
  const previous = motion.x;
  assert.ok(motion.advance(1400, effects) < previous);
});
test("client et serveur parcourent la même distance avec sprint, ralentissement et expiration", () => {
  for (const modifier of [
    "normal",
    "sprint",
    "slime",
    "both",
    "expiry",
  ] as const) {
    let now = 10000;
    const player = snapshot(100, -1, now);
    if (["sprint", "both", "expiry"].includes(modifier))
      player.bonus = {
        kind: "sprint",
        stage: 0,
        expiresAt: now + (modifier === "expiry" ? 125 : 8000),
      };
    if (["slime", "both", "expiry"].includes(modifier))
      player.slowedUntil = now + (modifier === "expiry" ? 175 : 4000);
    const round = roundSchema.parse({
      id: randomUUID(),
      startedAt: now,
      endsAt: now + 90000,
      ended: false,
      saved: false,
    });
    const arena = new Arena(
      round,
      [player],
      () => {},
      () => now,
    );
    arena.stop();
    const motion = new LocalMotion(player.x, now);
    const initialEffects = {
      bonus: player.bonus,
      slowedUntil: player.slowedUntil,
    };
    arena.move("a", { runningLeft: false, runningRight: true }, 0);
    motion.input(1, 0, now, initialEffects);
    for (let n = 0; n < 4; n++) {
      round.stars = [];
      now += 50;
      arena.halt("nobody");
      const clientX = motion.advance(now, initialEffects);
      assert.ok(Math.abs(clientX - player.x) < 1e-8, modifier);
    }
    if (modifier === "sprint") assert.equal(player.x, 265);
    if (modifier === "slime") assert.equal(player.x, 155);
    if (modifier === "both") assert.equal(player.x, 182.5);
    assert.equal(
      runnerSpeed(player, now),
      modifier === "sprint"
        ? 825
        : modifier === "slime"
          ? 275
          : modifier === "both"
            ? 412.5
            : 550,
    );
  }
});
test("avec 150 ms aller-retour, une traversée, un arrêt et un retour gardent la parité", () => {
  let elapsed = 0;
  const localNow = () => 1000 + elapsed;
  const serverNow = () => 10000 + elapsed;
  const player = snapshot(0, -1, serverNow());
  const round = roundSchema.parse({
    id: randomUUID(),
    startedAt: serverNow(),
    endsAt: serverNow() + 90000,
    ended: false,
    saved: false,
  });
  const deliveries: { at: number; player: Player }[] = [];
  const arena = new Arena(
    round,
    [player],
    () =>
      deliveries.push({ at: elapsed + 75, player: structuredClone(player) }),
    serverNow,
  );
  arena.stop();
  const motion = new LocalMotion(0, localNow());
  const inputs = [
    { at: 0, direction: 1 },
    { at: 1700, direction: 0 },
    { at: 2100, direction: -1 },
    { at: 2500, direction: 0 },
  ];
  let stopped: number | undefined;
  for (elapsed = 0; elapsed <= 2800; elapsed += 5) {
    const command = inputs.findIndex((input) => input.at === elapsed);
    if (command >= 0)
      motion.input(inputs[command].direction, command, localNow(), effects);
    const processed = inputs.findIndex((input) => input.at + 75 === elapsed);
    if (processed >= 0)
      arena.move(
        "a",
        {
          runningLeft: inputs[processed].direction === -1,
          runningRight: inputs[processed].direction === 1,
        },
        processed,
      );
    if (elapsed % 50 === 0) {
      round.stars = [];
      arena.halt("nobody");
    }
    motion.advance(localNow(), effects);
    for (const packet of deliveries.filter((value) => value.at === elapsed))
      motion.receive(packet.player, localNow());
    if (elapsed === 1665) assert.equal(motion.x, 915);
    if (elapsed === 1900) stopped = motion.x;
    if (elapsed >= 1900 && elapsed < 2100) assert.equal(motion.x, stopped);
  }
  assert.ok(Math.abs(motion.x - 695) < 1e-8);
  assert.ok(Math.abs(motion.x - player.x) < 1e-8);
});
test("l’adversaire rejoint sa position réseau progressivement sans dépasser la cible", () => {
  let x = 430;
  for (let n = 0; n < 60; n++) {
    x = smoothPosition(
      { x, targetX: 580, sampledAt: 0, local: false, direction: 0, speed: 550 },
      1 / 60,
      (n * 1000) / 60,
    );
    assert.ok(x >= 430 && x <= 580);
  }
  assert.ok(Math.abs(x - 580) < 0.01);
});

test("la séquence exposée correspond uniquement à une confirmation acceptée", () => {
  const motion = new LocalMotion(430, 1000);
  motion.input(1, 0, 1000, effects);
  motion.receive(snapshot(430, 0, 10075), 1150);
  assert.equal(motion.acceptedSequence, 0);
  motion.input(0, 1, 1200, effects);
  motion.receive(snapshot(540, 1, 10275, 10000), 1350);
  assert.equal(motion.acceptedSequence, 0);
  motion.receive(snapshot(540, 1, 10275), 1350);
  assert.equal(motion.acceptedSequence, 1);
  motion.receive(snapshot(800, 2, 10400), 1450);
  assert.equal(motion.acceptedSequence, 1);
});
test("la position finale reste figée malgré une prédiction active et un paquet retardé", () => {
  const motion = new LocalMotion(430, 1000);
  motion.input(1, 0, 1000, effects);
  motion.receive(snapshot(430, 0, 10075), 1150);
  motion.input(-1, 1, 1200, effects);
  assert.notEqual(motion.advance(1250, effects), 321);
  motion.freeze(321, 1250);
  assert.equal(motion.advance(1300, effects), 321);
  motion.receive(snapshot(540, 1, 10275), 1350);
  motion.input(1, 2, 1400, effects);
  assert.equal(motion.advance(1500, effects), 321);
  motion.reset(430, 1600);
  motion.input(1, 0, 1600, effects);
  assert.equal(motion.advance(1700, effects), 485);
});

test("le saut est immédiat, un maintien ou un appui en l’air ne programme aucun second saut", () => {
  const motion = new LocalMotion(430, 1000);
  motion.input(0, 0, 1000, effects, true);
  assert.equal(motion.jumpStartedAt, 1000);
  assert.equal(jumpOffset(motion, 1000 + JUMP_DURATION_MS / 2), JUMP_HEIGHT);
  motion.input(1, 1, 1100, effects, true);
  motion.input(1, 2, 1150, effects, false);
  motion.input(1, 3, 1200, effects, true);
  assert.equal(motion.jumpStartedAt, 1000);
  assert.equal(jumpOffset(motion, 1000 + JUMP_DURATION_MS), 0);
  motion.input(0, 4, 1000 + JUMP_DURATION_MS + 100, effects, true);
  assert.equal(motion.jumpStartedAt, 1000);
  motion.input(0, 5, 1000 + JUMP_DURATION_MS + 110, effects, false);
  motion.input(0, 6, 1000 + JUMP_DURATION_MS + 120, effects, true);
  assert.equal(motion.jumpStartedAt, 1000 + JUMP_DURATION_MS + 120);
});

test("les confirmations du saut gardent la prédiction malgré 150 ms RTT et des horloges différentes", () => {
  const motion = new LocalMotion(430, 1000);
  motion.input(0, 0, 1000, effects, true);
  motion.input(0, 1, 1050, effects, false);
  const ack = { ...snapshot(430, 0, 10075), jumpStartedAt: 10075 };
  motion.receive(ack, 1150);
  assert.equal(motion.acceptedSequence, 0);
  assert.equal(motion.jumpStartedAt, 1000);
  motion.receive({ ...snapshot(430, 1, 10125), jumpStartedAt: 10075 }, 1200);
  assert.equal(motion.jumpStartedAt, 1000);
  motion.input(0, 2, 1800, effects, true);
  // A snapshot from the preceding command must replay the pending new press.
  motion.receive(
    { ...snapshot(430, 1, 10125, 10725), jumpStartedAt: 10075 },
    1810,
  );
  assert.equal(motion.jumpStartedAt, 1800);
  motion.receive({ ...snapshot(430, 2, 10875), jumpStartedAt: 10875 }, 1950);
  assert.equal(motion.jumpStartedAt, 1800);
  motion.receive(ack, 2000);
  assert.equal(motion.jumpStartedAt, 1800);
});

test("un saut refusé par le serveur est retiré sans relancer les commandes en attente", () => {
  const motion = new LocalMotion(430, 1000);
  motion.input(0, 0, 1000, effects, true);
  motion.input(1, 1, 1100, effects, true);
  motion.receive(snapshot(430, 0, 10075), 1150);
  assert.equal(motion.jumpStartedAt, undefined);
  motion.receive(snapshot(430, 1, 10175), 1250);
  assert.equal(motion.jumpStartedAt, undefined);
  motion.freeze(430, 1300);
  assert.equal(motion.acceptedSequence, -1);
  motion.input(0, 2, 1400, effects, true);
  assert.equal(motion.jumpStartedAt, undefined);
  motion.reset(430, 1500);
  motion.input(0, 0, 1500, effects, true);
  assert.equal(motion.jumpStartedAt, 1500);
});

test("un ACK tardif de saut ne change pas la vitesse d’un déplacement continu", () => {
  const motion = new LocalMotion(430, 1000);
  motion.input(1, 0, 1000, effects);
  motion.advance(1150, effects);
  motion.receive(snapshot(430, 0, 10075), 1150);
  motion.advance(1200, effects);
  motion.input(1, 1, 1200, effects, true);
  motion.advance(1450, effects);
  motion.advance(1500, effects);
  // The jump arrives 150ms later than the first command; horizontal motion is unchanged.
  motion.receive({ ...snapshot(581.25, 1, 10350), jumpStartedAt: 10350 }, 1500);
  const before = motion.x;
  assert.equal(
    motion.jumpStartedAt,
    1200,
    "an accepted jump keeps its predicted phase",
  );
  assert.ok(
    Math.abs(motion.advance(1500 + 1000 / 60, effects) - before - 550 / 60) <
      1e-8,
  );
  motion.receive(
    { ...snapshot(608.75, 1, 10350, 10400), jumpStartedAt: 10350 },
    1550,
  );
  assert.equal(motion.jumpStartedAt, 1200);
});

test("le jitter, les bonus et les chevauchements gardent des images continues et un arrêt exact", () => {
  for (const modifier of ["normal", "sprint", "slime", "expiry"] as const) {
    let elapsed = 0;
    const player = snapshot(430, -1, 10000);
    if (modifier === "sprint" || modifier === "expiry")
      player.bonus = {
        kind: "sprint",
        stage: 0,
        expiresAt: modifier === "expiry" ? 10700 : 18000,
      };
    if (modifier === "slime" || modifier === "expiry")
      player.slowedUntil = modifier === "expiry" ? 10850 : 18000;
    const round = roundSchema.parse({
      id: randomUUID(),
      startedAt: 10000,
      endsAt: 100000,
      ended: false,
      saved: false,
    });
    const deliveries: { at: number; player: Player }[] = [];
    let lastDeliveryAt = 0,
      deliveryIndex = 0;
    const arena = new Arena(
      round,
      [player],
      () => {
        lastDeliveryAt = Math.max(
          lastDeliveryAt + 5,
          elapsed + [75, 145, 95, 185, 110][deliveryIndex++ % 5],
        );
        deliveries.push({
          at: lastDeliveryAt,
          player: structuredClone(player),
        });
      },
      () => 10000 + elapsed,
    );
    arena.stop();
    const motion = new LocalMotion(430, 1000);
    const modifierEffects = {
      bonus: player.bonus,
      slowedUntil: player.slowedUntil,
    };
    const inputs = [
      { at: 0, processedAt: 75, direction: 1, jumping: false },
      { at: 120, processedAt: 305, direction: 1, jumping: true },
      { at: 250, processedAt: 360, direction: 1, jumping: false },
      { at: 500, processedAt: 645, direction: 0, jumping: false },
      { at: 550, processedAt: 650, direction: -1, jumping: false },
      { at: 900, processedAt: 1085, direction: -1, jumping: true },
      { at: 950, processedAt: 1090, direction: -1, jumping: false },
      { at: 1200, processedAt: 1275, direction: 0, jumping: false },
    ];
    let direction = 0;
    let delivered = 0;
    let maxReceiveDelta = 0;
    let maxReceiveJumpDelta = 0;
    for (elapsed = 0; elapsed <= 1800; elapsed += 5) {
      const command = inputs.findIndex((input) => input.at === elapsed);
      if (command >= 0) {
        const input = inputs[command];
        direction = input.direction;
        motion.input(
          direction,
          command,
          1000 + elapsed,
          modifierEffects,
          input.jumping,
        );
      }
      const processed = inputs.findIndex(
        (input) => input.processedAt === elapsed,
      );
      if (processed >= 0) {
        const input = inputs[processed];
        arena.move(
          "a",
          {
            runningLeft: input.direction === -1,
            runningRight: input.direction === 1,
            jumping: input.jumping,
          },
          processed,
        );
      }
      const before = motion.x;
      const after = motion.advance(1000 + elapsed, modifierEffects);
      if (direction) {
        assert.ok(
          (after - before) * direction >= -1e-8,
          modifier + " never reverses a held input",
        );
        assert.ok(
          Math.abs(after - before) <= 825 * 0.005 * 1.35 + 1e-8,
          modifier + " has no discontinuity in a moving frame",
        );
      }
      while (deliveries[delivered]?.at <= elapsed) {
        const beforeReceive = motion.x;
        const beforeJump = jumpOffset(motion, 1000 + elapsed);
        motion.receive(deliveries[delivered++].player, 1000 + elapsed);
        maxReceiveDelta = Math.max(maxReceiveDelta, Math.abs(motion.x - beforeReceive));
        maxReceiveJumpDelta = Math.max(maxReceiveJumpDelta, Math.abs(jumpOffset(motion, 1000 + elapsed) - beforeJump));
      }
      if (elapsed % 50 === 0) {
        round.stars = [];
        // An unrelated runner forces a tick without changing this player's state.
        arena.halt("nobody");
      }
    }
    assert.ok(
      Math.abs(motion.x - player.x) < 1e-8,
      modifier + " converges to the real authoritative stop",
    );
    console.log("ACK continuity", modifier, { maxReceiveDelta, maxReceiveJumpDelta });
    assert.ok(maxReceiveDelta <= 3, modifier + " has no horizontal ACK teleport");
    assert.ok(maxReceiveJumpDelta <= 1, modifier + " has no vertical ACK teleport");
    assert.equal(motion.acceptedSequence, 7);
    assert.equal(jumpOffset(motion, 2800), 0);
  }
});
