// The same transform positions both pilots and pickups. Side margins keep
// the full silhouette visible even when the authoritative player reaches an edge.
export const ARENA_WIDTH = 960;
export const ARENA_HEIGHT = 540;
export const PILOT_TOP = 330;
export const PILOT_FLOOR = 490;
export const arenaX = (x: number) => 30 + x * (900 / 960);
