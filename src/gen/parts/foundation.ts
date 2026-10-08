import * as THREE from 'three';
import { PartBuilder, lumpify, mix, mul, vary } from '../builder';
import { wallExplode } from '../explode';
import type { PartDef } from '../house';
import type { HouseLayout, WallSpec } from '../layout';
import type { WallStyle } from '../params';
import type { Rng } from '../rng';

/**
 * Foundation: the stone plinth band the ground storey stands on, and the
 * stone steps up to the door.
 *
 * The plinth is a level base course of large, roughly dressed blocks laid in
 * running bond, one to three courses high depending on `plinthHeight`. At
 * every corner one block turns the corner, and which wall carries its long
 * side alternates from course to course (like quoins), so the band wraps the
 * house the way real masonry does. The top course has a weathered top that
 * sheds water away from the wall. A mortar bed behind the blocks fills the
 * joints whatever the wall style is.
 *
 * The steps are big slabs stacked like a small pyramid inside `layout.stoop`:
 * each one sits on (and is embedded in) the one below, lower steps wider and
 * deeper, the top one level with the door threshold.
 */
export const part: PartDef = {
  name: 'foundation',
  label: 'Foundation',
  explode: [0, 0, 0],
  build: ({ layout, rng }) => {
    // Steps are planned first: the plinth keeps its course tops and joints clear of them.
    const slabs = planSteps(layout, rng.fork('step-plan'));
    return [
      ...buildPlinth(layout, rng.fork('plinth'), slabs),
      buildMortarBed(layout, rng.fork('bed')),
      buildSteps(layout, slabs, rng.fork('steps')),
    ];
  },
};

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Plinth band, in wall-local coordinates (see the w budget in ARCHITECTURE.md). */
const BAND = {
  /** Buried a little so the band never floats on the (flat) ground. */
  bottom: -0.05,
  /** Back of the blocks, inside the wall body. */
  back: -0.045,
  /** Front face of the bottom course; lumps and jitter add < 1.5 cm. */
  front: 0.084,
  /** Each course above steps back by this much (a hint of batter). */
  batter: 0.006,
  /** Blocks are up to this much shallower than `front`, block by block. */
  frontJitter: 0.012,
  /** The top course stays just below floorY so it never fights the door hole's floor. */
  topBelowFloor: 0.009,
  /**
   * Weathering: the top course's top slopes down from just in front of the
   * wall face to the band's front, by this fraction of the run (a low plinth
   * gets the steeper `weatheringLow`, so it reads as a chamfered base course).
   */
  weathering: 0.36,
  weatheringLow: 0.95,
  /** A low plinth is buried this much deeper, so its blocks rise straight out of the ground. */
  buryLow: 0.06,
  /** Mortar joint between blocks. */
  joint: 0.016,
  /** Hand-made irregularity of each block. */
  lump: 0.007,
  /** Preferred course height; the plinth gets 1–3 courses. */
  courseTarget: 0.28,
};

/** Mortar bed behind the plinth blocks: shows in the joints. */
const BED = { front: 0.02, back: -0.05, topBelowFloor: 0.004 };

/** Door steps. */
const STEP = {
  /** Keep this far inside the stoop zone (lumps, jitter). */
  margin: 0.03,
  /** Back of every slab, tucked into the plinth / wall. */
  back: -0.04,
  /** Top step's top above the threshold (no z-fight with the plinth top). */
  topLift: 0.005,
  /** Each slab is embedded this deep into the one below it. */
  embed: 0.05,
  bottom: -0.06,
  /** Extra width of the top step on each side of the door opening. */
  topSideClear: 0.27,
  /** Slabs wider than this are laid as two stones. */
  maxSlabWidth: 1.7,
  radius: 0.04,
  lump: 0.008,
  /** Depth of the dip worn into the middle of each tread. */
  wear: 0.008,
  explode: 0.45,
};

// ---------------------------------------------------------------------------
// Plinth
// ---------------------------------------------------------------------------

interface Course {
  index: number;
  /** Bottom and top of the blocks in this course (joints already taken off). */
  y0: number;
  y1: number;
  /** Front face (w) of the blocks in this course. */
  front: number;
  isTop: boolean;
  /** Top course: how far its top drops at the front (weathering), and where the slope starts (w). */
  weathering: number;
  slopeFrom: number;
  /** 0: the weathering is a soft S-curve; 1: a straight chamfer (low plinths). */
  chamfer: number;
  /** Edge radius of the blocks. */
  radius: number;
  /** Block length multiplier. */
  lengthScale: number;
}

/** The block that turns one corner in one course. */
interface CornerBlock {
  /** Index (0–3, front/right/back/left) of the wall carrying its long side. */
  owner: number;
  /** Length along the owner wall, measured from the band's outer corner. */
  length: number;
  /** How far it reaches back into the owner wall's body; its return face on the neighbour is depth + protrusion wide. */
  depth: number;
}

function buildPlinth(layout: HouseLayout, rng: Rng, slabs: StepSlab[]): PartBuilder[] {
  const ground = layout.storeys[0];
  const walls = ground.walls;
  const pal = layout.params.palette;
  const base = mix(pal.stone, '#4f4a44', 0.32);
  const courses = planCourses(ground.floorY, ground.style, [...new Set(slabs.map((s) => s.y1))]);
  const corners = courses.map((c) => planCorners(c, walls, rng));
  // On the door wall, keep joints off the sides of the step slabs too.
  const stepEdges = slabs.flatMap((s) => [s.u0, s.u1]);

  // Joints of the course below on each wall (wall-local u), for running bond.
  const jointsBelow: number[][] = walls.map(() => []);
  const builders = walls.map((wall) => {
    const b = new PartBuilder(`foundation:plinth:${wall.id}`);
    b.explode = [0, 0, 0];
    return b;
  });

  for (const course of courses) {
    const P = course.front;
    walls.forEach((wall, j) => {
      const b = builders[j];
      const L = wall.length;
      const atStart = corners[course.index][j];
      const atEnd = corners[course.index][(j + 1) % 4];

      // Free run between the corner blocks (u of the joint centres).
      let runStart = atStart.depth + BAND.joint / 2;
      let runEnd = L - atEnd.depth - BAND.joint / 2;
      if (atStart.owner === j) {
        runStart = -P + atStart.length;
        addCornerBlock(b, wall, course, 'start', atStart, base, rng);
      }
      if (atEnd.owner === j) {
        runEnd = L + P - atEnd.length;
        addCornerBlock(b, wall, course, 'end', atEnd, base, rng);
      }

      const lengthScale = course.lengthScale;
      const avoid = wall.id === layout.stoop.wallId ? [...jointsBelow[j], ...stepEdges] : jointsBelow[j];
      const cuts = splitRun(runStart, runEnd, 0.65 * lengthScale, 1.15 * lengthScale, avoid, rng);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const u0 = cuts[i] + BAND.joint / 2;
        const u1 = cuts[i + 1] - BAND.joint / 2;
        const front = P - rng.range(0, BAND.frontJitter);
        addBlock(b, wall, course, { u0, u1, w0: BAND.back, w1: front }, null, base, rng);
      }
      jointsBelow[j] = cuts;
    });
  }
  return builders;
}

/**
 * Split the plinth height into level courses. Course boundaries are nudged
 * away from the step tops so no tread is ever coplanar with a block top.
 */
function planCourses(floorY: number, style: WallStyle, stepTops: number[]): Course[] {
  const low = lowness(floorY);
  const bottom = plinthBottom(floorY);
  const top = floorY - BAND.topBelowFloor;
  const height = top - BAND.bottom;
  const n = clamp(Math.round(height / BAND.courseTarget), 1, 3);
  // A slightly taller bottom course and shallower top course read as heavier at the base.
  const weights = Array.from({ length: n }, (_, i) => (n === 1 ? 1 : i === 0 ? 1.15 : i === n - 1 ? 0.9 : 1));
  const total = weights.reduce((s, w) => s + w, 0);
  // The weathering starts in front of whatever stands on the plinth (stone faces, a timber sill).
  const slopeFrom = style === 'stone' ? 0.03 : style === 'timber' ? 0.035 : 0;
  const levels = [bottom];
  let acc = BAND.bottom;
  for (let i = 0; i < n - 1; i++) {
    acc += (height * weights[i]) / total;
    // The block top below this joint sits at level - joint/2.
    const blockTop = nudgeAway(acc - BAND.joint / 2, stepTops, 0.015);
    levels.push(blockTop + BAND.joint / 2);
  }
  levels.push(top);
  return weights.map((_, i) => {
    const front = BAND.front - BAND.batter * i;
    const isTop = i === n - 1;
    // Visible height (the buried part does not count).
    const h = levels[i + 1] - Math.max(levels[i], BAND.bottom);
    return {
      index: i,
      y0: levels[i] + (i > 0 ? BAND.joint / 2 : 0),
      y1: levels[i + 1] - (i < n - 1 ? BAND.joint / 2 : 0),
      front,
      isTop,
      weathering: isTop ? (front - slopeFrom) * (BAND.weathering + (BAND.weatheringLow - BAND.weathering) * low) : 0,
      slopeFrom,
      chamfer: low,
      // A low base course is dressed crisper, so its chamfer reads.
      radius: clamp(h * 0.26, 0.03, 0.05) * (1 - 0.45 * low),
      // Taller courses get longer blocks, so proportions stay chunky; a low
      // base course is laid in long dressed lengths.
      lengthScale: Math.max(clamp(h / 0.24, 0.85, 1.4), 0.85 + 0.4 * low),
    };
  });
}

/** 1 for a very low plinth (≤ 0.15 m), 0 from 0.4 m up. */
function lowness(floorY: number): number {
  return clamp((0.4 - floorY) / 0.25, 0, 1);
}

/** Bottom of the plinth: a low plinth goes deeper, so its blocks rise straight out of the ground. */
function plinthBottom(floorY: number): number {
  return BAND.bottom - BAND.buryLow * lowness(floorY);
}

/** Corner blocks for one course; the long side alternates between the two walls per course. */
function planCorners(course: Course, walls: WallSpec[], rng: Rng): CornerBlock[] {
  return [0, 1, 2, 3].map((corner) => {
    // Corner i is the start of wall i and the end of wall i-1.
    const owner = (corner + course.index) % 2 === 0 ? corner : (corner + 3) % 4;
    const t = walls[owner].thickness;
    // Stay inside the wall body so the hidden back never reaches the interior.
    const maxDepth = Math.max(0.18, Math.min(0.34, t - 0.05));
    const h = course.y1 - course.y0;
    return {
      owner,
      length: rng.range(0.6, 0.8) * clamp(h / 0.24, 0.9, 1.35),
      depth: rng.range(Math.min(0.24, maxDepth * 0.9), maxDepth),
    };
  });
}

/** A corner block on its owner wall: long face on this wall, return face on the neighbour. */
function addCornerBlock(
  b: PartBuilder,
  wall: WallSpec,
  course: Course,
  end: 'start' | 'end',
  spec: CornerBlock,
  base: THREE.ColorRepresentation,
  rng: Rng,
): void {
  const P = course.front;
  const L = wall.length;
  const extent =
    end === 'start'
      ? { u0: -P, u1: -P + spec.length - BAND.joint / 2, w0: -spec.depth, w1: P }
      : { u0: L + P - spec.length + BAND.joint / 2, u1: L + P, w0: -spec.depth, w1: P };
  // How far a point is out over the neighbouring wall's face (0 at its face, 1 at the band's front).
  const overNeighbour = end === 'start' ? (u: number) => -u / P : (u: number) => (u - L) / P;
  addBlock(b, wall, course, extent, overNeighbour, vary(base, rng, 0.02, 0.01, 0), rng);
}

interface Extent {
  u0: number;
  u1: number;
  w0: number;
  w1: number;
}

/**
 * One plinth block in wall-local space. The top course gets a weathered top
 * that falls towards the band's front (and, on corner blocks, towards the
 * neighbouring wall's front too).
 */
function addBlock(
  b: PartBuilder,
  wall: WallSpec,
  course: Course,
  e: Extent,
  overNeighbour: ((u: number) => number) | null,
  base: THREE.ColorRepresentation,
  rng: Rng,
): void {
  const sx = e.u1 - e.u0;
  const sy = course.y1 - course.y0;
  const sz = e.w1 - e.w0;
  const c = new THREE.Vector3((e.u0 + e.u1) / 2, (course.y0 + course.y1) / 2, (e.w0 + e.w1) / 2);
  const g = roundedBlock(sx, sy, sz, course.radius, [sx > 0.8 ? 2 : 1, 1, 1]);
  g.translate(c.x, c.y, c.z);

  if (course.isTop) {
    const P = course.front;
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i);
      const y = pos.getY(i);
      const w = pos.getZ(i);
      const run = (v: number) => clamp((v - course.slopeFrom) / (P - course.slopeFrom), 0, 1);
      const out = Math.max(run(w), overNeighbour ? run(overNeighbour(u) * P) : 0);
      const up = clamp((y - c.y) / (sy / 2), 0, 1);
      const profile = smooth(out) + (out - smooth(out)) * course.chamfer;
      pos.setY(i, y - course.weathering * profile * up);
    }
  }
  roughen(g, BAND.lump, rng.int(0, 1e6));
  if (course.isTop) {
    // Lumps must not lift the top into the mortar bed's top or the door hole's floor.
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, Math.min(pos.getY(i), course.y1 + 0.002));
  }
  g.translate(-c.x, -c.y, -c.z);

  // Tiny rotations; ends move by at most ~4 mm so the band keeps its w budget.
  const halfLen = Math.max(sx, sz) / 2;
  const yaw = rng.jitter(0.004 / halfLen);
  const roll = course.isTop ? 0 : rng.jitter(0.003 / halfLen);
  const local = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, yaw, roll)));
  // Mostly even colour, with the odd noticeably lighter or darker block.
  const color = vary(base, rng, rng.chance(0.15) ? 0.1 : 0.05, 0.03, 0.01);
  const moss = rng.chance(0.3) ? rng.range(0.1, 0.22) : 0;
  b.add(g, 'stone', color, mul(wall.frame, local), (p, n, out) => groundGrime(p, n, out, moss));
}

/**
 * Cut points along a course: the run from `u0` to `u1` split into blocks of
 * `min`–`max` length, keeping joints off the joints of the course below.
 */
function splitRun(u0: number, u1: number, min: number, max: number, below: number[], rng: Rng): number[] {
  const bond = Math.min(0.16, min * 0.3);
  const clear = (u: number) => below.every((b) => Math.abs(b - u) >= bond);
  const cuts = [u0];
  let u = u0;
  for (let guard = 0; guard < 400 && u1 - u > max; guard++) {
    const rest = u1 - u;
    let length = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      length = rng.range(min, max);
      // Never leave a sliver for the last block.
      if (rest - length < min) length = rest / 2;
      if (clear(u + length)) break;
    }
    u += length;
    cuts.push(u);
  }
  cuts.push(u1);
  return cuts;
}

/** Ring of mortar behind the plinth blocks, so the joints show mortar, not plaster. */
function buildMortarBed(layout: HouseLayout, rng: Rng): PartBuilder {
  const g0 = layout.storeys[0];
  const b = new PartBuilder('foundation:bed');
  b.explode = [0, 0, 0];
  const top = g0.floorY - BED.topBelowFloor;
  const shape = rectPath(new THREE.Shape(), g0.minX - BED.front, g0.maxX + BED.front, g0.minZ - BED.front, g0.maxZ + BED.front);
  shape.holes.push(rectPath(new THREE.Path(), g0.minX - BED.back, g0.maxX + BED.back, g0.minZ - BED.back, g0.maxZ + BED.back));
  const bottom = plinthBottom(g0.floorY);
  const geom = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false });
  // Shape (x, -z) extruded along +z → lying flat, extruded up.
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, bottom, 0);
  b.add(geom, 'mortar', vary(mix(layout.params.palette.mortar, '#6b655c', 0.15), rng, 0.02, 0.02, 0));
  return b;
}

/** Trace an axis-aligned plan rectangle into `p`, in the (x, -z) plane of a flat Shape. */
function rectPath<T extends THREE.Path>(p: T, x0: number, x1: number, z0: number, z1: number): T {
  p.moveTo(x0, -z1);
  p.lineTo(x1, -z1);
  p.lineTo(x1, -z0);
  p.lineTo(x0, -z0);
  return p;
}

// ---------------------------------------------------------------------------
// Door steps
// ---------------------------------------------------------------------------

/** One stone slab of the door steps, in the door wall's local (u, y, w). */
interface StepSlab {
  /** 0 = bottom step. */
  step: number;
  isTop: boolean;
  u0: number;
  u1: number;
  y0: number;
  /** Tread height. */
  y1: number;
  /** Outer (front) edge; every slab starts at STEP.back. */
  front: number;
}

/**
 * Lay out the steps inside `layout.stoop`: equal risers from the ground up to
 * the threshold, the top step a landing in front of the door, each lower step
 * wider and one tread deeper. Lower steps sit under the ones above (so the
 * stack is solid) and wide ones are laid as two stones.
 */
function planSteps(layout: HouseLayout, rng: Rng): StepSlab[] {
  const stoop = layout.stoop;
  const n = Math.max(1, Math.round(stoop.steps));
  const tops = Array.from({ length: n }, (_, k) => (k === n - 1 ? stoop.topY + STEP.topLift : (stoop.topY * (k + 1)) / n));
  const uc = (stoop.u0 + stoop.u1) / 2;
  const halfMax = Math.max(0.2, (stoop.u1 - stoop.u0) / 2 - STEP.margin);
  const doorHalf = (layout.door.u1 - layout.door.u0) / 2;
  const halfTop = clamp(doorHalf + STEP.topSideClear, 0.2, halfMax);
  const shrink = n > 1 ? (halfMax - halfTop) / (n - 1) : 0;
  const frontMax = Math.max(0.2, stoop.w1 - STEP.margin);
  const tread = Math.max(0.05, (stoop.w1 - 0.12) / n);

  const slabs: StepSlab[] = [];
  for (let k = 0; k < n; k++) {
    const half = halfTop + (n - 1 - k) * shrink;
    const isTop = k === n - 1;
    const common = {
      step: k,
      isTop,
      y0: k === 0 ? STEP.bottom : tops[k - 1] - STEP.embed,
      y1: tops[k],
      front: Math.max(frontMax - k * tread, STEP.back + 0.15),
    };
    if (!isTop && 2 * half > STEP.maxSlabWidth) {
      // Joints staggered from step to step.
      const cut = uc + (k % 2 === 0 ? 1 : -1) * rng.range(0.12, 0.3);
      slabs.push({ ...common, u0: uc - half, u1: cut - BAND.joint / 2 });
      slabs.push({ ...common, u0: cut + BAND.joint / 2, u1: uc + half });
    } else {
      slabs.push({ ...common, u0: uc - half, u1: uc + half });
    }
  }
  return slabs;
}

function buildSteps(layout: HouseLayout, slabs: StepSlab[], rng: Rng): PartBuilder {
  const stoop = layout.stoop;
  const wall = layout.walls.find((w) => w.id === stoop.wallId) ?? layout.storeys[0].walls[0];
  const b = new PartBuilder('foundation:steps');
  b.explode = wallExplode(wall, STEP.explode);

  const uc = (stoop.u0 + stoop.u1) / 2;
  const base = mix(layout.params.palette.stone, '#7d766c', 0.14);
  const inv = wall.frame.clone().invert();
  // Where feet go: the middle of each tread, fading out towards its edges.
  const wear = (u: number, w: number, front: number) =>
    Math.exp(-(((u - uc) / 0.42) ** 2)) * clamp((front - w) / 0.12, 0, 1) * clamp((w + 0.02) / 0.12, 0, 1);

  for (const slab of slabs) {
    const { u0, u1, y0, y1, front } = slab;
    const sx = u1 - u0;
    const sy = y1 - y0;
    const sz = front - STEP.back;
    const c = new THREE.Vector3((u0 + u1) / 2, (y0 + y1) / 2, (STEP.back + front) / 2);
    const div: [number, number, number] = [clamp(Math.round(sx / 0.2), 2, 9), 1, clamp(Math.round(sz / 0.14), 1, 4)];
    const g = roundedBlock(sx, sy, sz, STEP.radius, div);
    g.translate(c.x, c.y, c.z);
    // A shallow dip worn into the tread.
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < y1 - STEP.radius) continue;
      const dip = STEP.wear * wear(pos.getX(i), pos.getZ(i), front) * clamp((y - (y1 - STEP.radius)) / STEP.radius, 0, 1);
      pos.setY(i, y - dip);
    }
    roughen(g, STEP.lump, rng.int(0, 1e6));
    g.translate(-c.x, -c.y, -c.z);

    // The top step stays square to the door; lower ones may sit a touch askew.
    const yaw = rng.jitter((slab.isTop ? 0.004 : 0.01) / Math.max(0.3, sx / 2));
    const local = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationY(yaw));
    const color = vary(base, rng, 0.07, 0.04, 0.015);
    const p = new THREE.Vector3();
    b.add(g, 'stone', color, mul(wall.frame, local), (pw, nrm, out) => {
      groundGrime(pw, nrm, out, 0);
      if (nrm.y > 0.6) {
        p.copy(pw).applyMatrix4(inv);
        out.lerp(LIGHT_WEAR, 0.22 * wear(p.x, p.z, front));
      }
    });
  }
  return b;
}

const LIGHT_WEAR = new THREE.Color('#ddd6c8');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MOSS = new THREE.Color('#6f7f45');

/**
 * Vertex paint for stones near the ground: darker splash zone at the base,
 * optional moss tint low down, slightly sun-bleached tops.
 */
function groundGrime(p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color, moss: number): void {
  const low = 1 - THREE.MathUtils.smoothstep(p.y, -0.04, 0.24);
  out.multiplyScalar(1 - 0.16 * low);
  if (moss > 0) out.lerp(MOSS, moss * low);
  if (n.y > 0.6) out.offsetHSL(0, -0.01, 0.025);
}

/**
 * A box with rounded edges, centred on the origin, built as ONE welded mesh
 * (RoundedBoxGeometry keeps its six faces separate), so `lumpify` keeps it
 * closed and smooth shading wraps around the edges. Each axis has two
 * rounded bands plus `div` flat segments in between; that is 108 triangles
 * at div = [1, 1, 1]. Normals are the ideal rounded-box normals.
 */
function roundedBlock(sx: number, sy: number, sz: number, radius: number, div: [number, number, number] = [1, 1, 1]): THREE.BufferGeometry {
  const half = [sx / 2, sy / 2, sz / 2];
  const r = Math.max(0.001, Math.min(radius, ...half.map((h) => h * 0.98)));
  const segs = div.map((d) => Math.max(1, Math.round(d)) + 2) as [number, number, number];
  const { grid, index } = boxSurface(...segs);

  const count = grid.length / 3;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    // Grid index on each axis → position: outer ring on the box, inner ones spread over the flat part.
    for (let a = 0; a < 3; a++) {
      const n = segs[a];
      const idx = grid[i * 3 + a];
      const inner = half[a] - r;
      p.setComponent(a, idx === 0 ? -half[a] : idx === n ? half[a] : -inner + ((idx - 1) / (n - 2)) * 2 * inner);
    }
    // Pull the edge/corner vertices onto a sphere of radius r around the inner box.
    q.set(clamp(p.x, -half[0] + r, half[0] - r), clamp(p.y, -half[1] + r, half[1] - r), clamp(p.z, -half[2] + r, half[2] - r));
    d.subVectors(p, q);
    const len = d.length() || 1;
    // Every surface point is exactly r from the inner box: d is its true normal.
    d.divideScalar(len);
    p.copy(q).addScaledVector(d, r);
    p.toArray(position, i * 3);
    d.toArray(normal, i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

/** Welded surface of an (nx, ny, nz) grid box: integer grid coords per vertex + outward-wound quads. */
interface BoxSurface {
  grid: Uint8Array;
  index: Uint32Array;
}
const surfaceCache = new Map<string, BoxSurface>();

function boxSurface(nx: number, ny: number, nz: number): BoxSurface {
  const key = `${nx},${ny},${nz}`;
  const cached = surfaceCache.get(key);
  if (cached) return cached;
  const n = [nx, ny, nz];
  const ids = new Map<number, number>();
  const grid: number[] = [];
  const vertex = (c: number[]) => {
    const k = c[0] + (nx + 1) * (c[1] + (ny + 1) * c[2]);
    let id = ids.get(k);
    if (id === undefined) {
      ids.set(k, (id = grid.length / 3));
      grid.push(c[0], c[1], c[2]);
    }
    return id;
  };
  const index: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    // (U, V, axis) is right-handed, so U × V points along +axis.
    const U = (axis + 1) % 3;
    const V = (axis + 2) % 3;
    for (const side of [0, n[axis]]) {
      for (let iu = 0; iu < n[U]; iu++) {
        for (let iv = 0; iv < n[V]; iv++) {
          const at = (du: number, dv: number) => {
            const c = [0, 0, 0];
            c[axis] = side;
            c[U] = iu + du;
            c[V] = iv + dv;
            return vertex(c);
          };
          const [a, b, c, e] = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
          if (side > 0) index.push(a, b, c, a, c, e);
          else index.push(a, c, b, a, e, c);
        }
      }
    }
  }
  const surface = { grid: Uint8Array.from(grid), index: Uint32Array.from(index) };
  surfaceCache.set(key, surface);
  return surface;
}

/**
 * Hand-made irregularity for a `roundedBlock`: lumpify the surface, then
 * blend the lumpy normals with the block's ideal ones so faces read as
 * dressed stone (flat-ish, crisp rounded edges) rather than soft pillows.
 */
function roughen(g: THREE.BufferGeometry, amount: number, seed: number, lumpiness = 0.4): THREE.BufferGeometry {
  const ideal = (g.attributes.normal as THREE.BufferAttribute).array.slice();
  lumpify(g, amount, seed);
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const n = new THREE.Vector3();
  for (let i = 0; i < nor.count; i++) {
    n.set(ideal[i * 3], ideal[i * 3 + 1], ideal[i * 3 + 2])
      .multiplyScalar(1 - lumpiness)
      .addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, i), lumpiness)
      .normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
  }
  return g;
}

/** Move `v` at least `gap` away from every value in `avoid` (single pass). */
function nudgeAway(v: number, avoid: number[], gap: number): number {
  for (const a of avoid) {
    if (Math.abs(v - a) < gap) v = a + (v >= a ? gap : -gap);
  }
  return v;
}

function smooth(x: number): number {
  return x * x * (3 - 2 * x);
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
