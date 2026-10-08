import { Color, Matrix4, SRGBColorSpace, Vector3 } from 'three';
import type { HouseParams, WallStyle } from './params';
import { Rng } from './rng';

/**
 * The "plan" of a house: pure numbers derived from HouseParams.
 *
 * Every geometry builder (walls, roof, windows …) reads this and nothing else,
 * so all parts agree on where things are. This is also the layer a future
 * village generator would drive: it decides *what* goes *where*; the part
 * builders only decide what it looks like.
 *
 * Conventions
 * - Metres, Y up, ground at y = 0, house centred on the origin.
 * - The ridge runs along X. The front facade (with the door) faces +Z.
 * - Walls are listed front, right, back, left. Walking from a wall's `start`
 *   to its `end`, the outside is on your right, i.e. seen from outside, `u`
 *   runs left → right.
 * - Wall-local coordinates (u, y, w): u along the wall from `start` (the outer
 *   corner), y = world height, w = outward distance from the OUTER face
 *   (w = 0 is the outer face, w = -thickness the inner face).
 *   `wall.frame` maps (u, y, w) → world and is a proper rotation (no mirroring).
 */

export type Side = 'front' | 'right' | 'back' | 'left';
export type OpeningKind = 'door' | 'window' | 'attic';

/** Axis-aligned rectangle in wall-local (u, y). */
export interface Rect {
  u0: number;
  u1: number;
  y0: number;
  y1: number;
}

export interface Opening {
  id: string;
  kind: OpeningKind;
  wallId: string;
  storey: number;
  /** Horizontal extent along the wall (wall-local u). */
  u0: number;
  u1: number;
  /** Vertical extent (world y). For arched openings y1 is the top of the arch. */
  y0: number;
  y1: number;
  /** Semicircular head with radius (u1-u0)/2; the arch springs at y1 - radius. */
  arched: boolean;
  /** w of the frame/glass plane (negative = set back into the wall). */
  recess: number;
  /** Lintel (beam or stone) directly above the opening. */
  lintel: Rect;
  /** Projecting sill below a window; null for doors. */
  sill: Rect | null;
  /**
   * Everything around the opening that belongs to the opening: frame, lintel,
   * sill. Stone coursing and timber bracing must keep out of this rectangle.
   */
  surround: Rect;
  shutters: boolean;
  flowerBox: boolean;
}

export interface GableSpec {
  /** u of the apex on the outer face. */
  apexU: number;
  apexY: number;
  /** Height of the gable's top edge at the wall's ends (= eave height). */
  eaveY: number;
}

export interface WallSpec {
  id: string;
  side: Side;
  storey: number;
  /** left/right walls carry the roof gables. */
  isGable: boolean;
  style: WallStyle;
  /** Outer-face corners in plan (x, z). */
  start: { x: number; z: number };
  end: { x: number; z: number };
  /** Unit direction start → end (x, z). */
  dir: { x: number; z: number };
  /** Unit outward normal (x, z). */
  normal: { x: number; z: number };
  /** Outer face length, corner to corner. */
  length: number;
  /**
   * u-range of the solid wall body. Front/back walls run the full length;
   * gable walls fit between them (u = thickness … length - thickness).
   */
  u0: number;
  u1: number;
  /** Vertical extent of the storey's wall (world y). */
  y0: number;
  y1: number;
  thickness: number;
  /** Only on the top storey's left/right walls: triangle above y1. */
  gable: GableSpec | null;
  openings: Opening[];
  /** Wall-local (u, y, w) → world. */
  frame: Matrix4;
}

export interface StoreySpec {
  index: number;
  /** Bottom of this storey's walls. */
  y0: number;
  /** Interior floor level (top of plinth for the ground floor). */
  floorY: number;
  /** Top of this storey's walls. */
  y1: number;
  style: WallStyle;
  /** Outer footprint of this storey's walls. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  walls: WallSpec[];
  /** How far the storey above projects past this one on the front/back (0 = no jetty). */
  jettyAbove: number;
  /**
   * Height of the jetty joist layer at the top of this storey's walls
   * (y ∈ [y1 - joistZone, y1]), 0 when there is no jetty above. The timber
   * part lays the joist ends there; stonework and door hoods keep clear.
   */
  joistZone: number;
}

/** What the roof is covered with (decided here so roof, chimney flashing and door hoods agree). */
export type RoofCovering = 'beaver' | 'fish' | 'slate' | 'shingle';

/**
 * Average height of each covering's visible tile surface above the deck,
 * perpendicular to the slope: head clearance + half a tile + the rise of a
 * tile's tail over the course below (+ the average hand-laid sag).
 */
const COVER_TOP: Record<RoofCovering, number> = {
  beaver: 0.083,
  fish: 0.078,
  slate: 0.065,
  shingle: 0.092,
};

export interface RoofSpec {
  type: 'gable';
  covering: RoofCovering;
  /** Pitch in radians. */
  pitch: number;
  /** Underside of the roof meets the top storey's outer eave-wall face at this height. */
  eaveY: number;
  /** Outer half-depth (z) of the top storey. */
  halfDepth: number;
  /** Underside height at the ridge line (z = 0). */
  ridgeY: number;
  /** Outer x-extent of the top storey walls. */
  minX: number;
  maxX: number;
  overhangEave: number;
  overhangGable: number;
  /** Thickness of the roof deck (boards/rafters), measured perpendicular to the slope. */
  deckThickness: number;
  /**
   * Deck + covering, perpendicular to the slope: `roofSurfaceY` is the
   * average top of the visible tile surface (individual tile tails stand
   * ≈1–2 cm proud of it, the ridge cap more).
   */
  coverThickness: number;
}

export interface ChimneySpec {
  /** Centre in plan. */
  x: number;
  z: number;
  /** Size along x and z. */
  sx: number;
  sz: number;
  /** Bottom (hidden inside the house) and top of the stack. */
  y0: number;
  y1: number;
}

/**
 * Steps in front of the door, in the door wall's local coordinates. The
 * foundation part builds them; props keep out of this zone (and the path
 * starts at its outer edge).
 */
export interface StoopSpec {
  wallId: string;
  u0: number;
  u1: number;
  /** Outward extent: steps occupy w ∈ [0, w1]. */
  w1: number;
  /** Number of steps from the ground up to the door threshold (floorY). */
  steps: number;
  /** Height of the door threshold (= ground storey floorY). */
  topY: number;
}

export interface HouseLayout {
  params: HouseParams;
  storeys: StoreySpec[];
  walls: WallSpec[];
  openings: Opening[];
  door: Opening;
  stoop: StoopSpec;
  roof: RoofSpec;
  chimney: ChimneySpec | null;
  /** World-space bounds of the whole house including roof overhang and chimney. */
  bounds: { min: Vector3; max: Vector3 };
}

// ---------------------------------------------------------------------------
// Helpers every builder can use
// ---------------------------------------------------------------------------

/** World position of wall-local (u, y, w). */
export function wallPoint(wall: WallSpec, u: number, y: number, w: number): Vector3 {
  return new Vector3(u, y, w).applyMatrix4(wall.frame);
}

/** Matrix placing an object at wall-local (u, y, w), axes aligned with the wall. */
export function wallMatrix(wall: WallSpec, u: number, y: number, w: number): Matrix4 {
  return wall.frame.clone().multiply(new Matrix4().makeTranslation(u, y, w));
}

/** Height of a gable wall's top edge at u (only meaningful when wall.gable is set). */
export function gableTopAt(wall: WallSpec, u: number): number {
  if (!wall.gable) return wall.y1;
  const tan = (wall.gable.apexY - wall.gable.eaveY) / wall.gable.apexU;
  return wall.gable.eaveY + Math.min(u, wall.length - u) * tan;
}

/** Underside height of the roof (deck bottom) at plan coordinate z. */
export function roofUndersideY(roof: RoofSpec, z: number): number {
  return roof.eaveY + (roof.halfDepth - Math.abs(z)) * Math.tan(roof.pitch);
}

/** Top of the roof covering (tiles) at plan coordinate z. */
export function roofSurfaceY(roof: RoofSpec, z: number): number {
  return roofUndersideY(roof, z) + roof.coverThickness / Math.cos(roof.pitch);
}

/** True when the wall-local rectangle overlaps any opening surround on the wall. */
export function hitsOpening(wall: WallSpec, r: Rect, pad = 0): boolean {
  return wall.openings.some(
    (o) =>
      r.u0 < o.surround.u1 + pad &&
      r.u1 > o.surround.u0 - pad &&
      r.y0 < o.surround.y1 + pad &&
      r.y1 > o.surround.y0 - pad,
  );
}

// ---------------------------------------------------------------------------
// Layout computation
// ---------------------------------------------------------------------------

const SIDES: Side[] = ['front', 'right', 'back', 'left'];

export function computeLayout(p: HouseParams): HouseLayout {
  const rng = new Rng(p.seed).fork('layout');
  const t = p.wallThickness;
  const floors = Math.max(1, Math.min(3, Math.round(p.floors)));

  // House-wide opening sizes (kept consistent across the house for coherence).
  const winW = round(rng.range(0.8, 1.0), 0.05);
  const winH = round(rng.range(1.05, 1.3), 0.05);
  const doorW = round(rng.range(1.0, 1.15), 0.05);
  // Under a jetty the joists eat into the storey top; keep the door a little
  // lower there so a proper hood fits above it.
  const underJetty = floors > 1 && p.jetty > 0.005;
  const doorH = round(Math.min(2.15, p.storeyHeight - (underJetty ? 0.65 : 0.35)), 0.05);
  const lintelH = 0.2;
  const sillH = 0.1;
  const recessWindow = -Math.min(0.14, t * 0.35);
  const recessDoor = -Math.min(0.16, t * 0.4);

  const storeys: StoreySpec[] = [];
  const allOpenings: Opening[] = [];
  let door: Opening | null = null;

  // Window columns along the front/back walls are shared by all storeys so
  // upper windows line up with the ones below.
  const cornerMargin = t + 0.75;
  const eaveColumns = columns(p.width, cornerMargin, p.windowSpacing);
  const doorHalfRange = Math.max(0, p.width / 2 - cornerMargin - doorW / 2);
  const doorU = p.width / 2 + clamp(p.doorOffset, -1, 1) * doorHalfRange;

  for (let s = 0; s < floors; s++) {
    const jet = p.jetty * s;
    const halfW = p.width / 2;
    const halfD = p.depth / 2 + jet;
    const y0 = s === 0 ? 0 : storeys[s - 1].y1;
    const floorY = s === 0 ? p.plinthHeight : y0;
    const y1 = floorY + p.storeyHeight;
    const style = s === 0 ? p.groundStyle : p.upperStyle;
    const top = s === floors - 1;

    const corners = [
      { x: -halfW, z: halfD }, // front-left
      { x: halfW, z: halfD }, // front-right
      { x: halfW, z: -halfD }, // back-right
      { x: -halfW, z: -halfD }, // back-left
    ];

    const walls: WallSpec[] = SIDES.map((side, i) => {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const dir = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
      // normal = dir × up = (dx, 0, dz) × (0, 1, 0) = (-dz, 0, dx)
      const normal = { x: -dir.z, z: dir.x };
      const isGable = side === 'left' || side === 'right';
      const frame = new Matrix4().makeBasis(
        new Vector3(dir.x, 0, dir.z),
        new Vector3(0, 1, 0),
        new Vector3(normal.x, 0, normal.z),
      );
      frame.setPosition(a.x, 0, a.z);
      return {
        id: `s${s}-${side}`,
        side,
        storey: s,
        isGable,
        style,
        start: a,
        end: b,
        dir,
        normal,
        length,
        u0: isGable ? t : 0,
        u1: isGable ? length - t : length,
        y0,
        y1,
        thickness: t,
        gable: null,
        openings: [],
        frame,
      };
    });

    const tan = Math.tan((p.roofPitch * Math.PI) / 180);
    if (top) {
      for (const w of walls) {
        if (!w.isGable) continue;
        w.gable = { apexU: w.length / 2, apexY: y1 + (w.length / 2) * tan, eaveY: y1 };
      }
    }

    // --- openings -------------------------------------------------------
    const winSill = floorY + (s === 0 ? 0.85 : 0.8);
    const makeOpening = (
      wall: WallSpec,
      kind: OpeningKind,
      uc: number,
      w: number,
      y0o: number,
      h: number,
      arched: boolean,
    ): Opening => {
      const u0 = uc - w / 2;
      const u1 = uc + w / 2;
      const y1o = y0o + h;
      const isDoor = kind === 'door';
      const lintel: Rect = { u0: u0 - 0.16, u1: u1 + 0.16, y0: y1o, y1: y1o + lintelH };
      const sill: Rect | null = isDoor ? null : { u0: u0 - 0.1, u1: u1 + 0.1, y0: y0o - sillH, y1: y0o };
      const o: Opening = {
        id: `${wall.id}-${kind}${wall.openings.length}`,
        kind,
        wallId: wall.id,
        storey: s,
        u0,
        u1,
        y0: y0o,
        y1: y1o,
        arched,
        recess: isDoor ? recessDoor : recessWindow,
        lintel,
        sill,
        surround: {
          u0: Math.min(lintel.u0, sill?.u0 ?? Infinity) - 0.02,
          u1: Math.max(lintel.u1, sill?.u1 ?? -Infinity) + 0.02,
          y0: (sill ? sill.y0 : y0o) - 0.02,
          y1: lintel.y1 + 0.02,
        },
        shutters: p.shutters && kind === 'window',
        flowerBox: p.flowerBoxes && kind === 'window' && (s > 0 || wall.side === 'front'),
      };
      wall.openings.push(o);
      allOpenings.push(o);
      return o;
    };

    for (const wall of walls) {
      if (!wall.isGable) {
        // Front / back: shared columns. Ground-floor front gets the door.
        const hasDoor = s === 0 && wall.side === 'front';
        if (hasDoor) {
          door = makeOpening(wall, 'door', doorU, doorW, floorY, doorH, p.archedDoor);
        }
        for (const uc of eaveColumns) {
          // The back wall is walked in the opposite direction; mirror columns
          // so windows line up front-to-back too.
          const u = wall.side === 'back' ? wall.length - uc : uc;
          const clearance = (doorW + winW) / 2 + 0.45;
          if (hasDoor && Math.abs(u - doorU) < clearance) continue;
          if (wall.side === 'back' && s === 0 && rng.chance(0.25)) continue;
          makeOpening(wall, 'window', u, winW, winSill, winH, false);
        }
      } else {
        // Gable walls: fewer windows, sometimes none on the ground floor.
        const cols = columns(wall.length, cornerMargin, p.windowSpacing * 1.1);
        const chimneyWall = p.chimney && wall.side === p.chimneySide;
        for (const uc of cols) {
          if (chimneyWall && s === 0 && rng.chance(0.5)) continue;
          if (s === 0 && rng.chance(0.2)) continue;
          makeOpening(wall, 'window', uc, winW * 0.9, winSill, winH * 0.92, false);
        }
        if (top && wall.gable) {
          // Attic window in the gable triangle if there is room.
          const triH = wall.gable.apexY - wall.gable.eaveY;
          const aw = 0.6;
          const ah = Math.min(0.9, triH * 0.38);
          const ay0 = wall.gable.eaveY + Math.max(0.35, triH * 0.18);
          const fits = ah >= 0.45 && ay0 + ah + lintelH + 0.15 < gableTopAt(wall, wall.length / 2 - aw / 2 - 0.2);
          if (fits) makeOpening(wall, 'attic', wall.length / 2, aw, ay0, ah, rng.chance(0.5));
        }
      }
    }

    storeys.push({
      index: s,
      y0,
      floorY,
      y1,
      style,
      minX: -halfW,
      maxX: halfW,
      minZ: -halfD,
      maxZ: halfD,
      walls,
      jettyAbove: 0,
      joistZone: 0,
    });
  }

  // Jetty joist layers: as deep as the openings below allow (0.10–0.15 m).
  for (let s = 0; s + 1 < storeys.length; s++) {
    const lower = storeys[s];
    const upper = storeys[s + 1];
    lower.jettyAbove = Math.max(0, upper.maxZ - lower.maxZ);
    if (lower.jettyAbove <= 0.005) continue;
    const tops = lower.walls.flatMap((w) => w.openings.map((o) => o.surround.y1));
    lower.joistZone = clamp(upper.y0 - Math.max(lower.y0, ...tops), 0.1, 0.15);
  }

  const top = storeys[storeys.length - 1];
  const pitch = (p.roofPitch * Math.PI) / 180;
  const covering = pickCovering(p.palette.roof, rng.fork('covering'));
  const deckThickness = 0.12;
  const roof: RoofSpec = {
    type: 'gable',
    covering,
    pitch,
    eaveY: top.y1,
    halfDepth: top.maxZ,
    ridgeY: top.y1 + top.maxZ * Math.tan(pitch),
    minX: top.minX,
    maxX: top.maxX,
    overhangEave: p.eaveOverhang,
    overhangGable: p.gableOverhang,
    deckThickness,
    coverThickness: deckThickness + COVER_TOP[covering],
  };

  let chimney: ChimneySpec | null = null;
  if (p.chimney) {
    const sx = round(rng.range(0.6, 0.8), 0.05);
    const sz = round(rng.range(0.55, 0.75), 0.05);
    const sign = p.chimneySide === 'right' ? 1 : -1;
    const x = sign * (top.maxX - t - sx / 2 - rng.range(0.15, 0.6));
    // Either straddling the ridge, or poking out of the back slope. Off the
    // ridge the stack must still clear it, so keep the drop between the stack's
    // foot and the ridge modest (≤ 1.2 m) or it turns into a tower.
    const onRidge = rng.chance(0.55) || pitch > (55 * Math.PI) / 180;
    const maxOff = Math.max(0, 1.2 / Math.tan(pitch) - sz / 2);
    const z = onRidge ? 0 : -round(Math.min(rng.range(0.25, 0.45) * top.maxZ, maxOff), 0.05);
    const surfaceAtHighSide = roofSurfaceY(roof, Math.max(0, Math.abs(z) - sz / 2));
    chimney = {
      x,
      z,
      sx,
      sz,
      y0: top.y1 - 0.5,
      y1: Math.max(surfaceAtHighSide + rng.range(0.7, 1.1), roofSurfaceY(roof, 0) + 0.45),
    };
  }

  const walls = storeys.flatMap((s) => s.walls);
  const maxZ = Math.max(...storeys.map((s) => s.maxZ)) + p.eaveOverhang;
  const maxY = Math.max(roofSurfaceY(roof, 0) + 0.15, chimney ? chimney.y1 + 0.2 : 0);
  const bounds = {
    min: new Vector3(top.minX - p.gableOverhang, 0, -maxZ),
    max: new Vector3(top.maxX + p.gableOverhang, maxY, maxZ),
  };

  if (!door) throw new Error('layout: house has no door');
  const d: Opening = door;
  const steps = Math.max(1, Math.ceil(p.plinthHeight / 0.19));
  const stoopHalf = (d.u1 - d.u0) / 2 + 0.3 + (steps - 1) * 0.08;
  const stoop: StoopSpec = {
    wallId: d.wallId,
    u0: (d.u0 + d.u1) / 2 - stoopHalf,
    u1: (d.u0 + d.u1) / 2 + stoopHalf,
    w1: 0.12 + steps * 0.32,
    steps,
    topY: storeys[0].floorY,
  };
  return { params: p, storeys, walls, openings: allOpenings, door: d, stoop, roof, chimney, bounds };
}

/** A covering that suits the palette's roof colour (classified as authored, in sRGB). */
function pickCovering(roofColor: string, rng: Rng): RoofCovering {
  const hsl = { h: 0, s: 0, l: 0 };
  new Color(roofColor).getHSL(hsl, SRGBColorSpace);
  let weights: [RoofCovering, number][];
  if (hsl.s < 0.18) weights = [['slate', 5], ['shingle', 2], ['fish', 2], ['beaver', 0.5]]; // grey / blue
  else if (hsl.h > 0.17 && hsl.h < 0.45) weights = [['shingle', 4], ['beaver', 2], ['fish', 1]]; // mossy green
  else if (hsl.h < 0.1 || hsl.h > 0.9) weights = [['beaver', 6], ['fish', 2]]; // terracotta reds
  else weights = [['beaver', 3], ['slate', 2], ['shingle', 2], ['fish', 1]];
  return rng.weighted(weights);
}

/** Evenly spaced centres along a wall, keeping `margin` clear at both ends. */
function columns(length: number, margin: number, spacing: number): number[] {
  const avail = length - 2 * margin;
  if (avail < 0) return length > 2.2 ? [length / 2] : [];
  const n = Math.max(1, Math.round(avail / spacing) + 1);
  if (n === 1) return [length / 2];
  return Array.from({ length: n }, (_, i) => margin + (avail * i) / (n - 1));
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

function round(v: number, step: number): number {
  return Number((Math.round(v / step) * step).toFixed(4));
}
