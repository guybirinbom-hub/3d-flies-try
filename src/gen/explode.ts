import type { HouseLayout, WallSpec } from './layout';

/**
 * Exploded-view offsets (at explode = 1), shared so that everything attached
 * to a wall moves with that wall's storey.
 *
 * - Each storey lifts by `STOREY_LIFT * storeyIndex`.
 * - Wall-mounted layers peel outward along the wall normal by their own
 *   distance (stones a little, timber more, windows/doors most).
 * - The roof floats above the top storey; the chimney above the roof.
 */
export const STOREY_LIFT = 1.4;

export const OUTWARD = {
  walls: 0,
  stonework: 0.55,
  timber: 0.95,
  openings: 1.7,
  props: 1.6,
} as const;

/** Offset for a builder holding pieces mounted on `wall`. */
export function wallExplode(wall: WallSpec, outward: number): [number, number, number] {
  return [wall.normal.x * outward, wall.storey * STOREY_LIFT, wall.normal.z * outward];
}

/** Vertical lift of the roof (and anything sitting on it). */
export function roofLift(layout: HouseLayout): number {
  return layout.storeys.length * STOREY_LIFT + 1.2;
}
