import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Star } from "../shared/contracts";
import {
  itemFallScale,
  itemTimeAtY,
  itemY,
  jumpOffset,
  JUMP_DURATION_MS,
  JUMP_HEIGHT,
} from "../shared/progression";

test("la vitesse de chute progresse continûment de 1 à 2,5 sur les 90 secondes", () => {
  const round = { startedAt: 1000, endsAt: 91000 };
  assert.equal(itemFallScale(round, 1000), 1);
  assert.equal(itemFallScale(round, 46000), 1.75);
  assert.equal(itemFallScale(round, 91000), 2.5);
  assert.equal(itemFallScale(round, -1000), 1);
  assert.equal(itemFallScale(round, 95000), 2.5);
  for (const boundary of [31000, 61000]) {
    assert.ok(
      itemFallScale(round, boundary + 1) - itemFallScale(round, boundary - 1) <
        0.00004,
    );
  }
  const item: Star = {
    id: randomUUID(),
    kind: "star",
    x: 450,
    bornAt: 1000,
    speed: 140,
  };
  assert.equal(itemY(item, 46000, round), 140 * 45 * 1.375);
  assert.equal(itemY(item, 91000, round), 140 * 90 * 1.75);
  const late = { ...item, bornAt: 61000 };
  assert.ok(itemY(late, 62000, round) > itemY(item, 2000, round) * 1.9);
  assert.equal(
    itemY(item, 2000),
    140,
    "les anciennes fixtures sans manche gardent une vitesse fixe",
  );
});

test("l’instant de contact inverse exactement la chute accélérée, y compris les objets déjà présents", () => {
  const round = { startedAt: 1000, endsAt: 91000 };
  for (const bornAt of [-2000, 1000, 30000, 90000, 95000]) {
    const item: Star = {
      id: randomUUID(),
      kind: "star",
      x: 450,
      bornAt,
      speed: 140,
    };
    for (const height of [0, 402, 460, 505, 10000]) {
      const at = itemTimeAtY(item, height, round);
      assert.ok(Math.abs(itemY(item, at, round) - height) < 1e-8);
    }
  }
});

test("la gravité partagée atteint le sommet à mi-saut et revient exactement au sol", () => {
  const player = { jumpStartedAt: 1000 };
  assert.equal(jumpOffset({}, 1200), 0);
  assert.equal(jumpOffset(player, 999), 0);
  assert.equal(jumpOffset(player, 1000), 0);
  assert.equal(jumpOffset(player, 1000 + JUMP_DURATION_MS / 2), JUMP_HEIGHT);
  assert.equal(jumpOffset(player, 1000 + JUMP_DURATION_MS), 0);
  assert.equal(jumpOffset(player, 9999), 0);
  assert.ok(
    Math.abs(jumpOffset(player, 1100) - jumpOffset(player, 1600)) < 1e-10,
  );
});
