import type { Stroke } from "../shared/contracts";
export type DrawingTool = "pen" | "line" | "rectangle" | "ellipse";
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  width: number,
  height: number,
) {
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = Math.max(1, (stroke.width * width) / 1000);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const x = stroke.x * width,
    y = stroke.y * height,
    px = stroke.px * width,
    py = stroke.py * height;
  ctx.beginPath();
  if (stroke.shape === "rectangle")
    ctx.rect(
      Math.min(x, px),
      Math.min(y, py),
      Math.abs(x - px),
      Math.abs(y - py),
    );
  else if (stroke.shape === "ellipse")
    ctx.ellipse(
      (x + px) / 2,
      (y + py) / 2,
      Math.max(0.1, Math.abs(x - px) / 2),
      Math.max(0.1, Math.abs(y - py) / 2),
      0,
      0,
      Math.PI * 2,
    );
  else if (x === px && y === py) {
    ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  } else {
    ctx.moveTo(px, py);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
}
export function roundCanvas(history: Stroke[], width = 360, height = 230) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Toile indisponible.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  for (const stroke of history) paintStroke(ctx, stroke, width, height);
  return canvas;
}
export function downloadCanvas(
  canvas: HTMLCanvasElement,
  name = "dessine-et-devine.png",
) {
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = name;
  link.click();
}
export class DrawingBoard {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private history: Stroke[] = [];
  private active?: {
    pointer: number;
    id: string;
    x: number;
    y: number;
    startX: number;
    startY: number;
    tool: DrawingTool;
    color: Stroke["color"];
    width: number;
  };
  enabled = false;
  color: Stroke["color"] = "#1f3b63";
  width = 10;
  tool: DrawingTool = "pen";
  private observer: ResizeObserver;
  constructor(canvas: HTMLCanvasElement, send: (stroke: Stroke) => void) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Votre navigateur ne prend pas en charge la toile.");
    this.context = context;
    this.observer = new ResizeObserver(() => this.repaint());
    this.observer.observe(canvas);
    const point = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      };
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (!this.enabled || event.button !== 0) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const p = point(event);
      this.active = {
        pointer: event.pointerId,
        id: crypto.randomUUID(),
        ...p,
        startX: p.x,
        startY: p.y,
        tool: this.tool,
        color: this.color,
        width: this.width,
      };
      if (this.tool === "pen")
        send({
          ...p,
          px: p.x,
          py: p.y,
          id: this.active.id,
          color: this.color,
          width: this.width,
        });
    });
    canvas.addEventListener("pointermove", (event) => {
      const active = this.active;
      if (!this.enabled || !active || active.pointer !== event.pointerId)
        return;
      const p = point(event);
      if (active.tool === "pen")
        send({
          ...p,
          px: active.x,
          py: active.y,
          id: active.id,
          color: active.color,
          width: active.width,
        });
      this.active = { ...active, ...p };
      if (active.tool !== "pen") {
        this.repaint();
        const rect = canvas.getBoundingClientRect();
        paintStroke(
          this.context,
          {
            ...p,
            px: active.startX,
            py: active.startY,
            id: active.id,
            color: active.color,
            width: active.width,
            shape: active.tool,
          },
          rect.width,
          rect.height,
        );
      }
    });
    canvas.addEventListener("pointerup", (event) => {
      const active = this.active;
      if (
        active &&
        active.pointer === event.pointerId &&
        this.enabled &&
        active.tool !== "pen"
      ) {
        const p = point(event);
        send({
          ...p,
          px: active.startX,
          py: active.startY,
          id: active.id,
          color: active.color,
          width: active.width,
          shape: active.tool,
        });
      }
      this.active = undefined;
      this.repaint();
    });
    for (const type of ["pointercancel", "lostpointercapture"])
      canvas.addEventListener(type, () => {
        this.active = undefined;
        this.repaint();
      });
  }
  add(stroke: Stroke) {
    this.history.push(stroke);
    const rect = this.canvas.getBoundingClientRect();
    paintStroke(this.context, stroke, rect.width, rect.height);
  }
  replace(strokes: Stroke[]) {
    this.history = [...strokes];
    this.repaint();
  }
  export() {
    downloadCanvas(this.canvas);
  }
  close() {
    this.observer.disconnect();
  }
  private repaint() {
    const rect = this.canvas.getBoundingClientRect(),
      dpr = devicePixelRatio || 1;
    if (!rect.width || !rect.height) return;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.context.fillStyle = "#fff";
    this.context.fillRect(0, 0, rect.width, rect.height);
    for (const stroke of this.history)
      paintStroke(this.context, stroke, rect.width, rect.height);
  }
}
