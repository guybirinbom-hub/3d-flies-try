import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PartBuilder, lumpify, mat4, mix, mul, vary, type ColorLike, type MatKey } from '../builder';
import { OUTWARD, wallExplode } from '../explode';
import type { PartDef } from '../house';
import type { HouseLayout, Opening, WallSpec } from '../layout';
import type { Palette } from '../params';
import type { Rng } from '../rng';

/**
 * Windows and doors: everything inside each opening's `surround` (frames,
 * glazing, door leaf and ironwork, lintel, sill, dressed-stone jambs or
 * timber posts), plus the things that sit in front of the wall: open
 * shutters, flower boxes and the hood over the front door.
 *
 * All geometry is built in wall-local (u, y, w) coordinates and placed with
 * `wall.frame`; one builder per wall so the exploded view peels a wall's
 * openings off together.
 */
export const part: PartDef = {
  name: 'openings',
  label: 'Windows & doors',
  explode: [0, 0, 0],
  build: ({ layout, rng }) => {
    const pal = layout.params.palette;
    const look = chooseLook(layout, rng.fork('look'));
    const out: PartBuilder[] = [];
    for (const wall of layout.walls) {
      if (!wall.openings.length) continue;
      const b = new PartBuilder(`openings:${wall.id}`);
      b.explode = wallExplode(wall, OUTWARD.openings);
      const c: Ctx = { b, wall, layout, pal, look, rng: rng.fork(wall.id) };
      const shutterPlan = planShutters(wall);
      for (const o of wall.openings) {
        buildSurround(c, o);
        if (o.kind === 'door') buildDoor(c, o);
        else buildWindow(c, o);
        const leaves = shutterPlan.get(o.id);
        if (leaves) buildShutters(c, o, leaves);
        if (o.flowerBox && o.sill) buildFlowerBox(c, o);
        if (o === layout.door) buildCanopy(c, o);
      }
      out.push(b);
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Dimensions (metres) and fixed colours
// ---------------------------------------------------------------------------

/** Mortar joint between dressed stones. */
const JOINT = 0.012;
/** Jambs, lintels and arch stones reach this far into the hole, so they form its reveal. */
const LIP = 0.012;
const WINDOW_FRAME = 0.075;
const ATTIC_FRAME = 0.065;
const DOOR_FRAME = 0.09;
const GLAZING_BAR = 0.034;
/** Gap between an opening's edge and the hinge side of an open shutter. */
const HINGE_GAP = 0.025;
/** Back face of open shutters (w-budget: ≥ 0.075). */
const SHUTTER_BACK = 0.08;
const SHUTTER_BOARD = 0.024;

const IRON = '#3a3430';
const GLASS = '#2f4152';
const GLASS_SKY = '#7d98ad';
const SOIL = '#4b3727';
const LEAF_GREENS = ['#5d8c3a', '#4f7d35', '#6d9a45', '#557f3c'];

// ---------------------------------------------------------------------------
// Context and house-wide look
// ---------------------------------------------------------------------------

/** Design choices made once per house, so every opening matches. */
interface Look {
  glazing: 'cross' | 'sixPane';
  shutterStyle: 'braced' | 'heart' | 'louvred';
  doorColor: THREE.Color;
  doorHingeLeft: boolean;
  doorWindow: boolean;
  boxColor: THREE.Color;
  dressedStone: THREE.Color;
  /**
   * 1 for ordinary houses, down to 0.55 for very large ones, thinning the
   * planting in flower boxes so big houses stay within the triangle budget.
   */
  detail: number;
}

interface Ctx {
  b: PartBuilder;
  wall: WallSpec;
  layout: HouseLayout;
  pal: Palette;
  look: Look;
  /** Private stream for this wall. */
  rng: Rng;
}

/** Axis-aligned box in wall-local coordinates. */
interface Extent {
  u: [number, number];
  y: [number, number];
  w: [number, number];
}

function chooseLook(layout: HouseLayout, rng: Rng): Look {
  const pal = layout.params.palette;
  const painted = rng.chance(0.4);
  return {
    glazing: rng.chance(0.55) ? 'cross' : 'sixPane',
    shutterStyle: rng.weighted([
      ['braced', 5],
      ['heart', 3],
      ['louvred', 3],
    ] as const),
    doorColor: painted ? mix(pal.shutter, '#3b2a1e', 0.18) : new THREE.Color(pal.wood),
    doorHingeLeft: rng.chance(0.5),
    doorWindow: rng.chance(0.45),
    boxColor: rng.chance(0.5) ? new THREE.Color(pal.wood) : mix(pal.shutter, pal.wood, 0.25),
    dressedStone: mix(pal.stone, '#efe8dc', 0.3),
    detail: clamp(30 / Math.max(1, layout.openings.length), 0.55, 1),
  };
}

// ---------------------------------------------------------------------------
// Surround: jambs, lintel / arch, sill, threshold
// ---------------------------------------------------------------------------

/**
 * Dressed-stone surround (jambs, stone lintel or arch, stone sill)? Always on
 * stone walls; on plaster walls arched heads are exposed stone too, while flat
 * heads get a timber beam. Timber walls get posts and beams.
 */
function isDressed(wall: WallSpec, o: Opening): boolean {
  return wall.style === 'stone' || (wall.style === 'plaster' && o.arched);
}

function buildSurround(c: Ctx, o: Opening): void {
  const style = c.wall.style;
  const dressed = isDressed(c.wall, o);
  if (style === 'timber') {
    timberPosts(c, o);
    timberLintel(c, o);
  } else if (dressed) {
    stoneJambs(c, o);
    if (o.arched) archStones(c, o, style === 'stone');
    else stoneLintel(c, o);
  } else {
    timberLintel(c, o);
  }
  if (o.sill) {
    if (dressed) stoneSill(c, o);
    else woodSill(c, o);
  }
  if (o.kind === 'door') threshold(c, o);
}

/** Dressed stones up both sides of the opening, alternating long and short. */
function stoneJambs(c: Ctx, o: Opening): void {
  const { rng } = c;
  const yA = (o.sill ? o.sill.y0 : o.y0) + 0.02;
  const yB = o.arched ? springY(o) - JOINT / 2 : o.y1 - LIP - JOINT;
  const room = o.u0 - o.lintel.u0; // usable width beside the hole
  const courses = Math.max(1, Math.round((yB - yA) / 0.27));
  const heights = randomSplit(yB - yA, courses, 0.25, rng);
  let y = yA;
  for (let i = 0; i < courses; i++) {
    const y0 = y;
    const y1 = y + heights[i] - (i < courses - 1 ? JOINT : 0);
    y += heights[i];
    for (const side of [-1, 1] as const) {
      const width = (i % 2 === 0 ? room - 0.006 : room * 0.78) - rng.range(0, 0.012);
      const u = side < 0 ? ([o.u0 - width, o.u0 + LIP] as [number, number]) : ([o.u1 - LIP, o.u1 + width] as [number, number]);
      const color = vary(c.look.dressedStone, rng, 0.05, 0.03, 0.006);
      block(c, 'stone', color, { u, y: [y0, y1], w: [-0.045, 0.05 + rng.jitter(0.006)] }, 0.022, rng.jitter(0.006));
    }
  }
}

/** A single dressed stone lintel over a flat-headed opening. */
function stoneLintel(c: Ctx, o: Opening): void {
  const { rng } = c;
  const L = o.lintel;
  const color = vary(c.look.dressedStone, rng, 0.04, 0.03, 0.005);
  block(
    c,
    'stone',
    color,
    { u: [L.u0 + 0.004, L.u1 - 0.004], y: [o.y1 - LIP, L.y1 - 0.006 - rng.range(0, 0.015)], w: [-0.045, 0.064] },
    0.026,
    rng.jitter(0.004),
  );
}

/**
 * Voussoirs with a keystone around an arched head. With `fillSpandrels` the
 * corners between the ring and the lintel rectangle get stones too, so the
 * whole surround reads as masonry on stone walls.
 */
function archStones(c: Ctx, o: Opening, fillSpandrels: boolean): void {
  const { rng } = c;
  const { uc, r } = archOf(o);
  const spring = springY(o);
  const rIn = r - LIP;
  const depth = clamp(0.1 + 0.12 * r, 0.13, 0.165);
  const rOut = rIn + depth;
  const L = o.lintel;
  const clip = { u0: L.u0 + 0.004, u1: L.u1 - 0.004, y1: L.y1 - 0.006 };
  const n = Math.max(5, 2 * Math.floor((Math.PI * (rIn + depth / 2)) / 0.2 / 2) + 1);
  const key = (n - 1) / 2;
  const outerOf = (i: number) => (i === key ? rOut + 0.03 : rOut + (i % 2 === 0 ? 0 : -0.012));

  for (let i = 0; i < n; i++) {
    const a0 = (Math.PI * i) / n;
    const a1 = (Math.PI * (i + 1)) / n;
    const pts = sectorStone(uc, spring, a0, a1, rIn, outerOf(i), clip);
    if (!pts) continue;
    const color = vary(i === key ? mix(c.look.dressedStone, '#ffffff', 0.08) : c.look.dressedStone, rng, 0.05, 0.03, 0.006);
    slab(c, 'stone', color, new THREE.Shape(roundPolygon(pts, 0.012, 1)), -0.045, i === key ? 0.07 : 0.058 + rng.jitter(0.004), 0.016);
  }
  if (!fillSpandrels) return;

  // Spandrels: the corners between the ring and the rectangle, laid as
  // rounded field stones in rough horizontal courses that hug the ring.
  const aKey0 = (Math.PI * key) / n;
  const aKey1 = (Math.PI * (key + 1)) / n;
  const rFill = rOut + JOINT;
  for (const [a0, a1] of [
    [0, aKey0],
    [aKey1, Math.PI],
  ]) {
    const region = sectorStone(uc, spring, a0, a1, rFill, Infinity, clip, 0.05);
    if (!region) continue;
    let y = spring;
    while (y < clip.y1 - 0.05) {
      const top = Math.min(clip.y1, y + rng.range(0.17, 0.26));
      const band = clipPolygon(region, (p) => p.y - y, (p) => top - JOINT / 2 - p.y);
      y = top + JOINT / 2;
      const [minU, maxU] = extentU(band);
      // Wide courses get a vertical joint.
      const pieces =
        maxU - minU > 0.42
          ? (() => {
              const cut = minU + (maxU - minU) * rng.range(0.4, 0.6);
              return [clipPolygon(band, (p) => cut - JOINT / 2 - p.x), clipPolygon(band, (p) => p.x - cut - JOINT / 2)];
            })()
          : [band];
      for (const piece of pieces) {
        if (polygonArea(piece) < 0.004 || extentU(piece)[1] - extentU(piece)[0] < 0.05) continue;
        const color = vary(c.pal.stone, rng, 0.07, 0.05, 0.012);
        slab(c, 'stone', color, new THREE.Shape(roundPolygon(piece, 0.03, 1)), -0.04, 0.05 + rng.jitter(0.008), 0.018);
      }
    }
  }
}

/** Wooden posts either side of an opening in a half-timbered wall. */
function timberPosts(c: Ctx, o: Opening): void {
  const { rng } = c;
  const yA = o.sill ? o.sill.y0 + 0.01 : o.y0;
  const yB = o.y1 - LIP + 0.01; // tucked under the lintel beam
  const width = Math.min(0.13, o.u0 - o.lintel.u0 - 0.01);
  for (const side of [-1, 1] as const) {
    const u: [number, number] = side < 0 ? [o.u0 - width, o.u0 + LIP] : [o.u1 - LIP, o.u1 + width];
    block(c, 'timber', vary(c.pal.timber, rng, 0.04, 0.03, 0.005), { u, y: [yA, yB], w: [-0.03, 0.042] }, 0.018);
  }
}

/** A chunky timber beam over the opening (also above arches on timber walls). */
function timberLintel(c: Ctx, o: Opening): void {
  const { rng } = c;
  const L = o.lintel;
  block(
    c,
    'timber',
    vary(c.pal.timber, rng, 0.04, 0.03, 0.005),
    { u: [L.u0 + 0.004, L.u1 - 0.004], y: [o.y1 - LIP, L.y1 - 0.008], w: [-0.04, 0.05] },
    0.02,
    rng.jitter(0.005),
  );
}

/** Bottom of the sill actually built (flower boxes hang just below it). */
function sillBottom(c: Ctx, o: Opening): number {
  // Stone sills and timber-wall sills fill the layout's sill rect; plaster walls get a thinner board.
  if (isDressed(c.wall, o) || c.wall.style === 'timber') return o.sill!.y0 + 0.006;
  return o.y0 - 0.075;
}

/** Stone sill: runs back into the hole up to the frame and projects to w ≈ 0.12. */
function stoneSill(c: Ctx, o: Opening): void {
  const { rng } = c;
  const s = o.sill!;
  const color = vary(c.look.dressedStone, rng, 0.04, 0.03, 0.005);
  const e: Extent = { u: [s.u0, s.u1], y: [sillBottom(c, o), o.y0 + 0.022], w: [o.recess + 0.035, 0.12] };
  blockTilted(c, 'stone', color, e, 0.025, 0.045);
}

/** Wooden sill board (with a beam-deep body on timber walls). */
function woodSill(c: Ctx, o: Opening): void {
  const { rng } = c;
  const s = o.sill!;
  const color = vary(c.wall.style === 'timber' ? c.pal.timber : c.pal.wood, rng, 0.04, 0.03, 0.006);
  const e: Extent = { u: [s.u0, s.u1], y: [sillBottom(c, o), o.y0 + 0.022], w: [o.recess + 0.035, 0.11] };
  blockTilted(c, 'wood', color, e, 0.02, 0.05);
}

/** Stone threshold strip across the bottom of a door hole. */
function threshold(c: Ctx, o: Opening): void {
  const color = vary(mix(c.pal.stone, '#8a8178', 0.25), c.rng, 0.04, 0.03, 0.005);
  block(c, 'stone', color, { u: [o.u0 - 0.03, o.u1 + 0.03], y: [o.y0 - 0.03, o.y0 + 0.03], w: [o.recess - 0.08, 0.035] }, 0.015);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function buildWindow(c: Ctx, o: Opening): void {
  const { rng } = c;
  const attic = o.kind === 'attic';
  const fw = attic ? ATTIC_FRAME : WINDOW_FRAME;
  const R = o.recess;
  const trim = vary(c.pal.trim, rng, 0.025, 0.02, 0.004);

  // Frame: a ring following the hole, slightly embedded in the reveal.
  const frame = new THREE.Shape(headOutline(o, -0.01, o.y0 - 0.01));
  frame.holes.push(new THREE.Path(headOutline(o, fw, o.y0 + fw)));
  slab(c, 'trim', trim, frame, R - 0.055, R + 0.035, 0.01);

  // Glass behind the glazing bars (behind the frame front).
  const glass = vary(GLASS, rng, 0.04, 0.05, 0.01);
  const ui0 = o.u0 + fw;
  const ui1 = o.u1 - fw;
  const yi0 = o.y0 + fw;
  const yi1 = o.arched ? springY(o) : o.y1 - fw;
  const barW: [number, number] = [R - 0.02, R + 0.014];
  const bar = (e: { u: [number, number]; y: [number, number] }) => block(c, 'trim', trim, { ...e, w: barW }, 0.008);
  const barColor = mix(trim, '#000000', 0.03);

  if (o.arched) {
    const pane = new THREE.Shape(headOutline(o, fw - 0.012, yi0 - 0.012));
    addGlass(c, extrudeSoft(pane, R - 0.03, R - 0.022, 0), glass, o);
    const { uc, r } = archOf(o);
    const ri = r - fw;
    // Mullion up to the crown, transom at the springing line, two fan bars.
    bar({ u: [uc - GLAZING_BAR / 2, uc + GLAZING_BAR / 2], y: [yi0 - 0.01, yi1 + ri + 0.01] });
    bar({ u: [ui0 - 0.01, ui1 + 0.01], y: [yi1 - GLAZING_BAR / 2, yi1 + GLAZING_BAR / 2] });
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4]) {
      const len = ri + 0.01;
      const m = at(c.wall, uc + (Math.cos(a) * len) / 2, yi1 + (Math.sin(a) * len) / 2, (barW[0] + barW[1]) / 2, 0, 0, a);
      c.b.add(softBox(len, GLAZING_BAR * 0.9, barW[1] - barW[0], 0.008), 'trim', barColor, m);
    }
    return;
  }

  // Rectangular: bars split the light into panes; each pane is its own pane of glass.
  const cols = [ui0, (ui0 + ui1) / 2, ui1];
  const rowFractions = attic ? [0.5] : c.look.glazing === 'cross' ? [0.6] : [1 / 3, 2 / 3];
  const rows = [yi0, ...rowFractions.map((f) => yi0 + (yi1 - yi0) * f), yi1];
  for (let i = 0; i < cols.length - 1; i++) {
    for (let j = 0; j < rows.length - 1; j++) {
      const pane = vary(glass, rng, 0.02, 0.02, 0.004);
      const g = softBox(cols[i + 1] - cols[i] + 0.02, rows[j + 1] - rows[j] + 0.02, 0.008, 0);
      addGlass(c, g, pane, o, mat4((cols[i] + cols[i + 1]) / 2, (rows[j] + rows[j + 1]) / 2, R - 0.026));
    }
  }
  bar({ u: [cols[1] - GLAZING_BAR / 2, cols[1] + GLAZING_BAR / 2], y: [yi0 - 0.01, yi1 + 0.01] });
  for (const y of rows.slice(1, -1)) bar({ u: [ui0 - 0.01, ui1 + 0.01], y: [y - GLAZING_BAR / 2, y + GLAZING_BAR / 2] });
}

/**
 * Add glass (placed in wall-local space by `local`), lighter towards the top
 * of the opening like a reflected sky.
 */
function addGlass(c: Ctx, g: THREE.BufferGeometry, color: THREE.Color, o: Opening, local?: THREE.Matrix4): void {
  const sky = new THREE.Color(GLASS_SKY);
  const h = Math.max(0.1, o.y1 - o.y0);
  c.b.add(g, 'glass', color, local ? mul(c.wall.frame, local) : c.wall.frame, (p, _n, out) => {
    out.lerp(sky, 0.38 * clamp((p.y - o.y0) / h, 0, 1));
  });
}

// ---------------------------------------------------------------------------
// Door
// ---------------------------------------------------------------------------

function buildDoor(c: Ctx, o: Opening): void {
  const { rng, look } = c;
  const R = o.recess;
  const fw = DOOR_FRAME;

  // Frame: jambs and head (no bottom rail: the threshold is there).
  const outer = headOutline(o, -0.012, o.y0 - 0.01, 18);
  const inner = headOutline(o, fw, o.y0 - 0.01, 18).reverse();
  slab(c, 'timber', vary(c.pal.timber, rng, 0.04, 0.03, 0.005), new THREE.Shape([...outer, ...inner]), R - 0.06, R + 0.05, 0.012);

  // Leaf: planks over a dark backing board that shows through the grooves.
  const lu0 = o.u0 + fw - 0.02;
  const lu1 = o.u1 - fw + 0.02;
  const ly0 = o.y0 + 0.038;
  const { uc, r } = archOf(o);
  const rLeaf = r - fw + 0.02;
  const spring = springY(o);
  const leafTop = (u: number) =>
    o.arched ? spring + Math.sqrt(Math.max(0, rLeaf * rLeaf - (u - uc) * (u - uc))) : o.y1 - fw + 0.02;
  const straightTop = o.arched ? spring : leafTop(uc);

  const backing = mix(look.doorColor, '#20160f', 0.65);
  slab(c, 'wood', backing, new THREE.Shape(plankOutline(lu0, lu1, ly0, leafTop, 12)), R - 0.062, R - 0.038, 0);

  const planks = Math.max(4, Math.round((lu1 - lu0) / 0.17));
  const pw = (lu1 - lu0) / planks;
  for (let i = 0; i < planks; i++) {
    const a = lu0 + i * pw + 0.006;
    const b = lu0 + (i + 1) * pw - 0.006;
    const color = vary(look.doorColor, rng, 0.05, 0.03, 0.008);
    const bottom = ly0 + rng.range(0, 0.008);
    if (o.arched) {
      slab(c, 'wood', color, new THREE.Shape(plankOutline(a, b, bottom, leafTop, 4)), R - 0.046, R - 0.002, 0.006);
    } else {
      block(c, 'wood', color, { u: [a, b], y: [bottom, leafTop(a)], w: [R - 0.046, R - 0.002] }, 0.007);
    }
  }

  // Ironwork: two strap hinges, ring pull, key plate.
  const front = R - 0.002;
  const hingeU = look.doorHingeLeft ? lu0 + 0.02 : lu1 - 0.02;
  const dir = look.doorHingeLeft ? 1 : -1;
  const strapLen = (lu1 - lu0) * 0.68;
  for (const y of [ly0 + 0.3, straightTop - 0.24]) strapHinge(c, hingeU, y, dir, strapLen, front, 0.05);

  const latchU = look.doorHingeLeft ? lu1 - 0.15 : lu0 + 0.15;
  const handleY = o.y0 + 1.0;
  const iron = vary(IRON, rng, 0.03, 0.02, 0);
  block(c, 'metal', iron, { u: [latchU - 0.045, latchU + 0.045], y: [handleY - 0.055, handleY + 0.055], w: [front, front + 0.012] }, 0.006);
  const ring = new THREE.TorusGeometry(0.048, 0.009, 5, 14);
  c.b.add(ring, 'metal', iron, at(c.wall, latchU, handleY - 0.045, front + 0.026, -0.25, 0, 0));
  block(c, 'metal', iron, { u: [latchU - 0.018, latchU + 0.018], y: [handleY - 0.19, handleY - 0.13], w: [front, front + 0.008] }, 0.004);

  if (look.doorWindow) doorWindow(c, (lu0 + lu1) / 2, o.arched ? spring + 0.05 : straightTop - 0.54, front);
}

/** Small barred window let into the upper part of the door leaf. */
function doorWindow(c: Ctx, u: number, y: number, front: number): void {
  const hw = 0.13;
  const hh = 0.15;
  const frameColor = vary(c.pal.timber, c.rng, 0.03, 0.02, 0);
  c.b.add(softBox(hw * 2, hh * 2, 0.01, 0), 'glass', vary(GLASS, c.rng, 0.03, 0.03, 0.01), at(c.wall, u, y, front + 0.004));
  const t = 0.035;
  const w: [number, number] = [front, front + 0.03];
  block(c, 'wood', frameColor, { u: [u - hw - t, u + hw + t], y: [y + hh, y + hh + t], w }, 0.008);
  block(c, 'wood', frameColor, { u: [u - hw - t, u + hw + t], y: [y - hh - t, y - hh], w }, 0.008);
  block(c, 'wood', frameColor, { u: [u - hw - t, u - hw], y: [y - hh, y + hh], w }, 0.008);
  block(c, 'wood', frameColor, { u: [u + hw, u + hw + t], y: [y - hh, y + hh], w }, 0.008);
  const iron = vary(IRON, c.rng, 0.03, 0.02, 0);
  block(c, 'metal', iron, { u: [u - 0.01, u + 0.01], y: [y - hh, y + hh], w: [front + 0.006, front + 0.022] }, 0);
  block(c, 'metal', iron, { u: [u - hw, u + hw], y: [y - 0.01, y + 0.01], w: [front + 0.006, front + 0.022] }, 0);
}

/** Dark iron strap hinge with a pointed end, nail heads and a pintle knuckle. */
function strapHinge(c: Ctx, u: number, y: number, dir: 1 | -1, len: number, front: number, height: number): void {
  const iron = vary(IRON, c.rng, 0.04, 0.02, 0);
  const u1 = u + dir * len;
  block(c, 'metal', iron, { u: [Math.min(u, u1), Math.max(u, u1)], y: [y - height / 2, y + height / 2], w: [front, front + 0.01] }, 0.005);
  // Diamond tip.
  const d = height * 1.25;
  c.b.add(softBox(d, d, 0.01, 0.004), 'metal', iron, at(c.wall, u1, y, front + 0.005, 0, 0, Math.PI / 4));
  // Nail heads.
  for (let k = 1; k <= 3; k++) {
    block(c, 'metal', iron, nailAt(u + dir * len * (k / 4), y, front + 0.01), 0);
  }
  // Knuckle at the hinge edge.
  const knuckle = new THREE.CylinderGeometry(0.016, 0.016, height * 1.6, 6);
  c.b.add(knuckle, 'metal', iron, at(c.wall, u - dir * 0.02, y, front + 0.006));
}

function nailAt(u: number, y: number, w: number): Extent {
  const s = 0.009;
  return { u: [u - s, u + s], y: [y - s, y + s], w: [w - 0.002, w + 0.008] };
}

// ---------------------------------------------------------------------------
// Shutters
// ---------------------------------------------------------------------------

/** Widths of the left and right shutter leaves (0 = no leaf). */
type LeafPlan = [number, number];

/**
 * Decide leaf widths for every shuttered window on a wall. Leaves are ideally
 * half the window wide; where neighbouring windows are close, every leaf on
 * the wall shrinks to the same width so the facade stays regular (or the wall
 * gets no shutters when they would be too narrow). A leaf squeezed by the
 * door or a wall end is shrunk a little or dropped on its own. Leaves never
 * cover a neighbour's surround or leaves or run past the wall's ends.
 */
function planShutters(wall: WallSpec): Map<string, LeafPlan> {
  const endClear = 0.12;
  interface Side {
    room: number;
    /** Limited by another window (shared gap) rather than the door / a wall end. */
    shared: boolean;
  }
  const rooms = new Map<string, [Side, Side]>();
  let want = Infinity;
  for (const o of wall.openings) {
    if (!o.shutters) continue;
    want = Math.min(want, (o.u1 - o.u0) / 2 + 0.015);
    const oc = (o.u0 + o.u1) / 2;
    const left: Side = { room: o.u0 - HINGE_GAP - endClear, shared: false };
    const right: Side = { room: wall.length - endClear - (o.u1 + HINGE_GAP), shared: false };
    for (const q of wall.openings) {
      if (q === o || q.surround.y1 < o.y0 || q.surround.y0 > o.y1) continue;
      // A little extra room beside the door, where its hood and brackets are.
      const pad = q.kind === 'door' ? 0.15 : 0.04;
      const toLeft = (q.u0 + q.u1) / 2 < oc;
      // Free distance from the hinge line to the obstacle.
      let room = toLeft ? o.u0 - HINGE_GAP - (q.surround.u1 + pad) : q.surround.u0 - pad - (o.u1 + HINGE_GAP);
      if (q.shutters) room = Math.min(room, (toLeft ? o.u0 - q.u1 : q.u0 - o.u1) / 2 - 0.04 - HINGE_GAP);
      const side = toLeft ? left : right;
      if (room < side.room) {
        side.room = room;
        side.shared = q.kind !== 'door';
      }
    }
    rooms.set(o.id, [left, right]);
  }

  // One leaf width for the whole wall, set by the tightest gap between windows.
  let uniform = want;
  for (const sides of rooms.values()) for (const s of sides) if (s.shared) uniform = Math.min(uniform, s.room);
  const plan = new Map<string, LeafPlan>();
  if (!(uniform >= 0.5 * want)) return plan;
  for (const [id, sides] of rooms) {
    const [l, r] = sides.map((s) => (s.room >= uniform ? uniform : s.room >= 0.75 * uniform ? s.room : 0));
    if (l || r) plan.set(id, [l, r]);
  }
  return plan;
}

function buildShutters(c: Ctx, o: Opening, [left, right]: LeafPlan): void {
  const base = vary(c.pal.shutter, c.rng, 0.03, 0.03, 0.006);
  if (left > 0) shutterLeaf(c, o, -1, left, base);
  if (right > 0) shutterLeaf(c, o, 1, right, base);
}

/**
 * One open leaf lying flat against the wall. `side` -1 = left of the window
 * (hinged on its right edge), +1 = right.
 */
function shutterLeaf(c: Ctx, o: Opening, side: -1 | 1, width: number, base: THREE.Color): void {
  const { rng } = c;
  const hingeU = side < 0 ? o.u0 - HINGE_GAP : o.u1 + HINGE_GAP;
  const freeU = hingeU + side * width;
  const ua = Math.min(hingeU, freeU);
  const ub = Math.max(hingeU, freeU);
  const ya = o.y0 + 0.035;
  const yb = o.y1 - 0.01;
  const h = yb - ya;
  const back = SHUTTER_BACK;
  const front = back + SHUTTER_BOARD;
  const style = c.look.shutterStyle;

  if (style === 'louvred') {
    louvredLeaf(c, ua, ub, ya, yb, base);
  } else {
    const boards = clamp(Math.round(width / 0.115), 2, 5);
    const bw = width / boards;
    for (let i = 0; i < boards; i++) {
      const color = vary(base, rng, 0.04, 0.03, 0.006);
      const dy = rng.range(0, 0.012);
      block(c, 'wood', color, { u: [ua + i * bw + 0.004, ua + (i + 1) * bw - 0.004], y: [ya + dy, yb - rng.range(0, 0.01)], w: [back, front] }, 0);
    }
    // Two ledges, and either a Z-brace or a heart cut-out between them.
    const ledgeH = 0.085;
    const lowY = ya + Math.min(0.2, h * 0.15);
    const highY = yb - Math.min(0.2, h * 0.15);
    const ledge = mix(base, '#000000', 0.06);
    for (const y of [lowY, highY]) {
      block(c, 'wood', vary(ledge, rng, 0.03, 0.02, 0), { u: [ua + 0.02, ub - 0.02], y: [y - ledgeH / 2, y + ledgeH / 2], w: [front - 0.002, front + 0.017] }, 0);
    }
    if (style === 'braced') {
      // The brace rises from the hinge side's bottom ledge to the free side's top ledge.
      const p0 = new THREE.Vector2(hingeU + side * 0.07, lowY + ledgeH / 2 - 0.012);
      const p1 = new THREE.Vector2(freeU - side * 0.07, highY - ledgeH / 2 + 0.012);
      const len = p0.distanceTo(p1);
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const m = at(c.wall, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2, front + 0.007, 0, 0, ang);
      c.b.add(softBox(len, 0.07, 0.016, 0), 'wood', vary(ledge, rng, 0.03, 0.02, 0), m);
    } else if (h > 0.6 && width > 0.3) {
      // Heart cut-out: a dark heart just proud of the boards.
      const s = Math.min(width * 0.32, 0.13);
      const heart = extrudeSoft(heartShape((ua + ub) / 2, (lowY + highY) / 2 + h * 0.08, s), front - 0.004, front + 0.003, 0);
      c.b.add(heart, 'wood', mix(base, '#1d140e', 0.82), c.wall.frame);
    }
    // Strap hinges along the ledges.
    const iron = vary(IRON, rng, 0.03, 0.02, 0);
    for (const y of [lowY, highY]) {
      const tip = hingeU + side * width * 0.55;
      block(c, 'metal', iron, { u: [Math.min(hingeU, tip), Math.max(hingeU, tip)], y: [y - 0.016, y + 0.016], w: [front + 0.017, front + 0.024] }, 0);
    }
  }
  // Pintles on the wall at the hinge edge.
  for (const y of [ya + Math.min(0.2, h * 0.15), yb - Math.min(0.2, h * 0.15)]) {
    block(c, 'metal', vary(IRON, rng, 0.03, 0.02, 0), { u: [hingeU - 0.016, hingeU + 0.016], y: [y - 0.035, y + 0.035], w: [-0.01, front + 0.006] }, 0);
  }
}

/** Louvred leaf: stiles and rails with angled slats over a dark back panel. */
function louvredLeaf(c: Ctx, ua: number, ub: number, ya: number, yb: number, base: THREE.Color): void {
  const { rng } = c;
  const back = SHUTTER_BACK;
  const depth = 0.034;
  const stile = Math.min(0.06, (ub - ua) * 0.18);
  const rail = 0.075;
  const color = () => vary(base, rng, 0.03, 0.02, 0.004);
  const w: [number, number] = [back, back + depth];
  block(c, 'wood', color(), { u: [ua, ua + stile], y: [ya, yb], w }, 0);
  block(c, 'wood', color(), { u: [ub - stile, ub], y: [ya, yb], w }, 0);
  const midY = ya + (yb - ya) * 0.45;
  for (const y of [ya + rail / 2, midY, yb - rail / 2]) {
    block(c, 'wood', color(), { u: [ua + stile - 0.005, ub - stile + 0.005], y: [y - rail / 2, y + rail / 2], w: [w[0], w[1] - 0.004] }, 0);
  }
  block(c, 'wood', mix(base, '#1d140e', 0.6), { u: [ua + stile - 0.005, ub - stile + 0.005], y: [ya + rail, yb - rail], w: [back, back + 0.006] }, 0);
  const slat = mix(base, '#000000', 0.05);
  const slatLen = ub - ua - 2 * stile + 0.01;
  for (const [y0, y1] of [
    [ya + rail, midY - rail / 2],
    [midY + rail / 2, yb - rail],
  ]) {
    const n = Math.max(1, Math.floor((y1 - y0) / 0.062));
    const step = (y1 - y0) / n;
    for (let i = 0; i < n; i++) {
      const m = at(c.wall, (ua + ub) / 2, y0 + (i + 0.5) * step, back + depth / 2, -0.6, 0, 0);
      c.b.add(softBox(slatLen, 0.058, 0.008, 0), 'wood', slat, m);
    }
  }
}

/** Heart outline centred at (u, y) about `s` across. */
function heartShape(u: number, y: number, s: number): THREE.Shape {
  const pts: THREE.Vector2[] = [];
  const n = 16;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const z = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push(new THREE.Vector2(u + (x / 34) * s, y + (z / 34) * s));
  }
  return new THREE.Shape(pts);
}

// ---------------------------------------------------------------------------
// Flower boxes
// ---------------------------------------------------------------------------

function buildFlowerBox(c: Ctx, o: Opening): void {
  const { rng } = c;
  const s = o.sill!;
  const u0 = s.u0 + 0.02;
  const u1 = s.u1 - 0.02;
  const top = sillBottom(c, o) - 0.008;
  const bot = top - 0.17;
  const w0 = 0.085;
  const w1 = 0.31;
  const wood = vary(c.look.boxColor, rng, 0.04, 0.03, 0.006);

  // Box with a slightly wider top rim, and soil.
  block(c, 'wood', wood, { u: [u0, u1], y: [bot, top - 0.03], w: [w0, w1] }, 0.018);
  block(c, 'wood', mix(wood, '#000000', 0.08), { u: [u0 - 0.012, u1 + 0.012], y: [top - 0.045, top], w: [w0, w1 + 0.012] }, 0.012);
  block(c, 'wood', SOIL, { u: [u0 + 0.03, u1 - 0.03], y: [top - 0.02, top + 0.004], w: [w0 + 0.03, w1 - 0.03] }, 0);

  // Two iron brackets carry the box: an arm under it, propped from the wall.
  const iron = vary(IRON, rng, 0.03, 0.02, 0);
  for (const u of [u0 + 0.1, u1 - 0.1]) {
    block(c, 'metal', iron, { u: [u - 0.012, u + 0.012], y: [bot - 0.018, bot], w: [-0.01, w1 - 0.03] }, 0);
    const p0 = new THREE.Vector2(-0.01, bot - 0.17);
    const p1 = new THREE.Vector2(w1 * 0.62, bot - 0.012);
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const m = at(c.wall, u, (p0.y + p1.y) / 2, (p0.x + p1.x) / 2, -ang, 0, 0);
    c.b.add(softBox(0.022, 0.02, p0.distanceTo(p1), 0), 'metal', iron, m);
  }

  // Foliage clumps along the box, some trailing over the front edge.
  const flowerColors = pickFlowers(c.pal, rng);
  const detail = c.look.detail;
  const n = Math.max(3, Math.round(((u1 - u0) / 0.19) * (0.4 + 0.6 * detail)));
  const step = (u1 - u0) / n;
  for (let i = 0; i < n; i++) {
    const u = u0 + (i + 0.5) * step + rng.jitter(step * 0.2);
    const rad = rng.range(0.085, 0.11);
    const scale = new THREE.Vector3(rng.range(1.0, 1.25), rng.range(0.75, 0.95), rng.range(0.95, 1.15));
    // Keep the leaves off the wall: nothing outside the surround behind w = 0.08.
    const w = Math.max(rng.range(0.17, 0.23), 0.08 + rad * scale.z * 1.2);
    const centre = new THREE.Vector3(u, top + rad * 0.45 + rng.range(0, 0.03), w);
    addBlob(c, 'foliage', vary(rng.pick(LEAF_GREENS), rng, 0.05, 0.05, 0.01), centre, rad, scale, 'clump');
    // Flowers dotted over the upper / outer side of the clump.
    const k = rng.int(1, detail > 0.8 ? 3 : 2);
    for (let f = 0; f < k; f++) {
      const a = rng.range(-1.2, 1.2);
      const e = rng.range(0.25, 1.1);
      const d = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
      const p = centre.clone().add(d.multiply(scale).multiplyScalar(rad * 0.95));
      addBlob(c, 'flower', vary(rng.pick(flowerColors), rng, 0.05, 0.05, 0.01), p, rng.range(0.02, 0.027), new THREE.Vector3(1, 0.8, 1), 'bud');
    }
  }
  // Trailing stems: a short chain of small leaf blobs spilling over the rim.
  const trailing = Math.max(1, Math.round(n * 0.5 * detail));
  for (let i = 0; i < trailing; i++) {
    const u = u0 + ((i + 0.5) / trailing) * (u1 - u0) + rng.jitter(0.05);
    const green = vary(rng.pick(LEAF_GREENS), rng, 0.05, 0.05, 0.01);
    const links = 2;
    for (let k = 0; k < links; k++) {
      const rad = 0.045 - k * 0.008;
      const centre = new THREE.Vector3(u + rng.jitter(0.015), top - 0.01 - k * 0.055, w1 + 0.012 + rad * 0.6 - k * 0.006);
      addBlob(c, 'foliage', green, centre, rad, new THREE.Vector3(1, 1.15, 0.8), 'sprig');
    }
    if (rng.chance(0.5)) {
      const p = new THREE.Vector3(u + rng.jitter(0.02), top - 0.03, w1 + 0.06);
      addBlob(c, 'flower', vary(rng.pick(flowerColors), rng, 0.05, 0.05, 0.01), p, 0.026, new THREE.Vector3(1, 1, 0.8), 'bud');
    }
  }
}

/** One or two flower colours per box keeps each box coherent. */
function pickFlowers(pal: Palette, rng: Rng): string[] {
  const all = pal.flowers.length ? pal.flowers : ['#e0587a'];
  const first = rng.pick(all);
  const second = rng.pick(all);
  return rng.chance(0.6) ? [first, second] : [first];
}

// ---------------------------------------------------------------------------
// Door canopy
// ---------------------------------------------------------------------------

/**
 * A small tiled hood over the front door on two timber brackets: gabled when
 * there is height for it, otherwise a lean-to. It stays within the lintel's
 * u-range ± 0.08, below the floor band / jetty above (or under the roof eave
 * on single-storey houses), and is skipped when it cannot fit.
 */
function buildCanopy(c: Ctx, o: Opening): void {
  // Own stream, so the hood does not change when the rest of the wall draws more numbers.
  const rng = c.rng.fork('canopy');
  const hc: Ctx = { ...c, rng };
  const ceiling = canopyCeiling(c.layout, o);
  const hood: Hood = {
    u0: o.lintel.u0 - 0.08,
    u1: o.lintel.u1 + 0.08,
    proj: rng.range(0.52, 0.64),
    deck: 0.045,
    tile: 0.034,
    pitch: 0,
    base: o.lintel.y1 + 0.03,
  };

  // Gabled (ridge perpendicular to the wall) when there is height for it.
  if (rng.chance(0.55)) {
    const pitch = THREE.MathUtils.degToRad(rng.range(30, 40));
    const halfW = (hood.u1 - hood.u0) / 2;
    const ridgeTop = hood.base + halfW * Math.tan(pitch) + (hood.deck + hood.tile + 0.02) / Math.cos(pitch) + 0.05;
    if (ridgeTop <= ceiling(hood.proj + 0.05)) {
      gabledHood(hc, { ...hood, pitch });
      return;
    }
  }

  // Lean-to: the fascia ideally just above the lintel and the top against the
  // wall; take the steepest pitch up to the wanted one that fits, shortening
  // the hood if needed. The deck's top is at base - w·tan(pitch).
  const wantDeg = rng.range(24, 32);
  for (let proj = hood.proj; proj >= 0.42; proj -= 0.05) {
    for (let deg = wantDeg; deg >= 10; deg -= 1) {
      const pitch = THREE.MathUtils.degToRad(deg);
      const tan = Math.tan(pitch);
      const cos = Math.cos(pitch);
      const tilesAbove = (hood.tile + 0.03) / cos; // tile tops above the deck top
      const fasciaBelow = (hood.deck + 0.07) / cos; // fascia bottom below the deck top
      const wanted = hood.base + fasciaBelow + proj * tan;
      const limit = ceiling(0.08) - tilesAbove + 0.07 * tan;
      const base = Math.min(wanted, limit);
      const front = base - proj * tan;
      if (front - fasciaBelow < o.y1 + 0.05) continue;
      if (front + tilesAbove > ceiling(proj)) continue;
      leanToHood(hc, { ...hood, proj, pitch, base });
      return;
    }
  }
}

/**
 * Highest point the hood may reach at outward distance w: under the joist
 * ends of a jetty or the band at the storey's top, or under the roof eave
 * (rafter tails, fascia) when the door is on the top storey.
 */
function canopyCeiling(layout: HouseLayout, o: Opening): (w: number) => number {
  const storey = layout.storeys[o.storey];
  const upper = layout.storeys[o.storey + 1];
  if (!upper) {
    const { eaveY, pitch } = layout.roof;
    return (w) => eaveY - w * Math.tan(pitch) - 0.2 / Math.cos(pitch);
  }
  const Y = upper.y0;
  let clearance = 0.03;
  if (storey.joistZone > 0) {
    // Joist ends under the jetty.
    clearance = storey.joistZone + 0.03;
  } else if (storey.style === 'timber' || (storey.style === 'plaster' && upper.style === 'stone')) {
    clearance = 0.23; // top plate / storey band
  }
  return () => Y - clearance;
}

interface Hood {
  u0: number;
  u1: number;
  /** Outward reach of the tiles (w). */
  proj: number;
  deck: number;
  tile: number;
  pitch: number;
  /**
   * Gabled: underside of the deck at the eaves. Lean-to: top of the deck
   * where it meets the wall plane (w = 0).
   */
  base: number;
}

function gabledHood(c: Ctx, h: Hood): void {
  const { wall, rng, pal } = c;
  const uc = (h.u0 + h.u1) / 2;
  const halfW = (h.u1 - h.u0) / 2;
  const tan = Math.tan(h.pitch);
  const cos = Math.cos(h.pitch);
  const sin = Math.sin(h.pitch);
  const slopeLen = halfW / cos + 0.05;
  const timber = vary(pal.timber, rng, 0.04, 0.03, 0.005);

  for (const side of [-1, 1] as const) {
    // Slope frame: x along the eave (±w), y out of the roof, z down the slope.
    const Z = new THREE.Vector3(side * cos, -sin, 0);
    const Y = new THREE.Vector3(side * sin, cos, 0);
    const X = new THREE.Vector3().crossVectors(Y, Z); // = (0, 0, -side) → x = -side·w
    const ridge = new THREE.Vector3(uc, h.base + halfW * tan + h.deck / cos, 0);
    const frame = mul(wall.frame, new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(ridge));
    const xw = (w: number) => -side * w;
    const xr = (w0: number, w1: number): [number, number] => [Math.min(xw(w0), xw(w1)), Math.max(xw(w0), xw(w1))];
    const [dx0, dx1] = xr(-0.03, h.proj + 0.02);
    c.b.add(softBox(dx1 - dx0, h.deck, slopeLen, 0.01), 'wood', timber, mul(frame, mat4((dx0 + dx1) / 2, -h.deck / 2, slopeLen / 2)));
    const [tx0, tx1] = xr(0.085, h.proj + 0.04);
    layTiles(c, frame, tx0, tx1, 0.03, slopeLen + 0.03);
    // Barge board along the front edge.
    const [bx0, bx1] = xr(h.proj + 0.02, h.proj + 0.05);
    c.b.add(softBox(bx1 - bx0, 0.13, slopeLen + 0.02, 0.01), 'wood', timber, mul(frame, mat4((bx0 + bx1) / 2, -0.03, slopeLen / 2)));
  }
  // Ridge cap astride the apex.
  const apexY = h.base + halfW * tan + (h.deck + h.tile) / cos;
  const capLen = h.proj + 0.02 - 0.08;
  c.b.add(softBox(0.1, 0.1, capLen, 0.03), 'roof', vary(pal.roof, rng, 0.05, 0.04, 0.01), at(wall, uc, apexY - 0.015, 0.08 + capLen / 2, 0, 0, Math.PI / 4));
  // Ridge beam under the apex.
  block(c, 'timber', timber, { u: [uc - 0.045, uc + 0.045], y: [h.base + halfW * tan - 0.11, h.base + halfW * tan + 0.01], w: [-0.03, h.proj] }, 0.015);

  // Brackets: a horizontal arm under each eave, propped by a knee brace.
  for (const side of [-1, 1] as const) {
    const u = side < 0 ? h.u0 + 0.1 : h.u1 - 0.1;
    const armTop = h.base + 0.06 * tan + 0.008;
    bracket(c, u, armTop, h.proj - 0.03, 0, timber);
  }
}

function leanToHood(c: Ctx, h: Hood): void {
  const { wall, rng, pal } = c;
  const cos = Math.cos(h.pitch);
  const sin = Math.sin(h.pitch);
  const timber = vary(pal.timber, rng, 0.04, 0.03, 0.005);
  // Slope frame: x = u, y out of the roof, z down the slope (outwards).
  const X = new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3(0, cos, sin);
  const Z = new THREE.Vector3(0, -sin, cos);
  const frame = mul(wall.frame, new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(0, h.base, 0));
  const z = (w: number) => w / cos;
  const zEnd = z(h.proj + 0.02);
  const zBack = z(-0.03);
  const len = zEnd - zBack;
  c.b.add(softBox(h.u1 - h.u0, h.deck, len, 0.01), 'wood', timber, mul(frame, mat4((h.u0 + h.u1) / 2, -h.deck / 2, zBack + len / 2)));
  layTiles(c, frame, h.u0, h.u1, z(0.085), z(h.proj + 0.04));
  // Flashing roll where the tiles meet the wall.
  c.b.add(softBox(h.u1 - h.u0 + 0.02, 0.06, 0.09, 0.025), 'roof', vary(pal.roof, rng, 0.05, 0.04, 0.01), mul(frame, mat4((h.u0 + h.u1) / 2, h.tile, z(0.13))));
  // Barge boards on both sides and a fascia along the front.
  for (const u of [h.u0 - 0.015, h.u1 + 0.015]) {
    c.b.add(softBox(0.03, 0.12, len, 0.01), 'wood', timber, mul(frame, mat4(u, -0.03, zBack + len / 2)));
  }
  c.b.add(softBox(h.u1 - h.u0 + 0.06, 0.09, 0.03, 0.01), 'wood', timber, mul(frame, mat4((h.u0 + h.u1) / 2, -h.deck - 0.025, zEnd - 0.03)));

  // Brackets under the deck, sloping with it.
  for (const side of [-1, 1] as const) {
    const u = side < 0 ? h.u0 + 0.1 : h.u1 - 0.1;
    const armTopAtWall = h.base - h.deck / cos + 0.008;
    bracket(c, u, armTopAtWall, h.proj - 0.05, h.pitch, timber);
  }
}

/**
 * Timber bracket: an arm from the wall out to `reach` whose top is at `topY`
 * at the wall and falls with `slope` (radians), propped by a diagonal brace
 * running down to the wall.
 */
function bracket(c: Ctx, u: number, topY: number, reach: number, slope: number, color: THREE.Color): void {
  const armH = 0.085;
  const armW = 0.075;
  const back = -0.03;
  const len = reach - back;
  const mid = (back + reach) / 2;
  const tan = Math.tan(slope);
  // Arm (tilted with the deck when sloped).
  c.b.add(
    softBox(armW, armH, len / Math.cos(slope), 0.015),
    'timber',
    color,
    at(c.wall, u, topY - armH / 2 / Math.cos(slope) - mid * tan, mid, slope, 0, 0),
  );
  // Knee brace from the wall below up to ~60% of the arm.
  const bw = reach * 0.6;
  const bTop = topY - armH / Math.cos(slope) - bw * tan + 0.02;
  const bBot = bTop - Math.max(0.3, bw * 0.95);
  const p0 = new THREE.Vector2(back, bBot);
  const p1 = new THREE.Vector2(bw, bTop);
  const blen = p0.distanceTo(p1);
  const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
  c.b.add(softBox(armW * 0.9, 0.07, blen, 0.015), 'timber', color, at(c.wall, u, (p0.y + p1.y) / 2, (p0.x + p1.x) / 2, -ang, 0, 0));
}

/**
 * Staggered courses of small tiles on a slope. `frame` maps slope-local
 * coordinates: x along the eave, y out of the roof, z down the slope. Each
 * tile's tail rests on the course below; beaver-tail and fish-scale roofs
 * get round-ended tiles like the main roof, others plain slates.
 */
function layTiles(c: Ctx, frame: THREE.Matrix4, x0: number, x1: number, z0: number, z1: number): void {
  const { rng, pal } = c;
  // Match the main roof: round-ended tiles under clay coverings, flat slates otherwise.
  const rounded = c.layout.roof.covering === 'beaver' || c.layout.roof.covering === 'fish';
  const courses = Math.max(2, Math.round((z1 - z0) / 0.12));
  const gauge = (z1 - z0) / courses;
  const n = Math.max(2, Math.round((x1 - x0) / 0.15));
  const tw = (x1 - x0) / n;
  const tilt = 0.08;
  for (let k = 0; k < courses; k++) {
    const tail = z0 + (k + 1) * gauge;
    const head = Math.max(z0, tail - gauge * 1.7);
    const offset = k % 2 ? tw / 2 : 0;
    for (let i = 0; i <= n; i++) {
      const a = Math.max(x0, x0 + i * tw - offset);
      const b = Math.min(x1, x0 + (i + 1) * tw - offset);
      if (b - a < 0.03) continue;
      const g = tileGeometry(b - a - 0.008, tail - head, rounded);
      const m = mul(frame, mat4((a + b) / 2, 0.004, head, -tilt, rng.jitter(0.025), 0));
      c.b.add(g, 'roof', vary(pal.roof, rng, 0.06, 0.05, 0.012), m);
    }
  }
}

/**
 * One tile lying in slope-local space: head at z = 0, tail at z = len,
 * centred on x, from y = 0 up to its thickness. Round-ended or square.
 */
function tileGeometry(width: number, len: number, rounded: boolean): THREE.BufferGeometry {
  return cached(`tile:${width.toFixed(4)},${len.toFixed(4)},${rounded}`, () => buildTile(width, len, rounded));
}

function buildTile(width: number, len: number, rounded: boolean): THREE.BufferGeometry {
  const hw = width / 2;
  // Outline in (x, z): head edge at z = 0, tail at z = len.
  const pts: THREE.Vector2[] = [new THREE.Vector2(-hw, 0), new THREE.Vector2(hw, 0)];
  if (rounded) {
    // Straight sides, then a half-ellipse tail across the full width.
    const r = Math.min(hw, len * 0.45);
    pts.push(new THREE.Vector2(hw, len - r));
    for (let i = 1; i < 6; i++) {
      const a = (Math.PI * i) / 6;
      pts.push(new THREE.Vector2(hw * Math.cos(a), len - r + r * Math.sin(a)));
    }
    pts.push(new THREE.Vector2(-hw, len - r));
  } else {
    const r = Math.min(0.012, hw * 0.3);
    pts.push(new THREE.Vector2(hw, len - r), new THREE.Vector2(hw - r, len), new THREE.Vector2(-hw + r, len), new THREE.Vector2(-hw, len - r));
  }
  const thick = 0.022;
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: thick, bevelEnabled: false, curveSegments: 1 });
  // Shape (x, y) → slope (x, z); the extrusion runs to -y, so lift it onto y ∈ [0, thick].
  g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0)));
  g.translate(0, thick, 0);
  return g;
}

// ---------------------------------------------------------------------------
// Opening geometry helpers
// ---------------------------------------------------------------------------

function archOf(o: Opening): { uc: number; r: number } {
  return { uc: (o.u0 + o.u1) / 2, r: (o.u1 - o.u0) / 2 };
}

/** Top of the straight sides: the springing line of an arch, else the head. */
function springY(o: Opening): number {
  return o.arched ? o.y1 - (o.u1 - o.u0) / 2 : o.y1;
}

/**
 * The opening outline offset inwards by `inset` (outwards when negative) as
 * an open polyline: from the bottom-right corner at `yBottom`, up, over the
 * head (arc or flat) and down to the bottom-left corner.
 */
function headOutline(o: Opening, inset: number, yBottom: number, segments = 12): THREE.Vector2[] {
  const u0 = o.u0 + inset;
  const u1 = o.u1 - inset;
  const pts = [new THREE.Vector2(u1, yBottom)];
  if (o.arched) {
    const { uc, r } = archOf(o);
    const spring = springY(o);
    const rr = r - inset;
    for (let i = 0; i <= segments; i++) {
      const a = (Math.PI * i) / segments;
      pts.push(new THREE.Vector2(uc + rr * Math.cos(a), spring + rr * Math.sin(a)));
    }
  } else {
    pts.push(new THREE.Vector2(u1, o.y1 - inset), new THREE.Vector2(u0, o.y1 - inset));
  }
  pts.push(new THREE.Vector2(u0, yBottom));
  return pts;
}

/** Outline of a plank (or a whole leaf) from u0 to u1 whose top follows `top(u)`. */
function plankOutline(u0: number, u1: number, y0: number, top: (u: number) => number, samples: number): THREE.Vector2[] {
  const pts = [new THREE.Vector2(u0, y0), new THREE.Vector2(u1, y0)];
  for (let i = samples; i >= 0; i--) {
    const u = u0 + ((u1 - u0) * i) / samples;
    pts.push(new THREE.Vector2(u, top(u)));
  }
  return pts;
}

/**
 * One stone of an arch: the annular sector between angles a0 < a1 (0 = right,
 * π = left) and radii rIn..rOut around (cx, cy), clipped to the box
 * u ∈ [u0, u1], y ≤ y1, with half a joint taken off each radial side.
 * Returns null when the clipped stone would be too thin.
 */
function sectorStone(
  cx: number,
  cy: number,
  a0: number,
  a1: number,
  rIn: number,
  rOut: number,
  clip: { u0: number; u1: number; y1: number },
  minDepth = 0.04,
): THREE.Vector2[] | null {
  const half = JOINT / 2;
  const lean = (rho: number) => Math.asin(Math.min(1, half / Math.max(rho, half)));
  const reach = (a: number) => Math.min(rOut, rayToBox(cx, cy, a, clip));

  // Trim the angle range to where the box leaves room outside rIn (near the
  // springing line the box side can come inside the ring).
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k <= 40; k++) {
    const a = a0 + ((a1 - a0) * k) / 40;
    if (reach(a) >= rIn + 0.025) {
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
    }
  }
  if (!(hi - lo > 0.02)) return null;
  // Untrimmed ends meet a neighbouring stone: take half a joint off them.
  const end0 = (rho: number) => (lo > a0 ? lo : a0 + lean(rho));
  const end1 = (rho: number) => (hi < a1 ? hi : a1 - lean(rho));
  const i0 = end0(rIn);
  const i1 = end1(rIn);
  const o0 = end0(reach(lo));
  const o1 = end1(reach(hi));
  if (i1 <= i0 || o1 <= o0) return null;

  // Outer boundary angles (descending), including box corners in between.
  const angles = [o1, o0];
  for (let k = 1; k < 4; k++) angles.push(o1 + ((o0 - o1) * k) / 4);
  for (const corner of [
    [clip.u0, clip.y1],
    [clip.u1, clip.y1],
  ]) {
    const a = Math.atan2(corner[1] - cy, corner[0] - cx);
    if (a > o0 && a < o1 && Math.hypot(corner[0] - cx, corner[1] - cy) < rOut) angles.push(a);
  }
  angles.sort((p, q) => q - p);
  if (Math.max(...angles.map((a) => reach(a))) - rIn < minDepth) return null;

  const pts: THREE.Vector2[] = [];
  const steps = Math.max(2, Math.ceil((i1 - i0) / 0.12));
  for (let k = 0; k <= steps; k++) {
    const a = i0 + ((i1 - i0) * k) / steps;
    pts.push(new THREE.Vector2(cx + rIn * Math.cos(a), cy + rIn * Math.sin(a)));
  }
  for (const a of angles) {
    // Never let the outer edge dip inside the inner arc.
    const rho = Math.max(reach(a), rIn + 0.01);
    pts.push(new THREE.Vector2(cx + rho * Math.cos(a), cy + rho * Math.sin(a)));
  }
  return pts;
}

/**
 * Round every corner of a polygon: each vertex becomes a short quadratic
 * curve between points `radius` along its two edges (less on short edges).
 */
function roundPolygon(pts: THREE.Vector2[], radius: number, segments = 2): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n];
    const p = pts[i];
    const next = pts[(i + 1) % n];
    const dIn = Math.min(radius, prev.distanceTo(p) * 0.45);
    const dOut = Math.min(radius, next.distanceTo(p) * 0.45);
    const a = p.clone().add(prev.clone().sub(p).setLength(dIn));
    const b = p.clone().add(next.clone().sub(p).setLength(dOut));
    for (let k = 0; k <= segments; k++) {
      const t = k / segments;
      // Quadratic Bézier a → p → b.
      out.push(
        new THREE.Vector2(
          (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * p.x + t * t * b.x,
          (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * p.y + t * t * b.y,
        ),
      );
    }
  }
  return out;
}

/**
 * Clip a polygon (Sutherland–Hodgman) to the region where every `keep`
 * function is ≥ 0; each must be linear in the point (a half-plane).
 */
function clipPolygon(pts: THREE.Vector2[], ...keep: ((p: THREE.Vector2) => number)[]): THREE.Vector2[] {
  let poly = pts;
  for (const f of keep) {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const fa = f(a);
      const fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) out.push(a.clone().lerp(b, fa / (fa - fb)));
    }
    poly = out;
    if (poly.length < 3) return [];
  }
  return poly;
}

function polygonArea(pts: THREE.Vector2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function extentU(pts: THREE.Vector2[]): [number, number] {
  if (!pts.length) return [0, 0];
  return [Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x))];
}

/** Distance from (cx, cy) along angle a to the box sides u0 / u1 / top y1. */
function rayToBox(cx: number, cy: number, a: number, box: { u0: number; u1: number; y1: number }): number {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  let t = Infinity;
  if (dx < -1e-6) t = Math.min(t, (box.u0 - cx) / dx);
  if (dx > 1e-6) t = Math.min(t, (box.u1 - cx) / dx);
  if (dy > 1e-6) t = Math.min(t, (box.y1 - cy) / dy);
  return Math.max(0, t);
}

// ---------------------------------------------------------------------------
// Generic geometry helpers
// ---------------------------------------------------------------------------

/** Matrix at wall-local (u, y, w), rotated (radians) about the wall-local axes. */
function at(wall: WallSpec, u: number, y: number, w: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return mul(wall.frame, mat4(u, y, w, rx, ry, rz));
}

/** Soft box filling an axis-aligned wall-local extent, optionally turned by rz about its centre. */
function block(c: Ctx, mat: MatKey, color: ColorLike, e: Extent, round = 0.012, rz = 0): void {
  const [u0, u1] = e.u;
  const [y0, y1] = e.y;
  const [w0, w1] = e.w;
  if (u1 - u0 < 1e-3 || y1 - y0 < 1e-3 || w1 - w0 < 1e-3) return;
  const m = at(c.wall, (u0 + u1) / 2, (y0 + y1) / 2, (w0 + w1) / 2, 0, 0, rz);
  c.b.add(softBox(u1 - u0, y1 - y0, w1 - w0, round), mat, color, m);
}

/** Like `block`, tipped forward by `tilt` radians (sills shed water). */
function blockTilted(c: Ctx, mat: MatKey, color: ColorLike, e: Extent, round: number, tilt: number): void {
  const [u0, u1] = e.u;
  const [y0, y1] = e.y;
  const [w0, w1] = e.w;
  const m = at(c.wall, (u0 + u1) / 2, (y0 + y1) / 2, (w0 + w1) / 2, tilt, 0, 0);
  c.b.add(softBox(u1 - u0, y1 - y0, w1 - w0, round), mat, color, m);
}

/** Extrude a wall-local (u, y) shape from w0 to w1 and add it to the wall's builder. */
function slab(c: Ctx, mat: MatKey, color: ColorLike, shape: THREE.Shape, w0: number, w1: number, bevel = 0.01, bevelSegments = 1): void {
  c.b.add(extrudeSoft(shape, w0, w1, bevel, bevelSegments), mat, color, c.wall.frame);
}

/**
 * Extrude a (u, y) shape so it spans w0..w1 in total, with a small bevel
 * around both faces that keeps the silhouette at its mid-depth.
 */
function extrudeSoft(shape: THREE.Shape, w0: number, w1: number, bevel: number, bevelSegments = 1): THREE.BufferGeometry {
  const b = Math.max(0, Math.min(bevel, (w1 - w0) / 3));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, w1 - w0 - 2 * b),
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments,
    curveSegments: 1,
  });
  g.translate(0, 0, w0 + b);
  return g;
}

/**
 * Box with chamfered edges and smooth (rounded-looking) normals: 44
 * triangles, against 108+ for a RoundedBoxGeometry. Every vertex sits on one
 * face's inner rectangle and carries that face's normal, so lighting blends
 * across the chamfers like a rounded edge.
 */
function softBox(sx: number, sy: number, sz: number, round: number): THREE.BufferGeometry {
  return cached(`box:${sx.toFixed(4)},${sy.toFixed(4)},${sz.toFixed(4)},${round.toFixed(4)}`, () => buildSoftBox(sx, sy, sz, round));
}

function buildSoftBox(sx: number, sy: number, sz: number, round: number): THREE.BufferGeometry {
  const h = [sx / 2, sy / 2, sz / 2];
  const r = Math.min(round, h[0] * 0.9, h[1] * 0.9, h[2] * 0.9);
  if (r <= 0.0015) return new THREE.BoxGeometry(sx, sy, sz);
  const pos: number[] = [];
  const nor: number[] = [];
  type Vert = { p: number[]; n: number[] };
  // The vertex of face `axis` (on side signs[axis]) nearest the corner `signs`.
  const vert = (axis: number, signs: number[]): Vert => ({
    p: [0, 1, 2].map((i) => (i === axis ? signs[i] * h[i] : signs[i] * (h[i] - r))),
    n: [0, 1, 2].map((i) => (i === axis ? signs[i] : 0)),
  });
  const tri = (a: Vert, b: Vert, d: Vert) => {
    // Wind outwards: the box is convex and centred on the origin.
    const e1 = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
    const e2 = [d.p[0] - a.p[0], d.p[1] - a.p[1], d.p[2] - a.p[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const cen = [a.p[0] + b.p[0] + d.p[0], a.p[1] + b.p[1] + d.p[1], a.p[2] + b.p[2] + d.p[2]];
    const order = cr[0] * cen[0] + cr[1] * cen[1] + cr[2] * cen[2] >= 0 ? [a, b, d] : [a, d, b];
    for (const v of order) {
      pos.push(...v.p);
      nor.push(...v.n);
    }
  };
  const quad = (a: Vert, b: Vert, d: Vert, e: Vert) => {
    tri(a, b, d);
    tri(a, d, e);
  };
  const S = [-1, 1];
  // Faces.
  for (let axis = 0; axis < 3; axis++) {
    const [i, j] = [0, 1, 2].filter((k) => k !== axis);
    for (const s of S) {
      const sg = (si: number, sj: number) => {
        const v = [0, 0, 0];
        v[axis] = s;
        v[i] = si;
        v[j] = sj;
        return vert(axis, v);
      };
      quad(sg(-1, -1), sg(1, -1), sg(1, 1), sg(-1, 1));
    }
  }
  // Edge chamfers.
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      const k = 3 - a - b;
      for (const sa of S) {
        for (const sb of S) {
          const signs = (sk: number) => {
            const v = [0, 0, 0];
            v[a] = sa;
            v[b] = sb;
            v[k] = sk;
            return v;
          };
          quad(vert(a, signs(-1)), vert(a, signs(1)), vert(b, signs(1)), vert(b, signs(-1)));
        }
      }
    }
  }
  // Corner triangles.
  for (const cx of S) {
    for (const cy of S) {
      for (const cz of S) {
        const s = [cx, cy, cz];
        tri(vert(0, s), vert(1, s), vert(2, s));
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/**
 * Lumpy, smooth-shaded unit blobs, a few cached variants per kind:
 * 'clump' (foliage, 80 tris), 'sprig' (trailing foliage, 20) and 'bud' (flower, 20).
 */
type BlobKind = 'clump' | 'sprig' | 'bud';
const blobCache = new Map<BlobKind, THREE.BufferGeometry[]>();
function blobVariants(kind: BlobKind): THREE.BufferGeometry[] {
  let list = blobCache.get(kind);
  if (!list) {
    list = [0, 1, 2, 3].map((seed) => {
      const base = kind === 'clump' ? new THREE.SphereGeometry(1, 8, 6) : new THREE.IcosahedronGeometry(1, 0);
      base.deleteAttribute('normal');
      base.deleteAttribute('uv');
      const g = mergeVertices(base);
      return lumpify(g, kind === 'clump' ? 0.14 : kind === 'bud' ? 0.1 : 0.18, seed + 1);
    });
    blobCache.set(kind, list);
  }
  return list;
}

function addBlob(c: Ctx, mat: MatKey, color: ColorLike, centre: THREE.Vector3, radius: number, scale: THREE.Vector3, kind: BlobKind): void {
  const variants = blobVariants(kind);
  const g = variants[c.rng.int(0, variants.length - 1)];
  // Spin first (variety), then stretch along the wall axes, then place.
  const spin = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(c.rng.range(0, 6.28), c.rng.range(0, 6.28), 0));
  const m = new THREE.Matrix4()
    .makeTranslation(centre.x, centre.y, centre.z)
    .multiply(new THREE.Matrix4().makeScale(radius * scale.x, radius * scale.y, radius * scale.z))
    .multiply(spin);
  c.b.add(g, mat, color, mul(c.wall.frame, m));
}

/**
 * Template geometry shared between calls with the same key. PartBuilder.add
 * copies what it is given, so templates are never modified; the cache is
 * dropped when it grows large (keys include random sizes).
 */
const templates = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = templates.get(key);
  if (!g) {
    if (templates.size > 4000) templates.clear();
    g = make();
    templates.set(key, g);
  }
  return g;
}

/** Split `total` into `n` parts of roughly equal size (± `spread` relative). */
function randomSplit(total: number, n: number, spread: number, rng: Rng): number[] {
  const weights = Array.from({ length: n }, () => 1 + rng.jitter(spread));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((wt) => (wt / sum) * total);
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
