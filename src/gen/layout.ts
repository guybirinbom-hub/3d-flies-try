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
  /** Fascia board along the eaves: thickness, and how far it hangs below the deck underside. */
  fasciaThickness: number;
  fasciaDrop: number;
  /** Dormers on the slopes (may be empty). */
  dormers: DormerSpec[];
  /**
   * Plan rectangles where the roof must leave its covering open because
   * something else (chimney, dormer) comes through. The owner of the
   * obstacle flashes/covers the edge.
   */
  holes: PlanRect[];
}

/** Axis-aligned rectangle in plan (x, z). */
export interface PlanRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** What made the hole. */
  kind: 'chimney' | 'dormer';
}

/**
 * A dormer on one roof slope. Plan values are measured on the dormer's own
 * slope (|z|); `sign` says which slope (+1 front / +Z, -1 back / -Z).
 *
 *   front wall: outer face at |z| = faceZ, from baseY (where it meets the
 *   roof covering) up to eaveY, spanning x ± width/2 (outer cheek faces).
 *   gable dormer: ridge (along z) at ridgeY, running back to |z| = backZ
 *   where it dies into the main roof. shed dormer: one slope rising from
 *   eaveY at the face to ridgeY at |z| = backZ.
 */
export interface DormerSpec {
  id: string;
  sign: 1 | -1;
  x: number;
  width: number;
  faceZ: number;
  baseY: number;
  eaveY: number;
  ridgeY: number;
  backZ: number;
  roof: 'gable' | 'shed';
  /** Pitch of the dormer's own roof (rad). */
  pitch: number;
  /** Wall finish of the dormer face and cheeks (follows the top storey). */
  style: WallStyle;
  /** Window in the face: x-range (world) and y-range. */
  window: { x0: number; x1: number; y0: number; y1: number; arched: boolean };
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
  /**
   * Zone reserved above the door for a hood/canopy (door wall local u, y;
   * outward up to w1). Openings builds the hood inside it (or a smaller
   * drip moulding); props keep the lantern out of it.
   */
  doorHood: Rect & { w1: number };
  roof: RoofSpec;
  chimney: ChimneySpec | null;
  /**
   * Level of detail, 0.45–1: 1 for an ordinary house, lower for very large
   * ones. Parts thin out small repeated detail with it to keep a house
   * around the triangle budget.
   */
  detail: number;
  /** Window glazing used throughout the house (wall and dormer windows match). */
  glazing: 'cross' | 'six';
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

/** Fascia board along the eaves (the roof part builds it to these sizes). */
const FASCIA_T = 0.045;
const FASCIA_DROP = 0.135;
/** Room kept above the door lintel for a hood. */
const HOOD_ROOM = 0.45;
/** Lintel and sill sizes shared by every opening. */
const LINTEL_H = 0.2;
const SILL_H = 0.1;
/** Narrowest wall pier left between two opening surrounds. */
const MIN_PIER = 0.35;

export function computeLayout(p: HouseParams): HouseLayout {
  const rng = new Rng(p.seed).fork('layout');
  const t = p.wallThickness;
  const floors = Math.max(1, Math.min(3, Math.round(p.floors)));
  const pitch = (p.roofPitch * Math.PI) / 180;
  const tanP = Math.tan(pitch);

  // House-wide opening sizes (kept consistent across the house for coherence).
  const winW = round(rng.range(0.8, 1.0), 0.05);
  const winH = round(rng.range(1.05, 1.3), 0.05);
  const doorW = round(rng.range(1.0, 1.15), 0.05);
  // Masonry storeys don't project, so only framed upper storeys jetty out.
  const jetty = p.upperStyle === 'stone' ? 0 : Math.max(0, p.jetty);
  // Under a jetty the joists eat into the storey top; keep the door a little
  // lower there so a hood fits above it (but never below 1.9 m).
  const underJetty = floors > 1 && jetty > 0.005;
  const doorH = round(
    Math.min(clamp(p.storeyHeight - (underJetty ? 0.75 : 0.6), 1.9, 2.05), p.storeyHeight - 0.45),
    0.05,
  );
  const recessWindow = -Math.min(0.14, t * 0.35);
  const recessDoor = -Math.min(0.16, t * 0.4);

  // Window columns along the front/back walls are shared by all storeys so
  // upper windows line up with the ones below. Columns keep a pier between
  // lintels (and room for open shutters).
  const cornerMargin = t + 0.75;
  const pierPitch = winW + 0.32 + MIN_PIER + (p.shutters ? winW * 0.55 : 0);
  const eaveColumns = columns(p.width, cornerMargin, p.windowSpacing, pierPitch);
  const doorU = placeDoor(p, eaveColumns, cornerMargin, doorW, winW);
  let overhangEave = p.eaveOverhang;
  // Flower boxes on one or two storeys, not on every window of the house.
  const boxStoreys = new Set<number>(
    floors === 1
      ? [0]
      : rng.fork('flower-boxes').weighted([
          [[1], 3],
          [[0], 2],
          [[0, 1], 2],
        ] as const),
  );

  const storeys: StoreySpec[] = [];
  const allOpenings: Opening[] = [];
  let door: Opening | null = null;

  for (let s = 0; s < floors; s++) {
    const style = s === 0 ? p.groundStyle : p.upperStyle;
    const jet = jetty * s;
    const halfW = p.width / 2;
    const halfD = p.depth / 2 + jet;
    const y0 = s === 0 ? 0 : storeys[s - 1].y1;
    const floorY = s === 0 ? p.plinthHeight : y0;
    const top = s === floors - 1;
    // Upper windows a little shorter than the ground floor's, the top floor's shortest.
    const winHs = round(winH * (s === 0 ? 1 : top ? 0.9 : 0.95), 0.05);
    const winSill = floorY + (s === 0 ? 0.85 : 0.8);
    let y1 = floorY + p.storeyHeight;

    if (top) {
      // Knee wall: the eave edge drops by overhang·tan(pitch) plus the
      // fascia, and must stay clear above the top storey's window lintels
      // (and on a cottage above the door and its hood). Raise the walls by
      // the shortfall; if that would be silly, shorten the overhang too.
      const sinP = Math.sin(pitch);
      const cosP = Math.cos(pitch);
      const fasciaBelow = FASCIA_T * sinP + FASCIA_DROP * cosP;
      let need = winSill + winHs + LINTEL_H + 0.08;
      if (s === 0) need = Math.max(need, floorY + doorH + LINTEL_H + HOOD_ROOM, 2.1);
      let knee = Math.max(0, need + overhangEave * tanP + fasciaBelow - y1);
      const maxKnee = 0.8;
      if (knee > maxKnee) {
        knee = maxKnee;
        overhangEave = clamp((y1 + knee - need - fasciaBelow) / tanP, 0.1, overhangEave);
      }
      y1 = round(y1 + knee, 0.01);
    }

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

    if (top) {
      for (const w of walls) {
        if (!w.isGable) continue;
        w.gable = { apexU: w.length / 2, apexY: y1 + (w.length / 2) * tanP, eaveY: y1 };
      }
    }

    // --- openings -------------------------------------------------------
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
      const lintel: Rect = { u0: u0 - 0.16, u1: u1 + 0.16, y0: y1o, y1: y1o + LINTEL_H };
      const sill: Rect | null = isDoor ? null : { u0: u0 - 0.1, u1: u1 + 0.1, y0: y0o - SILL_H, y1: y0o };
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
        flowerBox: p.flowerBoxes && kind === 'window' && boxStoreys.has(s) && (s > 0 || wall.side === 'front'),
      };
      wall.openings.push(o);
      allOpenings.push(o);
      return o;
    };

    for (const wall of walls) {
      if (!wall.isGable) {
        // Front / back: shared columns. Ground-floor front gets the door.
        const hasDoor = s === 0 && wall.side === 'front';
        if (hasDoor) door = makeOpening(wall, 'door', doorU, doorW, floorY, doorH, p.archedDoor);
        // The back wall is walked in the opposite direction; mirror columns
        // so windows line up front-to-back too.
        let cols = eaveColumns.map((uc) => (wall.side === 'back' ? wall.length - uc : uc));
        if (hasDoor) {
          const clearance = (doorW + winW) / 2 + 0.32 + MIN_PIER;
          cols = cols.filter((u) => Math.abs(u - doorU) >= clearance);
        } else if (wall.side === 'back' && s === 0) {
          cols = pattern(cols, wall.length, rng.weighted([['full', 3], ['sparse', 2]] as const));
        }
        for (const u of cols) makeOpening(wall, 'window', u, winW, winSill, winHs, false);
      } else {
        // Gable walls: their own columns, a deliberate pattern per storey.
        const cols = columns(wall.length, cornerMargin, p.windowSpacing * 1.1, pierPitch * 0.95);
        const chimneyWall = p.chimney && wall.side === p.chimneySide;
        const choice =
          s === 0
            ? rng.weighted([
                ['full', 3],
                ['centre', 2],
                ['blank', chimneyWall || style === 'stone' ? 1.5 : 0.3],
              ] as const)
            : rng.weighted([
                ['full', 4],
                ['centre', 1],
              ] as const);
        for (const u of pattern(cols, wall.length, choice)) {
          makeOpening(wall, 'window', u, winW * 0.9, winSill, winHs * 0.92, false);
        }
        if (top && wall.gable) atticWindows(wall, rng, makeOpening);
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
  const covering = p.roofCovering && p.roofCovering !== 'auto' ? p.roofCovering : pickCovering(p.palette.roof, rng.fork('covering'));
  const deckThickness = 0.12;
  const roof: RoofSpec = {
    type: 'gable',
    covering,
    pitch,
    eaveY: top.y1,
    halfDepth: top.maxZ,
    ridgeY: top.y1 + top.maxZ * tanP,
    minX: top.minX,
    maxX: top.maxX,
    overhangEave,
    overhangGable: p.gableOverhang,
    deckThickness,
    coverThickness: deckThickness + COVER_TOP[covering],
    fasciaThickness: FASCIA_T,
    fasciaDrop: FASCIA_DROP,
    dormers: [],
    holes: [],
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
    const maxOff = Math.max(0, 1.2 / tanP - sz / 2);
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
    roof.holes.push({ x0: x - sx / 2, x1: x + sx / 2, z0: z - sz / 2, z1: z + sz / 2, kind: 'chimney' });
  }

  roof.dormers = planDormers(p, roof, top, eaveColumns, chimney, rng.fork('dormers'));
  for (const d of roof.dormers) {
    const za = d.sign * d.backZ;
    const zb = d.sign * d.faceZ;
    roof.holes.push({ x0: d.x - d.width / 2, x1: d.x + d.width / 2, z0: Math.min(za, zb), z1: Math.max(za, zb), kind: 'dormer' });
  }

  const walls = storeys.flatMap((s) => s.walls);
  const maxZ = Math.max(...storeys.map((s) => s.maxZ)) + overhangEave;
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
  const doorHood = hoodZone(d, storeys[0], storeys[1]?.style ?? null, storeys.length === 1 ? roof : null);

  // Level of detail from the amount of wall: ~1 up to an ordinary 2-storey house.
  let wallArea = 0;
  for (const w of walls) {
    wallArea += w.length * (w.y1 - w.y0);
    if (w.gable) wallArea += (w.length * (w.gable.apexY - w.gable.eaveY)) / 2;
  }
  const detail = clamp(220 / wallArea, 0.45, 1);

  const glazing = rng.fork('glazing').chance(0.55) ? 'cross' : 'six';

  return { params: p, storeys, walls, openings: allOpenings, door: d, stoop, doorHood, roof, chimney, detail, glazing, bounds };
}

type WallPattern = 'full' | 'sparse' | 'centre' | 'blank';

/**
 * Which window columns a wall keeps. Never leaves a lone window off-centre:
 * 'sparse' keeps the outer pair (and the middle one), 'centre' a single
 * centred window.
 */
function pattern(cols: number[], length: number, kind: WallPattern): number[] {
  if (kind === 'blank') return [];
  if (kind === 'centre' || cols.length === 1) return cols.length ? [length / 2] : [];
  if (kind === 'sparse' && cols.length >= 3) {
    const keep = [cols[0], cols[cols.length - 1]];
    if (cols.length % 2 === 1) keep.splice(1, 0, cols[(cols.length - 1) / 2]);
    return keep;
  }
  return cols;
}

/**
 * Door position: as close to the requested offset as possible, but either on
 * a window column (so the windows above line up with it) or centred between
 * two columns that leave room for it.
 */
function placeDoor(p: HouseParams, cols: number[], margin: number, doorW: number, winW: number): number {
  const lo = margin + doorW / 2;
  const hi = p.width - margin - doorW / 2;
  const half = Math.max(0, (hi - lo) / 2);
  const wanted = p.width / 2 + clamp(p.doorOffset, -1, 1) * half;
  const candidates = [...cols];
  for (let i = 0; i + 1 < cols.length; i++) {
    if (cols[i + 1] - cols[i] >= doorW + winW + 2 * (0.32 + MIN_PIER)) candidates.push((cols[i] + cols[i + 1]) / 2);
  }
  const ok = candidates.filter((u) => u >= lo - 1e-6 && u <= hi + 1e-6);
  if (!ok.length) return clamp(wanted, Math.min(lo, p.width / 2), Math.max(hi, p.width / 2));
  return ok.reduce((best, u) => (Math.abs(u - wanted) < Math.abs(best - wanted) ? u : best));
}

/**
 * Windows in the gable triangle above the top storey: one attic window,
 * scaled with the triangle; tall gables get a loft pair below it.
 */
function atticWindows(
  wall: WallSpec,
  rng: Rng,
  make: (wall: WallSpec, kind: OpeningKind, uc: number, w: number, y0: number, h: number, arched: boolean) => Opening,
): void {
  const g = wall.gable!;
  const triH = g.apexY - g.eaveY;
  const mid = wall.length / 2;
  const fits = (uc: number, w: number, y0: number, h: number) =>
    y0 + h + LINTEL_H + 0.15 < gableTopAt(wall, uc - w / 2 - 0.2) &&
    y0 + h + LINTEL_H + 0.15 < gableTopAt(wall, uc + w / 2 + 0.2) &&
    uc - w / 2 - 0.2 > wall.u0 &&
    uc + w / 2 + 0.2 < wall.u1;
  let topY0 = g.eaveY + Math.max(0.35, triH * 0.18);
  if (triH > 3.5 && rng.chance(0.6)) {
    // Loft pair low in the gable, a smaller window up near the apex.
    const lw = 0.6;
    const lh = Math.min(0.95, triH * 0.22);
    const ly0 = g.eaveY + 0.4;
    const off = clamp(triH * 0.32, 0.75, 1.2);
    if (fits(mid - off, lw, ly0, lh) && fits(mid + off, lw, ly0, lh)) {
      make(wall, 'attic', mid - off, lw, ly0, lh, false);
      make(wall, 'attic', mid + off, lw, ly0, lh, false);
      topY0 = ly0 + lh + LINTEL_H + SILL_H + 0.35;
    }
  }
  const aw = clamp(0.5 + triH * 0.06, 0.55, 0.8);
  const ah = Math.min(1.0, triH * 0.3, g.apexY - topY0 - LINTEL_H - 0.6);
  if (ah >= 0.45 && fits(mid, aw, topY0, ah)) make(wall, 'attic', mid, aw, topY0, ah, rng.chance(0.5));
}

/** Room above the door for a hood: under the joists/band of the storey above, or the eave. */
function hoodZone(
  door: Opening,
  ground: StoreySpec,
  upperStyle: WallStyle | null,
  roofOverDoor: RoofSpec | null,
): Rect & { w1: number } {
  // Joist ends under a jetty; a timber top plate / storey band otherwise.
  const band = ground.style === 'timber' || (ground.style === 'plaster' && upperStyle === 'stone') ? 0.23 : 0.03;
  let ceiling = ground.y1 - (ground.joistZone > 0 ? ground.joistZone + 0.03 : band);
  if (roofOverDoor) {
    const r = roofOverDoor;
    // Under the eave (rafter tails, soffit) as far out as the hood reaches or the eave ends.
    const out = Math.min(0.6, r.overhangEave);
    ceiling = Math.min(ceiling, r.eaveY - out * Math.tan(r.pitch) - r.fasciaDrop * Math.cos(r.pitch));
  }
  return {
    u0: door.lintel.u0 - 0.12,
    u1: door.lintel.u1 + 0.12,
    y0: door.lintel.y1,
    y1: Math.max(door.lintel.y1, ceiling),
    w1: 0.75,
  };
}

/**
 * Dormers: on steep enough roofs, sometimes, lined up with the window
 * columns below and clear of the chimney and the gable ends.
 */
function planDormers(
  p: HouseParams,
  roof: RoofSpec,
  top: StoreySpec,
  cols: number[],
  chimney: ChimneySpec | null,
  rng: Rng,
): DormerSpec[] {
  const pitchDeg = (roof.pitch * 180) / Math.PI;
  const chance = p.floors === 1 ? 0.65 : 0.35;
  // -1 (or missing): the generator decides; 0–3: the user asked for that many.
  const wanted = p.dormers ?? -1;
  if (wanted === 0) return [];
  const auto = rng.chance(chance);
  if (wanted < 0 ? pitchDeg < 40 || !auto : pitchDeg < 32) return [];
  const tanP = Math.tan(roof.pitch);
  const cover = roof.coverThickness / Math.cos(roof.pitch);
  const firstKind: 'gable' | 'shed' = rng.chance(0.65) ? 'gable' : 'shed';
  const width = round(rng.range(1.15, 1.45), 0.05);
  const winW = round(Math.min(width - 0.5, rng.range(0.6, 0.8)), 0.05);
  const firstWinH = round(rng.range(0.7, 0.9), 0.05);
  // The dormer's face stands just behind the eave wall line.
  const faceZ = top.maxZ - round(rng.range(0.35, 0.6), 0.05);
  const baseY = roofSurfaceY(roof, faceZ);
  const pitchDraw = rng.next();

  /** Heights of a dormer of this kind and window height, or null if it doesn't fit the roof. */
  const fit = (kind: 'gable' | 'shed', winH: number) => {
    const faceH = winH + 0.25 + 0.3; // sill band + window + head band
    const eaveY = baseY + faceH;
    const dPitch = kind === 'gable' ? 0.75 + 0.2 * pitchDraw : 0.2 + 0.12 * pitchDraw;
    const dTan = Math.tan(dPitch);
    let ridgeY: number;
    let backZ: number;
    if (kind === 'gable') {
      ridgeY = eaveY + (width / 2) * dTan;
      // Where the main covering reaches the dormer ridge.
      backZ = roof.halfDepth - (ridgeY - roof.eaveY - cover) / tanP;
    } else {
      // The shed roof rises more gently than the main roof and meets it.
      if (tanP <= dTan + 0.05) return null;
      const run = faceH / (tanP - dTan);
      backZ = faceZ - run;
      ridgeY = eaveY + run * dTan;
    }
    if (backZ < 0.35 || faceZ - backZ < 0.5) return null;
    return { kind, winH, eaveY, ridgeY, backZ, dPitch };
  };
  let f = fit(firstKind, firstWinH);
  if (!f && wanted > 0) {
    // Asked for explicitly: try the other kind and a smaller window before giving up.
    const other = firstKind === 'gable' ? 'shed' : 'gable';
    for (const [k, h] of [[other, firstWinH], [firstKind, 0.6], [other, 0.6]] as const) {
      f = fit(k, h);
      if (f) break;
    }
  }
  if (!f) return [];
  const { kind, winH, eaveY, ridgeY, backZ, dPitch } = f;

  // Candidate centres: the window columns, away from gables and the chimney.
  const xs = cols
    .map((u) => u - p.width / 2)
    .filter((x) => x - width / 2 > roof.minX + 0.8 && x + width / 2 < roof.maxX - 0.8)
    .filter((x) => !chimney || Math.abs(x - chimney.x) > chimney.sx / 2 + width / 2 + 0.5);
  if (!xs.length) return [];
  // 1, 2 (symmetric pair) or 3 dormers.
  let chosen: number[];
  const three = xs.length >= 3 && rng.chance(0.35);
  const two = !three && xs.length >= 2 && rng.chance(0.6); // same draws as before the override existed
  const count = wanted > 0 ? Math.min(wanted, xs.length) : three ? 3 : two ? 2 : 1;
  if (count >= 3) chosen = [xs[0], xs[Math.floor(xs.length / 2)], xs[xs.length - 1]];
  else if (count === 2) chosen = [xs[0], xs[xs.length - 1]];
  else chosen = [xs.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a))];
  // Keep them apart.
  chosen = chosen.filter((x, i) => i === 0 || x - chosen[i - 1] > width + 0.6);

  const sides: (1 | -1)[] = rng.chance(0.3) ? [1, -1] : [1];
  const out: DormerSpec[] = [];
  for (const sign of sides) {
    for (const x of chosen) {
      if (sign === -1 && chimney && chimney.z < 0 && Math.abs(x - chimney.x) < chimney.sx / 2 + width / 2 + 0.5) continue;
      const wy0 = baseY + 0.25;
      out.push({
        id: `dormer-${sign > 0 ? 'f' : 'b'}${out.length}`,
        sign,
        x,
        width,
        faceZ,
        baseY,
        eaveY,
        ridgeY,
        backZ,
        roof: kind,
        pitch: dPitch,
        style: top.style,
        window: { x0: x - winW / 2, x1: x + winW / 2, y0: wy0, y1: wy0 + winH, arched: kind === 'gable' && rng.chance(0.3) },
      });
    }
  }
  return out;
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

/**
 * Evenly spaced centres along a wall, keeping `margin` clear at both ends,
 * about `spacing` apart but never closer than `minPitch` (lintels, piers,
 * open shutters need the room).
 */
function columns(length: number, margin: number, spacing: number, minPitch: number): number[] {
  const avail = length - 2 * margin;
  if (avail < 0) return length > 2.2 ? [length / 2] : [];
  let n = Math.floor(avail / spacing + 0.2) + 1;
  while (n > 1 && avail / (n - 1) < minPitch) n--;
  if (n <= 1) return [length / 2];
  return Array.from({ length: n }, (_, i) => margin + (avail * i) / (n - 1));
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

function round(v: number, step: number): number {
  return Number((Math.round(v / step) * step).toFixed(4));
}
