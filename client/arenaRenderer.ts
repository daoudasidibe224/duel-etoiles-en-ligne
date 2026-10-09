import type { Player, Round, Star } from "../shared/contracts";
import { activeBonus, itemY, jumpOffset } from "../shared/progression";
import {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  arenaX,
  PILOT_FLOOR,
  PILOT_TOP,
} from "./arenaLayout";
import { ITEM_ICONS } from "../shared/itemIcons";
export const ITEM_COLORS = Object.fromEntries(
  Object.entries(ITEM_ICONS).map(([kind, icon]) => [kind, icon.color]),
) as Record<Star["kind"], string>;
export type VisualRunner = Pick<
  Player,
  "id" | "x" | "bonus" | "slowedUntil" | "feedback" | "jumpStartedAt"
> & {
  color: string;
  moving: boolean;
  facing: number;
  local: boolean;
};
type Brush = CanvasRenderingContext2D;
function pill(
  c: Brush,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string | CanvasGradient,
  stroke?: string,
) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
  c.fillStyle = fill;
  c.fill();
  if (stroke) {
    c.strokeStyle = stroke;
    c.lineWidth = 2;
    c.stroke();
  }
}
function ellipse(
  c: Brush,
  x: number,
  y: number,
  rx: number,
  ry: number,
  fill: string,
) {
  c.beginPath();
  c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  c.fillStyle = fill;
  c.fill();
}
function line(c: Brush, points: number[][], color: string, width = 2) {
  c.beginPath();
  points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.lineWidth = width;
  c.strokeStyle = color;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.stroke();
}
function symbol(c: Brush, kind: Star["kind"], color: string, size = 20) {
  const icon = ITEM_ICONS[kind];
  c.save();
  c.scale(size / 32, size / 32);
  c.translate(-32, -32);
  for (const shape of icon.paths) {
    const path = new Path2D(shape.d);
    if (shape.fill) {
      c.fillStyle = shape.fill;
      c.fill(path);
    }
    c.strokeStyle = shape.stroke ?? color;
    c.lineWidth = shape.width ?? 2.5;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.stroke(path);
  }
  if (kind === "multiplier") {
    c.font = "700 27px sans-serif";
    c.textAlign = "center";
    c.textBaseline = "alphabetic";
    c.fillStyle = "#eee0ff";
    c.fillText("×2", 34, 48);
  }
  c.restore();
}
function backdrop(c: Brush) {
  const sky = c.createLinearGradient(0, 0, 0, 540);
  sky.addColorStop(0, "#0b192d");
  sky.addColorStop(0.7, "#18344b");
  sky.addColorStop(1, "#263e4c");
  c.fillStyle = sky;
  c.fillRect(0, 0, 960, 540);
  const nebula = c.createRadialGradient(670, 130, 10, 670, 130, 320);
  nebula.addColorStop(0, "#41727840");
  nebula.addColorStop(1, "#244f6600");
  c.fillStyle = nebula;
  c.fillRect(0, 0, 960, 490);
  for (let i = 0; i < 100; i++) {
    const x = (i * 193 + 37) % 960,
      y = (i * 113 + 19) % 416;
    ellipse(
      c,
      x,
      y,
      i % 11 ? 0.85 : 1.5,
      i % 11 ? 0.85 : 1.5,
      i % 3 ? "#bde8e456" : "#f5d9a578",
    );
  }
  // A drawn ringed planet belongs to the background, away from falling pickups.
  c.save();
  c.translate(765, 115);
  c.rotate(-0.25);
  c.beginPath();
  c.ellipse(0, 0, 106, 24, 0, Math.PI, 2 * Math.PI);
  c.strokeStyle = "#98bac65c";
  c.lineWidth = 12;
  c.stroke();
  const planet = c.createLinearGradient(-65, -60, 65, 65);
  planet.addColorStop(0, "#729aab");
  planet.addColorStop(0.45, "#476a80");
  planet.addColorStop(1, "#243c54");
  ellipse(c, 0, 0, 64, 64, "#21374e");
  c.beginPath();
  c.arc(0, 0, 63, 0, Math.PI * 2);
  c.fillStyle = planet;
  c.fill();
  c.save();
  c.clip();
  for (const [y, w] of [
    [-33, 9],
    [-13, 13],
    [10, 9],
    [30, 5],
  ]) {
    line(
      c,
      [
        [-75, y],
        [0, y + 8],
        [75, y + 5],
      ],
      "#97b9bd2d",
      w,
    );
  }
  c.restore();
  c.beginPath();
  c.ellipse(0, 0, 106, 24, 0, 0, Math.PI);
  c.strokeStyle = "#a6cbd481";
  c.lineWidth = 12;
  c.stroke();
  c.restore();
  // Silhouette of a distant moon base and two rocky ridges. No scrolling behind the collision lane.
  c.fillStyle = "#102639";
  c.beginPath();
  c.moveTo(0, 406);
  for (let i = 0; i <= 12; i++) c.lineTo(i * 80, 385 + ((i * 37) % 59));
  c.lineTo(960, 500);
  c.lineTo(0, 500);
  c.fill();
  pill(c, 92, 371, 101, 58, 11, "#223f50");
  pill(c, 110, 353, 67, 24, 10, "#2c4c5a");
  for (let i = 0; i < 5; i++) pill(c, 105 + i * 16, 389, 8, 10, 2, "#a4e4d257");
  line(
    c,
    [
      [158, 352],
      [158, 322],
    ],
    "#597783",
    3,
  );
  ellipse(c, 158, 321, 3, 3, "#e2b47c");
  c.fillStyle = "#355263";
  c.beginPath();
  c.moveTo(0, 466);
  for (let i = 0; i <= 16; i++) c.lineTo(i * 60, 447 + ((i * 19) % 27));
  c.lineTo(960, 500);
  c.lineTo(0, 500);
  c.fill();
  const floor = c.createLinearGradient(0, 486, 0, 540);
  floor.addColorStop(0, "#66817e");
  floor.addColorStop(0.18, "#3c575d");
  floor.addColorStop(1, "#1c3442");
  pill(c, 12, 489, 936, 61, 14, floor);
  pill(c, 12, 487, 936, 5, 2, "#bce0bc");
  for (let x = 32; x < 940; x += 64) {
    line(
      c,
      [
        [x, 499],
        [x - 13, 533],
      ],
      "#97b5ac29",
    );
    pill(c, x + 10, 507, 22, 3, 1, "#102b37");
  }
  line(
    c,
    [
      [16, 539],
      [944, 539],
    ],
    "#718f84",
    2,
  );
  // Faint inset frame stops the large empty canvas feeling unfinished.
  line(
    c,
    [
      [20, 58],
      [20, 20],
      [58, 20],
    ],
    "#8fbab93b",
  );
  line(
    c,
    [
      [902, 20],
      [940, 20],
      [940, 58],
    ],
    "#8fbab93b",
  );
}
function pickup(c: Brush, kind: Star["kind"]) {
  const icon = ITEM_ICONS[kind],
    danger = ["meteor", "barrier", "slime"].includes(kind);
  if (icon.frame !== false)
    pill(
      c,
      -30.5,
      -30.5,
      61,
      61,
      13,
      danger ? "#352b2e" : "#15303d",
      icon.color,
    );
  symbol(c, kind, icon.color, 32);
  if (icon.value && kind !== "multiplier") {
    pill(c, -17, 26, 34, 21, 7, "#10252f", icon.color);
    c.font = "700 17px sans-serif";
    c.textAlign = "center";
    c.textBaseline = "alphabetic";
    c.fillStyle = icon.color;
    c.fillText(icon.value, 0, 42);
  }
}
function pilot(
  c: Brush,
  p: VisualRunner,
  stride: number,
  now: number,
  reduced: boolean,
) {
  const color = p.color,
    amber = color === "#ffbf47",
    walk = p.moving && !reduced,
    step = walk ? Math.sin(stride) : 0,
    bounce = walk ? Math.abs(step) * 3 : 0;
  const headTop = (PILOT_TOP - PILOT_FLOOR) / 0.55;
  c.save();
  c.translate(0, -bounce);
  // Two different helmet profiles and shoulder silhouettes, with a hand drawn outline.
  const dark = "#18313c",
    white = "#edf2de";
  pill(c, -25, -116, 50, 90, 19, color, dark);
  pill(c, -29, -112, 58, 18, 8, color, dark);
  for (const i of [-1, 1]) {
    const leg = step * i * 8;
    pill(c, i * 13 - 11, -47 + Math.min(0, leg), 22, 39, 9, white, dark);
    pill(c, i * 13 - 13, -17 + Math.min(0, leg), 29, 18, 6, dark);
    pill(c, i * 13 - 10, -42 + Math.min(0, leg), 20, 6, 2, color);
    c.save();
    c.translate(i * 29, -103);
    c.rotate(step * i * 0.45);
    pill(c, -9, -2, 18, 47, 9, white, dark);
    pill(c, -10, 27, 20, 19, 7, color, dark);
    c.restore();
  }
  // Chest harness, zip and badge.
  pill(c, -18, -99, 36, 37, 9, white);
  line(
    c,
    [
      [0, -97],
      [0, -66],
    ],
    "#a1b5b0",
    2,
  );
  pill(c, -11, -86, 22, 17, 4, dark);
  ellipse(c, -5, -78, 2.5, 2.5, color);
  line(
    c,
    [
      [1, -80],
      [6, -80],
    ],
    "#b5d7d1",
    2,
  );
  pill(c, -23, -62, 46, 8, 3, dark);
  pill(c, -5, -63, 10, 10, 3, "#e4e9ce");
  // The shared contact height follows the pilot’s head.
  pill(
    c,
    amber ? -32 : -29,
    headTop,
    amber ? 64 : 58,
    60,
    amber ? 24 : 20,
    white,
    dark,
  );
  pill(c, -26, -153, 52, 9, 4, color);
  pill(c, -38, -141, 9, 24, 4, color, dark);
  pill(c, 29, -141, 9, 24, 4, color, dark);
  const visor = c.createLinearGradient(0, -145, 0, -115);
  visor.addColorStop(0, "#294958");
  visor.addColorStop(1, "#152c3b");
  pill(c, -27, -144, 54, 31, 12, visor);
  line(
    c,
    [
      [-18, -135],
      [-7, -139],
      [10, -139],
    ],
    "#a6ded65e",
    3,
  );
  ellipse(c, -10 + p.facing * 2, -128, 3.2, 4, "#dcefd6");
  ellipse(c, 11 + p.facing * 2, -128, 3.2, 4, "#dcefd6");
  if (!amber)
    line(
      c,
      [
        [3, -158],
        [3, -167],
      ],
      color,
      3,
    );
  c.restore();
}
export class ArenaRenderer {
  private context: Brush | null;
  private backdrop = document.createElement("canvas");
  private sprites = new Map<Star["kind"], HTMLCanvasElement>();
  private pilots = new Map<string, { x: number; stride: number }>();
  private width = 0;
  private lastFrame = 0;
  private intervals: number[] = [];
  private reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    .matches;
  private preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  private changePreference = () => {
    this.reduced = this.preference.matches;
  };
  private disposed = false;
  constructor(
    public canvas: HTMLCanvasElement,
    notice: HTMLElement,
  ) {
    this.context = canvas.getContext("2d", { alpha: false });
    canvas.dataset.renderer = "canvas-2d";
    canvas.dataset.scene = "lunar-arcade";
    notice.hidden = !!this.context;
    if (!this.context)
      notice.textContent =
        "L’affichage du jeu est indisponible. Rechargez la page pour réessayer.";
    this.preference.addEventListener("change", this.changePreference);
    this.backdrop.width = 960;
    this.backdrop.height = 540;
    const background = this.backdrop.getContext("2d");
    if (background) backdrop(background);
    for (const kind of Object.keys(ITEM_COLORS) as Star["kind"][]) {
      const sprite = document.createElement("canvas");
      sprite.width = 100;
      sprite.height = 120;
      const brush = sprite.getContext("2d");
      if (brush) {
        brush.translate(50, 45);
        pickup(brush, kind);
      }
      this.sprites.set(kind, sprite);
    }
  }
  render(
    players: VisualRunner[],
    items: Star[],
    now = Date.now(),
    round?: Round,
  ) {
    const c = this.context;
    if (!c || this.disposed) return;
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width)),
      height = Math.max(1, Math.round(bounds.height)),
      worldWidth = (ARENA_HEIGHT * width) / height,
      dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (
      this.width !== width ||
      this.canvas.width !== Math.round(width * dpr) ||
      this.canvas.height !== Math.round(height * dpr)
    ) {
      this.width = width;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    c.setTransform(
      this.canvas.width / worldWidth,
      0,
      0,
      this.canvas.height / ARENA_HEIGHT,
      0,
      0,
    );
    c.drawImage(
      this.backdrop,
      (ARENA_WIDTH - worldWidth) / 2,
      0,
      worldWidth,
      ARENA_HEIGHT,
      0,
      0,
      worldWidth,
      ARENA_HEIGHT,
    );
    const viewX = (x: number) => arenaX(x, worldWidth);
    const clock = performance.now();
    if (this.lastFrame && clock - this.lastFrame < 1000) {
      this.intervals.push(clock - this.lastFrame);
      if (this.intervals.length > 180) this.intervals.shift();
    }
    this.lastFrame = clock;
    for (const [id] of this.pilots)
      if (!players.some((p) => p.id === id)) this.pilots.delete(id);
    // Warnings live on the floor. They do not hide the falling object or either pilot.
    for (const item of items)
      if (
        ["meteor", "barrier", "slime"].includes(item.kind) &&
        itemY(item, now, round) > 270
      ) {
        const x = viewX(item.x);
        ellipse(c, x, 493, 29, 6, ITEM_COLORS[item.kind] + "35");
        line(
          c,
          [
            [x - 19, 493],
            [x + 19, 493],
          ],
          ITEM_COLORS[item.kind] + "a0",
          2,
        );
      }
    const ordered = [...players].sort(
      (a, b) => Number(a.local) - Number(b.local),
    );
    for (const p of ordered) {
      if (p.local) this.canvas.dataset.localX = p.x.toFixed(2);
      let state = this.pilots.get(p.id);
      if (!state) {
        state = { x: p.x, stride: 0 };
        this.pilots.set(p.id, state);
      }
      state.stride += Math.abs(p.x - state.x) * 0.045;
      state.x = p.x;
      const x = viewX(p.x + 22.5),
        lift = jumpOffset(p, now);
      if (p.local) this.canvas.dataset.localJumpOffset = lift.toFixed(2);
      c.save();
      c.translate(x, PILOT_FLOOR);
      ellipse(c, 0, 3, 22, 5, "#071d2b66");
      c.beginPath();
      c.ellipse(
        0,
        2,
        p.bonus?.kind === "magnet" && activeBonus(p, now) ? 43 : 23,
        5,
        0,
        0,
        Math.PI * 2,
      );
      c.strokeStyle = p.color;
      c.lineWidth = p.local ? 2 : 1;
      c.stroke();
      c.translate(0, -lift);
      const bonus = activeBonus(p, now),
        blocked =
          p.feedback?.text.startsWith("Bouclier :") &&
          now - p.feedback.at < 700;
      if (bonus?.kind === "shield" || blocked) {
        c.beginPath();
        c.ellipse(0, -44, 33, 56, 0, 0, Math.PI * 2);
        c.fillStyle = blocked ? "#b5ffe969" : "#65e5bc2b";
        c.fill();
        c.strokeStyle = blocked ? "#f2ffcd" : "#83f9ce";
        c.lineWidth = blocked ? 5 : 3;
        c.stroke();
        c.beginPath();
        c.ellipse(0, -44, 37, 60, 0, 0, Math.PI * 2);
        c.strokeStyle = "#8bf2cc50";
        c.lineWidth = 3;
        c.stroke();
        if (blocked)
          for (let i = 0; i < 8; i++) {
            const angle = (i * Math.PI) / 4;
            line(
              c,
              [
                [Math.cos(angle) * 37, -44 + Math.sin(angle) * 60],
                [Math.cos(angle) * 46, -44 + Math.sin(angle) * 69],
              ],
              "#d4ffe3",
              3,
            );
          }
      }
      if (bonus?.kind === "sprint" && p.moving) {
        for (let i = 0; i < 3; i++)
          line(
            c,
            [
              [-p.facing * 27, -24 - i * 18],
              [-p.facing * (48 + i * 6), -24 - i * 18],
            ],
            "#70daefd9",
            3,
          );
      }
      if (bonus?.kind === "magnet") {
        const radius = (95 * (900 / 960) * worldWidth) / 960;
        c.beginPath();
        c.ellipse(0, -42, radius, 51, 0, 0, Math.PI * 2);
        c.setLineDash([6, 7]);
        c.strokeStyle = "#efa6c9a0";
        c.lineWidth = 2;
        c.stroke();
        c.setLineDash([]);
        for (const direction of [-1, 1])
          line(
            c,
            [
              [direction * (radius - 9), -44],
              [direction * (radius - 22), -44],
              [direction * (radius - 16), -50],
            ],
            "#ffd0e5",
            2,
          );
      }
      if (bonus) {
        const badgeX = p.local ? 31 : 0;
        pill(
          c,
          badgeX - 13,
          -115,
          26,
          26,
          7,
          "#102b38",
          ITEM_COLORS[bonus.kind],
        );
        c.save();
        c.translate(badgeX, -102);
        symbol(c, bonus.kind, ITEM_COLORS[bonus.kind], 11);
        c.restore();
      }
      if ((p.slowedUntil ?? 0) > now) {
        ellipse(c, 0, 0, 24, 5, "#b6dc62b0");
        c.save();
        c.translate(-30, -25);
        symbol(c, "slime", ITEM_COLORS.slime, 12);
        c.restore();
      }
      if (blocked && p.local) {
        const size = Math.max(17, (10 * worldWidth) / width);
        c.font = `600 ${size}px "Chakra",sans-serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        const labelWidth = c.measureText("Protégé").width + 16;
        pill(c, -labelWidth / 2, -149, labelWidth, size + 8, 6, "#173e37");
        c.fillStyle = "#caffd9";
        c.fillText("Protégé", 0, -145 + size / 2);
      }
      c.save();
      c.scale(0.55, 0.55);
      pilot(c, p, state.stride, now, this.reduced);
      c.restore();
      if (p.local) {
        const size = Math.max(14, (9.5 * worldWidth) / width);
        c.font = `700 ${size}px "Chakra",sans-serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        const w = c.measureText("VOUS").width + 16,
          y = -109;
        pill(c, -w / 2, y - size / 2 - 2, w, size + 4, 5, "#142d3fc0");
        c.fillStyle = "#f3f2da";
        c.fillText("VOUS", 0, y);
      }
      if (p.feedback && now - p.feedback.at < 800 && p.local) {
        const text = p.feedback.text.match(/[+−-]\d+/)?.[0] ?? "";
        if (text) {
          c.font = '700 28px "Chakra",sans-serif';
          c.textAlign = "center";
          c.lineWidth = 5;
          c.strokeStyle = "#112839";
          c.strokeText(text, 43, -125);
          c.fillStyle = !p.feedback.good ? "#ffc198" : "#ffe8a3";
          c.fillText(text, 43, -125);
        }
      }
      c.restore();
    }
    // Pickups render in front of pilots at the authoritative contact height.
    for (const item of items) {
      const sprite = this.sprites.get(item.kind);
      if (sprite)
        c.drawImage(
          sprite,
          viewX(item.x) - 42,
          itemY(item, now, round) - 37.8,
          84,
          100.8,
        );
    }
    if (this.intervals.length) {
      const sorted = [...this.intervals].sort((a, b) => a - b);
      this.canvas.dataset.frameMedianMs =
        sorted[Math.floor(sorted.length * 0.5)].toFixed(2);
      this.canvas.dataset.frameP95Ms =
        sorted[
          Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
        ].toFixed(2);
      this.canvas.dataset.frameSamples = String(sorted.length);
    }
    this.canvas.dataset.worldWidth = worldWidth.toFixed(1);
    this.canvas.dataset.pilotHeight = String(PILOT_FLOOR - PILOT_TOP);
    this.canvas.dataset.pixelRatio = String(dpr);
    this.canvas.dataset.cachedSprites = String(this.sprites.size);
    this.canvas.dataset.visibleObjects = String(players.length + items.length);
  }
  dispose() {
    this.disposed = true;
    this.preference.removeEventListener("change", this.changePreference);
    this.pilots.clear();
    this.sprites.clear();
    this.backdrop.width = 0;
    this.backdrop.height = 0;
    this.context = null;
  }
}
