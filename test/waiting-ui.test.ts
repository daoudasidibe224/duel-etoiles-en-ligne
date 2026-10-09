import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const load = createRequire(__filename);
const pug = load("pug") as {
  renderFile: (file: string, locals: Record<string, unknown>) => string;
};
const html = pug.renderFile("public/views/jeu.pug", {
  nomDuSalon: "Alice",
  utilisateur: { nomUtilisateur: "Alice" },
});
const bundle = build({
  entryPoints: ["client/jeuClient.ts"],
  bundle: true,
  write: false,
  format: "iife",
  plugins: [
    {
      name: "renderer-fixture",
      setup(plugin) {
        plugin.onResolve({ filter: /arenaRenderer$/ }, () => ({
          path: "renderer",
          namespace: "renderer-fixture",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "renderer-fixture" }, () => ({
          contents:
            "export class ArenaRenderer { constructor(canvas) { this.canvas = canvas; } render() {} dispose() {} }",
        }));
      },
    },
    {
      name: "socket-fixture",
      setup(plugin) {
        plugin.onResolve({ filter: /^socket.io-client$/ }, () => ({
          path: "socket",
          namespace: "fixture",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: "export const io = () => globalThis.fixtureSocket",
        }));
      },
    },
  ],
});

class NodeFixture {
  textContent = "";
  hidden = false;
  disabled = false;
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  classes = new Set<string>();
  parentElement: NodeFixture | null = null;
  classList = {
    add: (value: string) => this.classes.add(value),
    toggle: (value: string, force: boolean) =>
      force ? this.classes.add(value) : this.classes.delete(value),
  };
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener() {}
}
class CanvasFixture extends NodeFixture {
  getContext() {
    return new Proxy({}, { get: () => () => {}, set: () => true });
  }
}
async function clientFixture() {
  const nodes = new Map<string, NodeFixture>();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g))
    nodes.set(
      id,
      id === "gameCanvas" ? new CanvasFixture() : new NodeFixture(),
    );
  const get = (id: string) => {
    const node = nodes.get(id);
    assert.ok(node, id);
    return node;
  };
  get("other-score").parentElement = new NodeFixture();
  const handlers = new Map<string, (payload?: unknown) => void>();
  const socket = {
    on: (name: string, handler: (payload?: unknown) => void) => {
      handlers.set(name, handler);
      return socket;
    },
    emit() {},
    timeout: () => socket,
  };
  runInNewContext((await bundle).outputFiles![0].text, {
    fixtureSocket: socket,
    document: {
      getElementById: get,
      querySelector: () => new NodeFixture(),
      addEventListener() {},
    },
    window: { addEventListener() {} },
    location: { pathname: "/jeu/fixture-room" },
    HTMLCanvasElement: CanvasFixture,
    HTMLButtonElement: NodeFixture,
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  const event = (name: string, payload?: unknown) => {
    assert.ok(handlers.has(name));
    handlers.get(name)!(payload);
  };
  const player = (name: string) => ({
    id: name,
    userId: name,
    nomUtilisateur: name,
    room: "fixture-room",
    kind: "guest",
    score: 0,
    usedStages: [],
  });
  const alice = player("Alice"),
    bob = player("Bob");
  const room = {
    room: "fixture-room",
    ownerId: "Alice",
    utilisateurs: [alice, bob],
  };
  event("identity", "Alice");
  return { get, event, alice, bob, room };
}

test("la page initiale annonce l’attente et ne présente pas de faux score adverse", () => {
  assert.match(html, /id="timer-label">Durée prévue</);
  assert.match(html, /id="other-name">Place libre</);
  assert.match(html, /id="other-score"[^>]*>—</);
  assert.match(html, /id="gameCanvas"[^>]*hidden/);
  assert.match(html, /src="\/images\/arena-preview.jpg"/);
});

test("l’aperçu suit attente, arrivée, départ, reprise, fin et restauration", async () => {
  const { get, event, alice, room } = await clientFixture();
  event("roomData", { ...room, utilisateurs: [alice] });
  assert.equal(get("arena-waiting").hidden, false);
  assert.equal(get("gameCanvas").hidden, true);
  assert.equal(get("timer-label").textContent, "Durée prévue");
  assert.equal(get("countdown").getAttribute("role"), null);
  assert.equal(get("other-name").textContent, "Place libre");
  assert.equal(get("other-score").textContent, "—");
  event("roomData", room);
  assert.equal(get("waiting-title").textContent, "Tout le monde est prêt");
  assert.equal(get("other-name").textContent, "Bob");
  assert.equal(get("other-score").textContent, "0");
  const now = Date.now();
  const round = {
    id: randomUUID(),
    startedAt: now,
    endsAt: now + 90000,
    ended: false,
    saved: false,
    stars: [],
    stage: 0,
  };
  event("init", round);
  assert.equal(get("arena-waiting").hidden, true);
  assert.equal(get("gameCanvas").hidden, false);
  assert.equal(get("timer-label").textContent, "Temps restant");
  assert.equal(get("countdown").getAttribute("role"), "timer");
  event("disconnect");
  event("roomData", { ...room, round });
  event("init", round);
  assert.equal(get("arena-waiting").hidden, true);
  assert.equal(get("gameCanvas").hidden, false);
  event("roundEnded", {
    ...room,
    round: { ...round, ended: true, saved: true },
    utilisateurs: [
      { ...alice, score: 3 },
      { ...room.utilisateurs[1], score: 2 },
    ],
  });
  assert.equal(get("arena-waiting").hidden, true);
  assert.equal(get("countdown").textContent, "0:00");
  assert.equal(get("gameCanvas").hidden, false);
  assert.equal(get("timer-label").textContent, "Temps restant");
  assert.equal(get("self-score").textContent, "3");
  assert.equal(get("other-score").textContent, "2");
  assert.equal(get("bonus-status").textContent, "Manche terminée.");
  event("roomData", {
    ...room,
    round: { ...round, ended: true, saved: true },
    utilisateurs: [{ ...alice, score: 3 }],
  });
  assert.equal(
    get("other-name").textContent,
    "Bob",
    "le départ de l’adversaire garde le résultat affiché",
  );
  assert.equal(get("other-score").textContent, "2");
  event("roomData", { ...room, recoveryNotice: "Manche interrompue." });
  assert.equal(get("arena-waiting").hidden, false);
  assert.equal(get("gameCanvas").hidden, true);
  assert.equal(get("timer-label").textContent, "Durée prévue");
  assert.equal(get("countdown").textContent, "1:30");
  assert.equal(get("self-score").textContent, "0");
  assert.equal(get("other-score").textContent, "0");
});
