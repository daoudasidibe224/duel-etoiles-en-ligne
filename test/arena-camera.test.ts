import assert from "node:assert/strict";
import { test } from "node:test";
import { Vector3 } from "three";
import { createArenaCamera } from "../client/arenaCamera";
test("le cadrage 3D garde les robots, le sol et la zone de contact visibles", () => {
  const camera = createArenaCamera();
  for (const x of [22.5, 452.5, 552.5, 937.5]) {
    for (const y of [-0.35, 0, 2.3]) {
      const projected = new Vector3((x - 480) / 48, y, 0).project(camera);
      assert.ok(
        Math.abs(projected.x) < 1 &&
          Math.abs(projected.y) < 1 &&
          Math.abs(projected.z) < 1,
        `${x}, ${y}`,
      );
    }
  }
  const upperContact = new Vector3(0, (490 - 382) / 48, 0).project(camera);
  const robotTop = new Vector3(0, 2.3, 0).project(camera);
  assert.ok(upperContact.y < robotTop.y);
});
