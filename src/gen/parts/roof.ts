import * as THREE from 'three';
import { PartBuilder, boxGeometry, mat4, mix, mul, vary, type MatKey } from '../builder';
import { roofLift } from '../explode';
import type { PartDef } from '../house';
import type { HouseLayout, Opening, RoofCovering, Side, WallSpec } from '../layout';
import type { Rng } from '../rng';

/**
 * Gable roof: per slope a boarded deck (soffit boards + slab) on the walls,
 * rafter tails under the eaves, purlin ends under the gable overhang, fascia
 * and barge boards, and courses of overlapping tiles; plus a ridge of
 * overlapping ridge tiles (and sometimes turned finials) on top.
 *
 * Slope-local coordinates (X, Y, Z) — everything on a slope is built in these:
 * - X along the ridge, from the roof's centre (world x for the front slope).
 * - Z down the slope from the ridge line, measured along the roof underside.
 * - Y outward, perpendicular to the slope: Y = 0 is the roof underside
 *   (`roofUndersideY`), Y = deckThickness the top of the deck.
 * The back slope is the front slope rotated 180° about the vertical axis, so
 * both slopes share one builder function ("canonical" coordinates are those of
 * the front slope: z ≥ 0 is the slope's own side).
 */

// ---------------------------------------------------------------------------
// Tile styles
// ---------------------------------------------------------------------------

/** The covering is chosen by the layout (`layout.roof.covering`). */
type TileKind = RoofCovering;

interface TileStyle {
  kind: TileKind;
  /** Nominal tile width (along the ridge) and length (down the slope), metres. */
  width: number;
  length: number;
  /** Nominal gauge: how far apart the courses are along the slope. */
  gauge: number;
  /** Plate thickness (at the butt for shingles). */
  thickness: number;
  /** Gap between neighbouring tiles of a course. */
  gap: number;
  /** Random widths (slate, shingle) instead of a regular staggered grid. */
  irregular: boolean;
  /** Per-tile colour jitter: lightness, saturation, hue. */
  jitter: [number, number, number];
  /** Amplitude of the hand-laid waviness of the course lines. */
  wave: number;
}

// Sizes are a little larger than real tiles so the courses read from afar.
// length / gauge ≈ 2.3: every point of the deck is covered by two or three tiles.
const TILE_STYLES: Record<TileKind, TileStyle> = {
  // Beaver-tail (Biberschwanz): flat plain tiles with a rounded tail.
  beaver: {
    kind: 'beaver', width: 0.25, length: 0.42, gauge: 0.18, thickness: 0.026, gap: 0.008,
    irregular: false, jitter: [0.03, 0.03, 0.006], wave: 0.012,
  },
  // Fish-scale: semicircular tails.
  fish: {
    kind: 'fish', width: 0.26, length: 0.4, gauge: 0.17, thickness: 0.024, gap: 0.006,
    irregular: false, jitter: [0.03, 0.03, 0.006], wave: 0.01,
  },
  // Natural slate: random widths, softly rounded tail corners.
  slate: {
    kind: 'slate', width: 0.3, length: 0.44, gauge: 0.19, thickness: 0.02, gap: 0.006,
    irregular: true, jitter: [0.045, 0.03, 0.012], wave: 0.014,
  },
  // Riven wooden shingles: narrow, random widths, thicker at the butt.
  shingle: {
    kind: 'shingle', width: 0.2, length: 0.42, gauge: 0.17, thickness: 0.028, gap: 0.008,
    irregular: true, jitter: [0.05, 0.04, 0.01], wave: 0.016,
  },
};

// ---------------------------------------------------------------------------
// Dimensions shared by every piece of the roof
// ---------------------------------------------------------------------------

const SOFFIT_BOARD = 0.025; // thickness of the boards forming the deck underside
const RAFTER_W = 0.09;
const RAFTER_DEPTH = 0.11;
const RAFTER_SPACING = 0.62;
const FASCIA_T = 0.045;
const BARGE_T = 0.05;
const EAVE_TILE_OVERHANG = 0.04; // first course past the fascia
const VERGE_TUCK = 0.006; // tiles end this far inside the barge boards
const CHIMNEY_MARGIN = 0.04;
const RIDGE_RADIUS = 0.07;

interface RoofDims {
  layout: HouseLayout;
  sin: number;
  cos: number;
  tan: number;
  ridgeY: number;
  /** Centre of the roof along x. */
  cx: number;
  /** Half the outer length of the top storey along x. */
  halfLen: number;
  /** Half the deck length incl. the gable overhang (local X of the barge's inner face). */
  xEnd: number;
  halfDepth: number;
  /** Local Z of the eave edge (deck underside ends at |z| = halfDepth + overhangEave). */
  zMax: number;
  deck: number;
  /** How far fascia and barge boards hang below the deck underside. */
  drop: number;

  tile: TileStyle;
  /** Actual course gauge (nominal gauge stretched to fit eave → ridge). */
  gauge: number;
  courses: number;
  /** Tilt of each tile relative to the deck (its tail rests on the course below). */
  tilt: number;
  /** Local Y of a tile's head (where it rests on the deck). */
  yHead: number;
  /** Lift of the tiles at the gable ends relative to the middle (a slight sag). */
  sagMax: number;
  /** Highest tile top (local Y) anywhere. */
  tileTop: number;
  /** Local Z of the eave course's tail. */
  eaveTail: number;
  /** Local Y of the barge boards' top edge. */
  bargeTop: number;

  /** Ridge tiles: outer surface height over the slopes (local Y), cap shell thickness, leg end (local Z). */
  capH: number;
  capT: number;
  capZ: number;
}

function roofDims(layout: HouseLayout, style: TileStyle, rng: Rng): RoofDims {
  const r = layout.roof;
  const sin = Math.sin(r.pitch);
  const cos = Math.cos(r.pitch);
  const tan = Math.tan(r.pitch);
  const halfLen = (r.maxX - r.minX) / 2;
  const xEnd = halfLen + r.overhangGable;
  const zMax = (r.halfDepth + r.overhangEave) / cos;
  const deck = r.deckThickness;

  // Bigger tiles on very large roofs keep the triangle count bounded.
  const estTiles = (2 * xEnd * zMax) / (style.width * style.gauge);
  const scale = clamp(Math.sqrt(estTiles / 1500), 1, 1.75);
  const tile: TileStyle = { ...style, width: style.width * scale, length: style.length * scale, gauge: style.gauge * scale };

  // Each tile's tail rests on the course below; in a steady stack its tail
  // is lifted by thickness * length / gauge above its head.
  const rise = (tile.thickness * tile.length) / tile.gauge;
  const tilt = Math.atan2(rise, tile.length);
  const yHead = deck + 0.004;
  const sagMax = rng.range(0.004, 0.018);
  const tileTop = yHead + rise + tile.thickness + sagMax + 0.004;

  // Ridge cap: legs parallel to the slopes, rounded over the apex. The shell
  // must clear the tiles even where the rounding cuts the corner.
  const capT = Math.max(0.035, RIDGE_RADIUS * (1 - cos) + 0.015);
  const capH = tileTop + capT;
  const zArc = -(capH - RIDGE_RADIUS) * tan; // where the rounding meets the leg
  const capZ = Math.max(zArc + 0.1, -deck * tan + 0.06);

  // Courses from the eave (tail just past the fascia) to the ridge (last tail
  // tucked under the ridge cap).
  const eaveTail = zMax + FASCIA_T + EAVE_TILE_OVERHANG;
  const lastTail = capZ - 0.03;
  const courses = Math.max(2, Math.round((eaveTail - lastTail) / tile.gauge) + 1);
  const gauge = (eaveTail - lastTail) / (courses - 1);

  return {
    layout,
    sin,
    cos,
    tan,
    ridgeY: r.ridgeY,
    cx: (r.minX + r.maxX) / 2,
    halfLen,
    xEnd,
    halfDepth: r.halfDepth,
    zMax,
    deck,
    drop: RAFTER_DEPTH + 0.025,
    tile,
    gauge,
    courses,
    tilt,
    yHead,
    sagMax,
    tileTop,
    eaveTail,
    bargeTop: tileTop + 0.004,
    capH,
    capT,
    capZ,
  };
}

/** Slope-local (Z, Y) → canonical world (z, y). */
function toWorld(d: RoofDims, Z: number, Y: number): [number, number] {
  return [Z * d.cos + Y * d.sin, d.ridgeY - Z * d.sin + Y * d.cos];
}

/** Canonical (front-slope) world → world for the slope on `side` (+1 front, -1 back). */
function sideFrame(d: RoofDims, side: number): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationY(side > 0 ? 0 : Math.PI);
  return m.setPosition(d.cx, 0, 0);
}

/** Slope-local (X, Y, Z) → world. */
function slopeFrame(d: RoofDims, side: number): THREE.Matrix4 {
  const basis = new THREE.Matrix4()
    .makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, d.cos, d.sin), new THREE.Vector3(0, -d.sin, d.cos))
    .setPosition(0, d.ridgeY, 0);
  return mul(sideFrame(d, side), basis);
}

/** Lift of the tiles (and ridge) at local X: zero mid-roof, sagMax at the gable ends. */
function sagAt(d: RoofDims, X: number): number {
  const t = clamp(X / d.xEnd, -1, 1);
  return d.sagMax * t * t;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

interface RoofColors {
  tile: THREE.Color;
  moss: THREE.Color;
  ridge: THREE.Color;
  trim: THREE.Color; // barge boards, fascia
  structure: THREE.Color; // rafters, purlins
  soffit: THREE.Color;
  deck: THREE.Color;
  mortar: THREE.Color;
}

function roofColors(layout: HouseLayout, rng: Rng): RoofColors {
  const pal = layout.params.palette;
  return {
    tile: new THREE.Color(pal.roof),
    moss: new THREE.Color('#5f6f45'),
    ridge: shade(pal.roof, -0.07),
    trim: new THREE.Color(rng.chance(0.6) ? pal.timber : pal.wood),
    structure: new THREE.Color(pal.timber),
    soffit: shade(pal.wood, 0.1),
    deck: shade(pal.wood, -0.16),
    mortar: shade(mix(pal.mortar, pal.roof, 0.3), -0.03),
  };
}

/**
 * Smooth, seeded colour noise over the roof (-1..1): patches of weathering so
 * the covering is not uniformly speckled.
 */
function patchNoise(rng: Rng, scale = 1): (x: number, z: number) => number {
  const waves = Array.from({ length: 3 }, (_, i) => ({
    fx: rng.range(0.4, 1.1) * (i + 1) * 0.6 * scale * (rng.chance(0.5) ? 1 : -1),
    fz: rng.range(0.4, 1.1) * (i + 1) * 0.6 * scale,
    ph: rng.range(0, Math.PI * 2),
    a: 1 / (i + 1.5),
  }));
  const norm = waves.reduce((s, w) => s + w.a, 0);
  return (x, z) => waves.reduce((s, w) => s + w.a * Math.sin(x * w.fx + z * w.fz + w.ph), 0) / norm;
}

// ---------------------------------------------------------------------------
// The part
// ---------------------------------------------------------------------------

export const part: PartDef = {
  name: 'roof',
  label: 'Roof',
  explode: [0, 0, 0],
  build: ({ layout, rng }) => {
    const style = TILE_STYLES[layout.roof.covering];
    const d = roofDims(layout, style, rng.fork('dims'));
    const colors = roofColors(layout, rng.fork('colors'));
    const lift = roofLift(layout);

    const front = buildSlope(d, 1, colors, rng.fork('front'));
    front.explode = [0, lift, 0.7];
    const back = buildSlope(d, -1, colors, rng.fork('back'));
    back.explode = [0, lift, -0.7];
    const ridge = buildRidge(d, colors, rng.fork('ridge'));
    ridge.explode = [0, lift + 0.5, 0];
    return [front, back, ridge];
  },
};

/** Everything belonging to one slope. `side` is +1 for the front (+Z), -1 for the back. */
function buildSlope(d: RoofDims, side: number, colors: RoofColors, rng: Rng): PartBuilder {
  const b = new PartBuilder(side > 0 ? 'roof:front' : 'roof:back');
  const frame = slopeFrame(d, side);
  const canon = sideFrame(d, side);

  addDeck(b, d, frame, canon, colors, rng.fork('deck'));
  addRafterTails(b, d, side, frame, colors, rng.fork('rafters'));
  addPurlins(b, d, side, frame, canon, colors, rng.fork('purlins'));
  addFascia(b, d, frame, colors);
  addBargeBoards(b, d, canon, colors);
  addEaveStarter(b, d, frame, colors);
  addTiles(b, d, side, frame, colors, rng.fork('tiles'));
  return b;
}

// ---------------------------------------------------------------------------
// Deck, soffit and structure
// ---------------------------------------------------------------------------

/**
 * The deck: soffit boards (the underside, exactly on `roofUndersideY`) and a
 * slab above them up to `deckThickness`. Cut plumb at the ridge so the two
 * slopes meet face to face, square at the eave (covered by the fascia).
 */
function addDeck(b: PartBuilder, d: RoofDims, frame: THREE.Matrix4, canon: THREE.Matrix4, colors: RoofColors, rng: Rng) {
  const slab: [number, number][] = [
    toWorld(d, -SOFFIT_BOARD * d.tan, SOFFIT_BOARD),
    toWorld(d, d.zMax, SOFFIT_BOARD),
    toWorld(d, d.zMax, d.deck),
    toWorld(d, -d.deck * d.tan, d.deck),
  ];
  b.add(prismX(slab, -d.xEnd, d.xEnd), 'wood', colors.deck, canon);

  // Boards along the ridge direction; chamfered so the joints read as grooves.
  const n = Math.max(3, Math.round(d.zMax / 0.19));
  const w = d.zMax / n;
  const board = boxGeometry(2 * d.xEnd, SOFFIT_BOARD, w, 0.007, 1);
  for (let i = 0; i < n; i++) {
    const m = mul(frame, mat4(0, SOFFIT_BOARD / 2, (i + 0.5) * w));
    b.add(board, 'wood', vary(colors.soffit, rng, 0.04, 0.03, 0.006), m);
  }
}

/** Rafter tails under the eave overhang, running out of the eave wall to the fascia. */
function addRafterTails(b: PartBuilder, d: RoofDims, side: number, frame: THREE.Matrix4, colors: RoofColors, rng: Rng) {
  const wall = topWall(d.layout, side > 0 ? 'front' : 'back');
  const zIn = (d.halfDepth - 0.1) / d.cos; // start a little inside the wall top
  const len = d.zMax - zIn;
  if (len <= 0.05) return;
  const span = d.halfLen - 0.25;
  const n = Math.max(2, Math.round((2 * span) / RAFTER_SPACING) + 1);
  // Lowest point of a rafter at distance w in front of the wall face.
  const yLow = (w: number) => d.layout.roof.eaveY - RAFTER_DEPTH / d.cos - Math.max(0, w) * d.tan;
  const rafter = boxGeometry(RAFTER_W, RAFTER_DEPTH, len, 0.016, 1);
  for (let i = 0; i < n; i++) {
    const X = -span + (2 * span * i) / (n - 1);
    // u along the eave wall (front and back walk opposite ways, and so do the canonical frames).
    const u = X + d.halfLen;
    if (blockedByOpening(wall, u - RAFTER_W / 2, u + RAFTER_W / 2, yLow)) continue;
    const m = mul(frame, mat4(X, -RAFTER_DEPTH / 2, zIn + len / 2, 0, rng.jitter(0.012), 0));
    b.add(rafter, 'timber', vary(colors.structure, rng, 0.04, 0.03, 0.005), m);
  }
}

/**
 * Purlin ends poking out of the gable walls under the gable overhang: one at
 * mid-slope per slope and the ridge purlin (built with the front slope).
 */
function addPurlins(b: PartBuilder, d: RoofDims, side: number, frame: THREE.Matrix4, canon: THREE.Matrix4, colors: RoofColors, rng: Rng) {
  const H = d.halfDepth;
  const x0 = d.halfLen - 0.12; // inside the gable wall
  const len = d.xEnd - x0;
  const eaveY = d.layout.roof.eaveY;
  // Gable walls at the canonical +X / -X ends, and their u for canonical z.
  const ends = [
    { sign: 1, wall: topWall(d.layout, side > 0 ? 'right' : 'left'), u: (z: number) => H - z },
    { sign: -1, wall: topWall(d.layout, side > 0 ? 'left' : 'right'), u: (z: number) => H + z },
  ];

  // Mid-slope purlin.
  const zp = H * 0.5;
  const ph = 0.16;
  const pw = 0.14;
  if (zp > 0.6) {
    const Z = zp / d.cos;
    const yLow = eaveY + (H - zp) * d.tan - ph * d.cos - (pw / 2) * d.sin;
    for (const e of ends) {
      const u = e.u(zp);
      if (blockedByOpening(e.wall, u - pw, u + pw, () => yLow)) continue;
      const m = mul(frame, mat4(e.sign * (x0 + len / 2), -ph / 2, Z));
      b.box('timber', vary(colors.structure, rng, 0.04, 0.03, 0.005), len, ph, pw, m, 0.02);
    }
  }

  // Ridge purlin: pentagon whose top follows the underside's apex.
  if (side > 0) {
    const hw = 0.09;
    const rh = 0.18;
    const yEdge = d.ridgeY - hw * d.tan;
    const profile: [number, number][] = [
      [-hw, yEdge],
      [0, d.ridgeY],
      [hw, yEdge],
      [hw, yEdge - rh],
      [-hw, yEdge - rh],
    ];
    for (const e of ends) {
      if (blockedByOpening(e.wall, H - hw, H + hw, () => yEdge - rh)) continue;
      const geo = e.sign > 0 ? prismX(profile, x0, d.xEnd, 0.015) : prismX(profile, -d.xEnd, -x0, 0.015);
      b.add(geo, 'timber', vary(colors.structure, rng, 0.04, 0.03, 0.005), canon);
    }
  }
}

/** Fascia board across the eave end of the deck, hiding the rafter ends; the first course rests on it. */
function addFascia(b: PartBuilder, d: RoofDims, frame: THREE.Matrix4, colors: RoofColors) {
  const top = starterUndersideAt(d, d.zMax + FASCIA_T) - 0.004;
  const h = top + d.drop;
  const len = 2 * (d.xEnd + 0.004);
  const m = mul(frame, mat4(0, top - h / 2, d.zMax + FASCIA_T / 2));
  b.box('wood', colors.trim, len, h, FASCIA_T, m, 0.014);
}

/**
 * Barge boards along both gable edges: in the vertical gable plane just
 * outside the deck, from below the soffit to just above the tiles, mitred
 * plumb at the ridge (and trimmed under the ridge cap's rounding).
 */
function addBargeBoards(b: PartBuilder, d: RoofDims, canon: THREE.Matrix4, colors: RoofColors) {
  const zEnd = d.eaveTail + 0.005;
  // The lower corner at the eave end is rounded off.
  const r = Math.min(0.07, (d.drop + d.bargeTop) * 0.3);
  const corner: [number, number][] = [];
  for (let k = 0; k <= 4; k++) {
    const a = -Math.PI / 2 + (k / 4) * (Math.PI / 2);
    corner.push([zEnd - r + Math.cos(a) * r, -d.drop + r + Math.sin(a) * r]);
  }
  const local: [number, number][] = [
    [d.drop * d.tan, -d.drop], // plumb cut at the ridge, bottom
    ...corner,
    [zEnd, d.bargeTop],
    [-d.bargeTop * d.tan, d.bargeTop], // plumb cut at the ridge, top
  ];
  const yClip = ridgeCapTopY(d) - d.capT * 0.8;
  const profile = clipBelow(
    local.map(([Z, Y]) => toWorld(d, Z, Y)),
    yClip,
  );
  b.add(prismX(profile, d.xEnd, d.xEnd + BARGE_T, 0.012), 'wood', colors.trim, canon);
  b.add(prismX(profile, -d.xEnd - BARGE_T, -d.xEnd, 0.012), 'wood', colors.trim, canon);
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

/** Local Y of the bottom of an untrimmed tile of a course, at Z. */
function tileUndersideAt(d: RoofDims, courseTail: number, Z: number): number {
  return d.yHead + (Z - (courseTail - d.tile.length)) * Math.tan(d.tilt);
}

/** Underside of the eave starter strip (just below the first course). */
function starterUndersideAt(d: RoofDims, Z: number): number {
  return tileUndersideAt(d, d.eaveTail, Z) - d.tile.thickness - 0.002;
}

/**
 * Doubled eave course: a strip under the first course, so the joints between
 * the first course's tiles show tile (not deck) and the eave reads thick.
 */
function addEaveStarter(b: PartBuilder, d: RoofDims, frame: THREE.Matrix4, colors: RoofColors) {
  const z0 = d.eaveTail - 0.55 * d.tile.length;
  const z1 = d.eaveTail - 0.012;
  const th = d.tile.thickness * 0.9;
  const y0 = starterUndersideAt(d, z0);
  const len = (z1 - z0) / Math.cos(d.tilt);
  const m = mul(frame, mat4(0, y0, z0, -d.tilt));
  const strip = boxGeometry(2 * (d.xEnd + VERGE_TUCK), th, len, 0.008, 1);
  strip.translate(0, th / 2, len / 2);
  b.add(strip, 'roof', shade(colors.tile, -0.12), m);
}

interface TileRect {
  x0: number;
  x1: number;
  /** Local Z of head (upper end) and tail (lower end). */
  zh: number;
  zt: number;
}

/** Courses of tiles, eave to ridge, staggered, fitted around the chimney. */
function addTiles(b: PartBuilder, d: RoofDims, side: number, frame: THREE.Matrix4, colors: RoofColors, rng: Rng) {
  const t = d.tile;
  const halfSpan = d.xEnd + VERGE_TUCK;
  const tanTilt = Math.tan(d.tilt);
  const obstacle = chimneyObstacle(d, side);
  const noise = patchNoise(rng.fork('noise'));
  const mossNoise = patchNoise(rng.fork('moss'), 2.5);
  // Moss grows in a few clusters, more on the back (shady) slope and on shingles.
  const mossBase = (side < 0 ? 0.35 : 0.15) * (t.kind === 'shingle' ? 2 : 1);
  // Tiles never cross the plumb plane through the ridge (the other slope's side).
  const ridgeLimit = -d.yHead * d.tan + 0.006;

  const palette = new TilePalette(t, colors, rng.fork('palette'));
  const batch = new PieceBatch(palette.colors.length);
  let prevJoints: number[] = [];
  for (let j = 0; j < d.courses; j++) {
    const courseTail = d.eaveTail - j * d.gauge;
    const wave = { a: t.wave * rng.range(0.3, 1), k: (Math.PI * 2) / rng.range(2.5, 6), ph: rng.range(0, Math.PI * 2) };
    const joints = courseJoints(-halfSpan, halfSpan, t, j % 2 === 1, prevJoints, rng);
    prevJoints = joints;

    for (let k = 0; k + 1 < joints.length; k++) {
      const x0 = joints[k] + (k === 0 ? 0 : t.gap / 2);
      const x1 = joints[k + 1] - (k + 2 === joints.length ? 0 : t.gap / 2);
      const xc0 = (x0 + x1) / 2;
      const dz = wave.a * Math.sin(xc0 * wave.k + wave.ph) + rng.jitter(0.006);
      const tail = courseTail + dz;
      const length = t.length * (1 + rng.jitter(0.02));
      const rect = fitAround({ x0, x1, zh: Math.max(tail - length, ridgeLimit), zt: tail }, obstacle, t);
      if (!rect || rect.zt - rect.zh < 0.05) continue;

      const w = rect.x1 - rect.x0;
      const len = rect.zt - rect.zh;
      const xc = (rect.x0 + rect.x1) / 2;
      // Underside line of this tile (its nominal head rests on the deck).
      const yHeadHere = d.yHead + (rect.zh - (tail - length)) * tanTilt + sagAt(d, xc);
      const mesh = tileMesh(t.kind, w, len / Math.cos(d.tilt), t.thickness, rng);
      const m = mul(frame, mat4(xc, yHeadHere, rect.zh, -d.tilt + rng.jitter(0.008), rng.jitter(0.022), rng.jitter(0.015)));
      const cluster = Math.max(0, mossNoise(xc * side, rect.zt) - 0.35);
      const moss = mossBase * cluster * (0.5 + rect.zt / d.zMax) + 0.003;
      batch.add(mesh, m, palette.pick(rng, noise(xc * 0.9 * side, rect.zt * 0.9), moss));
    }
  }
  batch.flush(b, 'roof', palette.colors);
}

/**
 * The tile colours of one slope: a few dozen variations around the roof
 * colour (sorted light → dark), some burnt darker ones and some mossy ones.
 * Tiles pick from it, so a slope is a handful of uniformly coloured batches.
 */
class TilePalette {
  readonly colors: THREE.Color[] = [];
  private readonly normal: number[] = [];
  private readonly dark: number[] = [];
  private readonly mossy: number[] = [];

  constructor(t: TileStyle, colors: RoofColors, rng: Rng) {
    const [l, s, h] = t.jitter;
    const lightness = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 }).l;
    const normal = Array.from({ length: 20 }, () => vary(colors.tile, rng, l * 1.4, s, h));
    normal.sort((a, b) => lightness(b) - lightness(a));
    // Each list holds indices into `colors` (one batch per colour).
    const put = (list: number[], c: THREE.Color) => {
      list.push(this.colors.length);
      this.colors.push(c);
    };
    for (const c of normal) put(this.normal, c);
    for (let i = 0; i < 4; i++) put(this.dark, vary(colors.tile, rng, l, s, h).multiplyScalar(rng.range(0.76, 0.88)));
    for (let i = 0; i < 6; i++) put(this.mossy, mix(vary(colors.tile, rng, l, s, h), colors.moss, rng.range(0.2, 0.45)));
  }

  /** Colour index for a tile in a weathering patch (-1 dark … 1 light) with the given chance of moss. */
  pick(rng: Rng, patch: number, moss: number): number {
    if (rng.chance(0.04)) return this.dark[rng.int(0, this.dark.length - 1)];
    if (rng.chance(moss)) return this.mossy[rng.int(0, this.mossy.length - 1)];
    const u = clamp(rng.next() * 0.65 + (0.5 - patch * 0.5) * 0.35, 0, 0.999);
    return this.normal[Math.floor(u * this.normal.length)];
  }
}

/**
 * Joint positions (incl. both ends) of one course. Regular styles stagger by
 * half a tile on odd courses (verge pieces become tile-and-a-half); irregular
 * styles use random widths kept clear of the previous course's joints.
 */
function courseJoints(x0: number, x1: number, t: TileStyle, odd: boolean, prev: number[], rng: Rng): number[] {
  const out = [x0];
  if (!t.irregular) {
    const n = Math.max(1, Math.round((x1 - x0) / t.width));
    const w = (x1 - x0) / n;
    for (let k = 1; k <= n; k++) {
      const x = x0 + (k - (odd ? 0.5 : 0)) * w + rng.jitter(0.03 * w);
      if (x - x0 < 0.55 * w || x1 - x < 0.55 * w) continue;
      out.push(x);
    }
  } else {
    let x = x0;
    for (;;) {
      let next = x + t.width * rng.range(0.65, 1.35);
      for (let tries = 0; tries < 3 && prev.some((p) => Math.abs(p - next) < 0.22 * t.width); tries++) next += 0.25 * t.width;
      if (x1 - next < 0.5 * t.width) break;
      out.push(next);
      x = next;
    }
  }
  out.push(x1);
  return out;
}

interface Obstacle {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** The chimney's footprint in this slope's local (X, Z), where it passes through the tile layer. */
function chimneyObstacle(d: RoofDims, side: number): Obstacle | null {
  const c = d.layout.chimney;
  if (!c) return null;
  const x = side * (c.x - d.cx);
  const z = side * c.z;
  const zA = z - c.sz / 2;
  const zB = z + c.sz / 2;
  if (zB <= 0) return null; // entirely on the other slope
  return {
    x0: x - c.sx / 2 - CHIMNEY_MARGIN,
    x1: x + c.sx / 2 + CHIMNEY_MARGIN,
    // The tile layer spans Y ∈ [deck, tileTop]: Z = (z - Y sin) / cos.
    z0: (zA - d.tileTop * d.sin) / d.cos - CHIMNEY_MARGIN,
    z1: (zB - d.deck * d.sin) / d.cos + CHIMNEY_MARGIN,
  };
}

/**
 * Trim a tile so it keeps clear of an obstacle: keep the largest piece left
 * after cutting it on one side, or drop it if nothing sensible remains.
 */
function fitAround(r: TileRect, o: Obstacle | null, t: TileStyle): TileRect | null {
  if (!o || r.x1 <= o.x0 || r.x0 >= o.x1 || r.zt <= o.z0 || r.zh >= o.z1) return r;
  const minW = 0.35 * t.width;
  const minL = 0.3 * t.length;
  const options: TileRect[] = [
    { ...r, x1: o.x0 },
    { ...r, x0: o.x1 },
    { ...r, zh: o.z1 },
    { ...r, zt: o.z0 },
  ].filter((c) => c.x1 - c.x0 >= minW && c.zt - c.zh >= minL);
  if (!options.length) return null;
  const area = (c: TileRect) => (c.x1 - c.x0) * (c.zt - c.zh);
  return options.reduce((a, c) => (area(c) > area(a) ? c : a));
}

/** Outline of a tile in its own (x, z) plane: x across, z from head (0) to tail (len). */
function tileOutline(kind: TileKind, w: number, len: number, rng: Rng): [number, number][] {
  const hw = w / 2;
  const j = () => rng.jitter(0.003);
  const pts: [number, number][] = [
    [-hw, 0],
    [hw, 0],
  ];
  const arc = (tailH: number, exponent: number, steps: number) => {
    const e = 2 / exponent;
    for (let k = 0; k <= steps; k++) {
      const phi = (k / steps) * Math.PI;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      pts.push([hw * Math.sign(c) * Math.abs(c) ** e + j(), len - tailH + tailH * Math.abs(s) ** e + j()]);
    }
  };
  switch (kind) {
    case 'beaver':
      arc(Math.min(len * 0.35, w * 0.34), 2.6, 6);
      break;
    case 'fish':
      arc(Math.min(len * 0.45, hw), 2, 6);
      break;
    case 'slate': {
      const r = Math.min(0.045, w * 0.22, len * 0.3);
      for (const [cx, sx] of [[hw - r, 1], [-hw + r, -1]] as const) {
        const a0 = sx > 0 ? 0 : Math.PI / 2;
        for (let k = 0; k <= 2; k++) {
          const a = a0 + (k / 2) * (Math.PI / 2);
          pts.push([cx + Math.cos(a) * r + j(), len - r + Math.sin(a) * r + j()]);
        }
      }
      break;
    }
    case 'shingle': {
      const skew = rng.jitter(Math.min(0.02, len * 0.05));
      const r = Math.min(0.012, w * 0.1);
      pts.push([hw, len + skew - r], [hw - r, len + skew], [-hw + r, len - skew], [-hw, len - skew - r]);
      break;
    }
  }
  return pts;
}

/**
 * A thin plate with softly rounded edges: bottom ring, slightly inset top
 * ring and centre fans, with hand-set normals so it shades like a pillowy
 * tile. Built at its real size (no scaling) so the normals stay right.
 */
function tileMesh(kind: TileKind, w: number, len: number, th: number, rng: Rng): RawMesh {
  let outline = tileOutline(kind, w, len, rng);
  // Wind counter-clockwise seen from +Y (negative shoelace sum in x/z).
  const shoelace = outline.reduce((s, p, i) => {
    const q = outline[(i + 1) % outline.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0);
  if (shoelace > 0) outline = outline.reverse();
  const n = outline.length;
  const cx = outline.reduce((s, p) => s + p[0], 0) / n;
  const cz = outline.reduce((s, p) => s + p[1], 0) / n;
  const inset = Math.min(0.012, w * 0.08, len * 0.08);
  const thick = (z: number) => (kind === 'shingle' ? th * (0.5 + 0.5 * clamp(z / len, 0, 1)) : th);

  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    const l = Math.hypot(nx, ny, nz) || 1;
    pos.push(x, y, z);
    nor.push(nx / l, ny / l, nz / l);
    return pos.length / 3 - 1;
  };

  // Outward (x, z) normal at each outline vertex: average of its two edges.
  const outward = outline.map((p, i) => {
    const a = outline[(i + n - 1) % n];
    const c = outline[(i + 1) % n];
    const e1 = [p[0] - a[0], p[1] - a[1]];
    const e2 = [c[0] - p[0], c[1] - p[1]];
    const l1 = Math.hypot(e1[0], e1[1]) || 1;
    const l2 = Math.hypot(e2[0], e2[1]) || 1;
    const ox = -e1[1] / l1 - e2[1] / l2;
    const oz = e1[0] / l1 + e2[0] / l2;
    const l = Math.hypot(ox, oz) || 1;
    return [ox / l, oz / l];
  });

  const bottomC = vert(cx, 0, cz, 0, -1, 0);
  const bottom = outline.map((p, i) => vert(p[0], 0, p[1], outward[i][0], -0.35, outward[i][1]));
  const top = outline.map((p, i) => {
    const dx = cx - p[0];
    const dz = cz - p[1];
    const l = Math.hypot(dx, dz) || 1;
    return vert(p[0] + (dx / l) * inset, thick(p[1]), p[1] + (dz / l) * inset, outward[i][0] * 0.55, 1, outward[i][1] * 0.55);
  });
  const topC = vert(cx, thick(cz) * 1.04, cz, 0, 1, 0);

  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    idx.push(topC, top[i], top[i2]);
    idx.push(bottomC, bottom[i2], bottom[i]);
    idx.push(bottom[i], bottom[i2], top[i2]);
    idx.push(bottom[i], top[i2], top[i]);
  }
  return { pos, nor, idx };
}

// ---------------------------------------------------------------------------
// Ridge
// ---------------------------------------------------------------------------

/** A point of a swept cross-section; smooth points get averaged normals. */
interface ProfilePoint {
  p: [number, number];
  smooth: boolean;
}

/** World y of the ridge cap's outer apex (without sag). */
function ridgeCapTopY(d: RoofDims): number {
  return d.ridgeY + (d.capH - RIDGE_RADIUS) / d.cos + RIDGE_RADIUS;
}

/**
 * Cross-section (world z, y) of a ridge tile: legs lying on both slopes,
 * rounded over the apex, solid down to the deck so nothing shows beneath.
 * Each point carries whether its normal should be smoothed.
 */
function ridgeProfile(d: RoofDims): ProfilePoint[] {
  const R = RIDGE_RADIUS;
  const pitch = Math.atan(d.tan);
  const yc = d.ridgeY + (d.capH - R) / d.cos;
  const legTop = toWorld(d, d.capZ, d.capH);
  const legBottom = toWorld(d, d.capZ, d.deck);
  const out: ProfilePoint[] = [];
  out.push({ p: [-legBottom[0], legBottom[1]], smooth: false });
  out.push({ p: [-legTop[0], legTop[1]], smooth: false });
  const steps = 8;
  for (let k = 0; k <= steps; k++) {
    const phi = -pitch + (2 * pitch * k) / steps;
    out.push({ p: [R * Math.sin(phi), yc + R * Math.cos(phi)], smooth: true });
  }
  out.push({ p: legTop, smooth: false });
  out.push({ p: legBottom, smooth: false });
  out.push({ p: [0, d.ridgeY + d.deck / d.cos], smooth: false });
  return out;
}

function buildRidge(d: RoofDims, colors: RoofColors, rng: Rng): PartBuilder {
  const b = new PartBuilder('roof:ridge');
  const profile = ridgeProfile(d);
  const pivot: [number, number] = [0, d.ridgeY + d.deck / d.cos];
  const xHi = d.xEnd + BARGE_T - 0.004;

  // Runs of ridge tiles, interrupted by a chimney sitting on the ridge.
  const runs: [number, number][] = [[-xHi, xHi]];
  const c = d.layout.chimney;
  const capHalf = toWorld(d, d.capZ, d.capH)[0];
  if (c && c.z - c.sz / 2 < capHalf && c.z + c.sz / 2 > -capHalf) {
    const a = c.x - d.cx - c.sx / 2 - CHIMNEY_MARGIN;
    const e = c.x - d.cx + c.sx / 2 + CHIMNEY_MARGIN;
    runs.splice(0, 1, [-xHi, a], [e, xHi]);
  }

  const pieceLen = 0.4;
  const overlap = 0.07;
  const taper = 0.06;
  const canon = sideFrame(d, 1);
  const pieces: RidgePiece[] = [];
  for (const [lo, hi] of runs) {
    const runLen = hi - lo;
    if (runLen < 0.12) continue;
    // Lay from +x to -x; each piece's wide end covers the previous piece's narrow end.
    const n = Math.max(1, Math.ceil((runLen - overlap) / (pieceLen - overlap)));
    const len = n === 1 ? runLen : pieceLen;
    const step = n === 1 ? 0 : (runLen - len) / (n - 1);
    for (let i = 0; i < n; i++) {
      const xStart = hi - i * step;
      const lift = sagAt(d, xStart - len / 2) + rng.jitter(0.003);
      const geo = sweepX(profile, len, taper, pivot);
      const m = mul(canon, mat4(xStart, lift, 0));
      b.add(geo, 'roof', vary(colors.ridge, rng, 0.018, 0.02, 0.004), m);
      pieces.push({ x0: xStart - len, x1: xStart, lift });
    }
  }

  // Mortar bedding peeking out under the ridge tiles of clay roofs.
  if (d.tile.kind === 'beaver' || d.tile.kind === 'fish') addRidgeMortar(b, d, pieces, colors, rng);
  const finials = rng.fork('finials');
  if (finials.chance(0.45)) addFinials(b, d, colors, finials);
  return b;
}

interface RidgePiece {
  /** Extent along x (relative to the roof centre) and vertical lift (sag). */
  x0: number;
  x1: number;
  lift: number;
}

/**
 * Mortar bedding under both edges of each ridge tile: a hand-trowelled
 * fillet that peeks out a little, slightly different under every tile.
 */
function addRidgeMortar(b: PartBuilder, d: RoofDims, pieces: RidgePiece[], colors: RoofColors, rng: Rng) {
  const h = 0.06;
  const wz = 0.05;
  for (const side of [1, -1]) {
    const frame = slopeFrame(d, side);
    for (const p of pieces) {
      const lo = Math.max(side > 0 ? p.x0 : -p.x1, -d.xEnd);
      const hi = Math.min(side > 0 ? p.x1 : -p.x0, d.xEnd);
      if (hi - lo < 0.05) continue;
      const y = d.tileTop - 0.012 - h / 2 + p.lift * d.cos + rng.jitter(0.005);
      const z = d.capZ - wz / 2 + 0.012 + rng.jitter(0.006);
      const m = mul(frame, mat4((lo + hi) / 2, y, z, 0, rng.jitter(0.02), 0));
      b.box('mortar', vary(colors.mortar, rng, 0.03, 0.02, 0.005), hi - lo, h, wz, m);
    }
  }
}

/** Turned finials where the barge boards meet at each gable apex. */
function addFinials(b: PartBuilder, d: RoofDims, colors: RoofColors, rng: Rng) {
  const yBottom = d.ridgeY - d.drop / d.cos - 0.18;
  const yTop = ridgeCapTopY(d) + d.sagMax + rng.range(0.3, 0.42);
  const postTop = yTop - 0.3;
  const r = 0.045;
  const h = yTop - yBottom;
  // Lathe profile (radius, height above the bottom).
  const pts: [number, number][] = [
    [0, 0],
    [0.022, 0.015],
    [0.04, 0.06],
    [0.03, 0.11],
    [r, 0.15],
    [r, postTop - yBottom],
    [0.058, postTop - yBottom + 0.04],
    [0.062, postTop - yBottom + 0.08],
    [0.05, postTop - yBottom + 0.12],
    [0.02, postTop - yBottom + 0.15],
    [0.012, h - 0.05],
    [0, h],
  ];
  const lathe = new THREE.LatheGeometry(
    pts.map(([x, y]) => new THREE.Vector2(x, y)),
    10,
  );
  const canon = sideFrame(d, 1);
  for (const sign of [1, -1]) {
    const m = mul(canon, mat4(sign * (d.xEnd + BARGE_T / 2), yBottom, 0));
    b.add(lathe, 'wood', colors.trim, m);
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Prism from a (z, y) profile, extruded along world x from x0 to x1, with
 * optionally bevelled (rounded) edges that stay inside the profile.
 */
function prismX(profile: [number, number][], x0: number, x1: number, bevel = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  const len = x1 - x0;
  const r = Math.min(bevel, len / 2 - 1e-3);
  const g =
    r > 0.002
      ? new THREE.ExtrudeGeometry(shape, {
          depth: len - 2 * r,
          bevelEnabled: true,
          bevelThickness: r,
          bevelSize: r,
          bevelOffset: -r,
          bevelSegments: 2,
          curveSegments: 4,
        })
      : new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  if (r > 0.002) g.translate(0, 0, r);
  // shape x → world z, shape y → world y, extrusion → world -x (a proper rotation).
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0));
  m.setPosition(x1, 0, 0);
  return g.applyMatrix4(m);
}

/**
 * Sweep a (z, y) profile along -x for `len` (starting at x = 0), shrinking it
 * towards `pivot` by `taper` at the far end. Smooth profile points get
 * averaged normals (round surfaces); the others stay crisp.
 */
function sweepX(profile: ProfilePoint[], len: number, taper: number, pivot: [number, number]): THREE.BufferGeometry {
  let pts = profile;
  const area = pts.reduce((s, a, i) => {
    const c = pts[(i + 1) % pts.length];
    return s + a.p[0] * c.p[1] - c.p[0] * a.p[1];
  }, 0);
  if (area < 0) pts = [...pts].reverse(); // counter-clockwise in (z, y)
  const n = pts.length;
  const scaled = (p: [number, number], s: number): [number, number] => [pivot[0] + (p[0] - pivot[0]) * s, pivot[1] + (p[1] - pivot[1]) * s];
  const s1 = 1 - taper;

  // Edge normals (outward for a counter-clockwise profile).
  const edgeN = pts.map((a, i) => {
    const c = pts[(i + 1) % n];
    const dz = c.p[0] - a.p[0];
    const dy = c.p[1] - a.p[1];
    const l = Math.hypot(dz, dy) || 1;
    return [dy / l, -dz / l];
  });

  const pos: number[] = [];
  const nor: number[] = [];
  // Profile coords (z, y) at sweep distance s → world (x = -s, y, z).
  const push = (p: [number, number], s: number, nz: number, ny: number, nx: number) => {
    pos.push(-s, p[1], p[0]);
    nor.push(nx, ny, nz);
  };
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    const normalAt = (k: number, edge: number) => {
      if (!pts[k].smooth) return edgeN[edge];
      const prev = edgeN[(k + n - 1) % n];
      const next = edgeN[k];
      const l = Math.hypot(prev[0] + next[0], prev[1] + next[1]) || 1;
      return [(prev[0] + next[0]) / l, (prev[1] + next[1]) / l];
    };
    const na = normalAt(i, i);
    const nb = normalAt(i2, i);
    const a0 = pts[i].p;
    const b0 = pts[i2].p;
    const a1 = scaled(a0, s1);
    const b1 = scaled(b0, s1);
    // Two triangles (a0, b0, b1), (a0, b1, a1); outward for a CCW profile swept along -x.
    push(a0, 0, na[0], na[1], 0);
    push(b0, 0, nb[0], nb[1], 0);
    push(b1, len, nb[0], nb[1], 0);
    push(a0, 0, na[0], na[1], 0);
    push(b1, len, nb[0], nb[1], 0);
    push(a1, len, na[0], na[1], 0);
  }

  // End caps.
  const contour = pts.map((q) => new THREE.Vector2(q.p[0], q.p[1]));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const [s, sc, facing] of [
    [0, 1, 1],
    [len, s1, -1],
  ] as const) {
    for (const tri of tris) {
      let [i0, i1, i2] = tri;
      const p0 = pts[i0].p;
      const p1 = pts[i1].p;
      const p2 = pts[i2].p;
      const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      // In world, profile (z, y) seen from +x is mirrored: a CCW (z, y) triangle faces -x.
      if ((cross > 0 ? -1 : 1) !== facing) [i1, i2] = [i2, i1];
      for (const k of [i0, i1, i2]) push(scaled(pts[k].p, sc), s, 0, 0, facing);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** Indexed triangles with per-vertex normals, in local coordinates. */
interface RawMesh {
  pos: number[];
  nor: number[];
  idx: number[];
}

/**
 * Collects thousands of small pieces (tiles) into one geometry per colour
 * bucket: much faster than a `builder.add` per piece.
 */
class PieceBatch {
  private readonly pos: Float32Array[] = [];
  private readonly nor: Float32Array[] = [];
  private readonly used: number[] = [];
  private readonly nm = new THREE.Matrix3();

  constructor(buckets: number) {
    for (let i = 0; i < buckets; i++) {
      this.pos.push(new Float32Array(3 * 1024));
      this.nor.push(new Float32Array(3 * 1024));
      this.used.push(0);
    }
  }

  add(mesh: RawMesh, m: THREE.Matrix4, bucket: number) {
    const need = this.used[bucket] + mesh.idx.length * 3;
    if (need > this.pos[bucket].length) {
      const size = Math.max(need, this.pos[bucket].length * 2);
      this.pos[bucket] = grow(this.pos[bucket], size);
      this.nor[bucket] = grow(this.nor[bucket], size);
    }
    const P = this.pos[bucket];
    const N = this.nor[bucket];
    let o = this.used[bucket];
    const e = m.elements;
    const n = this.nm.getNormalMatrix(m).elements;
    for (const i of mesh.idx) {
      const x = mesh.pos[i * 3];
      const y = mesh.pos[i * 3 + 1];
      const z = mesh.pos[i * 3 + 2];
      P[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      const nx = mesh.nor[i * 3];
      const ny = mesh.nor[i * 3 + 1];
      const nz = mesh.nor[i * 3 + 2];
      const tx = n[0] * nx + n[3] * ny + n[6] * nz;
      const ty = n[1] * nx + n[4] * ny + n[7] * nz;
      const tz = n[2] * nx + n[5] * ny + n[8] * nz;
      const l = Math.hypot(tx, ty, tz) || 1;
      N[o] = tx / l;
      N[o + 1] = ty / l;
      N[o + 2] = tz / l;
      o += 3;
    }
    this.used[bucket] = o;
  }

  /** Hand each non-empty bucket to the builder as one uniformly coloured geometry. */
  flush(b: PartBuilder, mat: MatKey, colors: THREE.Color[]) {
    this.used.forEach((count, i) => {
      if (!count) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this.pos[i].slice(0, count), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(this.nor[i].slice(0, count), 3));
      b.add(g, mat, colors[i]);
    });
  }
}

function grow(a: Float32Array, size: number): Float32Array {
  const out = new Float32Array(size);
  out.set(a);
  return out;
}

/** Clip a convex polygon to y ≤ yMax. */
function clipBelow(poly: [number, number][], yMax: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    const aIn = a[1] <= yMax;
    const cIn = c[1] <= yMax;
    if (aIn) out.push(a);
    if (aIn !== cIn) {
      const t = (yMax - a[1]) / (c[1] - a[1]);
      out.push([a[0] + (c[0] - a[0]) * t, yMax]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function topWall(layout: HouseLayout, side: Side): WallSpec {
  const top = layout.storeys[layout.storeys.length - 1];
  return top.walls.find((w) => w.side === side)!;
}

/**
 * Would a roof timber over u ∈ [u0, u1] clash with an opening's lintel, its
 * shutters or a door canopy? `yLow(w)` is the timber's lowest point at
 * distance w in front of the wall face.
 */
function blockedByOpening(wall: WallSpec, u0: number, u1: number, yLow: (w: number) => number): boolean {
  const overlaps = (a: number, b: number) => u0 < b && u1 > a;
  return wall.openings.some((o: Opening) => {
    const s = o.surround;
    // Lintel / frame head, up to w ≈ 0.08.
    if (overlaps(s.u0 - 0.04, s.u1 + 0.04) && yLow(0.08) < s.y1 + 0.03) return true;
    // Open shutters beside the window, up to w ≈ 0.16, as tall as the opening.
    const half = (o.u1 - o.u0) / 2;
    if (o.shutters && overlaps(o.u0 - half - 0.08, o.u1 + half + 0.08) && yLow(0.16) < o.y1 + 0.03) return true;
    // A door may get a canopy above it.
    if (o.kind === 'door' && overlaps(s.u0 - 0.45, s.u1 + 0.45) && yLow(0.6) < s.y1 + 0.5) return true;
    return false;
  });
}

/** A colour with its HSL lightness shifted by dl. */
function shade(color: THREE.ColorRepresentation, dl: number): THREE.Color {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return c.setHSL(hsl.h, hsl.s, clamp(hsl.l + dl, 0.04, 0.92));
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
