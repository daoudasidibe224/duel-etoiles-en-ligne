export interface MotionSample {
  x: number;
  targetX: number;
  sampledAt: number;
  local: boolean;
  direction: number;
  speed: number;
}
export function smoothPosition(sample: MotionSample, dt: number, now: number) {
  const clamp = (x: number) => Math.max(0, Math.min(915, x));
  if (!sample.local || !sample.direction)
    return clamp(
      sample.x + (sample.targetX - sample.x) * (1 - Math.exp(-18 * dt)),
    );
  let x = clamp(sample.x + sample.direction * sample.speed * dt);
  const expected = clamp(
    sample.targetX +
      sample.direction *
        sample.speed *
        Math.min(0.15, Math.max(0, (now - sample.sampledAt) / 1000)),
  );
  const error = expected - x;
  if (Math.abs(error) > 20) x += error * (1 - Math.exp(-8 * dt));
  return clamp(x);
}
