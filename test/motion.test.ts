import assert from "node:assert/strict";
import { test } from "node:test";
import { smoothPosition } from "../client/motion";
test("l’appui déplace le joueur dès l’image suivante, avant la réponse réseau", () => {
  const sample = {
    x: 430,
    targetX: 430,
    sampledAt: 1000,
    local: true,
    direction: 1,
    speed: 300,
  };
  assert.equal(smoothPosition(sample, 1 / 60, 1000 + 1000 / 60), 435);
});
test("la prédiction reste dans l’arène même aux limites avec accélération", () => {
  for (const direction of [-1, 1]) {
    let x = direction < 0 ? 0 : 915;
    for (let n = 0; n < 120; n++) {
      x = smoothPosition(
        {
          x,
          targetX: direction < 0 ? 0 : 915,
          sampledAt: 0,
          local: true,
          direction,
          speed: 450,
        },
        1 / 60,
        (n * 1000) / 60,
      );
      assert.ok(x >= 0 && x <= 915);
    }
  }
});
test("les positions adverses et l’arrêt convergent sans dépasser la correction serveur", () => {
  for (const local of [false, true]) {
    let x = 430;
    for (let n = 0; n < 60; n++) {
      x = smoothPosition(
        { x, targetX: 580, sampledAt: 0, local, direction: 0, speed: 300 },
        1 / 60,
        (n * 1000) / 60,
      );
      assert.ok(x >= 430 && x <= 580);
    }
    assert.ok(Math.abs(x - 580) < 0.01);
  }
});
