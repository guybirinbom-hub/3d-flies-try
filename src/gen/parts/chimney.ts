import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PartBuilder, boxGeometry, lumpify, mat4, mix, vary } from '../builder';
import { roofLift } from '../explode';
import type { PartDef } from '../house';
import { roofSurfaceY, type ChimneySpec, type HouseLayout } from '../layout';
import type { Rng } from '../rng';

/**
 * Chimney: a masonry stack (brick or field stone) rising through the roof,
 * crowned by a corbelled cap with clay pots or a little stone hood, and sealed
 * to the tiles with lead flashing — an apron on the downslope side, stepped
 * flashing up the sides and a back gutter on the upslope side — that follows
 * the roof surface on whichever slopes the stack touches.
 *
 * The stack is axis-aligned, so everything is built directly in world space.
 * Only the part above the tiles is detailed; below them the stack is just a
 * mortar-coloured core box (which also keeps the stack closed and shows as
 * mortar in the joints between the units).
 */
export const part: PartDef = {
  name: 'chimney',
  label: 'Chimney',
  explode: [0, 0, 0],
  build: ({ layout, rng }) => {
    const spec = layout.chimney;
    if (!spec) return new PartBuilder('chimney');
    const stack = planStack(layout, spec, rng.fork('plan'));
    const builders = [
      buildStack(stack, rng.fork('stack')),
      buildCap(stack, rng.fork('cap')),
      buildFlashing(stack, rng.fork('flashing')),
    ];
    const lift: [number, number, number] = [0, roofLift(layout) + 1.3, 0];
    for (const b of builders) b.explode = lift;
    return builders;
  },
};

// ---------------------------------------------------------------------------
// Look & feel constants
// ---------------------------------------------------------------------------

/** Lead flashing: a soft, matte blue-grey. */
const LEAD = '#737c85';
/** Soot inside the flue and pots (never pure black). */
const SOOT = '#2f2926';
const BRICK_REDS = ['#a5533b', '#9b4c38', '#b0613f', '#94493a', '#a95f45'];
const TERRACOTTA = ['#a85d3e', '#b36a47', '#9c573d'];

/** Masonry units the stack may hold before units get scaled up (≈44 triangles each). */
const MAX_UNITS = 230;

/** Flashing dimensions (metres). */
const FLASH = {
  /**
   * Height of the collar sheets' top above `roofSurfaceY`, measured
   * perpendicular to the slope: flush against the stack, sloping down at the
   * outer edges so the lead looks dressed into the tile courses. The apron's
   * edge stays higher so it still covers the tile tails below it.
   */
  lift: -0.004,
  edgeLift: -0.034,
  apronEdgeLift: -0.018,
  /** How far sheets and upstands reach below the tile surface (perpendicular), hiding the roof hole's edge. */
  drop: 0.07,
  /** Collar width beside the stack (over the side tiles). */
  side: 0.12,
  /** Apron width down the slope on the downslope side. */
  apron: 0.22,
  /** Back-gutter width up the slope on the upslope side. */
  gutter: 0.13,
  /** Upstand thickness proud of the masonry face, on top of the units' own bulge. */
  stand: 0.012,
  /** Upstand height above the tiles for the apron / back gutter. */
  standHeight: 0.1,
  /** Minimum height of each step of the side (step) flashing above the tiles. */
  stepHeight: 0.085,
};

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

type MasonryKind = 'brick' | 'stone';

/** Plan rectangle. */
interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** How the stack's outer skin is laid. */
interface Masonry {
  kind: MasonryKind;
  /** Nominal course height, bed joint included. */
  course: number;
  /** Nominal unit length along a face. */
  unit: number;
  /** How far a unit reaches into the stack; also what a corner unit shows on the return face. */
  depth: number;
  /** Gap between units (shows the mortar core behind). */
  joint: number;
  chamfer: number;
  lump: number;
  /** Max rotation jitter (radians). */
  tilt: number;
  /** Max outward jitter (metres). */
  bulge: number;
  base: THREE.Color;
  mortar: THREE.Color;
}

/** One horizontal course; `index` counts down from the topmost course (0). */
interface Course {
  y0: number;
  y1: number;
  index: number;
}

/** Everything the chimney builders share. */
interface Stack {
  layout: HouseLayout;
  spec: ChimneySpec;
  /** Outer footprint of the masonry. */
  rect: Rect;
  /** Top of the roof tiles at plan z. */
  surf: (z: number) => number;
  masonry: Masonry;
  /** Where the plain courses end and the cap starts. */
  bodyTop: number;
  /** Plain courses, top-down, reaching just below the stack's downslope foot. */
  courses: Course[];
  /** Number of courses the cap uses (they take indices 0 … capCourses-1). */
  capCourses: number;
}

function planStack(layout: HouseLayout, spec: ChimneySpec, rng: Rng): Stack {
  const surf = (z: number) => roofSurfaceY(layout.roof, z);
  const rect: Rect = {
    x0: spec.x - spec.sx / 2,
    x1: spec.x + spec.sx / 2,
    z0: spec.z - spec.sz / 2,
    z1: spec.z + spec.sz / 2,
  };
  // The roof is an inverted V, so over any z-interval its lowest point is at an end.
  const surfLow = Math.min(surf(rect.z0), surf(rect.z1));
  const masonry = chooseMasonry(layout, spec, surfLow, rng);

  // Brick stacks end in two oversailing courses; stone stacks in one slab.
  const capCourses = masonry.kind === 'brick' ? 2 : 1;
  const capHeight = masonry.kind === 'brick' ? 2 * masonry.course : rng.range(0.13, 0.16);
  const bodyTop = spec.y1 - capHeight;

  const courses: Course[] = [];
  const floor = Math.max(surfLow, spec.y0);
  let y = bodyTop;
  for (let i = capCourses; y > floor && courses.length < 200; i++) {
    const h = masonry.kind === 'brick' ? masonry.course : masonry.course * rng.range(0.9, 1.2);
    courses.push({ y0: y - h, y1: y, index: i });
    y -= h;
  }
  return { layout, spec, rect, surf, masonry, bodyTop, courses, capCourses };
}

/** Brick or field stone (stone houses favour stone), sized to stay within budget. */
function chooseMasonry(layout: HouseLayout, spec: ChimneySpec, surfLow: number, rng: Rng): Masonry {
  const pal = layout.params.palette;
  const stoneHouse = layout.storeys.some((s) => s.style === 'stone');
  const kind: MasonryKind = rng.chance(stoneHouse ? 0.6 : 0.35) ? 'stone' : 'brick';
  const m: Masonry =
    kind === 'brick'
      ? {
          kind,
          course: rng.range(0.095, 0.105),
          unit: rng.range(0.25, 0.29),
          depth: 0.11,
          joint: 0.014,
          chamfer: 0.012,
          lump: 0.004,
          tilt: 0.014,
          bulge: 0.006,
          base: new THREE.Color(rng.pick(BRICK_REDS)),
          // Lime mortar: a little lighter than the house's stone mortar.
          mortar: mix(pal.mortar, pal.plaster, 0.35),
        }
      : {
          kind,
          course: rng.range(0.15, 0.17),
          unit: rng.range(0.26, 0.31),
          depth: 0.15,
          joint: 0.02,
          chamfer: 0.026,
          lump: 0.011,
          tilt: 0.03,
          bulge: 0.01,
          base: new THREE.Color(pal.stone),
          mortar: new THREE.Color(pal.mortar),
        };
  // Very tall stacks (steep roofs, back-slope chimneys) get chunkier units.
  const units = ((spec.y1 - surfLow) / m.course) * ((2 * (spec.sx + spec.sz)) / m.unit);
  const scale = THREE.MathUtils.clamp(Math.sqrt(units / MAX_UNITS), 1, 1.8);
  m.course *= scale;
  m.unit *= scale;
  return m;
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

function buildStack(st: Stack, rng: Rng): PartBuilder {
  const b = new PartBuilder('chimney:stack');
  const { spec, masonry: m } = st;
  // Core box, a little inside the outer faces so the joints read as recessed
  // mortar. It runs from inside the house up to just under the cap.
  const inset = 0.016;
  const coreTop = m.kind === 'brick' ? spec.y1 - 0.012 : st.bodyTop + 0.012;
  b.box(
    'mortar',
    m.mortar,
    spec.sx - 2 * inset,
    coreTop - spec.y0,
    spec.sz - 2 * inset,
    mat4(spec.x, (spec.y0 + coreTop) / 2, spec.z),
  );
  for (const course of st.courses) layCourse(b, st, st.rect, course, m.depth, rng, true);
  return b;
}

/** The four outer faces: which plan axis a face runs along and which way it looks. */
const FACES = [
  { alongX: true, side: 1 }, // +z face
  { alongX: false, side: 1 }, // +x face
  { alongX: true, side: -1 }, // -z face
  { alongX: false, side: -1 }, // -x face
] as const;

/**
 * Lay one course of units around `rect` (the outer faces). Corners are bonded:
 * on even courses the faces running along x carry the corner units, on odd
 * courses the faces running along z do, so the corners interlock like real
 * brickwork / quoins. With `cull`, units hidden under the tiles and flashing
 * are skipped.
 */
function layCourse(b: PartBuilder, st: Stack, rect: Rect, course: Course, depth: number, rng: Rng, cull: boolean): void {
  const m = st.masonry;
  const g = m.joint;
  const d = Math.min(depth, (Math.min(rect.x1 - rect.x0, rect.z1 - rect.z0) - 0.1) / 2);
  const xFacesOwnCorners = course.index % 2 === 0;
  for (const face of FACES) {
    const owns = face.alongX === xFacesOwnCorners;
    const lo = face.alongX ? rect.x0 : rect.z0;
    const hi = face.alongX ? rect.x1 : rect.z1;
    const a = owns ? lo : lo + d + g;
    const span = (owns ? hi : hi - d - g) - a;
    if (span < 0.06) continue;
    const cuts = cutSpan(span, m, course.index, rng);
    for (let i = 0; i + 1 < cuts.length; i++) {
      // Joints between units; the outer ends meet the corner flush (or keep a joint from it).
      const p0 = a + cuts[i] + (i === 0 ? 0 : g / 2);
      const p1 = a + cuts[i + 1] - (i + 2 === cuts.length ? 0 : g / 2);
      layUnit(b, st, rect, face, course, d, p0, p1, rng, cull);
    }
  }
}

/** Cut positions (0 … span) along a face: stretcher bond for bricks, random lengths for stone. */
function cutSpan(span: number, m: Masonry, index: number, rng: Rng): number[] {
  if (m.kind === 'brick') {
    const n = Math.max(1, Math.round(span / m.unit));
    const step = span / n;
    const cuts = [0];
    // Odd courses are shifted half a brick so the vertical joints alternate.
    const first = index % 2 === 1 ? 0.5 : 1;
    for (let k = 0; k < n; k++) {
      const c = (k + first) * step;
      if (c < span - 0.02) cuts.push(c + rng.jitter(step * 0.05));
    }
    cuts.push(span);
    return cuts;
  }
  const n = Math.max(1, Math.round(span / m.unit + rng.jitter(0.45)));
  const weights = Array.from({ length: n }, () => rng.range(0.6, 1.4));
  const total = weights.reduce((s, w) => s + w, 0);
  const cuts = [0];
  let acc = 0;
  for (let k = 0; k < n - 1; k++) cuts.push((acc += (weights[k] / total) * span));
  cuts.push(span);
  return cuts;
}

/** One brick / stone on `face` covering [p0, p1] along the face. */
function layUnit(
  b: PartBuilder,
  st: Stack,
  rect: Rect,
  face: (typeof FACES)[number],
  course: Course,
  depth: number,
  p0: number,
  p1: number,
  rng: Rng,
  cull: boolean,
): void {
  const m = st.masonry;
  const stone = m.kind === 'stone';
  const len = p1 - p0;
  const mid = (p0 + p1) / 2;
  const height = course.y1 - course.y0 - m.joint - (stone ? rng.range(0, 0.022) : 0);
  const yc = (course.y0 + course.y1) / 2 + rng.jitter(stone ? 0.005 : 0.002);
  // Mostly proud of the face, occasionally a touch sunk.
  const out = rng.range(-0.3, 1) * m.bulge;
  let cx: number, cz: number, sx: number, sz: number;
  if (face.alongX) {
    cx = mid;
    cz = face.side > 0 ? rect.z1 - depth / 2 + out : rect.z0 + depth / 2 - out;
    sx = len;
    sz = depth;
  } else {
    cz = mid;
    cx = face.side > 0 ? rect.x1 - depth / 2 + out : rect.x0 + depth / 2 - out;
    sx = depth;
    sz = len;
  }
  const color = unitColor(m, course.index, rng);
  const tiltA = rng.jitter(m.tilt);
  const tiltB = rng.jitter(m.tilt * 0.5);
  const seed = rng.int(0, 1e6);
  // Fully under the tiles, or below the flashing upstand that covers the foot of the stack.
  if (cull && yc + height / 2 < Math.min(st.surf(cz - sz / 2), st.surf(cz + sz / 2)) + 0.03) return;
  const geom = lumpify(chamferBox(sx, height, sz, m.chamfer), m.lump, seed);
  const matrix = face.alongX ? mat4(cx, yc, cz, tiltB * 0.5, tiltB, tiltA) : mat4(cx, yc, cz, tiltA, tiltB, tiltB * 0.5);
  b.add(geom, 'stone', color, matrix);
}

/** Per-unit colour: varied, the odd over-fired brick or odd stone, soot near the top. */
function unitColor(m: Masonry, index: number, rng: Rng): THREE.Color {
  let c: THREE.Color;
  if (m.kind === 'brick') {
    c = vary(m.base, rng, 0.055, 0.06, 0.012);
    const r = rng.next();
    if (r < 0.08) c.lerp(new THREE.Color('#5f3428'), 0.35);
    else if (r < 0.14) c.lerp(new THREE.Color('#c98d62'), 0.3);
  } else {
    c = vary(m.base, rng, 0.075, 0.04, 0.012);
    const r = rng.next();
    if (r < 0.15) c.lerp(new THREE.Color('#b99b76'), 0.25);
    else if (r < 0.25) c.lerp(new THREE.Color('#9a9d99'), 0.2);
  }
  const soot = Math.max(0, 0.24 - 0.07 * index);
  return soot > 0 ? c.lerp(new THREE.Color(SOOT), soot) : c;
}

// ---------------------------------------------------------------------------
// Cap: corbel + pots, or stone slab + pots / hood
// ---------------------------------------------------------------------------

function buildCap(st: Stack, rng: Rng): PartBuilder {
  const b = new PartBuilder('chimney:cap');
  const { spec, masonry: m } = st;
  const overhang = rng.range(0.055, 0.075);
  const capRect = expand(st.rect, overhang);
  if (m.kind === 'brick') {
    // Two oversailing courses, each stepping out half the overhang.
    for (let k = st.capCourses - 1; k >= 0; k--) {
      const proj = (overhang * (st.capCourses - k)) / st.capCourses;
      const course: Course = { y0: spec.y1 - (k + 1) * m.course, y1: spec.y1 - k * m.course, index: k };
      layCourse(b, st, expand(st.rect, proj), course, m.depth + proj, rng, false);
    }
    potsOnFlaunching(b, st, capRect, spec.y1, rng);
  } else if (rng.chance(0.45)) {
    stoneHood(b, st, capRect, rng);
  } else {
    capSlabs(b, st, capRect, rng);
    potsOnFlaunching(b, st, capRect, spec.y1, rng);
  }
  return b;
}

/** One or two big stone slabs covering the top of a stone stack. */
function capSlabs(b: PartBuilder, st: Stack, r: Rect, rng: Rng): void {
  const { spec, bodyTop } = st;
  const t = spec.y1 - bodyTop;
  const split = r.x1 - r.x0 > 0.78 && rng.chance(0.7);
  const xs = (r.x0 + r.x1) / 2 + rng.jitter(0.08);
  const pieces: [number, number][] = split
    ? [
        [r.x0, xs - 0.007],
        [xs + 0.007, r.x1],
      ]
    : [[r.x0, r.x1]];
  for (const [x0, x1] of pieces) {
    stoneSlab(b, st, { x0, x1, z0: r.z0, z1: r.z1 }, bodyTop, t, rng);
  }
}

/** A chunky, slightly lumpy rounded stone slab. */
function stoneSlab(b: PartBuilder, st: Stack, r: Rect, y0: number, t: number, rng: Rng): void {
  const geom = lumpify(boxGeometry(r.x1 - r.x0, t, r.z1 - r.z0, 0.03), 0.007, rng.int(0, 1e6));
  const color = vary(st.masonry.base, rng, 0.05, 0.03, 0.01).lerp(new THREE.Color(SOOT), 0.08);
  b.add(geom, 'stone', color, mat4((r.x0 + r.x1) / 2, y0 + t / 2, (r.z0 + r.z1) / 2, 0, rng.jitter(0.012), rng.jitter(0.01)));
}

/**
 * Sloped mortar "flaunching" on top of the cap with 1–2 clay pots bedded in
 * it. The pots are what makes it read as a working chimney.
 */
function potsOnFlaunching(b: PartBuilder, st: Stack, capRect: Rect, top: number, rng: Rng): void {
  const { spec } = st;
  const radius = rng.range(0.095, 0.115);
  const room = capRect.x1 - capRect.x0 - 0.16;
  const gap = rng.range(0.05, 0.09);
  const count = rng.chance(0.6) && 4 * radius + gap <= room ? 2 : 1;
  const spacing = 2 * radius + gap;
  const xs = count === 2 ? [spec.x - spacing / 2, spec.x + spacing / 2] : [spec.x + rng.jitter(0.03)];

  // Frustum from just inside the cap's edge up to a pad around the pots.
  const rise = rng.range(0.06, 0.09);
  const inner = expand(capRect, -0.045);
  const half = (count === 2 ? spacing / 2 : 0) + radius + 0.04;
  const pad: Rect = {
    x0: Math.max(inner.x0 + 0.03, (xs[0] + xs[xs.length - 1]) / 2 - half),
    x1: Math.min(inner.x1 - 0.03, (xs[0] + xs[xs.length - 1]) / 2 + half),
    z0: Math.max(inner.z0 + 0.03, spec.z - radius - 0.04),
    z1: Math.min(inner.z1 - 0.03, spec.z + radius + 0.04),
  };
  const y0 = top - 0.012;
  const y1 = top + rise;
  const flaunch = hexahedron([
    new THREE.Vector3(inner.x0, y0, inner.z0),
    new THREE.Vector3(inner.x1, y0, inner.z0),
    new THREE.Vector3(inner.x1, y0, inner.z1),
    new THREE.Vector3(inner.x0, y0, inner.z1),
    new THREE.Vector3(pad.x0, y1, pad.z0),
    new THREE.Vector3(pad.x1, y1, pad.z0),
    new THREE.Vector3(pad.x1, y1, pad.z1),
    new THREE.Vector3(pad.x0, y1, pad.z1),
  ]);
  // Cement flaunching: greyer than the joints and a little sooty.
  const cement = mix(st.layout.params.palette.mortar, '#8c8a86', 0.4).lerp(new THREE.Color(SOOT), 0.18);
  b.add(flaunch, 'mortar', vary(cement, rng, 0.02, 0.02, 0));

  const terracotta = rng.pick(TERRACOTTA);
  const baseHeight = rng.range(0.3, 0.42);
  for (const x of xs) {
    const h = baseHeight * (count === 2 ? rng.range(0.88, 1.12) : 1);
    chimneyPot(b, x, y1 - 0.035, spec.z + rng.jitter(0.015), radius, h, vary(terracotta, rng, 0.04, 0.04, 0.01), rng);
  }
}

/** A tapered clay pot with a rolled rim; dark with soot inside and towards the top. */
function chimneyPot(b: PartBuilder, x: number, y: number, z: number, r: number, h: number, color: THREE.Color, rng: Rng): void {
  const P = (pr: number, py: number) => new THREE.Vector2(pr, py);
  const profile = [
    P(r * 1.04, 0),
    P(r * 1.06, 0.045),
    P(r * 0.97, 0.065),
    P(r * 0.88, h * 0.55),
    P(r * 0.83, h - 0.08),
    P(r * 0.97, h - 0.062),
    P(r * 0.99, h - 0.02),
    P(r * 0.9, h),
    P(r * 0.74, h),
    P(r * 0.71, h - 0.05),
    P(r * 0.68, h - 0.24),
    P(0.001, h - 0.24),
  ];
  const geom = new THREE.LatheGeometry(profile, 14);
  const soot = new THREE.Color(SOOT);
  const tilt = mat4(x, y, z, rng.jitter(0.02), rng.range(0, Math.PI), rng.jitter(0.02));
  const inv = tilt.clone().invert();
  const local = new THREE.Vector3();
  b.add(geom, 'roof', color, tilt, (p, _n, out) => {
    local.copy(p).applyMatrix4(inv);
    const radial = Math.hypot(local.x, local.z);
    // Everything inside the bore (the outer wall never comes this close to the axis).
    if (radial < r * 0.8) out.copy(soot);
    else out.lerp(soot, THREE.MathUtils.smoothstep(local.y / h, 0.55, 1) * 0.4);
  });
}

/**
 * Stone hood: a slab ring around a sooty flue, two little piers and a hood
 * slab on top, so the smoke escapes sideways. Common on stone cottages.
 */
function stoneHood(b: PartBuilder, st: Stack, capRect: Rect, rng: Rng): void {
  const { spec, bodyTop, rect } = st;
  const t = spec.y1 - bodyTop;
  // Ring of slabs around the flue opening.
  const rim = Math.min(0.17, (Math.min(spec.sx, spec.sz) - 0.24) / 2);
  const hole: Rect = { x0: rect.x0 + rim, x1: rect.x1 - rim, z0: rect.z0 + rim, z1: rect.z1 - rim };
  const j = 0.007;
  stoneSlab(b, st, { x0: capRect.x0, x1: capRect.x1, z0: hole.z1 + j, z1: capRect.z1 }, bodyTop, t, rng);
  stoneSlab(b, st, { x0: capRect.x0, x1: capRect.x1, z0: capRect.z0, z1: hole.z0 - j }, bodyTop, t, rng);
  stoneSlab(b, st, { x0: capRect.x0, x1: hole.x0 - j, z0: hole.z0 + j, z1: hole.z1 - j }, bodyTop, t, rng);
  stoneSlab(b, st, { x0: hole.x1 + j, x1: capRect.x1, z0: hole.z0 + j, z1: hole.z1 - j }, bodyTop, t, rng);
  // The flue: a sooty plug a little below the top, filling the opening.
  const flueTop = spec.y1 - 0.07;
  b.box(
    'mortar',
    SOOT,
    hole.x1 - hole.x0 + 0.03,
    flueTop - (bodyTop - 0.02),
    hole.z1 - hole.z0 + 0.03,
    mat4(spec.x, (flueTop + bodyTop - 0.02) / 2, spec.z),
  );

  // Two slim piers at the x ends, each of two stacked stones; the smoke
  // escapes front and back between them.
  const pierH = rng.range(0.24, 0.3);
  const pierW = Math.min(rng.range(0.1, 0.125), capRect.x1 - hole.x1 - 0.03);
  const pierD = capRect.z1 - capRect.z0 - 0.07;
  for (const side of [-1, 1]) {
    const xc = side < 0 ? capRect.x0 + 0.025 + pierW / 2 : capRect.x1 - 0.025 - pierW / 2;
    let y = spec.y1;
    for (const frac of [0.55, 0.45]) {
      const h = pierH * frac;
      const geom = lumpify(boxGeometry(pierW + rng.jitter(0.012), h - 0.012, pierD + rng.jitter(0.03), 0.026), 0.007, rng.int(0, 1e6));
      const color = vary(st.masonry.base, rng, 0.07, 0.04, 0.01).lerp(new THREE.Color(SOOT), 0.14);
      b.add(geom, 'stone', color, mat4(xc + rng.jitter(0.008), y + h / 2, spec.z + rng.jitter(0.01), 0, rng.jitter(0.04), 0));
      y += h;
    }
  }
  // Hood slab overhanging the piers a little, topped by a ridged capstone
  // that sheds rain like a tiny roof.
  const hood = expand(capRect, 0.025);
  const hoodY = spec.y1 + pierH - 0.006;
  const hoodT = rng.range(0.085, 0.105);
  stoneSlab(b, st, hood, hoodY, hoodT, rng);
  const r = expand(hood, -0.03);
  const y0 = hoodY + hoodT - 0.01;
  const ridge = y0 + ((r.z1 - r.z0) / 2) * Math.tan(rng.range(0.28, 0.42));
  const zc = (r.z0 + r.z1) / 2;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const wedge = hexahedron([
    V(r.x0, y0, r.z0),
    V(r.x1, y0, r.z0),
    V(r.x1, y0, r.z1),
    V(r.x0, y0, r.z1),
    V(r.x0 + 0.02, ridge, zc),
    V(r.x1 - 0.02, ridge, zc),
    V(r.x1 - 0.02, ridge, zc),
    V(r.x0 + 0.02, ridge, zc),
  ]);
  const color = vary(st.masonry.base, rng, 0.04, 0.03, 0.01).lerp(new THREE.Color(SOOT), 0.06);
  b.add(lumpify(wedge, 0.006, rng.int(0, 1e6)), 'stone', color);
}

// ---------------------------------------------------------------------------
// Flashing
// ---------------------------------------------------------------------------

/**
 * Lead flashing hugging the stack where it meets the roof: a collar of sheets
 * dressed over the tiles around the stack (apron downslope, back gutter
 * upslope, narrower strips beside it), upstands against the ±z faces and
 * stepped flashing climbing the ±x faces. Everything follows `roofSurfaceY`,
 * splitting at the ridge when the stack straddles it.
 */
function buildFlashing(st: Stack, rng: Rng): PartBuilder {
  const b = new PartBuilder('chimney:flashing');
  const { rect, surf } = st;
  const color = vary(LEAD, rng, 0.025, 0.02, 0.004);
  const cos = Math.cos(st.layout.roof.pitch);
  const below = (z: number) => surf(z) - FLASH.drop / cos;

  // Collar sheets. The +z face looks down the front slope when it lies in
  // front of the ridge (apron), otherwise up towards the ridge (back gutter).
  // Widths are measured along the slope, so convert them to plan.
  const downPos = rect.z1 > 0;
  const downNeg = rect.z0 < 0;
  const wPos = (downPos ? FLASH.apron : FLASH.gutter) * cos;
  const wNeg = (downNeg ? FLASH.apron : FLASH.gutter) * cos;
  const outer: Rect = { x0: rect.x0 - FLASH.side, x1: rect.x1 + FLASH.side, z0: rect.z0 - wNeg, z1: rect.z1 + wPos };
  // Sheet top: highest against the stack, sloping down to its outer edge so it
  // lies dressed over the tiles instead of standing on them like a plank.
  const sheetTop = (x: number, z: number) => {
    const tx = x < rect.x0 ? (x - outer.x0) / FLASH.side : x > rect.x1 ? (outer.x1 - x) / FLASH.side : 1;
    const tz = z < rect.z0 ? (z - outer.z0) / wNeg : z > rect.z1 ? (outer.z1 - z) / wPos : 1;
    const onApron = (z > rect.z1 && downPos) || (z < rect.z0 && downNeg);
    const edge = onApron ? FLASH.apronEdgeLift : FLASH.edgeLift;
    return surf(z) + THREE.MathUtils.lerp(edge, FLASH.lift, Math.min(tx, tz)) / cos;
  };
  // Nine-patch around the footprint (the middle cell is the stack itself).
  const xs = [outer.x0, rect.x0, rect.x1, outer.x1];
  const zs = [outer.z0, rect.z0, rect.z1, outer.z1];
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 3; k++) {
      if (i !== 1 || k !== 1) leadSlab(b, color, xs[i], xs[i + 1], zs[k], zs[k + 1], below, sheetTop);
    }
  }

  // Upstands against the faces, standing just proud of the bulgiest unit.
  const m = st.masonry;
  const proud = FLASH.stand + m.bulge + m.lump + 0.006;
  const inside = 0.012;
  for (const side of [1, -1]) {
    // ±z faces: the roof is level along x there, so a straight upstand.
    const zf = side > 0 ? rect.z1 : rect.z0;
    const top = snapToJoint(st, surf(zf) + FLASH.standHeight);
    const za = zf - side * inside;
    const zb = zf + side * proud;
    // Stops just short of the side upstands' outer faces so no faces coincide.
    leadSlab(b, color, rect.x0 - proud + 0.004, rect.x1 + proud - 0.004, Math.min(za, zb), Math.max(za, zb), below, () => top);
  }

  // Step flashing up the ±x faces: one step per course or so, each tucked into a joint.
  const stepLen = THREE.MathUtils.clamp(m.course / Math.tan(st.layout.roof.pitch), 0.07, 0.3);
  const z0 = rect.z0 - proud + 0.004;
  const z1 = rect.z1 + proud - 0.004;
  for (const side of [1, -1]) {
    const xf = side > 0 ? rect.x1 : rect.x0;
    const xa = xf - side * inside;
    const xb = xf + side * proud;
    for (const [s0, s1] of steps(z0, z1, stepLen)) {
      const top = snapToJoint(st, Math.max(surf(s0), surf(s1)) + FLASH.stepHeight);
      leadSlab(b, color, Math.min(xa, xb), Math.max(xa, xb), s0, s1, below, () => top);
    }
  }
  return b;
}

/** Split [z0, z1] into steps of about `len`, always breaking at the ridge (z = 0). */
function steps(z0: number, z1: number, len: number): [number, number][] {
  const pieces: [number, number][] = z0 < 0 && z1 > 0 ? [[z0, 0], [0, z1]] : [[z0, z1]];
  const out: [number, number][] = [];
  for (const [a, b] of pieces) {
    const n = Math.max(1, Math.round((b - a) / len));
    for (let i = 0; i < n; i++) out.push([a + ((b - a) * i) / n, a + ((b - a) * (i + 1)) / n]);
  }
  return out;
}

/** Raise `y` to the next bed joint above it (where flashing is tucked in), if one is close. */
function snapToJoint(st: Stack, y: number): number {
  let best = Infinity;
  for (const c of st.courses) if (c.y0 >= y && c.y0 < best) best = c.y0;
  return best - y < st.masonry.course * 0.5 ? best : y;
}

/**
 * Add a lead slab spanning [x0, x1] × [za, zb] in plan whose bottom and top
 * follow `bottomAt(z)` / `topAt(x, z)` (sampled at the corners). Split at the
 * ridge so each piece stays (nearly) planar. Lead is dull, so it goes in the
 * matte 'mortar' slot: the shiny 'metal' slot reads as polished steel.
 */
function leadSlab(
  b: PartBuilder,
  color: THREE.Color,
  x0: number,
  x1: number,
  za: number,
  zb: number,
  bottomAt: (z: number) => number,
  topAt: (x: number, z: number) => number,
): void {
  if (x1 - x0 < 1e-4 || zb - za < 1e-4) return;
  const ranges: [number, number][] = za < 0 && zb > 0 ? [[za, 0], [0, zb]] : [[za, zb]];
  for (const [a, c] of ranges) {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    b.add(
      hexahedron([
        V(x0, bottomAt(a), a),
        V(x1, bottomAt(a), a),
        V(x1, bottomAt(c), c),
        V(x0, bottomAt(c), c),
        V(x0, topAt(x0, a), a),
        V(x1, topAt(x1, a), a),
        V(x1, topAt(x1, c), c),
        V(x0, topAt(x0, c), c),
      ]),
      'mortar',
      color,
    );
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers (local to this part)
// ---------------------------------------------------------------------------

function expand(r: Rect, by: number): Rect {
  return { x0: r.x0 - by, x1: r.x1 + by, z0: r.z0 - by, z1: r.z1 + by };
}

/**
 * Box with 45° chamfers on every edge (44 triangles) and smoothed normals:
 * reads as a soft, hand-made brick or stone at a fraction of a rounded box's cost.
 */
function chamferBox(sx: number, sy: number, sz: number, chamfer: number): THREE.BufferGeometry {
  const half = [sx / 2, sy / 2, sz / 2];
  const c = Math.max(0.001, Math.min(chamfer, ...half.map((h) => h - 0.002)));
  // Vertex at corner `signs`, pushed out along `axis` (the other two coordinates are inset).
  const vert = (signs: number[], axis: number) =>
    new THREE.Vector3(...signs.map((s, i) => s * (i === axis ? half[i] : half[i] - c)) as [number, number, number]);
  const pos: number[] = [];
  const centre = new THREE.Vector3();
  const pm = [1, -1];
  // Six main faces.
  for (let k = 0; k < 3; k++) {
    for (const s of pm) {
      const i = (k + 1) % 3;
      const j = (k + 2) % 3;
      const corner = (si: number, sj: number) => {
        const signs = [0, 0, 0];
        signs[k] = s;
        signs[i] = si;
        signs[j] = sj;
        return vert(signs, k);
      };
      pushPolygon(pos, [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)], centre);
    }
  }
  // Twelve edge chamfers.
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const l = 3 - i - j;
      for (const si of pm) {
        for (const sj of pm) {
          const signs = (sl: number) => {
            const s = [0, 0, 0];
            s[i] = si;
            s[j] = sj;
            s[l] = sl;
            return s;
          };
          pushPolygon(pos, [vert(signs(1), i), vert(signs(1), j), vert(signs(-1), j), vert(signs(-1), i)], centre);
        }
      }
    }
  }
  // Eight corner triangles.
  for (const a of pm) for (const bb of pm) for (const cc of pm) {
    const s = [a, bb, cc];
    pushPolygon(pos, [vert(s, 0), vert(s, 1), vert(s, 2)], centre);
  }
  // Weld and smooth: the chamfers then shade like rounded edges while the
  // big faces stay (almost) flat — a soft, pillowy unit.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const welded = mergeVertices(g, 1e-5);
  welded.computeVertexNormals();
  return welded;
}

/**
 * Convex solid from 8 corners: bottom quad (x0z0, x1z0, x1z1, x0z1) then the
 * top quad in the same order. Faces are wound outwards automatically.
 */
function hexahedron(c: THREE.Vector3[]): THREE.BufferGeometry {
  const faces = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const centre = c.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / c.length);
  const pos: number[] = [];
  for (const f of faces) pushPolygon(pos, f.map((i) => c[i]), centre);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Fan-triangulate a convex polygon (vertices in cyclic order) into `out`,
 * wound so that it faces away from `inside`.
 */
function pushPolygon(out: number[], pts: THREE.Vector3[], inside: THREE.Vector3): void {
  // Newell normal: robust even if a corner is degenerate.
  const n = new THREE.Vector3();
  const mid = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    n.x += (p.y - q.y) * (p.z + q.z);
    n.y += (p.z - q.z) * (p.x + q.x);
    n.z += (p.x - q.x) * (p.y + q.y);
    mid.add(p);
  }
  if (n.lengthSq() < 1e-12) return; // collapsed face (e.g. the ridge of a wedge)
  mid.multiplyScalar(1 / pts.length);
  const ordered = n.dot(mid.sub(inside)) < 0 ? [...pts].reverse() : pts;
  for (let i = 1; i + 1 < ordered.length; i++) {
    for (const p of [ordered[0], ordered[i], ordered[i + 1]]) out.push(p.x, p.y, p.z);
  }
}
