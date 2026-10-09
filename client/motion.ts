import type { Player } from "../shared/contracts";
import { JUMP_DURATION_MS, runnerTravel } from "../shared/progression";
const clamp = (x: number) => Math.max(0, Math.min(915, x));
type Effects = Pick<Player, "bonus" | "slowedUntil">;
interface Input {
  sequence: number;
  at: number;
  direction: number;
  jumping: boolean;
}

/** Predict immediately; replay inputs the server has not acknowledged yet. */
export class LocalMotion {
  x: number;
  private direction = 0;
  jumpStartedAt: number | undefined;
  private jumping = false;
  private serverJumping = false;
  private updatedAt: number;
  private pending: Input[] = [];
  private acknowledged = -1;
  private serverDirection = 0;
  private timelineOffset = 0;
  private clockAnchored = false;
  private confirmedJump: { server: number; local: number } | undefined;
  private correction = 0;
  private sampledAt = -Infinity;
  private frozen = false;
  get acceptedSequence() {
    return this.acknowledged;
  }
  constructor(x: number, now = Date.now()) {
    this.x = x;
    this.updatedAt = now;
  }
  reset(x: number, now = Date.now(), jumpStartedAt?: number) {
    this.x = clamp(x);
    this.updatedAt = now;
    this.direction = this.serverDirection = 0;
    this.jumping = this.serverJumping = false;
    this.jumpStartedAt = jumpStartedAt;
    this.pending = [];
    this.acknowledged = -1;
    this.timelineOffset = 0;
    this.clockAnchored = false;
    this.confirmedJump = undefined;
    this.correction = 0;
    this.sampledAt = -Infinity;
    this.frozen = false;
  }
  freeze(x: number, now = Date.now()) {
    this.x = clamp(x);
    this.updatedAt = now;
    this.direction = this.serverDirection = 0;
    this.jumping = this.serverJumping = false;
    this.jumpStartedAt = undefined;
    this.confirmedJump = undefined;
    this.pending = [];
    this.acknowledged = -1;
    this.correction = 0;
    this.frozen = true;
  }
  input(
    direction: number,
    sequence: number,
    now: number,
    effects: Effects,
    jumping = false,
  ) {
    if (this.frozen) return;
    this.advance(now, effects);
    if (this.direction !== direction) this.correction = 0;
    this.direction = direction;
    if (jumping && !this.jumping && this.grounded(now))
      this.jumpStartedAt = now;
    this.jumping = jumping;
    this.pending.push({ sequence, at: now, direction, jumping });
  }
  private grounded(now: number) {
    return (
      this.jumpStartedAt === undefined ||
      now - this.jumpStartedAt >= JUMP_DURATION_MS
    );
  }
  advance(now: number, effects: Effects) {
    if (this.frozen) return this.x;
    const from = Math.max(this.updatedAt, now - 250);
    const distance = runnerTravel(
      effects,
      from - this.timelineOffset,
      now - this.timelineOffset,
    );
    const dt = Math.max(0, (now - from) / 1000);
    this.updatedAt = now;
    if (this.direction) {
      // Reconciliation cannot reverse a held direction or add inertia to a stop.
      const adjustment = Math.max(
        -distance * 0.35,
        Math.min(distance * 0.35, this.correction * (1 - Math.exp(-12 * dt))),
      );
      this.x = clamp(this.x + this.direction * distance + adjustment);
      this.correction -= adjustment;
    }
    return this.x;
  }
  receive(player: Player, now: number) {
    if (this.frozen) return;
    const sequence = player.movementSequence;
    if (
      sequence === undefined ||
      player.sampledAt === undefined ||
      player.movementStartedAt === undefined ||
      sequence < this.acknowledged ||
      player.sampledAt < this.sampledAt
    )
      return;
    if (sequence > this.acknowledged) {
      const input = this.pending.find((value) => value.sequence === sequence);
      if (!input) return;
      // Keep this clock fixed: a later command's network delay is not clock drift.
      if (!this.clockAnchored) {
        this.timelineOffset = input.at - player.movementStartedAt;
        this.clockAnchored = true;
      }
      if (
        player.jumpStartedAt !== undefined &&
        player.jumpStartedAt !== this.confirmedJump?.server
      ) {
        const launch = this.pending.find(
          (value) =>
            value.sequence <= sequence &&
            value.jumping &&
            value.at === this.jumpStartedAt,
        );
        this.confirmedJump = {
          server: player.jumpStartedAt,
          local: launch?.at ?? player.jumpStartedAt + this.timelineOffset,
        };
      }
      this.serverDirection = input.direction;
      this.serverJumping = input.jumping;
      this.acknowledged = sequence;
      this.pending = this.pending.filter((value) => value.sequence > sequence);
    }
    this.sampledAt = player.sampledAt;
    this.jumpStartedAt =
      player.jumpStartedAt === undefined
        ? undefined
        : this.confirmedJump?.server === player.jumpStartedAt
          ? this.confirmedJump.local
          : player.jumpStartedAt + this.timelineOffset;
    let jumping = this.serverJumping;
    for (const input of this.pending) {
      if (input.jumping && !jumping && this.grounded(input.at))
        this.jumpStartedAt = input.at;
      jumping = input.jumping;
    }
    // A snapshot preceding a stop/reversal must not pull against the new command.
    if (this.pending.length && this.direction !== this.serverDirection) return;
    let at = Math.min(now, player.sampledAt + this.timelineOffset);
    at = Math.max(now - 250, at);
    let x = player.x;
    let direction = this.serverDirection;
    for (const input of this.pending) {
      const next = Math.max(at, Math.min(now, input.at));
      x = clamp(
        x +
          direction *
            runnerTravel(
              player,
              at - this.timelineOffset,
              next - this.timelineOffset,
            ),
      );
      direction = input.direction;
      at = next;
    }
    x = clamp(
      x +
        direction *
          runnerTravel(
            player,
            at - this.timelineOffset,
            now - this.timelineOffset,
          ),
    );
    if (!this.direction && !this.pending.length) {
      this.x = x;
      this.correction = 0;
      this.updatedAt = now;
    } else this.correction = x - this.x;
  }
}
export interface MotionSample {
  x: number;
  targetX: number;
  sampledAt: number;
  local: boolean;
  direction: number;
  speed: number;
}
export function smoothPosition(sample: MotionSample, dt: number, _now: number) {
  if (sample.local)
    return clamp(sample.x + sample.direction * sample.speed * dt);
  return clamp(
    sample.x + (sample.targetX - sample.x) * (1 - Math.exp(-18 * dt)),
  );
}
