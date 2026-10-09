import * as T from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { createArenaCamera } from "./arenaCamera";
import type { Player, Star } from "../shared/contracts";
import { activeBonus, itemY } from "../shared/progression";
export type VisualRunner = Pick<
  Player,
  "id" | "x" | "bonus" | "slowedUntil" | "feedback"
> & { color: string; moving: boolean; facing: number; local: boolean };
export const ITEM_COLORS: Record<Star["kind"], string> = {
  star: "#ffda62",
  gold: "#ffbc38",
  sprint: "#56e5ff",
  multiplier: "#ba9aff",
  shield: "#78efa9",
  magnet: "#fa94d6",
  meteor: "#ff715c",
  slime: "#b6e757",
  barrier: "#ff9868",
};
function material(color: string, glow = false) {
  return new T.MeshStandardMaterial({
    color,
    roughness: 0.38,
    metalness: 0.25,
    emissive: glow ? color : "#000000",
    emissiveIntensity: glow ? 0.4 : 0,
  });
}
function mesh(
  parent: T.Object3D,
  geometry: T.BufferGeometry,
  mat: T.Material,
  position: [number, number, number],
  scale?: [number, number, number],
) {
  const part = new T.Mesh(geometry, mat);
  part.position.set(...position);
  if (scale) part.scale.set(...scale);
  parent.add(part);
  return part;
}
function dispose(root: T.Object3D) {
  root.traverse((part) => {
    if (
      part instanceof T.Mesh ||
      part instanceof T.Sprite ||
      part instanceof T.Points
    ) {
      if (part instanceof T.Mesh || part instanceof T.Points)
        part.geometry.dispose();
      for (const mat of Array.isArray(part.material)
        ? part.material
        : [part.material]) {
        if ("map" in mat && mat.map instanceof T.Texture) mat.map.dispose();
        mat.dispose();
      }
    }
  });
}
function label(text: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 80;
  const ctx = canvas.getContext("2d")!;
  let fontSize = 38;
  ctx.font = `bold ${fontSize}px sans-serif`;
  while (ctx.measureText(text).width > 238 && fontSize > 14)
    ctx.font = `bold ${--fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "#101c2b";
  ctx.lineWidth = 9;
  ctx.strokeText(text, 128, 40);
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 40);
  const sprite = new T.Sprite(
    new T.SpriteMaterial({
      map: new T.CanvasTexture(canvas),
      depthTest: false,
    }),
  );
  sprite.scale.set(1.8, 0.56, 1);
  return sprite;
}
function starGeometry() {
  const shape = new T.Shape();
  for (let i = 0; i <= 10; i++) {
    const a = (i * Math.PI) / 5 + Math.PI / 2,
      r = i % 2 ? 0.16 : 0.35;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  return new T.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: true,
    bevelSize: 0.025,
    bevelThickness: 0.025,
    bevelSegments: 1,
    steps: 1,
  });
}
function robot(color: string) {
  const group = new T.Group(),
    shell = material(color),
    dark = material("#182a3d"),
    bright = material("#d8fbff", true);
  mesh(
    group,
    new RoundedBoxGeometry(0.65, 0.54, 0.4, 2, 0.1),
    shell,
    [0, 0.68, 0],
  );
  mesh(
    group,
    new T.SphereGeometry(0.42, 16, 12),
    shell,
    [0, 1.15, 0],
    [1, 0.82, 0.85],
  );
  mesh(
    group,
    new RoundedBoxGeometry(0.61, 0.23, 0.12, 2, 0.08),
    dark,
    [0, 1.15, 0.32],
  );
  for (const x of [-0.14, 0.14])
    mesh(
      group,
      new T.SphereGeometry(0.055, 8, 6),
      bright,
      [x, 1.16, 0.4],
      [1, 1.35, 0.6],
    );
  mesh(
    group,
    new T.CylinderGeometry(0.023, 0.023, 0.21, 6),
    dark,
    [0.05, 1.58, 0],
  );
  mesh(group, new T.SphereGeometry(0.065, 8, 6), bright, [0.05, 1.7, 0]);
  mesh(group, new T.TorusGeometry(0.1, 0.023, 6, 12), bright, [0, 0.72, 0.225]);
  const legs: T.Group[] = [],
    arms: T.Group[] = [];
  for (const x of [-1, 1]) {
    const arm = new T.Group();
    arm.position.set(x * 0.43, 0.83, 0);
    group.add(arm);
    mesh(arm, new T.SphereGeometry(0.12, 8, 6), dark, [0, 0, 0]);
    mesh(arm, new T.CapsuleGeometry(0.09, 0.19, 3, 8), shell, [0, -0.18, 0]);
    arms.push(arm);
    const leg = new T.Group();
    leg.position.set(x * 0.18, 0.4, 0);
    group.add(leg);
    mesh(leg, new T.CapsuleGeometry(0.095, 0.17, 3, 8), dark, [0, -0.14, 0]);
    mesh(
      leg,
      new RoundedBoxGeometry(0.24, 0.14, 0.34, 1, 0.05),
      shell,
      [0, -0.33, 0.045],
    );
    legs.push(leg);
  }
  const shield = mesh(
    group,
    new T.SphereGeometry(0.92, 16, 10),
    new T.MeshBasicMaterial({
      color: "#78efa9",
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      wireframe: true,
    }),
    [0, 0.78, 0],
  );
  const ring = mesh(
    group,
    new T.TorusGeometry(0.6, 0.022, 6, 28),
    material(color, true),
    [0, 0.015, 0],
  );
  ring.rotation.x = Math.PI / 2;
  const shadow = mesh(
    group,
    new T.CircleGeometry(0.5, 20),
    new T.MeshBasicMaterial({
      color: "#061119",
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    }),
    [0, 0.01, 0],
  );
  shadow.rotation.x = -Math.PI / 2;
  return {
    group,
    name: undefined as T.Sprite | undefined,
    legs,
    arms,
    shield,
    ring,
    feedback: undefined as T.Sprite | undefined,
    feedbackId: "",
  };
}
export class ArenaRenderer {
  private renderer?: T.WebGLRenderer;
  private fallback?: CanvasRenderingContext2D;
  private scene = new T.Scene();
  private camera = createArenaCamera();
  private robots = new Map<string, ReturnType<typeof robot>>();
  private objects = new Map<string, T.Group>();
  private width = 0;
  private lost = false;
  private reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    .matches;
  constructor(
    public canvas: HTMLCanvasElement,
    private notice: HTMLElement,
  ) {
    try {
      this.renderer = new T.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: "low-power",
        alpha: false,
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.outputColorSpace = T.SRGBColorSpace;
      this.renderer.toneMapping = T.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.4;
      canvas.dataset.renderer = "webgl-3d";
      this.scene.background = new T.Color("#101f31");
      this.scene.fog = new T.Fog("#101f31", 20, 40);
      const backdropCanvas = document.createElement("canvas");
      backdropCanvas.width = 8;
      backdropCanvas.height = 256;
      const backdropContext = backdropCanvas.getContext("2d")!;
      const sky = backdropContext.createLinearGradient(0, 0, 0, 256);
      sky.addColorStop(0, "#201c3c");
      sky.addColorStop(0.5, "#172c45");
      sky.addColorStop(1, "#305259");
      backdropContext.fillStyle = sky;
      backdropContext.fillRect(0, 0, 8, 256);
      const skyTexture = new T.CanvasTexture(backdropCanvas);
      skyTexture.colorSpace = T.SRGBColorSpace;
      mesh(
        this.scene,
        new T.PlaneGeometry(60, 30),
        new T.MeshBasicMaterial({ map: skyTexture, fog: false }),
        [0, 5, -18],
      );
      for (let i = 0; i < 5; i++) {
        const island = mesh(
          this.scene,
          new T.ConeGeometry(1.5 + (i % 2), 1.8 + (i % 3), 5),
          material(i % 2 ? "#293e50" : "#31505a"),
          [i * 4.3 - 8.6, -0.3, -7],
        );
        island.rotation.z = Math.PI;
        mesh(
          this.scene,
          new T.CylinderGeometry(0.7, 1.3, 0.25, 6),
          material("#385960"),
          [i * 4.3 - 8.6, 0.75 + (i % 3) * 0.5, -7],
        );
        const crystal = mesh(
          this.scene,
          new T.OctahedronGeometry(0.24 + (i % 2) * 0.12),
          material(i % 2 ? "#ad83e9" : "#6cc5cc", true),
          [i * 4.3 - 8.6, 1.2 + (i % 3) * 0.5, -7],
        );
        crystal.scale.y = 1.7;
      }
      this.scene.add(new T.HemisphereLight("#bedaff", "#7c715b", 2.5));
      const key = new T.DirectionalLight("#fff2d5", 4);
      key.position.set(-5, 10, 9);
      this.scene.add(key);
      const rim = new T.DirectionalLight("#8de4d3", 2);
      rim.position.set(7, 4, -6);
      this.scene.add(rim);
      mesh(
        this.scene,
        new RoundedBoxGeometry(21, 0.65, 5, 2, 0.17),
        material("#2c4653"),
        [0, -0.37, -0.6],
      );
      mesh(
        this.scene,
        new T.BoxGeometry(20.2, 0.06, 3.7),
        material("#3a6267"),
        [0, -0.02, -0.6],
      );
      for (const z of [-2.1, 1.05])
        mesh(
          this.scene,
          new T.BoxGeometry(20.1, 0.04, 0.045),
          material("#9dd9bd", true),
          [0, 0.04, z],
        );
      for (let x = -9; x <= 9; x++)
        mesh(
          this.scene,
          new T.BoxGeometry(0.025, 0.01, 3.1),
          material("#547779"),
          [x, 0.03, -0.6],
        );
      const positions: number[] = [],
        colors: number[] = [];
      for (let i = 0; i < 120; i++) {
        positions.push(
          ((i * 73) % 201) / 10 - 10,
          ((i * 31) % 110) / 10 + 0.8,
          -8 - (i % 5),
        );
        const tint = new T.Color(i % 3 ? "#87b8bf" : "#ffe8b0");
        colors.push(tint.r, tint.g, tint.b);
      }
      const dots = new T.BufferGeometry();
      dots.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
      dots.setAttribute("color", new T.Float32BufferAttribute(colors, 3));
      this.scene.add(
        new T.Points(
          dots,
          new T.PointsMaterial({
            size: 0.045,
            vertexColors: true,
            sizeAttenuation: true,
          }),
        ),
      );
      mesh(
        this.scene,
        new T.SphereGeometry(1.15, 24, 16),
        material("#859cb4"),
        [-6.8, 6.2, -9],
      );
      const orbit = mesh(
        this.scene,
        new T.TorusGeometry(1.85, 0.035, 6, 56),
        material("#a4cbc4", true),
        [-6.8, 6.2, -9],
      );
      orbit.rotation.set(0.8, 0.3, 0.2);
      for (const x of [-9.7, 9.7]) {
        mesh(
          this.scene,
          new T.CylinderGeometry(0.12, 0.18, 1.3, 8),
          material("#667d8b"),
          [x, 0.6, -1.8],
        );
        mesh(
          this.scene,
          new T.SphereGeometry(0.15, 8, 6),
          material("#baf4cd", true),
          [x, 1.3, -1.8],
        );
      }
      canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        this.lost = true;
        notice.hidden = false;
        notice.textContent =
          "Affichage 3D interrompu. La partie continue ; le navigateur tente de le rétablir.";
      });
      canvas.addEventListener("webglcontextrestored", () => {
        this.lost = false;
        notice.hidden = true;
        this.width = 0;
      });
    } catch {
      // Replace the failed WebGL canvas: a canvas cannot switch rendering contexts.
      const replacement = canvas.cloneNode() as HTMLCanvasElement;
      canvas.replaceWith(replacement);
      this.canvas = replacement;
      this.fallback = replacement.getContext("2d") ?? undefined;
      replacement.dataset.renderer = "2d-fallback";
      notice.hidden = false;
      notice.textContent =
        "La 3D est indisponible sur ce navigateur. Le jeu reste jouable en vue simplifiée.";
    }
  }
  render(players: VisualRunner[], items: Star[], now = Date.now()) {
    if (this.fallback) {
      this.renderFallback(players, items, now);
      return;
    }
    if (!this.renderer || this.lost) return;
    const width = Math.max(
      320,
      Math.round(this.canvas.getBoundingClientRect().width),
    );
    if (width !== this.width) {
      this.width = width;
      this.renderer.setSize(width, Math.round((width * 9) / 16), false);
    }
    const time = this.reduced ? 0 : now / 1000;
    for (const [id, bot] of this.robots)
      if (!players.some((p) => p.id === id)) {
        this.scene.remove(bot.group);
        dispose(bot.group);
        this.robots.delete(id);
      }
    for (const player of players) {
      let bot = this.robots.get(player.id);
      if (!bot) {
        bot = robot(player.color);
        this.robots.set(player.id, bot);
        this.scene.add(bot.group);
      }
      bot.group.scale.setScalar(1.35);
      if (!bot.name) {
        bot.name = label(player.local ? "VOUS" : "RIVAL", player.color);
        bot.name.scale.set(1.2, 0.36, 1);
        bot.name.position.set(0, 2.0, 0);
        bot.group.add(bot.name);
      }
      bot.group.position.set((player.x + 22.5 - 480) / 48, 0, 0);
      bot.group.rotation.y = player.facing * 0.28;
      const stride = player.moving ? Math.sin(time * 15) * 0.45 : 0;
      bot.legs.forEach((leg, i) => (leg.rotation.x = stride * (i ? 1 : -1)));
      bot.arms.forEach((arm, i) => (arm.rotation.x = stride * (i ? -1 : 1)));
      const effect = activeBonus(player, now);
      bot.shield.visible = effect?.kind === "shield";
      const aura = bot.ring.material as T.MeshStandardMaterial;
      aura.color.set(effect ? ITEM_COLORS[effect.kind] : player.color);
      aura.emissive.copy(aura.color);
      if (player.feedback && now - player.feedback.at < 600 && !this.reduced) {
        if (player.feedback.good)
          bot.arms.forEach((arm, i) => (arm.rotation.z = i ? -0.8 : 0.8));
        else bot.group.rotation.z = Math.sin(time * 35) * 0.045;
      } else {
        bot.arms.forEach((arm) => (arm.rotation.z = 0));
        bot.group.rotation.z = 0;
      }

      bot.ring.scale.setScalar(
        activeBonus(player, now)?.kind === "magnet" ? 2.8 : 1,
      );
      if (player.feedback && bot.feedbackId !== player.feedback.id) {
        if (bot.feedback) {
          bot.group.remove(bot.feedback);
          dispose(bot.feedback);
        }
        bot.feedbackId = player.feedback.id;
        bot.feedback = label(
          player.feedback.text,
          player.feedback.good ? "#d5ffc4" : "#ffb199",
        );
        bot.group.add(bot.feedback);
      }
      if (bot.feedback) {
        const age = (now - (player.feedback?.at ?? 0)) / 1000;
        bot.feedback.visible = age < 1.5;
        bot.name.visible = !bot.feedback.visible;
        bot.feedback.position.set(0, 2.4 + Math.min(0.35, age * 0.2), 0);
        bot.feedback.scale.set(2.8, 0.7, 1);
      }
    }
    for (const [id, obj] of this.objects)
      if (!items.some((item) => item.id === id)) {
        this.scene.remove(obj);
        dispose(obj);
        this.objects.delete(id);
      }
    for (const item of items) {
      let obj = this.objects.get(item.id);
      if (!obj) {
        obj = new T.Group();
        const color = ITEM_COLORS[item.kind],
          mat = material(color, true);
        if (item.kind === "star" || item.kind === "gold") {
          const body = mesh(obj, starGeometry(), mat, [0, 0, 0]);
          if (item.kind === "gold") body.scale.setScalar(1.3);
        } else if (item.kind === "meteor")
          mesh(obj, new T.IcosahedronGeometry(0.36, 0), mat, [0, 0, 0]);
        else if (item.kind === "barrier") {
          mesh(
            obj,
            new RoundedBoxGeometry(0.62, 0.7, 0.55, 1, 0.05),
            mat,
            [0, 0, 0],
          );
          for (const angle of [-0.7, 0.7]) {
            const stripe = mesh(
              obj,
              new T.BoxGeometry(0.5, 0.09, 0.015),
              material("#29394b"),
              [0, 0, 0.29],
            );
            stripe.rotation.z = angle;
          }
        } else if (item.kind === "slime")
          mesh(
            obj,
            new T.SphereGeometry(0.34, 12, 8),
            mat,
            [0, 0, 0],
            [1, 0.6, 1],
          );
        else {
          mesh(obj, new T.OctahedronGeometry(0.3), mat, [0, 0, 0]);
          mesh(
            obj,
            new T.TorusGeometry(0.44, 0.045, 6, 20),
            mat.clone(),
            [0, 0, 0],
          );
        }
        if (item.kind !== "star") {
          const tag = label(
            {
              gold: "+3",
              sprint: "VITESSE",
              multiplier: "×2",
              shield: "PROTECTION",
              magnet: "AIMANT",
              meteor: "−3",
              slime: "RALENTIT",
              barrier: "−2",
              star: "+1",
            }[item.kind],
            color,
          );
          tag.position.y = 0.7;
          tag.scale.set(2.6, 0.68, 1);
          obj.add(tag);
        }
        if (["meteor", "barrier", "slime"].includes(item.kind)) {
          const warning = mesh(
            obj,
            new T.RingGeometry(0.35, 0.5, 20),
            new T.MeshBasicMaterial({
              color,
              transparent: true,
              opacity: 0.38,
              side: T.DoubleSide,
              depthWrite: false,
            }),
            [0, 0, 0],
          );
          warning.rotation.x = -Math.PI / 2;
          warning.userData.ground = true;
        }
        this.objects.set(item.id, obj);
        this.scene.add(obj);
      }
      obj.position.set((item.x - 480) / 48, (490 - itemY(item, now)) / 48, 0);
      for (const part of obj.children)
        if (part.userData.ground) {
          part.position.y = 0.05 - obj.position.y;
          part.visible = itemY(item, now) < 425;
        }
      // Rotate geometry, keep the price/effect label facing the camera.
      for (const part of obj.children)
        if (
          part instanceof T.Mesh &&
          !part.userData.ground &&
          item.kind !== "barrier"
        )
          part.rotation.y = time * 1.4;
    }
    this.renderer.render(this.scene, this.camera);
  }
  private renderFallback(players: VisualRunner[], items: Star[], now: number) {
    const ctx = this.fallback!;
    this.canvas.width = 960;
    this.canvas.height = 540;
    ctx.fillStyle = "#101f31";
    ctx.fillRect(0, 0, 960, 540);
    ctx.fillStyle = "#3a6267";
    ctx.fillRect(0, 490, 960, 50);
    for (const player of players) {
      ctx.fillStyle = player.color;
      ctx.fillRect(player.x, 433, 45, 57);
      ctx.fillStyle = "#142136";
      ctx.fillRect(player.x + 5, 440, 35, 15);
      ctx.fillStyle = "#e7ffff";
      ctx.fillRect(player.x + 10, 445, 5, 5);
      ctx.fillRect(player.x + 30, 445, 5, 5);
    }
    for (const item of items) {
      ctx.fillStyle = ITEM_COLORS[item.kind];
      ctx.beginPath();
      ctx.arc(item.x, itemY(item, now), 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "bold 16px sans-serif";
      ctx.fillText(
        item.kind === "meteor"
          ? "−3"
          : item.kind === "barrier"
            ? "−2"
            : item.kind === "star"
              ? "★"
              : item.kind === "gold"
                ? "+3"
                : item.kind === "multiplier"
                  ? "×2"
                  : item.kind === "sprint"
                    ? ">>"
                    : item.kind === "shield"
                      ? "◈"
                      : item.kind === "magnet"
                        ? "U"
                        : "½",
        item.x - 9,
        itemY(item, now) - 17,
      );
    }
  }
  dispose() {
    dispose(this.scene);
    this.renderer?.dispose();
  }
}
