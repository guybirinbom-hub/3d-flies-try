import * as THREE from 'three';
import { PartBuilder, lumpify, mat4, vary } from '../builder';
import { OUTWARD, wallExplode } from '../explode';
import type { PartDef } from '../house';
import { gableTopAt, type HouseLayout, type Rect, type StoreySpec, type WallSpec } from '../layout';
import type { Palette } from '../params';
import type { Rng } from '../rng';

/**
 * Stonework: individual field stones laid in irregular horizontal courses on
 * the outer face of every stone wall, with dressed quoins wrapping the corners.
 * The wall body underneath is mortar-coloured (see `walls`), so the joints
 * between stones read as mortar.
 *
 * How a stone storey is laid
 * 1. Quoin bands: the storey is cut into bands (~0.3–0.55 m) shared by all
 *    four corners, snapped to sill / lintel lines where they are close.
 * 2. Every corner gets one dressed quoin per band, alternating long / short
 *    along the two faces so they interlock, kept clear of opening surrounds.
 * 3. Every wall splits the bands into courses (and keeps coursing up the gable
 *    triangle), moving its own course lines onto its sills and lintels.
 * 4. Each course subtracts obstacles (opening surrounds, quoins, stones from
 *    the course below that are two courses tall) and fills the free pieces
 *    with stones of varied length that butt exactly against them.
 * 5. Every stone is squeezed under the roof: its vertices are pulled below
 *    the gable edge / soffit plane, so nothing pokes through the roof deck.
 *    Under a jetty the top of the walls (the joist layer) gets a thin course:
 *    small packing stones between the timber joist ends on the eave walls,
 *    a levelling course between the corner joists on the gables.
 * 6. Big houses (low `layout.detail`) get fewer, larger stones (Lod).
 */
export const part: PartDef = {
  name: 'stonework',
  label: 'Stonework',
  explode: [0, 0, 0],
  build: ({ layout, rng }) => {
    const lod = stoneLod(layout);
    const out: PartBuilder[] = [];
    // Quoins keep alternating from one stone storey into the next.
    let below: boolean[] | null = null;
    for (const storey of layout.storeys) {
      if (storey.style !== 'stone') {
        below = null;
        continue;
      }
      const built = buildStorey(layout, storey, lod, below, rng.fork(`storey${storey.index}`));
      out.push(...built.builders);
      below = built.topLongA;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Dimensions (metres)
// ---------------------------------------------------------------------------

/** Depth budget from ARCHITECTURE.md: stones in w ∈ [-0.05, +0.06], quoins up to +0.07. */
const W_BACK_LIMIT = -0.05;
const W_FRONT_LIMIT = 0.06;
const W_FRONT_LIMIT_QUOIN = 0.07;
/** Hidden back of a field stone, buried in the wall body. */
const STONE_BACK = -0.035;
/** Stones stay this far below the gable edge / roof underside (contract: ≥ 0.03). */
const ROOF_CLEARANCE = 0.035;
/** Clearance between stones and an opening surround (≥ lumps + roll slack). */
const SURROUND_GAP = 0.01;
/** Joint between a quoin and the face stones next to it. */
const QUOIN_JOINT = 0.016;
/** Shortest regular stone: shorter leftovers are merged into a neighbour. */
const MIN_STONE = 0.12;
/** Free gaps narrower than this stay mortar (a wide joint). */
const MIN_GAP_STONE = 0.055;
/** Lowest stone worth placing (thin stones over lintels, wedges under the gable edge). */
const MIN_STONE_H = 0.075;
/** Lowest course; course lines never move closer together than this. */
const MIN_COURSE = 0.13;
/** How far lumps and roll may push a stone past its slot (less than half a joint). */
const STONE_SPILL = 0.0045;
/** Random in/out wobble of a field stone's front ring. */
const FACE_JITTER = 0.003;
/**
 * Jetty joists (timber part, height from `storey.joistZone`): the corner
 * joists reach this far into the gable faces.
 */
const JOIST_DEPTH = 0.1;
/**
 * Rough stonework triangles per m² of stone face at full detail and normal
 * stone size, and what we aim for (ARCHITECTURE.md budgets 120k; keep margin).
 */
const TRIANGLES_PER_M2 = 450;
const TRIANGLE_TARGET = 100_000;
/** Largest stone size scale on a huge stone house. */
const MAX_SCALE = 1.3;
/** Ignore overlaps thinner than this (touching rectangles). */
const EPS = 0.002;

const WARM_STONE = new THREE.Color('#c79d6b');
const COOL_STONE = new THREE.Color('#8f989e');
const DAMP = new THREE.Color('#6c7155');
const MOSS = new THREE.Color('#71844a');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Horizontal band of a wall, world y. */
interface Band {
  y0: number;
  y1: number;
}

/** A free rectangle of a course to be filled with stones; `full` = spans the whole course height. */
interface Piece extends Rect {
  full: boolean;
}

/**
 * One dressed corner stone. It belongs to the wall that ENDS at the corner
 * (wall A); `alongA` is how far it reaches along A's face, `alongB` along the
 * next wall's face (both measured from the outer corner).
 */
interface Quoin extends Band {
  alongA: number;
  alongB: number;
  /** Planned long along A (before any trimming for openings). */
  longA: boolean;
}

/**
 * Level of detail of the stonework. Big houses are seen from further away,
 * so their stones get a coarser outline and grow a little (fewer, larger
 * stones keep the same texture on screen and the house near budget).
 */
interface Lod {
  /** Outline points per stone corner: 3 (round) or 2 (cut corner). */
  perCorner: 2 | 3;
  /** Stone / course size multiplier (1 = normal). */
  scale: number;
}

/** Highest allowed y at wall-local (u, w): the roof underside minus clearance. */
type Ceiling = (u: number, w: number) => number;

type Paint = (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void;

/** Everything needed to lay stones on one wall. */
interface WallJob {
  wall: WallSpec;
  builder: PartBuilder;
  rng: Rng;
  ceiling: Ceiling;
  /** Top-storey gable wall: courses are clipped to the sloped edge. */
  raking: boolean;
  /** Rectangles (wall-local u, y) the face stones must keep out of. */
  obstacles: Rect[];
  stoneColor: THREE.Color;
  paint: Paint;
  lod: Lod;
  /**
   * Under a jetty: a thin course of stones at the joist level, between the
   * corner joists. On the eave walls the joist ends come through it, so it is
   * packed with small stones (`packed`) that the joists cover where they meet.
   */
  levelling: (Band & { packed: boolean }) | null;
}

// ---------------------------------------------------------------------------
// Storey
// ---------------------------------------------------------------------------

/**
 * Lay one stone storey. `below` says, per corner, whether the top quoin of
 * the stone storey underneath runs long along wall A (null: none below).
 * Returns the builders and the same for this storey's top quoins.
 */
function buildStorey(
  layout: HouseLayout,
  storey: StoreySpec,
  lod: Lod,
  below: boolean[] | null,
  rng: Rng,
): { builders: PartBuilder[]; topLongA: boolean[] } {
  const pal = layout.params.palette;
  const isTop = storey.index === layout.storeys.length - 1;
  const walls = storey.walls;
  const yStart = storey.floorY;
  // Under the eaves the soffit drops outward from the wall face; stop the
  // coursing a little lower there so the top course keeps its shape. Under a
  // jetty the joist ends (timber) take the top of the eave walls.
  const joists = storey.joistZone;
  const yEnd = isTop ? storey.y1 - 0.015 - 0.03 * Math.tan(layout.roof.pitch) : storey.y1 - joists;

  const bands = quoinBands(yStart, yEnd, walls.flatMap(openingLines), lod.scale, rng.fork('bands'));
  // corners[i] sits at the END of walls[i] = the START of walls[i + 1].
  const corners = walls.map((wall, i) =>
    planCorner(wall, walls[(i + 1) % 4], bands, lod.scale, below ? !below[i] : null, rng.fork(`corner${i}`)),
  );

  const out: PartBuilder[] = [];
  walls.forEach((wall, i) => {
    const builder = new PartBuilder(`stonework:${wall.id}`);
    builder.explode = wallExplode(wall, OUTWARD.stonework);
    const job: WallJob = {
      wall,
      builder,
      rng: rng.fork(wall.id),
      ceiling: roofCeiling(layout, wall),
      raking: isTop && wall.gable !== null,
      obstacles: [],
      stoneColor: new THREE.Color(pal.stone),
      paint: facePaint(storey, [wall]),
      lod,
      levelling: joists > 0 ? { y0: yEnd, y1: storey.y1, packed: !wall.isGable } : null,
    };
    layWall(job, bands, corners[(i + 3) % 4], corners[i], storey.index === 0);
    out.push(builder);
  });

  walls.forEach((a, i) => {
    const b = walls[(i + 1) % 4];
    const builder = new PartBuilder(`stonework:${a.id}-corner`);
    builder.explode = cornerExplode(a, b);
    layQuoins(builder, a, corners[i], roofCeiling(layout, a), pal, facePaint(storey, [a, b]), rng.fork(`quoins${i}`));
    out.push(builder);
  });
  return { builders: out, topLongA: corners.map((q) => q[q.length - 1]?.longA ?? false) };
}

/**
 * Course lines (band boundaries) of a storey's quoins, from y0 to y1. Bands
 * are ~0.36–0.52 m, snapped onto nearby opening lines so the coursing meets
 * sills and lintels cleanly.
 */
function quoinBands(y0: number, y1: number, targets: number[], scale: number, rng: Rng): number[] {
  const lines = [y0];
  let y = y0;
  for (;;) {
    const rest = y1 - y;
    if (rest <= 0.56 * scale) break;
    let next: number;
    if (rest <= 0.95 * scale) {
      next = y + rest * rng.range(0.45, 0.55);
    } else {
      // Bigger corner stones low down, a little smaller higher up.
      const low = y - y0 < 0.9 * scale;
      next = y + (low ? rng.range(0.4, 0.52) : rng.range(0.36, 0.48)) * scale;
      const snap = nearest(targets, next, 0.1 * scale, (t) => t - y >= 0.28 * scale && y1 - t >= 0.3 * scale);
      if (snap !== null) next = snap;
    }
    lines.push(next);
    y = next;
  }
  lines.push(y1);
  return lines;
}

// ---------------------------------------------------------------------------
// Quoins
// ---------------------------------------------------------------------------

/**
 * Plan the quoins of the corner where wall `a` ends and wall `b` starts: per
 * band one dressed stone, long on one face and short on the other, swapping
 * every course. The short side stays thinner than the wall so the stone stays
 * inside the masonry (it never shows on the inside).
 */
function planCorner(a: WallSpec, b: WallSpec, bands: number[], scale: number, firstLongA: boolean | null, rng: Rng): Quoin[] {
  const maxShort = Math.max(0.14, a.thickness - 0.04);
  const coin = rng.chance(0.5);
  const flip = firstLongA === null ? coin : !firstLongA;
  const quoins: Quoin[] = [];
  for (let k = 0; k + 1 < bands.length; k++) {
    const band = { y0: bands[k], y1: bands[k + 1] };
    const long = rng.range(0.44, 0.6) * scale;
    const short = Math.min(maxShort, rng.range(0.24, 0.32));
    const aLong = (k % 2 === 0) !== flip;
    let alongA = aLong ? long : short;
    let alongB = aLong ? short : long;
    // Keep clear of openings near the corner on either face …
    const freeA = clearFromEnd(a, band) - QUOIN_JOINT;
    const freeB = clearFromStart(b, band) - QUOIN_JOINT;
    alongA = Math.min(alongA, freeA);
    alongB = Math.min(alongB, freeB);
    // … and if only a sliver would be left before the opening, let the quoin
    // reach all the way to it (as long as it still fits inside the masonry).
    if (freeA - alongA < MIN_STONE + 0.03 && Math.min(freeA, alongB) <= maxShort) alongA = freeA;
    if (freeB - alongB < MIN_STONE + 0.03 && Math.min(alongA, freeB) <= maxShort) alongB = freeB;
    quoins.push({ ...band, alongA, alongB, longA: aLong });
  }
  return quoins;
}

/** Distance from a wall's end corner to the nearest opening surround overlapping `band`. */
function clearFromEnd(wall: WallSpec, band: Band): number {
  let free = Infinity;
  for (const r of surroundObstacles(wall)) {
    if (overlapsY(r, band)) free = Math.min(free, wall.length - r.u1);
  }
  return free;
}

/** Distance from a wall's start corner to the nearest opening surround overlapping `band`. */
function clearFromStart(wall: WallSpec, band: Band): number {
  let free = Infinity;
  for (const r of surroundObstacles(wall)) {
    if (overlapsY(r, band)) free = Math.min(free, r.u0);
  }
  return free;
}

/**
 * Build the quoins of one corner, in the frame of wall `a` (which ends at the
 * corner). Each one is a single chamfered block wrapping both faces:
 * u ∈ [len - alongA, len + protrusionB], w ∈ [-alongB, protrusionA].
 */
function layQuoins(
  builder: PartBuilder,
  a: WallSpec,
  quoins: Quoin[],
  ceiling: Ceiling,
  pal: Palette,
  paint: Paint,
  rng: Rng,
): void {
  // Dressed stone: a little lighter and more even than the field stones.
  const base = new THREE.Color(pal.stone).lerp(new THREE.Color('#efe4cf'), 0.16);
  const len = a.length;
  for (const q of quoins) {
    const outA = rng.range(0.05, 0.062);
    const outB = rng.range(0.05, 0.062);
    const yb = q.y0 + rng.range(0.006, 0.009);
    const yt = q.y1 - rng.range(0.006, 0.009);
    const sx = q.alongA + outB;
    const sy = yt - yb;
    const sz = q.alongB + outA;
    const g = chamferedBlock(sx, sy, sz, rng.range(0.024, 0.034));
    lumpify(g, 0.004, rng.int(0, 1e6));
    g.applyMatrix4(mat4(len - q.alongA + sx / 2, (yb + yt) / 2, -q.alongB + sz / 2, 0, 0, rng.jitter(0.006)));
    fitUnder(g, ceiling, yb, yt);
    clampAxis(g, 'z', -Infinity, W_FRONT_LIMIT_QUOIN);
    clampAxis(g, 'x', -Infinity, len + W_FRONT_LIMIT_QUOIN);
    g.computeVertexNormals();
    builder.add(g, 'stone', vary(base, rng, 0.035, 0.03, 0.006), a.frame, paint);
  }
}

// ---------------------------------------------------------------------------
// Face stones
// ---------------------------------------------------------------------------

/**
 * Lay the field stones of one wall face between the quoins of its two
 * corners. `startCorner` is the corner at u = 0 (its quoins reach `alongB`
 * along this wall), `endCorner` the one at u = length (`alongA`).
 */
function layWall(job: WallJob, bands: number[], startCorner: Quoin[], endCorner: Quoin[], ground: boolean): void {
  const { wall } = job;
  job.obstacles.push(...surroundObstacles(wall));
  for (const q of startCorner) job.obstacles.push({ u0: -1, u1: q.alongB + QUOIN_JOINT, y0: q.y0, y1: q.y1 });
  for (const q of endCorner) {
    job.obstacles.push({ u0: wall.length - q.alongA - QUOIN_JOINT, u1: wall.length + 1, y0: q.y0, y1: q.y1 });
  }

  const lines = wallCourses(wall, bands, ground, job.lod.scale, job.rng);
  if (job.levelling) {
    const { y0, y1 } = job.levelling;
    lines.push(y1);
    job.obstacles.push({ u0: -1, u1: JOIST_DEPTH + QUOIN_JOINT, y0, y1 });
    job.obstacles.push({ u0: wall.length - JOIST_DEPTH - QUOIN_JOINT, u1: wall.length + 1, y0, y1 });
  }
  let belowJoints: number[] = [];
  for (let k = 0; k + 1 < lines.length; k++) {
    const course: Band = { y0: lines[k], y1: lines[k + 1] };
    const above: Band | null = k + 2 < lines.length ? { y0: lines[k + 1], y1: lines[k + 2] } : null;
    const [uMin, uMax] = courseExtent(job, course);
    if (uMax - uMin < MIN_GAP_STONE) continue;
    const joints: number[] = [];
    const packed = job.levelling?.packed && course.y0 >= job.levelling.y0 - EPS;
    for (const piece of freePieces(course, uMin, uMax, job.obstacles)) {
      if (packed) packPiece(job, piece);
      else fillPiece(job, piece, piece.full ? above : null, belowJoints, joints);
    }
    belowJoints = joints;
  }
}

/**
 * Course lines of one wall: the storey's quoin bands, each split into one or
 * two courses, continued up the gable triangle, then nudged onto the wall's
 * own sill / lintel lines. Band lines stay put so the courses meet the quoins.
 */
function wallCourses(wall: WallSpec, bands: number[], ground: boolean, scale: number, rng: Rng): number[] {
  const lines: { y: number; locked: boolean }[] = [{ y: bands[0], locked: true }];
  for (let k = 0; k + 1 < bands.length; k++) {
    const y0 = bands[k];
    const h = bands[k + 1] - y0;
    // The footing course of the house is mostly left whole: big stones at the base.
    const splitChance = ground && k === 0 ? 0.3 : 0.85;
    if (h >= 0.5 * scale || (h >= 0.38 * scale && rng.chance(splitChance))) lines.push({ y: y0 + h * rng.range(0.4, 0.6), locked: false });
    lines.push({ y: bands[k + 1], locked: true });
  }
  if (wall.gable) {
    // Keep coursing up the gable; courses get a little lower towards the apex.
    const apex = wall.gable.apexY - ROOF_CLEARANCE;
    const rise = Math.max(0.5, apex - wall.y1);
    let y = lines[lines.length - 1].y;
    while (apex - y > MIN_STONE_H + 0.03) {
      y += rng.range(0.2, 0.3) * scale * (1 - 0.25 * Math.min(1, (y - wall.y1) / rise));
      lines.push({ y, locked: false });
    }
  }

  for (const t of openingLines(wall)) {
    const first = lines[0].y;
    const last = lines[lines.length - 1].y;
    if (t <= first + MIN_COURSE || t >= last - MIN_COURSE) continue;
    // Move the nearest free line onto t …
    let best = -1;
    for (let i = 1; i < lines.length - 1; i++) {
      if (lines[i].locked && Math.abs(lines[i].y - t) > 1e-6) continue;
      if (best < 0 || Math.abs(lines[i].y - t) < Math.abs(lines[best].y - t)) best = i;
    }
    if (
      best > 0 &&
      Math.abs(lines[best].y - t) <= 0.11 &&
      t - lines[best - 1].y >= MIN_COURSE &&
      lines[best + 1].y - t >= MIN_COURSE
    ) {
      lines[best] = { y: t, locked: true };
      continue;
    }
    // … or split the course that contains it, if both halves stay tall enough.
    const j = lines.findIndex((l, i) => i + 1 < lines.length && l.y < t && lines[i + 1].y > t);
    if (j >= 0 && t - lines[j].y >= MIN_COURSE && lines[j + 1].y - t >= MIN_COURSE) {
      lines.splice(j + 1, 0, { y: t, locked: true });
    }
  }
  return lines.map((l) => l.y);
}

/** u-range of a course; on a gable it shrinks to where a stone still fits under the slope. */
function courseExtent(job: WallJob, course: Band): [number, number] {
  const { wall } = job;
  if (!job.raking || !wall.gable) return [0, wall.length];
  const tan = (wall.gable.apexY - wall.gable.eaveY) / wall.gable.apexU;
  // The thin end of a wedge under the slope keeps a good part of the course height.
  const thinEnd = Math.max(MIN_STONE_H, 0.45 * (course.y1 - course.y0));
  const need = course.y0 + 0.01 + thinEnd + ROOF_CLEARANCE;
  const d = Math.max(0, (need - wall.gable.eaveY) / tan);
  return [d, wall.length - d];
}

/**
 * Split a course into free rectangles: the course minus every obstacle. Where
 * an obstacle covers only part of the course height, the remaining strip
 * above or below it becomes its own (lower) piece.
 */
function freePieces(course: Band, uMin: number, uMax: number, obstacles: Rect[]): Piece[] {
  const hits = obstacles.filter((o) => overlapsY(o, course) && o.u1 > uMin && o.u0 < uMax);
  const cuts = [uMin, uMax];
  for (const o of hits) {
    if (o.u0 > uMin && o.u0 < uMax) cuts.push(o.u0);
    if (o.u1 > uMin && o.u1 < uMax) cuts.push(o.u1);
  }
  cuts.sort((p, q) => p - q);

  const spans: Piece[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a < 1e-6) continue;
    const mid = (a + b) / 2;
    let free: Band[] = [course];
    for (const o of hits) {
      if (o.u0 <= mid && o.u1 >= mid) free = subtract(free, o);
    }
    for (const f of free) {
      if (f.y1 - f.y0 < MIN_STONE_H + 0.012) continue;
      const full = f.y0 <= course.y0 + EPS && f.y1 >= course.y1 - EPS;
      spans.push({ u0: a, u1: b, y0: f.y0, y1: f.y1, full });
    }
  }
  // Merge neighbouring spans with the same height range.
  spans.sort((p, q) => p.y0 - q.y0 || p.y1 - q.y1 || p.u0 - q.u0);
  const pieces: Piece[] = [];
  for (const s of spans) {
    const last = pieces[pieces.length - 1];
    if (last && last.y0 === s.y0 && last.y1 === s.y1 && Math.abs(last.u1 - s.u0) < 1e-6) last.u1 = s.u1;
    else pieces.push({ ...s });
  }
  return pieces.sort((p, q) => p.u0 - q.u0);
}

/** Vertical ranges left of `bands` after removing the y-range of `o`. */
function subtract(bands: Band[], o: Rect): Band[] {
  const out: Band[] = [];
  for (const b of bands) {
    if (o.y1 <= b.y0 + EPS || o.y0 >= b.y1 - EPS) {
      out.push(b);
      continue;
    }
    if (o.y0 > b.y0) out.push({ y0: b.y0, y1: o.y0 });
    if (o.y1 < b.y1) out.push({ y0: o.y1, y1: b.y1 });
  }
  return out;
}

/**
 * Fill one free piece with a run of stones that exactly spans it. Full-height
 * pieces sometimes get a stone two courses tall (`above` is the next course)
 * or two thin stones stacked in one slot.
 */
function fillPiece(job: WallJob, piece: Piece, above: Band | null, belowJoints: number[], joints: number[]): void {
  const { rng } = job;
  const S = job.lod.scale;
  const width = piece.u1 - piece.u0;
  const height = piece.y1 - piece.y0;
  if (width < MIN_GAP_STONE) return;
  const run = bestRun(width, S, rng, belowJoints, piece.u0);
  let u = piece.u0;
  run.lengths.forEach((len, i) => {
    const s0 = u;
    const s1 = u + len;
    if (i > 0) joints.push(s0 - run.joints[i - 1] / 2);
    u = s1 + (run.joints[i] ?? 0);

    if (above && len >= 0.22 * S && len <= 0.62 * S && above.y1 - piece.y0 <= 0.6 * S && rng.chance(0.08) && canJump(job, s0, s1, above)) {
      // A tall stone spanning two courses breaks up the grid.
      addFieldStone(job, s0, s1, piece.y0 + bedJoint(rng), above.y1 - bedJoint(rng));
      const j = rng.range(0.01, 0.02);
      job.obstacles.push({ u0: s0 - j, u1: s1 + j, y0: piece.y0, y1: above.y1 });
      return;
    }
    if (piece.full && height >= 0.27 * S && len >= 0.2 * S && len <= 0.55 * S && rng.chance(0.07)) {
      // Two thin stones stacked in one slot.
      const split = piece.y0 + height * rng.range(0.42, 0.58);
      const shrink = rng.range(0, Math.min(0.08, len - MIN_STONE));
      const left = rng.chance(0.5);
      addFieldStone(job, s0, s1, piece.y0 + bedJoint(rng), split - bedJoint(rng));
      addFieldStone(job, left ? s0 : s0 + shrink, left ? s1 - shrink : s1, split + bedJoint(rng), piece.y1 - bedJoint(rng));
      return;
    }
    // Not every stone fills its course: some sit a little low or high in it.
    const slack = height > 0.15 && rng.chance(0.4) ? rng.range(0, Math.min(0.035, height * 0.12)) : 0;
    const lift = slack * rng.pick([0, 0.5, 1]);
    addFieldStone(job, s0, s1, piece.y0 + bedJoint(rng) + lift, piece.y1 - bedJoint(rng) - (slack - lift));
  });
}

/**
 * Fill the joist course of an eave wall with small packing stones. The joist
 * ends (timber) come out of the wall somewhere along it; small stones read
 * as packed in around them wherever they land, and a joist simply hides the
 * part of a stone behind it.
 */
function packPiece(job: WallJob, piece: Piece): void {
  const { rng } = job;
  const h = piece.y1 - piece.y0;
  let u = piece.u0 + rng.range(0.004, 0.01);
  while (piece.u1 - u >= MIN_GAP_STONE) {
    let len = rng.range(0.13, 0.24);
    if (piece.u1 - u - len < MIN_STONE + 0.02) len = piece.u1 - u - rng.range(0.004, 0.01);
    if (len < MIN_GAP_STONE) break;
    // A little low or high in the course, like hand-set pinnings.
    const slack = rng.range(0, Math.min(0.02, h * 0.15));
    const lift = slack * rng.next();
    // Small and in the jetty's shadow: the cut-corner outline is plenty.
    addFieldStone(job, u, u + len, piece.y0 + bedJoint(rng) + lift, piece.y1 - bedJoint(rng) - (slack - lift), 2);
    u += len + rng.range(0.012, 0.024);
  }
}

/** Half of a bed (horizontal) joint: joints end up ≈ 1–2.2 cm. */
function bedJoint(rng: Rng): number {
  return rng.range(0.005, 0.011);
}

/** Can a stone at [s0, s1] continue up through the course `above`? */
function canJump(job: WallJob, s0: number, s1: number, above: Band): boolean {
  const r: Rect = { u0: s0 - 0.012, u1: s1 + 0.012, y0: above.y0, y1: above.y1 };
  if (job.obstacles.some((o) => overlapsY(o, r) && o.u0 < r.u1 && o.u1 > r.u0)) return false;
  const [uMin, uMax] = courseExtent(job, above);
  if (s0 < uMin || s1 > uMax) return false;
  return Math.min(job.ceiling(s0, W_FRONT_LIMIT), job.ceiling(s1, W_FRONT_LIMIT)) >= above.y1;
}

interface Run {
  lengths: number[];
  /** joints[i] sits between lengths[i] and lengths[i + 1]. */
  joints: number[];
}

/**
 * Stone lengths for a free width: a few random runs, keeping the one whose
 * vertical joints stay furthest from the joints of the course below.
 */
function bestRun(width: number, scale: number, rng: Rng, belowJoints: number[], u0: number): Run {
  let best = randomRun(width, scale, rng);
  let bestScore = jointScore(best, belowJoints, u0);
  for (let attempt = 0; attempt < 4 && bestScore < 0.09; attempt++) {
    const run = randomRun(width, scale, rng);
    const score = jointScore(run, belowJoints, u0);
    if (score > bestScore) {
      best = run;
      bestScore = score;
    }
  }
  return best;
}

/** Random stone lengths (≈0.25–0.75 m, occasionally a long one) exactly filling `width`. */
function randomRun(width: number, scale: number, rng: Rng): Run {
  const target = rng.range(0.4, 0.6) * scale;
  const n = Math.max(1, Math.round(width / target));
  const joints = Array.from({ length: n - 1 }, () => rng.range(0.01, 0.024));
  const weights = Array.from({ length: n }, () => (rng.chance(0.12) ? rng.range(1.5, 1.9) : rng.range(0.6, 1.25)));
  const avail = width - joints.reduce((s, j) => s + j, 0);
  const total = weights.reduce((s, w) => s + w, 0);
  const lengths = weights.map((w) => (avail * w) / total);
  // Merge slivers into their shorter neighbour.
  while (lengths.length > 1) {
    let i = 0;
    for (let k = 1; k < lengths.length; k++) if (lengths[k] < lengths[i]) i = k;
    if (lengths[i] >= MIN_STONE) break;
    const j = i === 0 ? 1 : i === lengths.length - 1 ? i - 1 : lengths[i - 1] < lengths[i + 1] ? i - 1 : i + 1;
    const joint = Math.min(i, j);
    lengths[j] += lengths[i] + joints[joint];
    lengths.splice(i, 1);
    joints.splice(joint, 1);
  }
  return { lengths, joints };
}

/** Smallest distance between a run's vertical joints and the joints below (bigger is better). */
function jointScore(run: Run, belowJoints: number[], u0: number): number {
  let score = Infinity;
  let u = u0;
  for (let i = 0; i + 1 < run.lengths.length; i++) {
    u += run.lengths[i] + run.joints[i] / 2;
    for (const b of belowJoints) score = Math.min(score, Math.abs(b - u));
    u += run.joints[i] / 2;
  }
  return score;
}

/**
 * One rounded field stone filling [u0, u1] × [y0, y1] on the wall face, with a
 * small random tilt and a colour of its own.
 */
function addFieldStone(job: WallJob, u0: number, u1: number, y0: number, y1: number, perCorner = job.lod.perCorner): void {
  const { rng } = job;
  const len = u1 - u0;
  const h = y1 - y0;
  if (len < 0.02 || h < 0.02) return;
  const small = Math.min(len, h);
  const shoulder = rng.range(0.01, 0.02);
  const face = shoulder + rng.range(0.01, 0.018);
  const profile: StoneProfile = {
    back: STONE_BACK,
    shoulder,
    face,
    crown: face + rng.range(0.005, 0.014),
    inset: Math.min(small * 0.28, rng.range(0.028, 0.05)),
  };
  const g = fieldStoneGeometry(len, h, profile, perCorner, rng);
  const lump = Math.min(0.004, small * 0.03);
  lumpify(g, lump, rng.int(0, 1e6));

  // Tilt within what is left of the depth budget; roll within the joints.
  const tilt = Math.max(0, Math.min(0.012, W_FRONT_LIMIT - (profile.crown + FACE_JITTER + lump) - 0.001));
  const rx = rng.jitter(tilt / h);
  const ry = rng.jitter(tilt / len);
  const rz = rng.jitter(Math.min(0.035, 0.008 / len));
  g.applyMatrix4(mat4((u0 + u1) / 2, (y0 + y1) / 2, 0, rx, ry, rz));
  // Lumps and roll may only eat into the stone's own joints, never past them.
  clampAxis(g, 'x', u0 - STONE_SPILL, u1 + STONE_SPILL);
  clampAxis(g, 'y', y0 - STONE_SPILL, y1 + STONE_SPILL);
  fitUnder(g, job.ceiling, y0, y1);
  clampAxis(g, 'z', W_BACK_LIMIT, W_FRONT_LIMIT);
  g.computeVertexNormals();

  const color = stoneColor(job.stoneColor, rng);
  const mossy = rng.chance(0.06);
  const paint: Paint = mossy
    ? (p, n, out) => {
        job.paint(p, n, out);
        if (n.y > 0.3) out.lerp(MOSS, 0.45 * n.y);
      }
    : job.paint;
  job.builder.add(g, 'stone', color, job.wall.frame, paint);
}

/** Per-stone colour: around the palette stone, with the odd warmer, cooler or darker one. */
function stoneColor(base: THREE.Color, rng: Rng): THREE.Color {
  const c = vary(base, rng, 0.07, 0.05, 0.012);
  const r = rng.next();
  if (r < 0.12) c.lerp(WARM_STONE, rng.range(0.2, 0.4));
  else if (r < 0.22) c.lerp(COOL_STONE, rng.range(0.2, 0.38));
  else if (r < 0.28) c.multiplyScalar(rng.range(0.82, 0.9));
  return c;
}

// ---------------------------------------------------------------------------
// Roof clearance
// ---------------------------------------------------------------------------

/**
 * The roof underside over a wall, minus clearance, in wall-local (u, w). Only
 * the top storey has one: the gable edge for gable walls, the soffit plane
 * (dropping outward with the pitch) for eave walls.
 */
function roofCeiling(layout: HouseLayout, wall: WallSpec): Ceiling {
  if (wall.storey !== layout.storeys.length - 1) return () => Infinity;
  if (wall.gable) return (u) => gableTopAt(wall, u) - ROOF_CLEARANCE;
  const tan = Math.tan(layout.roof.pitch);
  return (_u, w) => wall.y1 - w * tan - ROOF_CLEARANCE;
}

/**
 * Squeeze a stone (wall-local geometry, nominally y ∈ [yb, yt]) under the
 * ceiling: where the ceiling is lower than the stone's top, its height is
 * scaled down towards the bottom, so a stone under the gable edge becomes a
 * wedge that follows the slope. The ceiling is concave (a plane, or the two
 * gable slopes), so with every vertex below it, every triangle is too.
 */
function fitUnder(g: THREE.BufferGeometry, ceiling: Ceiling, yb: number, yt: number): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i);
    const w = pos.getZ(i);
    const c = ceiling(u, w);
    if (c === Infinity) return;
    let y = pos.getY(i);
    if (c < yt) y = yb + (y - yb) * Math.max(0, (c - yb) / (yt - yb));
    pos.setY(i, Math.min(y, c));
  }
  pos.needsUpdate = true;
}

/** Clamp one coordinate of every vertex (a plane clamp keeps triangles inside too). */
function clampAxis(g: THREE.BufferGeometry, axis: 'x' | 'y' | 'z', lo: number, hi: number): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const k = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  for (let i = 0; i < pos.count; i++) {
    pos.setComponent(i, k, THREE.MathUtils.clamp(pos.getComponent(i, k), lo, hi));
  }
  pos.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Depth profile of a field stone (all w, metres). */
interface StoneProfile {
  /** Back of the side walls, buried in the wall body. */
  back: number;
  /** Where the side walls turn into the rounded front. */
  shoulder: number;
  /** The inset front ring. */
  face: number;
  /** The domed middle of the face. */
  crown: number;
  /** How far the front ring sits in from the outline. */
  inset: number;
}

/**
 * Low-poly field stone (60 triangles; 40 at detail 2), centred on x/y, with
 * z = w. The outline is a rounded rectangle (three points per corner, each
 * corner its own radius)
 * with every point nudged a little inward, so no two stones share a silhouette
 * and none leaves its slot. Side walls rise from the buried back (no back cap:
 * it is inside the wall) to a shoulder, then an inset front ring and a domed
 * crown. Indexed, so normals come out smooth and the stone reads as a pillow.
 */
function fieldStoneGeometry(sx: number, sy: number, p: StoneProfile, perCorner: number, rng: Rng): THREE.BufferGeometry {
  const hx = sx / 2;
  const hy = sy / 2;
  const small = Math.min(sx, sy);
  // Corners counter-clockwise seen from the front (+z), starting bottom-right.
  const corners = [
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
  ];
  const ring: [number, number][] = [];
  corners.forEach(([cx, cy], k) => {
    const r = Math.min(small * 0.48, THREE.MathUtils.clamp(small * rng.range(0.26, 0.46), 0.03, 0.14));
    const ox = cx * (hx - r);
    const oy = cy * (hy - r);
    for (let i = 0; i < 3; i++) {
      // Always draw the nudge, so the detail level never reshuffles the stones.
      const rr = r - rng.range(0, Math.min(0.012, small * 0.08));
      if (perCorner === 2 && i === 1) continue;
      const a = ((k - 1) * Math.PI) / 2 + (i * Math.PI) / 4;
      ring.push([ox + rr * Math.cos(a), oy + rr * Math.sin(a)]);
    }
  });
  const kx = Math.max(0.3, (hx - p.inset) / hx);
  const ky = Math.max(0.3, (hy - p.inset) / hy);
  const pos: number[] = [];
  for (const [x, y] of ring) pos.push(x, y, p.back);
  for (const [x, y] of ring) pos.push(x, y, p.shoulder);
  for (const [x, y] of ring) pos.push(x * kx, y * ky, p.face + rng.jitter(FACE_JITTER));
  pos.push(rng.jitter(hx * 0.2), rng.jitter(hy * 0.2), p.crown);

  const n = ring.length;
  const index: number[] = [];
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < n; i++) {
      const a = r * n + i;
      const b = r * n + ((i + 1) % n);
      index.push(a, b, b + n, a, b + n, a + n);
    }
  }
  const centre = 3 * n;
  for (let i = 0; i < n; i++) index.push(centre, 2 * n + i, 2 * n + ((i + 1) % n));

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

/**
 * Closed chamfered block (56 triangles) centred on the origin: six faces
 * (each fanned from a centre vertex so it stays flat in the middle), twelve
 * bevelled edges and eight corner facets.
 */
function chamferedBlock(sx: number, sy: number, sz: number, chamfer: number): THREE.BufferGeometry {
  const half = [sx / 2, sy / 2, sz / 2];
  const c = Math.min(chamfer, ...half.map((h) => h * 0.45));
  const pos: number[] = [];
  // Three vertices per box corner, one on each face that meets there.
  const cornerVertex = (sign: number[], axis: number): number => {
    const corner = (sign[0] > 0 ? 1 : 0) + (sign[1] > 0 ? 2 : 0) + (sign[2] > 0 ? 4 : 0);
    return corner * 3 + axis;
  };
  for (let corner = 0; corner < 8; corner++) {
    const sign = [corner & 1 ? 1 : -1, corner & 2 ? 1 : -1, corner & 4 ? 1 : -1];
    for (let axis = 0; axis < 3; axis++) {
      const v = [0, 1, 2].map((k) => sign[k] * (k === axis ? half[k] : half[k] - c));
      pos.push(v[0], v[1], v[2]);
    }
  }
  const index: number[] = [];
  const tri = (a: number, b: number, d: number) => {
    // Orient outward: the block is convex and centred on the origin.
    const p = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const [pa, pb, pd] = [p(a), p(b), p(d)];
    const normal = pb.clone().sub(pa).cross(pd.clone().sub(pa));
    if (normal.dot(pa.add(pb).add(pd)) < 0) index.push(a, d, b);
    else index.push(a, b, d);
  };
  const quad = (a: number, b: number, d: number, e: number) => {
    tri(a, b, d);
    tri(a, d, e);
  };

  for (let axis = 0; axis < 3; axis++) {
    const [p, q] = [0, 1, 2].filter((k) => k !== axis);
    for (const s of [-1, 1]) {
      // Face: fan from a centre vertex.
      const centre = pos.length / 3;
      const cv = [0, 0, 0];
      cv[axis] = s * half[axis];
      pos.push(cv[0], cv[1], cv[2]);
      const loop = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([a, b]) => {
        const sign = [0, 0, 0];
        sign[axis] = s;
        sign[p] = a;
        sign[q] = b;
        return cornerVertex(sign, axis);
      });
      for (let i = 0; i < 4; i++) tri(centre, loop[i], loop[(i + 1) % 4]);
    }
    // Bevelled edges running along `axis`.
    for (const a of [-1, 1]) {
      for (const b of [-1, 1]) {
        const lo = [0, 0, 0];
        const hi = [0, 0, 0];
        lo[axis] = -1;
        hi[axis] = 1;
        lo[p] = hi[p] = a;
        lo[q] = hi[q] = b;
        quad(cornerVertex(lo, p), cornerVertex(hi, p), cornerVertex(hi, q), cornerVertex(lo, q));
      }
    }
  }
  for (let corner = 0; corner < 8; corner++) tri(corner * 3, corner * 3 + 1, corner * 3 + 2);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Opening surrounds of a wall, grown by the clearance stones keep from them. */
function surroundObstacles(wall: WallSpec): Rect[] {
  return wall.openings.map(({ surround: s }) => ({
    u0: s.u0 - SURROUND_GAP,
    u1: s.u1 + SURROUND_GAP,
    y0: s.y0 - SURROUND_GAP,
    y1: s.y1 + SURROUND_GAP,
  }));
}

/** Heights the coursing should meet: the bottom and top of every opening surround. */
function openingLines(wall: WallSpec): number[] {
  return surroundObstacles(wall).flatMap((r) => [r.y0, r.y1]);
}

function overlapsY(r: Band, band: Band): boolean {
  return r.y0 < band.y1 - EPS && r.y1 > band.y0 + EPS;
}

/** The value in `values` closest to `x` within `maxDist` that passes `ok`, or null. */
function nearest(values: number[], x: number, maxDist: number, ok: (v: number) => boolean): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (Math.abs(v - x) > maxDist || !ok(v)) continue;
    if (best === null || Math.abs(v - x) < Math.abs(best - x)) best = v;
  }
  return best;
}

/**
 * Vertex paint shared by the stones of a face: sides of a stone (deep in the
 * joints) a touch darker than its face, and a damp, greenish tint low on the
 * ground storey.
 */
function facePaint(storey: StoreySpec, walls: WallSpec[]): Paint {
  const normals = walls.map((w) => new THREE.Vector3(w.normal.x, 0, w.normal.z));
  const ground = storey.index === 0;
  const floorY = storey.floorY;
  return (p, n, out) => {
    let facing = 0;
    for (const nn of normals) facing = Math.max(facing, n.dot(nn));
    out.multiplyScalar(0.84 + 0.16 * THREE.MathUtils.clamp(facing, 0, 1));
    if (ground) {
      const k = THREE.MathUtils.clamp(1 - (p.y - floorY) / 0.75, 0, 1);
      if (k > 0) out.lerp(DAMP, 0.18 * k * k);
    }
  };
}

/**
 * Level of detail for a house. `layout.detail` drops below 1 on big houses,
 * which are seen from further away: their stones grow a little (up to +25 %).
 * If the estimated triangle count is still over target, the stones lose the
 * round corner points, then grow further (up to MAX_SCALE).
 */
function stoneLod(layout: HouseLayout): Lod {
  const area = stoneArea(layout);
  const coarse = THREE.MathUtils.clamp(1 - layout.detail, 0, 0.55);
  let scale = 1 + 0.45 * coarse;
  let perCorner: 2 | 3 = 3;
  const estimate = () => (area * TRIANGLES_PER_M2 * (perCorner === 2 ? 0.7 : 1)) / (scale * scale);
  if (estimate() > TRIANGLE_TARGET) perCorner = 2;
  if (estimate() > TRIANGLE_TARGET) scale = Math.min(MAX_SCALE, scale * Math.sqrt(estimate() / TRIANGLE_TARGET));
  return { perCorner, scale };
}

/** Approximate stone-faced area of the house (walls and gables minus openings), m². */
function stoneArea(layout: HouseLayout): number {
  let area = 0;
  for (const wall of layout.walls) {
    if (wall.style !== 'stone') continue;
    const floorY = layout.storeys[wall.storey].floorY;
    area += wall.length * (wall.y1 - floorY);
    if (wall.gable) area += (wall.length * (wall.gable.apexY - wall.gable.eaveY)) / 2;
    for (const o of wall.openings) area -= (o.surround.u1 - o.surround.u0) * (o.surround.y1 - o.surround.y0);
  }
  return area;
}

/** Exploded-view offset of a corner: it moves out with both of its walls. */
function cornerExplode(a: WallSpec, b: WallSpec): [number, number, number] {
  const ea = wallExplode(a, OUTWARD.stonework);
  const eb = wallExplode(b, OUTWARD.stonework);
  return [ea[0] + eb[0], ea[1], ea[2] + eb[2]];
}
