import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arenaX,
  ARENA_WIDTH,
  ARENA_HEIGHT,
  PILOT_TOP,
  PILOT_FLOOR,
} from "../client/arenaLayout";
test("le cadrage 2D garde les petits pilotes visibles aux bords en portrait et paysage", () => {
  for (const width of [720, ARENA_WIDTH])
    for (const x of [0, 450, 915]) {
      const center = arenaX(x + 22.5, width);
      assert.ok(center - 22 > 0 && center + 22 < width);
    }
  assert.equal(PILOT_FLOOR - PILOT_TOP, 88);
  assert.ok(PILOT_FLOOR < ARENA_HEIGHT);
  assert.equal(arenaX(960) - arenaX(0), 900);
});
