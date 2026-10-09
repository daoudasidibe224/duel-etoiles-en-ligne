import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arenaX,
  ARENA_WIDTH,
  ARENA_HEIGHT,
  PILOT_TOP,
  PILOT_FLOOR,
} from "../client/arenaLayout";
test("le cadrage 2D garde les silhouettes aux bords et aligne les objets sur les pilotes", () => {
  for (const x of [0, 450, 915]) {
    const center = arenaX(x + 22.5);
    assert.ok(center - 39 > 0 && center + 39 < ARENA_WIDTH);
  }
  assert.equal(PILOT_TOP, 330); // Upper swept collision boundary.
  assert.equal(PILOT_FLOOR, 490);
  assert.ok(PILOT_FLOOR < ARENA_HEIGHT);
  assert.equal(arenaX(960) - arenaX(0), 900);
});
