import { PILOT_CONTACT_TOP } from "../shared/progression";
// Both pilots and pickups share the same horizontal mapping. Portrait screens
// compress the spacing, while their silhouettes keep their proportions.
export const ARENA_WIDTH = 960;
export const ARENA_HEIGHT = 540;
export const PILOT_TOP = PILOT_CONTACT_TOP;
export const PILOT_FLOOR = 490;
export const arenaX = (x: number, viewWidth = ARENA_WIDTH) =>
  ((30 + x * (900 / 960)) * viewWidth) / ARENA_WIDTH;
