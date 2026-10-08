import * as THREE from 'three';
import { PartBuilder, mat4, mul, vary } from '../builder';
import { OUTWARD, wallExplode } from '../explode';
import type { PartDef } from '../house';
import { gableTopAt, type Opening, type WallSpec } from '../layout';

/**
 * Solid wall bodies: one extruded slab per wall (pentagon for gables) with
 * holes cut for every opening. Plaster for plaster/timber storeys, mortar for
 * stone storeys (the individual stones are laid on top by `stonework`).
 * Plaster storeys get softly rounded corners.
 */
export const part: PartDef = {
  name: 'walls',
  label: 'Walls',
  explode: [0, 0, 0],
  build: ({ layout, rng }) => {
    const pal = layout.params.palette;
    // One tone per storey so the corners of a plaster storey don't show seams.
    const tones = layout.storeys.map((st) =>
      st.style === 'stone' ? vary(pal.mortar, rng, 0.02, 0.02, 0) : vary(pal.plaster, rng, 0.012, 0.02, 0.004),
    );
    const out: PartBuilder[] = [];
    for (const wall of layout.walls) {
      const b = new PartBuilder(`walls:${wall.id}`);
      b.explode = wallExplode(wall, OUTWARD.walls);
      const storey = layout.storeys[wall.storey];
      const color = tones[wall.storey];
      const mat = wall.style === 'stone' ? 'mortar' : 'plaster';
      b.add(slab(wallShape(wall), wall.thickness), mat, color, wall.frame);
      if (wall.storey === layout.storeys.length - 1 && !wall.isGable) {
        b.add(eaveWedge(wall, Math.tan(layout.roof.pitch)), mat, color, wall.frame);
      }
      // Plaster storeys have no quoins or corner posts: soften the arris
      // where this wall ends (each wall owns the corner at its end).
      if (wall.style === 'plaster') {
        // Centred just inside the arris so it bulges ~1 cm past both faces.
        const bead = new THREE.CylinderGeometry(CORNER_R, CORNER_R, wall.y1 - storey.y0, 10);
        const c = CORNER_R * 0.7;
        b.add(bead, 'plaster', color, mul(wall.frame, mat4(wall.length - c, (storey.y0 + wall.y1) / 2, -c)));
      }
      out.push(b);
    }
    return out;
  },
};

/** Radius of the rounded plaster arris at the corners of plaster storeys. */
const CORNER_R = 0.035;

/**
 * Extrude a wall outline (in wall-local u, y) by `depth` towards -w.
 *
 * Like THREE.ExtrudeGeometry, but watertight: when several openings share a
 * sill or head line, the triangulation produces zero-area triangles and
 * T-junctions (a vertex in the middle of a neighbour's edge), which show as
 * pixel sparkles on large plaster faces. Those are removed here.
 */
export function slab(shape: THREE.Shape, depth: number): THREE.BufferGeometry {
  const { shape: outer, holes } = shape.extractPoints(12);
  // Closed paths repeat their first point at the end; triangulateShape would
  // strip it in place and shift our indices, so do it up front.
  const open = (loop: THREE.Vector2[]) =>
    loop.length > 1 && loop[0].distanceTo(loop[loop.length - 1]) < 1e-9 ? loop.slice(0, -1) : loop.slice();
  const ccw = open(outer);
  const contour = THREE.ShapeUtils.isClockWise(ccw) ? ccw.reverse() : ccw;
  const loops = [contour, ...holes.map(open).map((h) => (THREE.ShapeUtils.isClockWise(h) ? h : h.reverse()))];
  const verts = loops.flat();
  let tris = THREE.ShapeUtils.triangulateShape(contour, loops.slice(1));
  tris = splitTJunctions(dropDegenerate(tris, verts), verts);

  const pos: number[] = [];
  const nor: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3) => {
    // Wind so the geometric normal agrees with the intended one.
    const g = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const [p, q] = g.dot(n) >= 0 ? [b, c] : [c, b];
    pos.push(a.x, a.y, a.z, p.x, p.y, p.z, q.x, q.y, q.z);
    for (let i = 0; i < 3; i++) nor.push(n.x, n.y, n.z);
  };
  const front = new THREE.Vector3(0, 0, 1);
  const back = new THREE.Vector3(0, 0, -1);
  const v3 = (v: THREE.Vector2, w: number) => new THREE.Vector3(v.x, v.y, w);
  for (const [a, b, c] of tris) {
    tri(v3(verts[a], 0), v3(verts[b], 0), v3(verts[c], 0), front);
    tri(v3(verts[a], -depth), v3(verts[b], -depth), v3(verts[c], -depth), back);
  }
  // Sides (wall ends, top, bottom, opening reveals): the outward normal of
  // each loop edge points away from the solid.
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i];
      const q = loop[(i + 1) % loop.length];
      if (p.distanceTo(q) < 1e-6) continue;
      // Contour is CCW and holes CW, so the solid is always on the left.
      const n = new THREE.Vector3(q.y - p.y, p.x - q.x, 0).normalize();
      tri(v3(p, 0), v3(q, 0), v3(q, -depth), n);
      tri(v3(p, 0), v3(q, -depth), v3(p, -depth), n);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

function dropDegenerate(tris: number[][], v: THREE.Vector2[]): number[][] {
  return tris.filter(([a, b, c]) => Math.abs((v[b].x - v[a].x) * (v[c].y - v[a].y) - (v[c].x - v[a].x) * (v[b].y - v[a].y)) > 1e-9);
}

/** Split triangles whose edges pass through another vertex, until none do. */
function splitTJunctions(tris: number[][], v: THREE.Vector2[]): number[][] {
  const onSegment = (p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    if (t <= 1e-6 || t >= 1 - 1e-6) return false;
    const cross = (p.x - a.x) * aby - (p.y - a.y) * abx;
    return Math.abs(cross) / Math.sqrt(len2) < 1e-6;
  };
  const out: number[][] = [];
  const queue = [...tris];
  let guard = 0;
  while (queue.length && guard++ < 100000) {
    const t = queue.pop()!;
    let split = false;
    for (let e = 0; e < 3 && !split; e++) {
      const a = t[e];
      const b = t[(e + 1) % 3];
      const c = t[(e + 2) % 3];
      for (let k = 0; k < v.length; k++) {
        if (k === a || k === b || k === c) continue;
        if (onSegment(v[k], v[a], v[b])) {
          queue.push([a, k, c], [k, b, c]);
          split = true;
          break;
        }
      }
    }
    if (!split) out.push(t);
  }
  return out;
}

/**
 * The roof underside rises inward from the eave, so a flat wall top leaves a
 * thin triangular void under the deck, visible in the gable faces at the
 * corners. This wedge (wall-local, along the whole wall) fills it.
 */
function eaveWedge(wall: WallSpec, tanPitch: number): THREE.BufferGeometry {
  const t = wall.thickness;
  // Profile in (a = -w, y), extruded along u.
  const tri = new THREE.Shape();
  tri.moveTo(0, wall.y1);
  tri.lineTo(t, wall.y1);
  tri.lineTo(t, wall.y1 + t * tanPitch);
  tri.closePath();
  const g = new THREE.ExtrudeGeometry(tri, { depth: wall.length, bevelEnabled: false });
  // (a, y, z) → (u = z, y, w = -a): a proper rotation, so faces stay outward.
  return g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)));
}

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
