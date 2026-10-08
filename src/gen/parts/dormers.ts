import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PartBuilder, extrudeLocal, lumpify, mix, mul, vary, type ColorLike, type MatKey } from '../builder';
import { roofLift } from '../explode';
import type { PartDef } from '../house';
import { roofSurfaceY, type DormerSpec, type HouseLayout, type RoofCovering, type RoofSpec } from '../layout';
import type { Palette } from '../params';
import type { Rng } from '../rng';

/**
 * Dormers: every dormer in `layout.roof.dormers` — the face wall with its
 * window, the two cheeks, the dormer's own little roof (gabled or shed),
 * and the lead work where it all meets the main roof (apron, side flashing,
 * open valleys, a saddle at the ridge end).
 *
 * The main roof leaves its covering open over each dormer's plan rectangle
 * (`roof.holes`); a dormer covers all of it: the cheeks and face stand on
 * the hole's edges, the dormer roof covers the middle, and the corners
 * behind a gabled dormer's cheeks (outside its valleys) get main-roof tiles
 * laid in the main roof's plane and courses.
 *
 * Everything is built in "canonical" coordinates — as if the dormer were on
 * the front slope (+Z), with |z| from the spec — and turned 180° about the
 * vertical axis for the back slope, like the roof part does.
 */
export const part: PartDef = {
  name: 'dormers',
  label: 'Dormers',
  explode: [0, 0, 0],
  build: ({ layout, rng }) => {
    const dormers = layout.roof.dormers;
    if (!dormers.length) return [];
    const look = chooseLook(layout, rng.fork('look'));
    return dormers.map((d) => buildDormer(layout, d, look, rng.fork(d.id)));
  },
};

// ---------------------------------------------------------------------------
// Dimensions (metres) and fixed colours
// ---------------------------------------------------------------------------

/** Face wall thickness (behind its outer face at |z| = faceZ). */
const FACE_T = 0.14;
const CHEEK_T = 0.11;
/** Walls reach this far (vertically) below the main roof surface, into the roof. */
const SINK = 0.12;
/** Dormer roof boarding, perpendicular to its slope. */
const DECK = 0.06;
/** Barge boards / fascia: thickness, and how far they hang below the dormer roof underside. */
const BOARD_T = 0.04;
const BOARD_DROP = 0.09;
/** Tiles stop this far short of a valley line on both sides (an open lead valley). */
const VALLEY_GAP = 0.055;
/** Main-roof patch tiles reach this far past the hole's edges (under the neighbours' edges). */
const PATCH_EXT = 0.015;
/** Lead flashing: width over the tiles beside the cheeks / in front of the face. */
const FLASH_SIDE = 0.12;
const FLASH_APRON = 0.2;
const WINDOW_FRAME = 0.06;
const GLAZING_BAR = 0.03;
/** Window frame plane (w, set back into the face wall). */
const RECESS = -0.055;

const LEAD = '#737c85';
const GLASS = '#3a5566';
const GLASS_SKY = '#8eaab8';
const IRON = '#3a3430';
const SOIL = '#4b3727';
const MOSS = '#5f6f45';
const LEAF_GREENS = ['#5d8c3a', '#4f7d35', '#6d9a45', '#557f3c'];

// ---------------------------------------------------------------------------
// Tile styles (sizes match the main roof's, see roof.ts)
// ---------------------------------------------------------------------------

interface TileSpec {
  kind: RoofCovering;
  width: number;
  length: number;
  gauge: number;
  thickness: number;
  gap: number;
  /** Random widths (slate, shingle) instead of a regular staggered grid. */
  irregular: boolean;
  /** Per-tile colour jitter: lightness, saturation, hue. */
  jitter: [number, number, number];
}

const TILE_STYLES: Record<RoofCovering, TileSpec> = {
  beaver: { kind: 'beaver', width: 0.25, length: 0.42, gauge: 0.18, thickness: 0.026, gap: 0.008, irregular: false, jitter: [0.03, 0.03, 0.006] },
  fish: { kind: 'fish', width: 0.26, length: 0.4, gauge: 0.17, thickness: 0.024, gap: 0.006, irregular: false, jitter: [0.03, 0.03, 0.006] },
  slate: { kind: 'slate', width: 0.3, length: 0.44, gauge: 0.19, thickness: 0.02, gap: 0.006, irregular: true, jitter: [0.045, 0.03, 0.012] },
  shingle: { kind: 'shingle', width: 0.2, length: 0.42, gauge: 0.17, thickness: 0.028, gap: 0.008, irregular: true, jitter: [0.05, 0.04, 0.01] },
};

/** A tile style scaled (sizes and thickness) by `k`. */
function scaledTiles(t: TileSpec, k: number, kThick = k): TileSpec {
  return { ...t, width: t.width * k, length: t.length * k, gauge: t.gauge * k, thickness: t.thickness * kThick };
}

/** How far a tile's tail is lifted above its head when it rests on the course below. */
function tileRise(t: TileSpec): number {
  return (t.thickness * t.length) / t.gauge;
}

/**
 * The main roof's tile courses (as the roof part lays them): tile size, and
 * the slope-local Z (down the slope from the ridge, along the underside) of
 * the eave course's tail and the course gauge. Used to lay the patches behind
 * gabled dormers in step with the surrounding courses.
 */
interface MainCourses {
  tile: TileSpec;
  eaveTail: number;
  gauge: number;
  yHead: number;
  tilt: number;
}

function mainCourses(layout: HouseLayout): MainCourses {
  const r = layout.roof;
  const style = TILE_STYLES[r.covering];
  const cos = Math.cos(r.pitch);
  const tan = Math.tan(r.pitch);
  const xEnd = (r.maxX - r.minX) / 2 + r.overhangGable;
  const zMax = (r.halfDepth + r.overhangEave) / cos;
  const scale = clamp(Math.sqrt((2 * xEnd * zMax) / (style.width * style.gauge) / 1500), 1, 1.75);
  const tile: TileSpec = { ...style, width: style.width * scale, length: style.length * scale, gauge: style.gauge * scale };
  const rise = tileRise(tile);
  const yHead = r.deckThickness + 0.004;
  const tileTop = yHead + rise + tile.thickness + 0.011 + 0.004;
  const capT = Math.max(0.035, 0.07 * (1 - cos) + 0.015);
  const capZ = Math.max(-(tileTop + capT - 0.07) * tan + 0.1, -r.deckThickness * tan + 0.06);
  const eaveTail = zMax + r.fasciaThickness + 0.04;
  const lastTail = capZ - 0.03;
  const courses = Math.max(2, Math.round((eaveTail - lastTail) / tile.gauge) + 1);
  return { tile, eaveTail, gauge: (eaveTail - lastTail) / (courses - 1), yHead, tilt: Math.atan2(rise, tile.length) };
}

// ---------------------------------------------------------------------------
// House-wide look
// ---------------------------------------------------------------------------

type CheekFinish = 'timber' | 'plaster' | 'boards' | 'tiles';

interface Look {
  pal: Palette;
  cheek: CheekFinish;
  glazing: 'cross' | 'six';
  /** Barge boards, fascias, corner boards, weatherboards. */
  trim: THREE.Color;
  plaster: THREE.Color;
  mortar: THREE.Color;
  dressedStone: THREE.Color;
  flowerBox: boolean;
  finial: boolean;
  /** Tiles of the dormer roofs and tile-hung cheeks. */
  tile: TileSpec;
  hung: TileSpec;
  main: MainCourses;
  tiles: TilePalette;
}

function chooseLook(layout: HouseLayout, rng: Rng): Look {
  const pal = layout.params.palette;
  const style = layout.roof.dormers[0].style;
  const cheek: CheekFinish =
    style === 'timber'
      ? 'timber'
      : style === 'stone'
        ? rng.weighted([['tiles', 3], ['plaster', 2], ['boards', 1]] as const)
        : rng.weighted([['plaster', 3], ['boards', 2], ['tiles', 1]] as const);
  const base = TILE_STYLES[layout.roof.covering];
  // Smaller tiles than the main roof's (a small roof), a little larger on big houses.
  const k = 0.82 / Math.sqrt(clamp(layout.detail, 0.45, 1));
  const tile = scaledTiles(base, k, 0.85);
  // Hung tiles on the cheeks: small plain tiles (round-ended under clay roofs).
  const hungKind: RoofCovering = base.kind === 'beaver' || base.kind === 'fish' ? base.kind : 'slate';
  const hung = { ...scaledTiles(TILE_STYLES[hungKind], 0.72 / Math.sqrt(clamp(layout.detail, 0.45, 1)), 0.75), irregular: false };
  return {
    pal,
    cheek,
    glazing: rng.chance(0.55) ? 'cross' : 'six',
    trim: new THREE.Color(rng.chance(0.65) ? pal.timber : pal.wood),
    plaster: vary(pal.plaster, rng, 0.01, 0.015, 0.003),
    mortar: vary(pal.mortar, rng, 0.02, 0.02, 0),
    dressedStone: mix(pal.stone, '#efe8dc', 0.3),
    flowerBox: layout.params.flowerBoxes && rng.chance(0.6),
    finial: rng.chance(0.4),
    tile,
    hung,
    main: mainCourses(layout),
    tiles: new TilePalette(base, pal.roof, rng.fork('palette')),
  };
}

/** A few dozen tile colours around the roof colour; tiles pick from it (one batch per colour). */
class TilePalette {
  readonly colors: THREE.Color[] = [];
  private readonly normal: number[] = [];
  private readonly dark: number[] = [];
  private readonly mossy: number[] = [];

  constructor(t: TileSpec, roof: string, rng: Rng) {
    const [l, s, h] = t.jitter;
    const put = (list: number[], c: THREE.Color) => {
      list.push(this.colors.length);
      this.colors.push(c);
    };
    for (let i = 0; i < 14; i++) put(this.normal, vary(roof, rng, l * 1.4, s, h));
    for (let i = 0; i < 3; i++) put(this.dark, vary(roof, rng, l, s, h).multiplyScalar(rng.range(0.76, 0.88)));
    for (let i = 0; i < 3; i++) put(this.mossy, mix(vary(roof, rng, l, s, h), MOSS, rng.range(0.2, 0.4)));
  }

  pick(rng: Rng, moss = 0.03): number {
    if (rng.chance(0.04)) return this.dark[rng.int(0, this.dark.length - 1)];
    if (rng.chance(moss)) return this.mossy[rng.int(0, this.mossy.length - 1)];
    return this.normal[rng.int(0, this.normal.length - 1)];
  }
}

// ---------------------------------------------------------------------------
// One dormer: its numbers
// ---------------------------------------------------------------------------

/** Everything about one dormer, in canonical (front-slope) coordinates. */
interface Geo {
  d: DormerSpec;
  roof: RoofSpec;
  gable: boolean;
  xc: number;
  hw: number;
  zf: number;
  baseY: number;
  eaveY: number;
  ridgeY: number;
  backZ: number;
  faceH: number;
  tanP: number;
  cosP: number;
  sinP: number;
  tD: number;
  cD: number;
  sD: number;
  /** Front overhang of the dormer roof, and (horizontal) side overhang past the cheeks. */
  fo: number;
  so: number;
  zFront: number;
  /** Average top of the dormer's tiles above its roof underside (perpendicular). */
  cover: number;
  /** Window in face-local (u, y). */
  win: { u0: number; u1: number; y0: number; y1: number; arched: boolean };
  /** How far the face / cheek finishes stand proud of the wall (flashing upstands go in front). */
  faceProud: number;
  cheekProud: number;
  /** Canonical z where each cheek's foot ends (the cheek dies into the roof there). */
  cheekEnd: number;
}

/** Main roof tile surface at canonical z. */
function surf(g: Geo, z: number): number {
  return roofSurfaceY(g.roof, z);
}

/** Canonical z where the main roof surface reaches height y. */
function zOnSurface(g: Geo, y: number): number {
  return g.zf - (y - g.baseY) / g.tanP;
}

/** Gabled dormer roof underside at distance a from the dormer's centre line. */
function gableUnder(g: Geo, a: number): number {
  return g.ridgeY - a * g.tD;
}

/** Shed roof underside at canonical z. */
function shedUnder(g: Geo, z: number): number {
  return g.ridgeY - (z - g.backZ) * g.tD;
}

function geoOf(layout: HouseLayout, d: DormerSpec, look: Look, rng: Rng): Geo {
  const roof = layout.roof;
  const xc = d.sign * d.x;
  const hw = d.width / 2;
  const [wx0, wx1] = d.sign > 0 ? [d.window.x0, d.window.x1] : [-d.window.x1, -d.window.x0];
  const t = look.tile;
  const cover = DECK + 0.003 + t.thickness + 0.6 * tileRise(t);
  const style = d.style;
  const timber = style === 'timber';
  return {
    d,
    roof,
    gable: d.roof === 'gable',
    xc,
    hw,
    zf: d.faceZ,
    baseY: d.baseY,
    eaveY: d.eaveY,
    ridgeY: d.ridgeY,
    backZ: d.backZ,
    faceH: d.eaveY - d.baseY,
    tanP: Math.tan(roof.pitch),
    cosP: Math.cos(roof.pitch),
    sinP: Math.sin(roof.pitch),
    tD: Math.tan(d.pitch),
    cD: Math.cos(d.pitch),
    sD: Math.sin(d.pitch),
    fo: rng.range(0.16, 0.24),
    so: rng.range(0.12, 0.17),
    zFront: 0,
    cover,
    win: { u0: wx0 - (xc - hw), u1: wx1 - (xc - hw), y0: d.window.y0, y1: d.window.y1, arched: d.window.arched },
    faceProud: timber || style === 'stone' ? 0.05 : look.cheek === 'boards' ? 0.03 : 0.028,
    cheekProud: look.cheek === 'timber' ? 0.05 : look.cheek === 'tiles' ? 0.06 : look.cheek === 'boards' ? 0.035 : 0.004,
    cheekEnd: 0,
  };
}

// ---------------------------------------------------------------------------
// Building one dormer
// ---------------------------------------------------------------------------

interface Kit {
  b: PartBuilder;
  g: Geo;
  look: Look;
  rng: Rng;
  /** Canonical → world. */
  C: THREE.Matrix4;
  /** Tiles batched by colour, flushed at the end. */
  tiles: PieceBatch;
  /** This dormer's lead (one colour, so overlapping sheets never flicker). */
  lead: THREE.Color;
}

function buildDormer(layout: HouseLayout, d: DormerSpec, look: Look, rng: Rng): PartBuilder {
  const b = new PartBuilder(`dormers:${d.id}`);
  b.explode = [0, roofLift(layout) + 0.6, 0.6 * d.sign];
  const g = geoOf(layout, d, look, rng.fork('geo'));
  g.zFront = g.zf + g.fo;
  g.cheekEnd = g.gable ? zOnSurface(g, g.eaveY) : g.backZ;
  const C = new THREE.Matrix4().makeRotationY(d.sign > 0 ? 0 : Math.PI);
  const k: Kit = { b, g, look, rng, C, tiles: new PieceBatch(look.tiles.colors.length), lead: vary(LEAD, rng.fork('lead'), 0.02, 0.02, 0.004) };

  buildFace(k, rng.fork('face'));
  buildCheeks(k, rng.fork('cheeks'));
  buildWindow(k, rng.fork('window'));
  if (g.gable) buildGableRoof(k, rng.fork('roof'));
  else buildShedRoof(k, rng.fork('roof'));
  buildFlashing(k);
  k.tiles.flush(b, 'roof', look.tiles.colors, C);
  return b;
}

/** Add canonical geometry (placed by `m`, canonical) to the dormer's builder. */
function put(k: Kit, geom: THREE.BufferGeometry | null, mat: MatKey, color: ColorLike, m?: THREE.Matrix4, paint?: (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void): void {
  if (!geom) return;
  k.b.add(geom, mat, color, m ? mul(k.C, m) : k.C, paint);
}

/** Face-local (u, y, w) → canonical: u along +x from the face's left edge, w out of the face. */
function faceFrame(g: Geo): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(g.xc - g.hw, 0, g.zf);
}

/**
 * Cheek-local (u, y, w) → canonical for the cheek on side s (±1 in x):
 * u = s·(faceZ - z), w outward from the cheek's outer face.
 */
function cheekFrame(g: Geo, s: number): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeBasis(new THREE.Vector3(0, 0, -s), new THREE.Vector3(0, 1, 0), new THREE.Vector3(s, 0, 0))
    .setPosition(g.xc + s * g.hw, 0, g.zf);
}

/** Cheek-local u of canonical z. */
function cheekU(g: Geo, s: number, z: number): number {
  return s * (g.zf - z);
}

/** Cheek-local u-range of the strip from depth d0 to d1 behind the face plane. */
function behind(s: number, d0: number, d1: number): [number, number] {
  return s > 0 ? [d0, d1] : [-d1, -d0];
}

// ---------------------------------------------------------------------------
// Face wall
// ---------------------------------------------------------------------------

function faceOutline(g: Geo): V2[] {
  const W = 2 * g.hw;
  const yb = g.baseY - SINK;
  return g.gable
    ? [[0, yb], [W, yb], [W, g.eaveY], [g.hw, g.ridgeY], [0, g.eaveY]]
    : [[0, yb], [W, yb], [W, g.eaveY], [0, g.eaveY]];
}

function buildFace(k: Kit, rng: Rng): void {
  const { g, look } = k;
  const F = faceFrame(g);
  const shape = new THREE.Shape(faceOutline(g).map(([u, y]) => new THREE.Vector2(u, y)));
  shape.holes.push(new THREE.Path(windowOutline(g, 0, g.win.y0, 12)));
  const stone = g.d.style === 'stone';
  put(k, extrudeLocal(shape, FACE_T, 0, 12), stone ? 'mortar' : 'plaster', stone ? look.mortar : look.plaster, F);

  if (g.d.style === 'timber') faceTimber(k, rng);
  else if (stone) faceStones(k, rng);
  else facePlaster(k, rng);
}

/** Half-timber frame on the face: sill beam, corner posts, top plate, gable rafters and king post. */
function faceTimber(k: Kit, rng: Rng): void {
  const { g, look } = k;
  const F = faceFrame(g);
  const W = 2 * g.hw;
  const col = () => vary(look.pal.timber, rng, 0.04, 0.03, 0.006);
  const beam = (poly: V2[], front = 0.04) => put(k, prism(poly, -0.02, front - rng.range(0, 0.003), 0.018), 'timber', col(), F);
  const sillTop = g.baseY + 0.11;
  const plate = g.eaveY - 0.13;
  const post = 0.13;
  beam(rect(0, W, g.baseY - 0.04, sillTop), 0.045);
  beam(rect(0, W, plate, g.eaveY), 0.045);
  beam(rect(0, post, sillTop, plate));
  beam(rect(W - post, W, sillTop, plate));
  if (g.gable) {
    // Rafters under both gable edges, a king post between them.
    const rw = 0.13 / g.cD;
    for (const s of [-1, 1]) {
      const edge = (a: number) => g.ridgeY - a * g.tD;
      const u0 = s < 0 ? 0 : g.hw;
      const u1 = s < 0 ? g.hw : W;
      const ua = (u: number) => Math.abs(u - g.hw);
      const poly: V2[] = [
        [u0, edge(ua(u0))],
        [u1, edge(ua(u1))],
        [u1, edge(ua(u1)) - rw],
        [u0, edge(ua(u0)) - rw],
      ];
      beam(clipHalf(poly, 0, -1, -g.eaveY));
    }
    const kp = 0.06;
    beam(rect(g.hw - kp, g.hw + kp, g.eaveY, g.ridgeY - rw - kp * g.tD + 0.005), 0.037);
  }
}

/** Plaster face: corner boards and a timber lintel over the window. */
function facePlaster(k: Kit, rng: Rng): void {
  const { g, look } = k;
  const F = faceFrame(g);
  const W = 2 * g.hw;
  const bw = 0.1;
  const top = (u: number) => (g.gable ? Math.min(g.eaveY + 0.0, g.ridgeY - Math.abs(u - g.hw) * g.tD) : g.eaveY);
  for (const [u0, u1] of [[0, bw], [W - bw, W]] as const) {
    const poly: V2[] = [[u0, g.baseY - 0.04], [u1, g.baseY - 0.04], [u1, top(u1)], [u0, top(u0)]];
    put(k, prism(poly, -0.01, 0.026, 0.008), 'wood', vary(look.trim, rng, 0.03, 0.02, 0.004), F);
  }
  const w = g.win;
  put(k, prism(rect(w.u0 - 0.1, w.u1 + 0.1, w.y1 - 0.012, w.y1 + 0.13), -0.02, 0.045, 0.016), 'timber', vary(look.pal.timber, rng, 0.04, 0.03, 0.005), F);
}

/**
 * Stone face: field stones in courses over a mortar body, dressed quoins at
 * both corners (wrapping onto the cheeks), a stone lintel or arch over the
 * window. In a gable the stones are squeezed under the gable edge.
 */
function faceStones(k: Kit, rng: Rng): void {
  const { g, look } = k;
  const F = faceFrame(g);
  const W = 2 * g.hw;
  const w = g.win;
  const top = (u: number) => (g.gable ? g.ridgeY - Math.abs(u - g.hw) * g.tD : g.eaveY) - 0.03;
  // The apron's upstand covers the foot of the face; the stones start above it.
  const yBottom = g.baseY + 0.1;

  // Quoins: alternating long / short, on the face and wrapping round onto the
  // cheek (just over the face wall's edge when the cheek has its own cladding).
  const quoinTop = g.eaveY - 0.02;
  const nQ = Math.max(3, Math.round((quoinTop - yBottom) / 0.26));
  const qh = (quoinTop - yBottom) / nQ;
  const quoinAlong: number[] = [];
  // Long quoins reach the window jamb when the pier is narrow (no slivers of mortar).
  const pier = Math.min(w.u0, W - w.u1);
  const longQ = pier < 0.36 ? pier - 0.03 : 0.24;
  const shortQ = Math.min(0.15, longQ * 0.62);
  for (let i = 0; i < nQ; i++) {
    const y0 = yBottom + i * qh + 0.006;
    const y1 = yBottom + (i + 1) * qh - 0.006;
    const long = i % 2 === 0;
    const along = long ? longQ : shortQ;
    quoinAlong.push(along);
    for (const s of [-1, 1] as const) {
      const side = look.cheek === 'plaster' ? (long ? 0.1 : 0.2) : 0.012;
      const c = vary(look.dressedStone, rng, 0.05, 0.03, 0.006);
      const u0 = s < 0 ? 0 : W - along;
      const u1 = s < 0 ? along : W;
      put(k, prism(rect(u0, u1, y0, y1), -0.03, 0.055 + rng.jitter(0.004), 0.02), 'stone', c, F);
      const [ua, ub] = behind(s, -0.055, FACE_T + side);
      put(k, prism(rect(ua, ub, y0, y1), -0.03, 0.05 + rng.jitter(0.004), 0.02), 'stone', c, cheekFrame(g, s));
    }
  }

  // Window head: a stone lintel, or a ring of voussoirs round an arch.
  const lintelTop = Math.min(w.y1 + 0.17, g.eaveY - 0.03);
  if (w.arched) {
    const uc = (w.u0 + w.u1) / 2;
    const r = (w.u1 - w.u0) / 2;
    const spring = w.y1 - r;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a0 = (Math.PI * i) / n + 0.012;
      const a1 = (Math.PI * (i + 1)) / n - 0.012;
      const r1 = r + (i === 3 ? 0.17 : 0.14);
      const poly: V2[] = [];
      for (const a of [a0, (a0 + a1) / 2, a1]) poly.push([uc + (r - 0.01) * Math.cos(a), spring + (r - 0.01) * Math.sin(a)]);
      for (const a of [a1, a0]) poly.push([uc + r1 * Math.cos(a), spring + r1 * Math.sin(a)]);
      const c = vary(i === 3 ? mix(look.dressedStone, '#ffffff', 0.08) : look.dressedStone, rng, 0.05, 0.03, 0.006);
      put(k, prism(poly, -0.03, i === 3 ? 0.065 : 0.055, 0.014), 'stone', c, F);
    }
  } else {
    put(k, prism(rect(w.u0 - 0.13, w.u1 + 0.13, w.y1 - 0.01, lintelTop), -0.03, 0.06, 0.02), 'stone', vary(look.dressedStone, rng, 0.04, 0.03, 0.005), F);
  }

  // Field stones in courses, keeping out of the window surround and the
  // quoins; course lines fall on the sill and the window head.
  const sillBottom = w.y0 - 0.075;
  const uc = (w.u0 + w.u1) / 2;
  const r = (w.u1 - w.u0) / 2;
  const headStart = w.arched ? w.y1 - r : w.y1 - 0.01;
  const headEnd = w.arched ? w.y1 + 0.19 : lintelTop + 0.008;
  // Zones of the window surround: [y0, y1] → the u-range stones keep out of.
  const zones: [number, number, number, number][] = [
    [sillBottom - 0.008, w.y0 + 0.025, w.u0 - 0.08, w.u1 + 0.08],
    [w.y0 + 0.025, headStart, w.u0 - 0.016, w.u1 + 0.016],
    [headStart, headEnd, w.arched ? uc - r - 0.17 : w.u0 - 0.14, w.arched ? uc + r + 0.17 : w.u1 + 0.14],
  ];
  const yTop = g.gable ? g.ridgeY - 0.05 : g.eaveY - 0.03;
  const lines = [yBottom, sillBottom - 0.008, w.y0 + 0.025, headStart, headEnd, yTop].filter((v, i, a) => i === 0 || v > a[i - 1] + 1e-3);
  const rows: [number, number][] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const span = lines[i + 1] - lines[i];
    if (span < 0.06) continue;
    const n = Math.max(1, Math.round(span / 0.18));
    for (let j = 0; j < n; j++) rows.push([lines[i] + (span * j) / n, lines[i] + (span * (j + 1)) / n]);
  }
  rows.forEach(([ya, yb], row) => {
    const y0 = ya + 0.007;
    const y1 = yb - 0.007;
    // Clear of every quoin band the course touches.
    let along = 0;
    quoinAlong.forEach((a, i) => {
      const q0 = yBottom + i * qh;
      if (y0 < q0 + qh && y1 > q0) along = Math.max(along, a);
    });
    const qa = along ? along + 0.014 : 0.01;
    let spans: [number, number][] = [[qa, W - qa]];
    for (const [z0, z1, k0, k1] of zones) {
      if (y1 <= z0 || y0 >= z1) continue;
      spans = spans.flatMap(([a, c]) => [[a, Math.min(c, k0)], [Math.max(a, k1), c]] as [number, number][]);
    }
    for (const [a, c] of spans) {
      if (c - a < 0.06) continue;
      let u = a;
      let first = true;
      while (u < c - 0.05) {
        let len = rng.range(0.2, 0.34) * (first && row % 2 ? 0.6 : 1);
        first = false;
        if (c - (u + len) < 0.12) len = c - u;
        const u0 = u + 0.007;
        const u1 = u + len - 0.007;
        u += len;
        if (Math.max(top(u0), top(u1)) - y0 < 0.06) continue;
        stone(k, F, u0, u1, y0, y1, top, look.pal.stone, rng);
      }
    }
  });
}

/** One rounded field stone on the face, its top squeezed under `top(u)`. */
function stone(k: Kit, F: THREE.Matrix4, u0: number, u1: number, y0: number, y1: number, top: (u: number) => number, base: string, rng: Rng): void {
  const g = fieldStone(u1 - u0, y1 - y0, rng);
  g.translate((u0 + u1) / 2, (y0 + y1) / 2, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const c = top(pos.getX(i));
    const yy = pos.getY(i);
    if (c < y1) pos.setY(i, y0 + (yy - y0) * Math.max(0, (c - y0) / (y1 - y0)));
  }
  g.computeVertexNormals();
  const color = vary(base, rng, 0.07, 0.05, 0.012);
  if (rng.chance(0.15)) color.multiplyScalar(rng.range(0.85, 0.95));
  put(k, g, 'stone', color, F);
}

/** Pillowy field stone centred on the origin (x, y), from w = -0.03 up to a domed front. */
function fieldStone(sx: number, sy: number, rng: Rng): THREE.BufferGeometry {
  const hx = sx / 2;
  const hy = sy / 2;
  const small = Math.min(sx, sy);
  const ring: V2[] = [];
  [[1, -1], [1, 1], [-1, 1], [-1, -1]].forEach(([cx, cy], k) => {
    const r = Math.min(small * 0.45, clamp(small * rng.range(0.28, 0.45), 0.025, 0.1));
    for (let i = 0; i < 3; i++) {
      const a = ((k - 1) * Math.PI) / 2 + (i * Math.PI) / 4;
      const rr = r - rng.range(0, Math.min(0.008, small * 0.06));
      ring.push([cx * (hx - r) + rr * Math.cos(a), cy * (hy - r) + rr * Math.sin(a)]);
    }
  });
  const inset = Math.min(small * 0.28, rng.range(0.025, 0.04));
  const kx = Math.max(0.3, (hx - inset) / hx);
  const ky = Math.max(0.3, (hy - inset) / hy);
  const shoulder = rng.range(0.012, 0.02);
  const face = shoulder + rng.range(0.01, 0.016);
  const pos: number[] = [];
  for (const [x, y] of ring) pos.push(x, y, -0.03);
  for (const [x, y] of ring) pos.push(x, y, shoulder);
  for (const [x, y] of ring) pos.push(x * kx, y * ky, face + rng.jitter(0.003));
  pos.push(rng.jitter(hx * 0.2), rng.jitter(hy * 0.2), face + rng.range(0.006, 0.012));
  const n = ring.length;
  const index: number[] = [];
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < n; i++) {
      const a = r * n + i;
      const b = r * n + ((i + 1) % n);
      index.push(a, b, b + n, a, b + n, a + n);
    }
  }
  for (let i = 0; i < n; i++) index.push(3 * n, 2 * n + i, 2 * n + ((i + 1) % n));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  return lumpify(g, Math.min(0.004, small * 0.03), rng.int(0, 1e6));
}

// ---------------------------------------------------------------------------
// Cheeks
// ---------------------------------------------------------------------------

/** Outline of a cheek in canonical (z, y): foot along the roof (sunk), top under the dormer roof. */
function cheekOutlineZY(g: Geo): V2[] {
  const zA = g.zf - FACE_T;
  if (g.gable) {
    const zc = g.zf - (g.faceH + SINK) / g.tanP;
    return [[zA, surf(g, zA) - SINK], [zA, g.eaveY], [zc, g.eaveY]];
  }
  const zc = g.zf - (g.faceH + SINK) / (g.tanP - g.tD);
  return [[zA, surf(g, zA) - SINK], [zA, shedUnder(g, zA)], [zc, shedUnder(g, zc)]];
}

function buildCheeks(k: Kit, rng: Rng): void {
  const { g, look } = k;
  for (const s of [-1, 1] as const) {
    const Ck = cheekFrame(g, s);
    const poly = cheekOutlineZY(g).map(([z, y]) => [cheekU(g, s, z), y] as V2);
    put(k, prism(poly, -CHEEK_T, 0, 0), 'plaster', look.plaster, Ck);
    if (look.cheek === 'timber') cheekTimber(k, s, rng);
    else if (look.cheek === 'boards') cheekBoards(k, s, rng);
    else if (look.cheek === 'tiles') cheekTiles(k, s, rng);
    else if (g.d.style === 'plaster') {
      // Corner board wrapping round from the face.
      const [ua, ub] = behind(s, -0.026, FACE_T + 0.09);
      const poly2 = rect(ua, ub, g.baseY - 0.04, cheekTopAt(g, g.zf - FACE_T - 0.09) - 0.005);
      put(k, prism(poly2, -0.01, 0.026, 0.008), 'wood', vary(look.trim, rng, 0.03, 0.02, 0.004), Ck);
    }
  }
}

/** Height of the cheek's top (the dormer roof underside over the cheek's outer face) at canonical z. */
function cheekTopAt(g: Geo, z: number): number {
  return g.gable ? g.eaveY : shedUnder(g, z);
}

/**
 * Depth behind the face plane where a cheek's own cladding starts: stone
 * faces' quoins cover the face wall's edge, other claddings wrap it.
 */
function claddingStart(g: Geo): number {
  return g.d.style === 'stone' ? FACE_T + 0.012 : -0.004;
}

/**
 * The visible part of the cheek in cheek-local (u, y), from `depth0` behind
 * the face plane back to where it dies into the roof: above the roof surface
 * (+ lift), below its top.
 */
function cheekVisible(g: Geo, s: number, lift = 0, depth0 = 0): V2[] {
  const zA = g.zf - depth0;
  const zEnd = g.cheekEnd;
  const pts: V2[] = [
    [zA, surf(g, zA) + lift],
    [zA, cheekTopAt(g, zA)],
    [zEnd, cheekTopAt(g, zEnd)],
  ];
  return pts.map(([z, y]) => [cheekU(g, s, z), y]);
}

/** Timber framing on a cheek: corner post (wrapping the face's), sole plate along the roof, top plate, a stud. */
function cheekTimber(k: Kit, s: number, rng: Rng): void {
  const { g, look } = k;
  const Ck = cheekFrame(g, s);
  const col = () => vary(look.pal.timber, rng, 0.04, 0.03, 0.006);
  const beam = (poly: V2[], front = 0.04) => put(k, prism(poly, -0.02, front - rng.range(0, 0.003), 0.018), 'timber', col(), Ck);
  const vis = cheekVisible(g, s);
  const sole = 0.12;
  const plate = 0.12;
  // Bands along the roof line and under the top, as cheek-local polygons.
  const band = (z0: number, z1: number, y: (z: number) => number, h0: number, h1: number): V2[] =>
    [
      [z0, y(z0) + h0],
      [z1, y(z1) + h0],
      [z1, y(z1) + h1],
      [z0, y(z0) + h1],
    ].map(([z, yy]) => [cheekU(g, s, z), yy] as V2);
  const zA = g.zf + 0.3;
  const zB = g.cheekEnd - 0.5;
  beam(clipConvex(band(zA, zB, (z) => surf(g, z), -0.03, sole), vis), 0.045);
  beam(clipConvex(band(zA, zB, (z) => cheekTopAt(g, z), -plate, 0), vis), 0.045);
  // Between the plates: the corner post (wrapping round the face's) and a stud.
  const between = (poly: V2[]) => {
    const tTop = g.gable ? 0 : g.tD;
    // y ≥ roof line + sole, y ≤ top line - plate (both linear in u: z = faceZ - s·u).
    const p1 = clipHalf(poly, s * g.tanP, -1, -(g.baseY + sole));
    return clipHalf(p1, -s * tTop, 1, g.eaveY - plate);
  };
  const [pa, pb] = behind(s, -0.05, FACE_T + 0.1);
  beam(between(rect(pa, pb, g.baseY - 1, g.eaveY + 1)));
  const zm = g.zf - (g.zf - g.cheekEnd) * 0.45;
  const um = cheekU(g, s, zm);
  if (cheekTopAt(g, zm) - plate - (surf(g, zm) + sole) > 0.3) {
    beam(between(rect(um - 0.055, um + 0.055, g.baseY - 1, g.eaveY + 1)), 0.037);
  }
}

/** Horizontal weatherboards on a cheek. */
function cheekBoards(k: Kit, s: number, rng: Rng): void {
  const { g, look } = k;
  const Ck = cheekFrame(g, s);
  // The boards also cover the face wall's edge (and butt against the face's corner board).
  const region = cheekVisible(g, s, -0.03, claddingStart(g));
  const ys = region.map((p) => p[1]);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const bh = 0.13;
  const n = Math.max(2, Math.round((y1 - y0) / bh));
  const step = (y1 - y0) / n;
  const base = look.trim;
  for (let i = 0; i < n; i++) {
    const ya = y0 + i * step;
    const poly = clipConvex(rect(-5, 5, ya - 0.012, ya + step), region);
    if (poly.length < 3 || polyArea(poly) < 0.002) continue;
    const c = vary(base, rng, 0.04, 0.03, 0.006);
    // Each board's lower edge stands proud (lapped weatherboards).
    const geom = prism(poly, -0.008, 0.03, 0.006);
    if (!geom) continue;
    const m = new THREE.Matrix4().makeTranslation(0, ya, 0).multiply(new THREE.Matrix4().makeRotationX(-0.06)).multiply(new THREE.Matrix4().makeTranslation(0, -ya, 0));
    put(k, geom, 'wood', c, mul(Ck, m));
  }
}

/** Tile-hung cheek: small plain tiles in courses, tails down. */
function cheekTiles(k: Kit, s: number, rng: Rng): void {
  const { g, look } = k;
  const Ck = cheekFrame(g, s);
  const t = look.hung;
  const region = cheekVisible(g, s, -0.04, claddingStart(g) - 0.008);
  const yTop = Math.max(...region.map((p) => p[1]));
  // Tile frame: X = u, Y = outward (w), Z = down from yTop.
  const frame = mul(
    Ck,
    new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0)).setPosition(0, yTop, 0),
  );
  const local = region.map(([u, y]) => [u, yTop - y] as V2);
  const zMax = Math.max(...local.map((p) => p[1]));
  const n = Math.max(1, Math.round((zMax + 0.02) / t.gauge));
  layTiles(k, frame, local, t, 0.004, { tail0: zMax + 0.02, gauge: (zMax + 0.02) / n, minZ: 0, hung: true }, rng);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * The window outline (face-local u, y) offset inwards by `inset` as an open
 * polyline: from the bottom-right corner at `yBottom`, up, over the head and
 * down to the bottom-left corner.
 */
function windowOutline(g: Geo, inset: number, yBottom: number, segments = 10): THREE.Vector2[] {
  const w = g.win;
  const u0 = w.u0 + inset;
  const u1 = w.u1 - inset;
  const pts = [new THREE.Vector2(u1, yBottom)];
  if (w.arched) {
    const uc = (w.u0 + w.u1) / 2;
    const r = (w.u1 - w.u0) / 2;
    const spring = w.y1 - r;
    for (let i = 0; i <= segments; i++) {
      const a = (Math.PI * i) / segments;
      pts.push(new THREE.Vector2(uc + (r - inset) * Math.cos(a), spring + (r - inset) * Math.sin(a)));
    }
  } else {
    pts.push(new THREE.Vector2(u1, w.y1 - inset), new THREE.Vector2(u0, w.y1 - inset));
  }
  pts.push(new THREE.Vector2(u0, yBottom));
  return pts;
}

function buildWindow(k: Kit, rng: Rng): void {
  const { g, look } = k;
  const F = faceFrame(g);
  const w = g.win;
  const fw = WINDOW_FRAME;
  const trim = vary(look.pal.trim, rng, 0.025, 0.02, 0.004);

  // Frame ring, slightly embedded in the reveal.
  const ring = new THREE.Shape(windowOutline(g, -0.01, w.y0 - 0.01));
  ring.holes.push(new THREE.Path(windowOutline(g, fw, w.y0 + fw)));
  put(k, extrudeLocal(ring, 0.07, RECESS + 0.03, 10), 'trim', trim, F);

  // Glass: teal-grey, lighter towards the top like a reflected sky.
  const glass = new THREE.Shape(windowOutline(g, fw - 0.012, w.y0 + fw - 0.012));
  const sky = new THREE.Color(GLASS_SKY);
  const h = Math.max(0.1, w.y1 - w.y0);
  put(k, extrudeLocal(glass, 0.008, RECESS - 0.018, 10), 'glass', vary(GLASS, rng, 0.03, 0.04, 0.008), F, (p, _n, out) => {
    out.lerp(sky, 0.42 * clamp((p.y - w.y0) / h, 0, 1));
  });

  // Glazing bars.
  const barColor = mix(trim, '#000000', 0.03);
  const bar = (u0: number, u1: number, y0: number, y1: number) => put(k, prism(rect(u0, u1, y0, y1), RECESS - 0.016, RECESS + 0.016, 0.006), 'trim', barColor, F);
  const ui0 = w.u0 + fw;
  const ui1 = w.u1 - fw;
  const yi0 = w.y0 + fw;
  const uc = (w.u0 + w.u1) / 2;
  const B = GLAZING_BAR / 2;
  if (w.arched) {
    const r = (w.u1 - w.u0) / 2;
    const spring = w.y1 - r;
    bar(uc - B, uc + B, yi0 - 0.01, w.y1 - fw + 0.01);
    bar(ui0 - 0.01, ui1 + 0.01, spring - B, spring + B);
    // Two fan bars in the head.
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4]) {
      const len = r - fw + 0.01;
      const m = new THREE.Matrix4().makeTranslation(uc + (Math.cos(a) * len) / 2, spring + (Math.sin(a) * len) / 2, RECESS).multiply(new THREE.Matrix4().makeRotationZ(a));
      put(k, prism(rect(-len / 2, len / 2, -B * 0.9, B * 0.9), -0.015, 0.015, 0.005), 'trim', barColor, mul(F, m));
    }
  } else {
    const yi1 = w.y1 - fw;
    bar(uc - B, uc + B, yi0 - 0.01, yi1 + 0.01);
    const rows = look.glazing === 'cross' ? [0.58] : [1 / 3, 2 / 3];
    for (const f of rows) {
      const y = yi0 + (yi1 - yi0) * f;
      bar(ui0 - 0.01, ui1 + 0.01, y - B, y + B);
    }
  }

  // Sill: dressed stone on stone faces, a wooden board otherwise.
  const stone = g.d.style === 'stone';
  const sillColor = stone ? vary(look.dressedStone, rng, 0.04, 0.03, 0.005) : vary(look.pal.timber, rng, 0.04, 0.03, 0.006);
  const sillBottom = w.y0 - (stone ? 0.075 : 0.055);
  const sill = prism(rect(w.u0 - 0.07, w.u1 + 0.07, sillBottom, w.y0 + 0.018), -(0.1 - RECESS - 0.03) / 2, (0.1 - RECESS - 0.03) / 2, 0.012);
  const sm = new THREE.Matrix4()
    .makeTranslation(0, 0, (0.1 + RECESS + 0.03) / 2)
    .multiply(new THREE.Matrix4().makeTranslation(0, (sillBottom + w.y0) / 2, 0))
    .multiply(new THREE.Matrix4().makeRotationX(0.06))
    .multiply(new THREE.Matrix4().makeTranslation(0, -(sillBottom + w.y0) / 2, 0));
  put(k, sill, stone ? 'stone' : 'wood', sillColor, mul(F, sm));

  if (look.flowerBox) flowerBox(k, sillBottom, rng.fork('box'));
}

/** A flower box hanging under the sill, propped on two little brackets. */
function flowerBox(k: Kit, sillBottom: number, rng: Rng): void {
  const { g, look } = k;
  const F = faceFrame(g);
  const w = g.win;
  const u0 = w.u0 - 0.03;
  const u1 = w.u1 + 0.03;
  const top = sillBottom - 0.006;
  const bot = top - 0.14;
  const w0 = 0.07;
  const w1 = 0.27;
  // Keep clear of the apron (which follows the roof down from the face).
  if (bot < g.baseY + 0.02) return;
  const wood = vary(rng.chance(0.5) ? look.pal.wood : mix(look.pal.shutter, look.pal.wood, 0.25), rng, 0.04, 0.03, 0.006);
  const box = (u: [number, number], y: [number, number], ww: [number, number], color: ColorLike, mat: MatKey = 'wood', r = 0.012) => {
    const m = new THREE.Matrix4().makeTranslation(0, 0, 0);
    put(k, prism(rect(u[0], u[1], y[0], y[1]), ww[0], ww[1], r), mat, color, mul(F, m));
  };
  box([u0, u1], [bot, top - 0.03], [w0, w1], wood);
  box([u0 - 0.012, u1 + 0.012], [top - 0.045, top], [w0, w1 + 0.012], mix(wood, '#000000', 0.08));
  box([u0 + 0.03, u1 - 0.03], [top - 0.02, top + 0.004], [w0 + 0.03, w1 - 0.03], SOIL, 'wood', 0);
  const iron = vary(IRON, rng, 0.03, 0.02, 0);
  for (const u of [u0 + 0.08, u1 - 0.08]) {
    box([u - 0.012, u + 0.012], [bot - 0.016, bot], [-0.01, w1 - 0.03], iron, 'metal', 0);
    box([u - 0.012, u + 0.012], [bot - 0.016, top - 0.05], [-0.01, 0.012 + g.faceProud], iron, 'metal', 0);
  }
  // Foliage clumps with a few flowers, one or two trailing sprigs.
  const flowers = look.pal.flowers.length ? look.pal.flowers : ['#e0587a'];
  const fc = [rng.pick(flowers), rng.pick(flowers)];
  const n = Math.max(3, Math.round((u1 - u0) / 0.19));
  const step = (u1 - u0) / n;
  for (let i = 0; i < n; i++) {
    const u = u0 + (i + 0.5) * step + rng.jitter(step * 0.2);
    const rad = rng.range(0.08, 0.1);
    const scale = new THREE.Vector3(rng.range(1.0, 1.2), rng.range(0.75, 0.9), rng.range(0.95, 1.1));
    const centre = new THREE.Vector3(u, top + rad * 0.45 + rng.range(0, 0.025), Math.max(rng.range(0.16, 0.2), 0.08 + rad * scale.z * 1.2));
    blob(k, F, 'foliage', vary(rng.pick(LEAF_GREENS), rng, 0.05, 0.05, 0.01), centre, rad, scale, 'clump', rng);
    for (let f = 0; f < rng.int(1, 3); f++) {
      const a = rng.range(-1.2, 1.2);
      const e = rng.range(0.25, 1.1);
      const dir = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
      const p = centre.clone().add(dir.multiply(scale).multiplyScalar(rad * 0.95));
      blob(k, F, 'flower', vary(rng.pick(fc), rng, 0.05, 0.05, 0.01), p, rng.range(0.02, 0.026), new THREE.Vector3(1, 0.8, 1), 'bud', rng);
    }
  }
  for (let i = 0; i < 2; i++) {
    const u = u0 + ((i + 0.5) / 2) * (u1 - u0) + rng.jitter(0.05);
    const green = vary(rng.pick(LEAF_GREENS), rng, 0.05, 0.05, 0.01);
    for (let j = 0; j < 2; j++) {
      const rad = 0.042 - j * 0.008;
      blob(k, F, 'foliage', green, new THREE.Vector3(u + rng.jitter(0.015), top - 0.01 - j * 0.05, w1 + 0.012 + rad * 0.6 - j * 0.006), rad, new THREE.Vector3(1, 1.15, 0.8), 'sprig', rng);
    }
  }
}

// ---------------------------------------------------------------------------
// Gabled dormer roof
// ---------------------------------------------------------------------------

/**
 * Slope frame of a gabled dormer's slope on side s: X along the dormer ridge
 * (away from the front for s = +1, towards it for s = -1), Y out of the
 * slope, Z down the slope; origin on the underside's ridge line at the front
 * edge of the roof.
 */
function gableSlopeFrame(g: Geo, s: number): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeBasis(new THREE.Vector3(0, 0, -s), new THREE.Vector3(s * g.sD, g.cD, 0), new THREE.Vector3(s * g.cD, -g.sD, 0))
    .setPosition(g.xc, g.ridgeY, g.zFront);
}

/** Frame of the main roof's (canonical front) slope: X = x, Y out of the slope, Z down it from the ridge. */
function mainFrame(g: Geo): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, g.cosP, g.sinP), new THREE.Vector3(0, -g.sinP, g.cosP))
    .setPosition(0, g.roof.ridgeY, 0);
}

/** (X, Z) of a canonical point in a frame. */
function localXZ(frame: THREE.Matrix4, p: THREE.Vector3): V2 {
  const q = p.clone().applyMatrix4(frame.clone().invert());
  return [q.x, q.z];
}

/** The two ends of a gabled dormer's valley on side s (canonical, on the tile surfaces). */
function valleyEnds(g: Geo, s: number): [THREE.Vector3, THREE.Vector3] {
  const topAt = (a: number) => gableUnder(g, a) + g.cover / g.cD;
  const ae = g.hw + g.so;
  const y0 = topAt(0);
  const y1 = topAt(ae);
  return [new THREE.Vector3(g.xc, y0, zOnSurface(g, y0)), new THREE.Vector3(g.xc + s * ae, y1, zOnSurface(g, y1))];
}

/** Half-plane (keep side containing `inside`) through p, q, pulled in by `margin`. */
function keepSide(poly: V2[], p: V2, q: V2, inside: V2, margin: number): V2[] {
  let nx = -(q[1] - p[1]);
  let ny = q[0] - p[0];
  const l = Math.hypot(nx, ny) || 1;
  nx /= l;
  ny /= l;
  if (nx * (inside[0] - p[0]) + ny * (inside[1] - p[1]) < 0) {
    nx = -nx;
    ny = -ny;
  }
  // Keep n·(x - p) ≥ margin  ⇔  -n·x ≤ -(n·p + margin).
  return clipHalf(poly, -nx, -ny, -(nx * p[0] + ny * p[1] + margin));
}

function buildGableRoof(k: Kit, rng: Rng): void {
  const { g, look } = k;
  const t = look.tile;
  const ae = g.hw + g.so;
  const zEave = ae / g.cD;
  const rise = tileRise(t);
  const tilt = Math.atan2(rise, t.length);
  const deckColor = shade(look.pal.wood, -0.12);

  for (const s of [-1, 1] as const) {
    const S = gableSlopeFrame(g, s);
    const [V0, V1] = valleyEnds(g, s);
    const L0 = localXZ(S, V0);
    const L1 = localXZ(S, V1);
    const far = s * (g.zFront + 0.5);
    const inside: V2 = [s * 0.05, zEave * 0.5];

    // Deck: front edge to past the valley (it dives under the main roof there).
    const deckRect: V2[] = [[0, -DECK * g.tD], [far, -DECK * g.tD], [far, zEave], [0, zEave]];
    const deck = keepSide(deckRect, L0, L1, inside, -0.12);
    put(k, slabXZ(deck, 0, DECK), 'wood', deckColor, S);

    // Tiles: eave to ridge, clipped along the valley (an open valley).
    const tail0 = zEave + 0.045;
    const lastTail = 0.07;
    const n = Math.max(2, Math.round((tail0 - lastTail) / t.gauge));
    const region = keepSide([[0, 0], [far, 0], [far, tail0], [0, tail0]], L0, L1, inside, VALLEY_GAP);
    layTiles(k, S, region, t, DECK + 0.003, { tail0, gauge: (tail0 - lastTail) / n, minZ: -0.02, tilt }, rng);

    // Valley lead, the dormer's side of it.
    // (Cut at the plumb plane through the ridge, where it meets the other slope's.)
    valleyLead(k, S, L0, L1, inside, g.cover - 0.045, -(g.cover - 0.06) * g.tD);

    // Fascia along the eave, dying into the main roof.
    const yU = gableUnder(g, ae);
    const fascia: V2[] = [
      [g.zFront + BOARD_T, yU - BOARD_DROP],
      [g.zFront + BOARD_T, yU + 0.035],
      [V1.z - 1.5, yU + 0.035],
      [V1.z - 1.5, yU - BOARD_DROP],
    ];
    const cut = clipHalf(fascia, -g.tanP, -1, -(g.baseY + g.zf * g.tanP - 0.05));
    const x0 = g.xc + s * ae;
    put(k, prismX(cut, Math.min(x0, x0 + s * BOARD_T), Math.max(x0, x0 + s * BOARD_T), 0.01), 'wood', vary(look.trim, rng, 0.03, 0.02, 0.004));
  }

  // Patches of main-roof tiles behind the cheeks, outside the valleys.
  for (const s of [-1, 1] as const) mainPatch(k, s, rng);

  // Barge boards on the front gable, meeting plumb at the apex.
  const top = g.cover / g.cD + 0.02;
  const ab = ae + 0.03;
  for (const s of [-1, 1] as const) {
    const poly: V2[] = [
      [g.xc, g.ridgeY - BOARD_DROP],
      [g.xc + s * ab, gableUnder(g, ab) - BOARD_DROP],
      [g.xc + s * ab, gableUnder(g, ab) + top],
      [g.xc, g.ridgeY + top],
    ];
    put(k, prism(poly, g.zFront, g.zFront + BOARD_T, 0.01), 'wood', vary(look.trim, rng, 0.03, 0.02, 0.004));
  }

  // Ridge: rounded ridge tiles lying on both slopes, from the front to where
  // the ridge dives into the main roof (a lead saddle covers the junction).
  const ridge = ridgeProfile(g);
  const capTop = Math.max(...ridge.map((q) => q.p[1]));
  const zStart = g.zFront + BOARD_T + 0.025;
  const zEnd = Math.max(0.05, zOnSurface(g, capTop - 0.01));
  const len = zStart - zEnd;
  if (len > 0.1) {
    const pieces = Math.max(1, Math.round(len / 0.32));
    const pl = len / pieces;
    const ridgeColor = shade(look.pal.roof, -0.07);
    for (let i = 0; i < pieces; i++) {
      const z1 = zStart - i * pl;
      const z0 = i === pieces - 1 ? zEnd : z1 - pl - 0.03;
      const m = new THREE.Matrix4().makeTranslation(0, rng.jitter(0.003), 0);
      put(k, sweepZ(ridge, z0, z1, 0.05, [g.xc, g.ridgeY + DECK / g.cD]), 'roof', vary(ridgeColor, rng, 0.02, 0.02, 0.004), m);
    }
    const zs = Math.max(0.04, zEnd - 0.2);
    leadOnRoof(k, g.xc - 0.22, g.xc + 0.22, zs, zEnd + 0.16, 0.018, 0.003, k.lead, { x0: true, x1: true, za: true, zb: true });
  }

  if (look.finial) {
    const yBottom = g.ridgeY - BOARD_DROP - 0.12;
    const yTop = capTop + rng.range(0.16, 0.22);
    const h = yTop - yBottom;
    const pts: [number, number][] = [
      [0, 0],
      [0.02, 0.012],
      [0.032, 0.05],
      [0.028, 0.09],
      [0.034, 0.12],
      [0.034, h - 0.16],
      [0.045, h - 0.13],
      [0.048, h - 0.1],
      [0.036, h - 0.07],
      [0.012, h - 0.03],
      [0, h],
    ];
    const lathe = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 8);
    put(k, lathe, 'wood', vary(look.trim, rng, 0.03, 0.02, 0.004), new THREE.Matrix4().makeTranslation(g.xc, yBottom, g.zFront + BOARD_T + 0.03));
  }
}

/**
 * Main-roof tiles over the corner of the hole behind a cheek, outside the
 * valley (side s), laid in the main roof's plane and course rhythm, on a thin
 * underlay so no deck can show between them.
 */
function mainPatch(k: Kit, s: number, rng: Rng): void {
  const { g, look } = k;
  const M = mainFrame(g);
  const [V0, V1] = valleyEnds(g, s);
  const L0 = localXZ(M, V0);
  const L1 = localXZ(M, V1);
  const at = (x: number, z: number) => localXZ(M, new THREE.Vector3(x, surf(g, z), z));
  const xa = g.xc;
  const xb = g.xc + s * (g.hw + PATCH_EXT);
  const za = g.backZ - PATCH_EXT;
  const zb = g.zf;
  const quad = [at(xa, za), at(xb, za), at(xb, zb), at(xa, zb)];
  const inside = at(g.xc + s * g.hw, g.backZ);
  const region = keepSide(quad, L0, L1, inside, VALLEY_GAP);
  if (region.length < 3 || polyArea(region) < 0.003) return;
  const r = g.roof;
  const under = keepSide(quad, L0, L1, inside, -0.03);
  put(k, slabXZ(under, r.deckThickness - 0.012, r.deckThickness + 0.002), 'wood', shade(look.pal.wood, -0.16), M);
  const mc = look.main;
  layTiles(k, M, region, mc.tile, mc.yHead, { tail0: mc.eaveTail, gauge: mc.gauge, minZ: -1, tilt: mc.tilt, hung: true }, rng);
  valleyLead(k, M, L0, L1, inside, r.coverThickness - 0.045);
}

/**
 * One wing of an open lead valley in a slope frame: a thin sheet along the
 * valley line, a little below the tile surface (`y` is its top), reaching
 * under the tiles on its side and just past the valley under the other wing.
 */
function valleyLead(k: Kit, frame: THREE.Matrix4, p: V2, q: V2, inside: V2, y: number, minZ = -Infinity): void {
  const dx = q[0] - p[0];
  const dz = q[1] - p[1];
  const l = Math.hypot(dx, dz) || 1;
  const tx = dx / l;
  const tz = dz / l;
  let nx = -tz;
  let nz = tx;
  if (nx * (inside[0] - p[0]) + nz * (inside[1] - p[1]) < 0) {
    nx = -nx;
    nz = -nz;
  }
  const a: V2 = [p[0] - tx * 0.04, p[1] - tz * 0.04];
  const b: V2 = [q[0] + tx * 0.03, q[1] + tz * 0.03];
  const poly: V2[] = [
    [a[0] - nx * 0.03, a[1] - nz * 0.03],
    [b[0] - nx * 0.03, b[1] - nz * 0.03],
    [b[0] + nx * 0.15, b[1] + nz * 0.15],
    [a[0] + nx * 0.15, a[1] + nz * 0.15],
  ];
  put(k, slabXZ(clipHalf(poly, 0, -1, -minZ), y - 0.014, y), 'mortar', k.lead, frame);
}

/** A point of a swept cross-section; smooth points get averaged normals. */
interface ProfilePoint {
  p: V2;
  smooth: boolean;
}

/**
 * Cross-section (canonical x, y) of a gabled dormer's ridge tiles: legs
 * lying on both slopes over the top course, rounded over the apex, solid
 * down to the deck so nothing shows beneath.
 */
function ridgeProfile(g: Geo): ProfilePoint[] {
  const R = 0.045;
  const capH = g.cover + 0.028;
  const capZ = 0.095;
  const at = (s: number, Z: number, Y: number): V2 => [g.xc + s * (Z * g.cD + Y * g.sD), g.ridgeY - Z * g.sD + Y * g.cD];
  const yc = g.ridgeY + (capH - R) / g.cD;
  const out: ProfilePoint[] = [
    { p: at(-1, capZ, DECK * 0.5), smooth: false },
    { p: at(-1, capZ, capH), smooth: false },
  ];
  const pitch = Math.atan(g.tD);
  for (let i = 0; i <= 6; i++) {
    const phi = -pitch + (2 * pitch * i) / 6;
    out.push({ p: [g.xc + R * Math.sin(phi), yc + R * Math.cos(phi)], smooth: true });
  }
  out.push({ p: at(1, capZ, capH), smooth: false }, { p: at(1, capZ, DECK * 0.5), smooth: false });
  return out;
}

/**
 * Sweep a closed (x, y) profile along z from z0 to z1, shrinking it towards
 * `pivot` by `taper` at the z0 end (ridge tiles overlap like this). Smooth
 * profile points get averaged normals.
 */
function sweepZ(profile: ProfilePoint[], z0: number, z1: number, taper: number, pivot: V2): THREE.BufferGeometry {
  let pts = profile;
  if (signedArea(pts.map((q) => q.p)) < 0) pts = [...pts].reverse();
  const n = pts.length;
  const scaled = (p: V2, s: number): V2 => [pivot[0] + (p[0] - pivot[0]) * s, pivot[1] + (p[1] - pivot[1]) * s];
  const s0 = 1 - taper;
  const edgeN = pts.map((a, i) => {
    const c = pts[(i + 1) % n];
    const dx = c.p[0] - a.p[0];
    const dy = c.p[1] - a.p[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l];
  });
  const pos: number[] = [];
  const nor: number[] = [];
  const push = (p: V2, z: number, nx: number, ny: number, nz: number) => {
    pos.push(p[0], p[1], z);
    nor.push(nx, ny, nz);
  };
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    const normalAt = (k2: number, edge: number) => {
      if (!pts[k2].smooth) return edgeN[edge];
      const a = edgeN[(k2 + n - 1) % n];
      const c = edgeN[k2];
      const l = Math.hypot(a[0] + c[0], a[1] + c[1]) || 1;
      return [(a[0] + c[0]) / l, (a[1] + c[1]) / l];
    };
    const na = normalAt(i, i);
    const nb = normalAt(i2, i);
    const a1 = pts[i].p;
    const b1 = pts[i2].p;
    const a0 = scaled(a1, s0);
    const b0 = scaled(b1, s0);
    // Counter-clockwise profile seen from +z: (a1, b1, b0) and (a1, b0, a0) face outward.
    push(a1, z1, na[0], na[1], 0);
    push(b0, z0, nb[0], nb[1], 0);
    push(b1, z1, nb[0], nb[1], 0);
    push(a1, z1, na[0], na[1], 0);
    push(a0, z0, na[0], na[1], 0);
    push(b0, z0, nb[0], nb[1], 0);
  }
  const tris = THREE.ShapeUtils.triangulateShape(
    pts.map((q) => new THREE.Vector2(q.p[0], q.p[1])),
    [],
  );
  for (const [i0, i1, i2] of tris) {
    const cross = (pts[i1].p[0] - pts[i0].p[0]) * (pts[i2].p[1] - pts[i0].p[1]) - (pts[i1].p[1] - pts[i0].p[1]) * (pts[i2].p[0] - pts[i0].p[0]);
    const [j1, j2] = cross > 0 ? [i1, i2] : [i2, i1];
    // Front cap (z1) faces +z, back cap (z0) faces -z.
    for (const k2 of [i0, j1, j2]) push(pts[k2].p, z1, 0, 0, 1);
    for (const k2 of [i0, j2, j1]) push(scaled(pts[k2].p, s0), z0, 0, 0, -1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return geo;
}

// ---------------------------------------------------------------------------
// Shed dormer roof
// ---------------------------------------------------------------------------

/** Shed roof frame: X = x, Y out of the slope, Z down it towards the front; origin on the underside at the back line. */
function shedFrame(g: Geo): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, g.cD, g.sD), new THREE.Vector3(0, -g.sD, g.cD))
    .setPosition(g.xc, g.ridgeY, g.backZ);
}

function buildShedRoof(k: Kit, rng: Rng): void {
  const { g, look } = k;
  const t = look.tile;
  const S = shedFrame(g);
  const half = g.hw + g.so;
  // Where the shed roof's tiles meet the main roof's.
  const zj = g.zf - (g.faceH + g.cover / g.cD) / (g.tanP - g.tD);
  const Zj = localXZ(S, new THREE.Vector3(g.xc, shedUnder(g, zj) + g.cover / g.cD, zj))[1];
  const Zf = (g.zFront - g.backZ) / g.cD;

  put(k, slabXZ(rect(-half, half, Zj - 0.12, Zf), 0, DECK), 'wood', shade(look.pal.wood, -0.12), S);
  const rise = tileRise(t);
  const tail0 = Zf + 0.045;
  const top = Zj - 0.06;
  const n = Math.max(2, Math.round((tail0 - top - t.length * 0.6) / t.gauge) + 1);
  layTiles(k, S, rect(-half, half, top, tail0), t, DECK + 0.003, { tail0, gauge: (tail0 - top - t.length * 0.6) / (n - 1), minZ: top, tilt: Math.atan2(rise, t.length) }, rng);

  // Lead flashing over the top course, tucked up under the main roof's tiles.
  const lead = k.lead;
  put(k, slabXZ(rect(-half - 0.02, half + 0.02, Zj - 0.03, Zj + 0.11), g.cover - 0.012, g.cover + 0.016), 'mortar', lead, S);
  const M = mainFrame(g);
  const J = localXZ(M, new THREE.Vector3(g.xc, surf(g, zj), zj));
  put(k, slabXZ(rect(g.xc - half - 0.02, g.xc + half + 0.02, J[1] - 0.14, J[1] + 0.035), g.roof.coverThickness - 0.035, g.roof.coverThickness - 0.008), 'mortar', lead, M);

  // Fascia across the front, barge boards along both sides.
  const yF = shedUnder(g, g.zFront);
  const trim = () => vary(look.trim, rng, 0.03, 0.02, 0.004);
  put(k, prism(rect(g.xc - half - BOARD_T, g.xc + half + BOARD_T, yF - BOARD_DROP + 0.01, yF + 0.025), g.zFront, g.zFront + BOARD_T, 0.01), 'wood', trim());
  const coverY = g.cover / g.cD + 0.018;
  for (const s of [-1, 1] as const) {
    const zA = g.zFront + BOARD_T;
    const zB = g.backZ - 1;
    const poly: V2[] = [
      [zA, shedUnder(g, zA) - BOARD_DROP],
      [zA, shedUnder(g, zA) + coverY],
      [zB, shedUnder(g, zB) + coverY],
      [zB, shedUnder(g, zB) - BOARD_DROP],
    ];
    const cut = clipHalf(poly, -g.tanP, -1, -(g.baseY + g.zf * g.tanP - 0.05));
    const x0 = g.xc + s * half;
    put(k, prismX(cut, Math.min(x0, x0 + s * BOARD_T), Math.max(x0, x0 + s * BOARD_T), 0.01), 'wood', trim());
  }
}

// ---------------------------------------------------------------------------
// Flashing: apron under the face, step flashing up the cheeks
// ---------------------------------------------------------------------------

function buildFlashing(k: Kit): void {
  const { g } = k;
  const lead = k.lead;
  const x0 = g.xc - g.hw;
  const x1 = g.xc + g.hw;
  // Apron: over the tiles in front of the face, and up the face.
  const apronZ = g.zf + FLASH_APRON * g.cosP;
  leadOnRoof(k, x0 - FLASH_SIDE, x1 + FLASH_SIDE, g.zf, apronZ, 0.018, 0.006, lead, { x0: true, x1: true, zb: true });
  const fp = g.faceProud;
  const upTop = g.baseY + 0.1;
  put(k, prism(rect(x0 - fp - 0.012, x1 + fp + 0.012, surf(g, g.zf + fp) - 0.03, upTop), g.zf + fp, g.zf + fp + 0.012, 0.004), 'mortar', lead);

  // Beside the cheeks: a strip over the tiles and stepped flashing up the cheek.
  for (const s of [-1, 1] as const) {
    const xa = g.xc + s * g.hw;
    const xb = xa + s * FLASH_SIDE;
    leadOnRoof(k, Math.min(xa, xb), Math.max(xa, xb), g.cheekEnd - 0.02, g.zf, 0.018, 0.006, lead, s > 0 ? { x1: true, za: true } : { x0: true, za: true });
    const Ck = cheekFrame(g, s);
    const cp = g.cheekProud;
    const zEnd = g.cheekEnd;
    const zStart = g.zf + fp + 0.012;
    const steps = Math.max(1, Math.round((zStart - zEnd) / 0.2));
    for (let i = 0; i < steps; i++) {
      const za = zStart - ((zStart - zEnd) * i) / steps;
      const zb = zStart - ((zStart - zEnd) * (i + 1)) / steps;
      const ua = cheekU(g, s, za);
      const ub = cheekU(g, s, zb);
      const ceiling = Math.min(cheekTopAt(g, za), cheekTopAt(g, zb)) - 0.02 - cp * (g.gable ? g.tD : 0);
      const stepTop = Math.min(Math.max(surf(g, za), surf(g, zb)) + 0.085, ceiling);
      const poly: V2[] = [
        [ua, surf(g, za) - 0.03],
        [ub, surf(g, zb) - 0.03],
        [ub, stepTop],
        [ua, stepTop],
      ];
      if (stepTop - Math.max(surf(g, za), surf(g, zb)) < 0.02) continue;
      put(k, prism(poly, cp, cp + 0.012, 0.003), 'mortar', lead, Ck);
    }
  }
}

/** Which edges of a lead sheet are free (dressed down onto the tiles) rather than tucked against something. */
interface Free {
  x0?: boolean;
  x1?: boolean;
  za?: boolean;
  zb?: boolean;
}

/**
 * A lead sheet lying on the main roof over the plan rectangle [x0, x1] ×
 * [za, zb] (canonical): its top `lift` above the tile surface (perpendicular),
 * dressed down to `edgeLift` along its free edges, its bottom under the
 * tiles. Built as a 3 × 3 grid of slabs so every free edge can taper.
 */
function leadOnRoof(k: Kit, x0: number, x1: number, za: number, zb: number, lift: number, edgeLift: number, color: ColorLike, free: Free): void {
  const { g } = k;
  if (x1 - x0 < 1e-3 || zb - za < 1e-3) return;
  const mx = Math.min(0.04, (x1 - x0) / 3);
  const mz = Math.min(0.04, (zb - za) / 3);
  const xs = [x0, x0 + mx, x1 - mx, x1];
  const zs = [za, za + mz, zb - mz, zb];
  const out = (i: number, j: number) => (i === 0 && free.x0) || (i === 3 && free.x1) || (j === 0 && free.za) || (j === 3 && free.zb);
  const top = (i: number, j: number) => surf(g, zs[j]) + (out(i, j) ? edgeLift : lift) / g.cosP;
  // Thin at the dressed edges, so only a sliver of edge shows over the tiles.
  const below = (i: number, j: number) => surf(g, zs[j]) - (out(i, j) ? 0.014 : 0.035) / g.cosP;
  const V = (i: number, y: number, j: number) => new THREE.Vector3(xs[i], y, zs[j]);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      put(
        k,
        hexahedron([
          V(i, below(i, j), j),
          V(i + 1, below(i + 1, j), j),
          V(i + 1, below(i + 1, j + 1), j + 1),
          V(i, below(i, j + 1), j + 1),
          V(i, top(i, j), j),
          V(i + 1, top(i + 1, j), j),
          V(i + 1, top(i + 1, j + 1), j + 1),
          V(i, top(i, j + 1), j + 1),
        ]),
        'mortar',
        color,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

interface CourseOpts {
  /** Slope-local Z of the lowest course's tail, and the course gauge. */
  tail0: number;
  gauge: number;
  /** Courses whose tail is above this Z are not laid. */
  minZ: number;
  /** Tilt of each tile (tail lifted over the course below); defaults to the style's. */
  tilt?: number;
  /** Hung on a wall: no tile ever shows its back. */
  hung?: boolean;
}

/**
 * Courses of tiles in a slope frame (X along the courses, Y out of the
 * surface, Z down the slope), staggered, each tile clipped to the convex
 * `region` in (X, Z). Tile heads rest at Y = yHead.
 */
function layTiles(k: Kit, frame: THREE.Matrix4, region: V2[], t: TileSpec, yHead: number, o: CourseOpts, rng: Rng): void {
  if (region.length < 3) return;
  const xs = region.map((p) => p[0]);
  const zs = region.map((p) => p[1]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);
  const tilt = o.tilt ?? Math.atan2(tileRise(t), t.length);
  const nominal = t.width * t.gauge;
  let prev: number[] = [];
  for (let j = 0; j < 400; j++) {
    const tail = o.tail0 - j * o.gauge;
    if (tail < zMin || tail < o.minZ) break;
    if (tail - t.length > zMax) continue;
    const joints = courseJoints(xMin, xMax, t, j % 2 === 1, prev, rng);
    prev = joints;
    for (let i = 0; i + 1 < joints.length; i++) {
      const x0 = joints[i] + t.gap / 2;
      const x1 = joints[i + 1] - t.gap / 2;
      const w = x1 - x0;
      if (w < 0.02) continue;
      const xc = (x0 + x1) / 2;
      const len = t.length * (1 + rng.jitter(0.02));
      const tl = tail + rng.jitter(0.006);
      const head = tl - len;
      const outline = tileOutline(t.kind, w, len, rng);
      const foot = clipConvex(outline.map(([x, z]) => [x + xc, z + head] as V2), region);
      if (foot.length < 3) continue;
      const area = polyArea(foot);
      if (area < Math.max(0.0015, 0.08 * nominal)) continue;
      // Only the lowest course can show its underside (and never on a wall).
      const mesh = tileMesh(t.kind, foot.map(([x, z]) => [x - xc, z - head] as V2), len, t.thickness, j === 0 && !o.hung);
      if (!mesh) continue;
      const m = mul(frame, rot(xc, yHead, head, -tilt + rng.jitter(0.008), rng.jitter(0.02), rng.jitter(0.012)));
      k.tiles.add(mesh, m, k.look.tiles.pick(rng));
    }
  }
}

/** Joint positions (incl. both ends) of one course: staggered grid, or random widths clear of the joints below. */
function courseJoints(x0: number, x1: number, t: TileSpec, odd: boolean, prev: number[], rng: Rng): number[] {
  const out = [x0];
  if (!t.irregular) {
    const n = Math.max(1, Math.round((x1 - x0) / t.width));
    const w = (x1 - x0) / n;
    for (let k = 1; k <= n; k++) {
      const x = x0 + (k - (odd ? 0.5 : 0)) * w + rng.jitter(0.03 * w);
      if (x - x0 < 0.4 * w || x1 - x < 0.4 * w) continue;
      out.push(x);
    }
  } else {
    let x = x0;
    for (;;) {
      let next = x + t.width * rng.range(0.65, 1.35);
      for (let tries = 0; tries < 3 && prev.some((p) => Math.abs(p - next) < 0.22 * t.width); tries++) next += 0.25 * t.width;
      if (x1 - next < 0.45 * t.width) break;
      out.push(next);
      x = next;
    }
  }
  out.push(x1);
  return out;
}

/** Outline of a tile in its own (x, z) plane: x across, z from head (0) to tail (len). */
function tileOutline(kind: RoofCovering, w: number, len: number, rng: Rng): V2[] {
  const hw = w / 2;
  const j = () => rng.jitter(0.002);
  const pts: V2[] = [
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
      arc(Math.min(len * 0.35, w * 0.34), 2.6, 4);
      break;
    case 'fish':
      arc(Math.min(len * 0.45, hw), 2, 4);
      break;
    case 'slate': {
      const r = Math.min(0.035, w * 0.22, len * 0.3);
      pts.push([hw, len - r], [hw - r * 0.3, len - r * 0.3], [hw - r, len], [-hw + r, len], [-hw + r * 0.3, len - r * 0.3], [-hw, len - r]);
      break;
    }
    case 'shingle': {
      const skew = rng.jitter(Math.min(0.02, len * 0.05));
      const r = Math.min(0.01, w * 0.1);
      pts.push([hw, len + skew - r], [hw - r, len + skew], [-hw + r, len - skew], [-hw, len - skew - r]);
      break;
    }
  }
  return pts;
}

/**
 * A thin pillowy plate over a convex outline (x, z): bottom ring, slightly
 * inset top ring and centre fans, with hand-set normals (like the roof's).
 * Shingles are thicker towards the tail (z = len).
 */
function tileMesh(kind: RoofCovering, outline: V2[], len: number, th: number, bottom: boolean): RawMesh | null {
  let pts = dedupe(outline);
  if (pts.length < 3) return null;
  // Counter-clockwise seen from +Y (negative shoelace sum in x/z).
  const shoelace = pts.reduce((s, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0);
  if (shoelace > 0) pts = pts.slice().reverse();
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cz = pts.reduce((s, p) => s + p[1], 0) / n;
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  const small = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  const inset = Math.min(0.01, small * 0.12);
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
  const outward = pts.map((p, i) => {
    const a = pts[(i + n - 1) % n];
    const c = pts[(i + 1) % n];
    const l1 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1;
    const l2 = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1;
    const ox = -(p[1] - a[1]) / l1 - (c[1] - p[1]) / l2;
    const oz = (p[0] - a[0]) / l1 + (c[0] - p[0]) / l2;
    const l = Math.hypot(ox, oz) || 1;
    return [ox / l, oz / l];
  });
  const bottomC = vert(cx, 0, cz, 0, -1, 0);
  const bottomRing = pts.map((p, i) => vert(p[0], 0, p[1], outward[i][0], -0.35, outward[i][1]));
  const top = pts.map((p, i) => {
    const dx = cx - p[0];
    const dz = cz - p[1];
    const l = Math.hypot(dx, dz) || 1;
    return vert(p[0] + (dx / l) * inset, thick(p[1]), p[1] + (dz / l) * inset, outward[i][0] * 0.55, 1, outward[i][1] * 0.55);
  });
  const topC = vert(cx, thick(cz) * 1.04, cz, 0, 1, 0);
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    idx.push(topC, top[i], top[i2]);
    if (bottom) idx.push(bottomC, bottomRing[i2], bottomRing[i]);
    idx.push(bottomRing[i], bottomRing[i2], top[i2]);
    idx.push(bottomRing[i], top[i2], top[i]);
  }
  return { pos, nor, idx };
}

/** Indexed triangles with per-vertex normals, in local coordinates. */
interface RawMesh {
  pos: number[];
  nor: number[];
  idx: number[];
}

/** Collects many small pieces into one geometry per colour bucket. */
class PieceBatch {
  private readonly pos: number[][] = [];
  private readonly nor: number[][] = [];
  private readonly nm = new THREE.Matrix3();

  constructor(buckets: number) {
    for (let i = 0; i < buckets; i++) {
      this.pos.push([]);
      this.nor.push([]);
    }
  }

  add(mesh: RawMesh, m: THREE.Matrix4, bucket: number): void {
    const P = this.pos[bucket];
    const N = this.nor[bucket];
    const e = m.elements;
    const n = this.nm.getNormalMatrix(m).elements;
    for (const i of mesh.idx) {
      const x = mesh.pos[i * 3];
      const y = mesh.pos[i * 3 + 1];
      const z = mesh.pos[i * 3 + 2];
      P.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      const nx = mesh.nor[i * 3];
      const ny = mesh.nor[i * 3 + 1];
      const nz = mesh.nor[i * 3 + 2];
      const tx = n[0] * nx + n[3] * ny + n[6] * nz;
      const ty = n[1] * nx + n[4] * ny + n[7] * nz;
      const tz = n[2] * nx + n[5] * ny + n[8] * nz;
      const l = Math.hypot(tx, ty, tz) || 1;
      N.push(tx / l, ty / l, tz / l);
    }
  }

  /** Hand each non-empty bucket to the builder as one uniformly coloured geometry (placed by `m`). */
  flush(b: PartBuilder, mat: MatKey, colors: THREE.Color[], m: THREE.Matrix4): void {
    this.pos.forEach((P, i) => {
      if (!P.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor[i], 3));
      b.add(g, mat, colors[i], m);
    });
  }
}

// ---------------------------------------------------------------------------
// Flower-box foliage
// ---------------------------------------------------------------------------

type BlobKind = 'clump' | 'sprig' | 'bud';
const blobCache = new Map<BlobKind, THREE.BufferGeometry[]>();

function blobVariants(kind: BlobKind): THREE.BufferGeometry[] {
  let list = blobCache.get(kind);
  if (!list) {
    list = [0, 1, 2].map((seed) => {
      const base = kind === 'clump' ? new THREE.SphereGeometry(1, 8, 6) : new THREE.IcosahedronGeometry(1, 0);
      base.deleteAttribute('normal');
      base.deleteAttribute('uv');
      return lumpify(mergeVertices(base), kind === 'clump' ? 0.14 : kind === 'bud' ? 0.1 : 0.18, seed + 7);
    });
    blobCache.set(kind, list);
  }
  return list;
}

function blob(k: Kit, F: THREE.Matrix4, mat: MatKey, color: ColorLike, centre: THREE.Vector3, radius: number, scale: THREE.Vector3, kind: BlobKind, rng: Rng): void {
  const variants = blobVariants(kind);
  const g = variants[rng.int(0, variants.length - 1)];
  const spin = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rng.range(0, 6.28), rng.range(0, 6.28), 0));
  const m = new THREE.Matrix4()
    .makeTranslation(centre.x, centre.y, centre.z)
    .multiply(new THREE.Matrix4().makeScale(radius * scale.x, radius * scale.y, radius * scale.z))
    .multiply(spin);
  put(k, g, mat, color, mul(F, m));
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type V2 = [number, number];

function rect(u0: number, u1: number, y0: number, y1: number): V2[] {
  return [
    [u0, y0],
    [u1, y0],
    [u1, y1],
    [u0, y1],
  ];
}

/** Matrix from position and XYZ Euler rotation. */
function rot(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z);
}

/** Keep the part of a polygon where nx·x + ny·y ≤ d (Sutherland–Hodgman step). */
function clipHalf(poly: V2[], nx: number, ny: number, d: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = nx * p[0] + ny * p[1] - d;
    const dq = nx * q[0] + ny * q[1] - d;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Clip a polygon to a convex region (either winding). */
function clipConvex(poly: V2[], region: V2[]): V2[] {
  if (region.length < 3) return [];
  const ccw = signedArea(region) > 0;
  let out = poly;
  for (let i = 0; i < region.length && out.length >= 3; i++) {
    const p = region[i];
    const q = region[(i + 1) % region.length];
    // Inside is to the left of p → q for a CCW region.
    let nx = -(q[1] - p[1]);
    let ny = q[0] - p[0];
    if (!ccw) {
      nx = -nx;
      ny = -ny;
    }
    out = clipHalf(out, -nx, -ny, -(nx * p[0] + ny * p[1]));
  }
  return out.length >= 3 ? out : [];
}

function signedArea(p: V2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

function polyArea(p: V2[]): number {
  return Math.abs(signedArea(p));
}

function perimeter(p: V2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    s += Math.hypot(q[0] - p[i][0], q[1] - p[i][1]);
  }
  return s;
}

/** Drop consecutive (near-)duplicate vertices. */
function dedupe(p: V2[]): V2[] {
  const out: V2[] = [];
  for (const v of p) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(v[0] - last[0], v[1] - last[1]) > 1e-5) out.push(v);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-5) out.pop();
  return out;
}

/** Offset a CCW polygon inwards by c (mitred; sharp corners limited). */
function insetPoly(p: V2[], c: number): V2[] {
  const n = p.length;
  return p.map((v, i) => {
    const prev = p[(i - 1 + n) % n];
    const next = p[(i + 1) % n];
    const l1 = Math.hypot(v[0] - prev[0], v[1] - prev[1]) || 1;
    const l2 = Math.hypot(next[0] - v[0], next[1] - v[1]) || 1;
    const n1x = -(v[1] - prev[1]) / l1;
    const n1y = (v[0] - prev[0]) / l1;
    const n2x = -(next[1] - v[1]) / l2;
    const n2y = (next[0] - v[0]) / l2;
    const k = Math.max(0.25, 1 + n1x * n2x + n1y * n2y);
    return [v[0] + ((n1x + n2x) * c) / k, v[1] + ((n1y + n2y) * c) / k] as V2;
  });
}

/**
 * Prism over a convex polygon (x, y) from z = z0 to z = z1. The rim of the
 * front cap (z1) is cut by a small chamfer whose normals blend from the side
 * to the cap, so it shades like a rounded edge (20 triangles for a box).
 */
function prism(poly: V2[], z0: number, z1: number, chamfer: number): THREE.BufferGeometry | null {
  let pts = dedupe(poly);
  if (pts.length < 3) return null;
  let area = signedArea(pts);
  if (Math.abs(area) < 1e-7 || !(z1 > z0)) return null;
  if (area < 0) {
    pts = pts.slice().reverse();
    area = -area;
  }
  const cf = Math.max(0, Math.min(chamfer, (0.8 * area) / perimeter(pts), (z1 - z0) * 0.45));
  const front = cf > 0 ? insetPoly(pts, cf) : pts;
  const pos: number[] = [];
  const nor: number[] = [];
  type V = [number, number, number];
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const tri = (a: V, b: V, c: V, na: V, nb: V, nc: V) => {
    va.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    vb.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    va.cross(vb);
    if (va.x * (na[0] + nb[0] + nc[0]) + va.y * (na[1] + nb[1] + nc[1]) + va.z * (na[2] + nb[2] + nc[2]) < 0) {
      [b, c] = [c, b];
      [nb, nc] = [nc, nb];
    }
    pos.push(...a, ...b, ...c);
    nor.push(...na, ...nb, ...nc);
  };
  const faces = THREE.ShapeUtils.triangulateShape(
    pts.map(([x, y]) => new THREE.Vector2(x, y)),
    [],
  );
  const Fn: V = [0, 0, 1];
  const Bn: V = [0, 0, -1];
  for (const [i, j, k] of faces) {
    tri([front[i][0], front[i][1], z1], [front[j][0], front[j][1], z1], [front[k][0], front[k][1], z1], Fn, Fn, Fn);
    tri([pts[i][0], pts[i][1], z0], [pts[j][0], pts[j][1], z0], [pts[k][0], pts[k][1], z0], Bn, Bn, Bn);
  }
  const zs1 = z1 - cf;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const p = pts[i];
    const q = pts[j];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const o: V = [(q[1] - p[1]) / len, -(q[0] - p[0]) / len, 0];
    tri([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], zs1], o, o, o);
    tri([p[0], p[1], z0], [q[0], q[1], zs1], [p[0], p[1], zs1], o, o, o);
    if (cf > 0) {
      const fi = front[i];
      const fj = front[j];
      tri([p[0], p[1], zs1], [q[0], q[1], zs1], [fj[0], fj[1], z1], o, o, Fn);
      tri([p[0], p[1], zs1], [fj[0], fj[1], z1], [fi[0], fi[1], z1], o, Fn, Fn);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** A slab over a polygon in a slope frame's (X, Z), from Y = y0 to y1 (chamfered top edges). */
function slabXZ(poly: V2[], y0: number, y1: number): THREE.BufferGeometry | null {
  // Prism (a, b, c) → frame (X = a, Y = c, Z = -b): a proper rotation.
  const g = prism(
    poly.map(([x, z]) => [x, -z] as V2),
    y0,
    y1,
    Math.min(0.006, (y1 - y0) * 0.4),
  );
  if (!g) return null;
  return g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)));
}

/** A prism over a (z, y) profile, extruded along x from x0 to x1. */
function prismX(profile: V2[], x0: number, x1: number, chamfer: number): THREE.BufferGeometry | null {
  // Prism (a, b, c) → (x = c, y = b, z = -a): a proper rotation.
  const g = prism(
    profile.map(([z, y]) => [-z, y] as V2),
    x0,
    x1,
    chamfer,
  );
  if (!g) return null;
  return g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)));
}

/** Closed hexahedron from 8 corners (bottom 4, then top 4, same order), flat-shaded. */
function hexahedron(v: THREE.Vector3[]): THREE.BufferGeometry {
  const faces = [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0],
  ];
  const centre = v.reduce((a, b) => a.clone().add(b), new THREE.Vector3()).multiplyScalar(1 / 8);
  const pos: number[] = [];
  for (const [a, b, c, d] of faces) {
    for (const [p, q, r] of [
      [a, b, c],
      [a, c, d],
    ]) {
      const n = v[q].clone().sub(v[p]).cross(v[r].clone().sub(v[p]));
      const mid = v[p].clone().add(v[q]).add(v[r]).multiplyScalar(1 / 3);
      const order = n.dot(mid.sub(centre)) >= 0 ? [p, q, r] : [p, r, q];
      for (const i of order) pos.push(v[i].x, v[i].y, v[i].z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A colour with its HSL lightness shifted by dl. */
function shade(color: ColorLike, dl: number): THREE.Color {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return c.setHSL(hsl.h, hsl.s, clamp(hsl.l + dl, 0.04, 0.92));
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
