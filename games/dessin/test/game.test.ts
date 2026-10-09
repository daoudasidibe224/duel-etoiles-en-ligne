import { test } from "node:test";
import assert from "node:assert/strict";
import { GameRoom } from "../server/game";
import type { Stroke } from "../shared/contracts";
const a = { id: "alice", name: "Alice" },
  b = { id: "bob", name: "Bob" },
  c = { id: "cam", name: "Cam" };
const stroke: Stroke = {
  id: "trait",
  x: 0.2,
  y: 0.4,
  px: 0.1,
  py: 0.3,
  color: "#1f3b63",
  width: 10,
};
function room() {
  const room = new GameRoom("Test", () => {}, {
    countdownMs: 0,
    chooseMs: 5000,
    drawMs: 5000,
    revealMs: 5000,
  });
  room.join(a);
  room.join(b);
  return room;
}
test("hôte, mots secrets et permissions du dessinateur", () => {
  const current = room();
  try {
    assert.throws(() => current.start(b.id, 1, 60), /hôte/);
    current.start(a.id, 1, 60);
    assert.equal(current.phase, "choosing");
    assert.equal(current.snapshot(b.id).choices, undefined);
    assert.equal(current.snapshot(a.id).choices?.length, 3);
    assert.throws(() => current.choose(b.id, "chat"));
    assert.throws(() => current.choose(a.id, "mot inexistant"));
    const word = current.snapshot(a.id).choices?.[0];
    assert.ok(word);
    current.choose(a.id, word);
    assert.equal(current.snapshot(a.id).word, word);
    assert.equal(current.snapshot(b.id).word, undefined);
    assert.throws(() => current.draw(b.id, stroke));
    assert.throws(() => current.undo(b.id));
    assert.throws(() => current.clear(b.id));
    current.draw(a.id, stroke);
    current.draw(a.id, { ...stroke, x: 0.5 });
    assert.equal(current.history.length, 2);
    current.undo(a.id);
    assert.equal(current.history.length, 0);
    current.draw(a.id, stroke);
    current.clear(a.id);
    assert.equal(current.history.length, 0);
  } finally {
    current.close();
  }
});
test("score autoritaire, réponse masquée et répétitions", () => {
  const current = room();
  current.join(c);
  try {
    current.start(a.id, 1, 60);
    const word = current.snapshot(a.id).choices?.[0];
    assert.ok(word);
    current.choose(a.id, word);
    assert.throws(() => current.guess(a.id, word), /secret/);
    current.guess(b.id, word.toUpperCase());
    assert.equal(current.players.get(b.id)?.guessed, true);
    assert.ok((current.players.get(b.id)?.score || 0) >= 100);
    assert.equal(current.players.get(a.id)?.score, 50);
    assert.equal(current.snapshot(c.id).word, undefined);
    assert.equal(current.messages.at(-1)?.text, "Bob a trouvé le mot !");
    assert.throws(() => current.guess(b.id, word), /déjà/);
    current.guess(c.id, word);
    assert.equal(current.phase, "reveal");
    assert.equal(current.snapshot(b.id).word, word);
  } finally {
    current.close();
  }
});
test("limites, départ de l’hôte, départ du dessinateur et salons indépendants", () => {
  const current = room(),
    other = room();
  try {
    for (let i = 0; i < 8; i++)
      current.join({ id: "extra" + i, name: "Extra" });
    assert.throws(
      () => current.join({ id: "overflow", name: "Extra" }),
      /complet/,
    );
    current.start(a.id, 1, 30);
    assert.throws(() => current.join({ id: "late", name: "Retard" }));
    current.leave(a.id);
    assert.equal(current.host, b.id);
    assert.equal(current.phase, "reveal");
    assert.equal(other.phase, "waiting");
    current.leave(b.id);
    assert.notEqual(current.host, b.id);
    for (const id of [...current.players.keys()].slice(1)) current.leave(id);
    assert.equal(current.phase, "waiting");
  } finally {
    current.close();
    other.close();
  }
});
test("délais automatiques et partie terminée", async () => {
  const current = new GameRoom("Chrono", () => {}, {
    countdownMs: 0,
    chooseMs: 20,
    drawMs: 20,
    revealMs: 20,
  });
  current.join(a);
  current.join(b);
  current.start(a.id, 1, 30);
  try {
    const until = Date.now() + 3000;
    while (current.phase !== "finished" && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(current.phase, "finished");
    assert.equal(current.round, 1);
    assert.equal(current.deadline, 0);
  } finally {
    current.close();
  }
});
test("reconnexion conserve les points et la toile", () => {
  const current = room();
  try {
    current.start(a.id, 1, 60);
    const word = current.snapshot(a.id).choices?.[0];
    assert.ok(word);
    current.choose(a.id, word);
    current.draw(a.id, stroke);
    current.players.get(b.id)!.score = 12;
    current.disconnect(b.id);
    assert.equal(current.players.get(b.id)?.connected, false);
    current.join(b);
    assert.equal(current.players.get(b.id)?.score, 12);
    assert.deepEqual(current.snapshot(b.id).history, [stroke]);
  } finally {
    current.close();
  }
});
test("historique et chat bornés", () => {
  const current = room();
  try {
    for (let i = 0; i < 110; i++) current.chat(b.id, "message" + i);
    assert.equal(current.messages.length, 100);
    current.start(a.id, 1, 60);
    const word = current.snapshot(a.id).choices?.[0];
    assert.ok(word);
    current.choose(a.id, word);
    current.history = Array.from({ length: 20000 }, () => stroke);
    assert.throws(() => current.draw(a.id, stroke), /pleine/);
  } finally {
    current.close();
  }
});

test("rétablissement invalidé par nouveau trait et carnet borné sans divulgation anticipée", async () => {
  const current = new GameRoom("Archives", () => {}, {
    countdownMs: 0,
    chooseMs: 10000,
    drawMs: 10000,
    revealMs: 5,
  });
  current.join(a);
  current.join(b);
  current.start(a.id, 5, 60);
  try {
    const word = current.snapshot(a.id).choices?.[0];
    assert.ok(word);
    current.choose(a.id, word);
    current.draw(a.id, stroke);
    current.undo(a.id);
    assert.equal(current.snapshot(a.id).canRedo, true);
    current.draw(a.id, { ...stroke, id: "nouveau" });
    assert.equal(current.snapshot(a.id).canRedo, false);
    assert.throws(() => current.redo(a.id), /Aucun/);
    assert.equal(current.snapshot(b.id).gallery.length, 0);
    for (let i = 0; i < 8; i++) {
      current.skip(current.drawer);
      assert.equal(
        current.gallery.filter((round) => round.id === current.turn).length,
        1,
      );
      const deadline = Date.now() + 1000;
      while (current.phase === "reveal" && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(current.phase, "choosing");
    }
    assert.equal(current.gallery.length, 6);
    assert.equal(new Set(current.gallery.map((round) => round.id)).size, 6);
    assert.ok(current.gallery[0].word);
  } finally {
    current.close();
  }
});

test("réponses fermées avant dessin, après délai/révélation/fin et discussion sans score", () => {
  const current = room();
  try {
    assert.throws(() => current.guess(b.id, "chat"), /uniquement/);
    current.chat(b.id, "chat");
    assert.equal(current.players.get(b.id)?.score, 0);
    current.start(a.id, 1, 60);
    assert.throws(() => current.guess(b.id, "chat"), /uniquement/);
    assert.throws(() => current.chat(b.id, "chat"), /discussion/);
    const word = current.snapshot(a.id).choices?.[0];
    assert.ok(word);
    current.choose(a.id, word);
    assert.throws(() => current.guess(a.id, "un autre mot"), /secret/);
    assert.throws(() => current.chat(b.id, word), /discussion/);
    current.deadline = Date.now() - 1;
    assert.throws(() => current.guess(b.id, word), /uniquement/);
    current.skip(a.id);
    assert.throws(() => current.guess(b.id, word), /uniquement/);
    current.chat(b.id, word);
    assert.equal(current.players.get(b.id)?.score, 0);
    current.phase = "finished";
    assert.throws(() => current.guess(b.id, word), /uniquement/);
    assert.throws(() => current.draw(a.id, stroke));
  } finally {
    current.close();
  }
});

test("compte à rebours réel : aucun dessin/réponse, un seul départ et départ annulé si joueur quitte", async () => {
  const current = new GameRoom("Départ", () => {}, {
    countdownMs: 30,
    drawMs: 5000,
  });
  current.join(a);
  current.join(b);
  current.start(a.id, 1, 60);
  const word = current.snapshot(a.id).choices?.[0];
  assert.ok(word);
  current.choose(a.id, word);
  assert.equal(current.phase, "countdown");
  assert.equal(current.snapshot(a.id).word, undefined);
  assert.throws(() => current.draw(a.id, stroke));
  assert.throws(() => current.guess(b.id, word), /uniquement/);
  assert.throws(() => current.chat(b.id, word), /discussion/);
  assert.throws(() => current.choose(a.id, word));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(current.phase, "drawing");
  current.draw(a.id, stroke);
  current.deadline = Date.now() - 1;
  assert.throws(() => current.draw(a.id, stroke));
  current.close();
  const interrupted = new GameRoom("Interrompu", () => {}, { countdownMs: 30 });
  interrupted.join(a);
  interrupted.join(b);
  interrupted.start(a.id, 1, 60);
  const other = interrupted.snapshot(a.id).choices?.[0];
  assert.ok(other);
  interrupted.choose(a.id, other);
  interrupted.leave(b.id);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(interrupted.phase, "waiting");
  assert.equal(interrupted.deadline, 0);
  assert.equal(interrupted.gallery.length, 0);
  interrupted.close();
});
