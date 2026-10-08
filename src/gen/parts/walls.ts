import * as THREE from 'three';
import { PartBuilder, extrudeLocal, vary } from '../builder';
import { OUTWARD, wallExplode } from '../explode';
import type { PartDef } from '../house';
import { gableTopAt, type Opening, type WallSpec } from '../layout';

/**
 * Solid wall bodies: one extruded slab per wall (pentagon for gables) with
 * holes cut for every opening. Plaster for plaster/timber storeys, mortar for
 * stone storeys (the individual stones are laid on top by `stonework`).
 */
export const part: PartDef = {
  name: 'walls',
  label: 'Walls',
  explode: [0, 0, 0],
  build: ({ layout, rng }) => {
    const pal = layout.params.palette;
    const out: PartBuilder[] = [];
    for (const wall of layout.walls) {
      const b = new PartBuilder(`walls:${wall.id}`);
      b.explode = wallExplode(wall, OUTWARD.walls);
      const stone = wall.style === 'stone';
      const color = stone ? vary(pal.mortar, rng, 0.02, 0.02, 0) : vary(pal.plaster, rng, 0.015, 0.02, 0.004);
      b.add(extrudeLocal(wallShape(wall), wall.thickness), stone ? 'mortar' : 'plaster', color, wall.frame);
      out.push(b);
    }
    return out;
  },
};

/** Outline of the wall body in wall-local (u, y), with opening holes. */
export function wallShape(wall: WallSpec): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(wall.u0, wall.y0);
  s.lineTo(wall.u1, wall.y0);
  if (wall.gable) {
    s.lineTo(wall.u1, gableTopAt(wall, wall.u1));
    s.lineTo(wall.gable.apexU, wall.gable.apexY);
    s.lineTo(wall.u0, gableTopAt(wall, wall.u0));
  } else {
    s.lineTo(wall.u1, wall.y1);
    s.lineTo(wall.u0, wall.y1);
  }
  s.closePath();
  for (const o of wall.openings) s.holes.push(openingPath(o));
  return s;
}

/** Outline of an opening (rectangle, or rectangle with a semicircular head). */
export function openingPath(o: Opening, inset = 0): THREE.Path {
  const u0 = o.u0 + inset;
  const u1 = o.u1 - inset;
  const y0 = o.y0 + inset;
  const h = new THREE.Path();
  h.moveTo(u0, y0);
  h.lineTo(u1, y0);
  if (o.arched) {
    const r = (o.u1 - o.u0) / 2;
    const spring = o.y1 - r;
    h.lineTo(u1, spring);
    h.absarc((o.u0 + o.u1) / 2, spring, r - inset, 0, Math.PI, false);
  } else {
    h.lineTo(u1, o.y1 - inset);
    h.lineTo(u0, o.y1 - inset);
  }
  h.closePath();
  return h;
}
