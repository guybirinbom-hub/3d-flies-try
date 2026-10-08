import * as THREE from 'three';
import { PartBuilder, mix, vary } from '../builder';
import { OUTWARD, wallExplode } from '../explode';
import type { PartDef } from '../house';
import { hitsOpening, type HouseLayout, type Rect, type StoreySpec, type WallSpec } from '../layout';
import type { Rng } from '../rng';

/**
 * Half-timber framing ("Fachwerk") on every timber storey, plus the floor
 * bands, joist ends and brackets between storeys.
 *
 * Everything that lies in a wall plane is a convex polygon in wall-local
 * (u, y), extruded along w with a softly rounded front edge (see
 * `prismGeometry`). Members are laid out as a carpenter would: sill and top
 * plate run continuously, corner posts and window posts stand between them,
 * studs keep plaster panels small, rails line up with the window sills and
 * lintels, and braces fill some panels. Members never overlap in the same
 * depth layer: they either abut exactly, or the one tucked underneath sits
 * a few millimetres further back (see `W`), so nothing z-fights.
 *
 * Gable triangles get edge rafters, a king post (or posts around the attic
 * window), studs, a collar and struts, all clipped 2 cm below the roof line.
 */
export const part: PartDef = {
  name: 'timber',
  label: 'Timber framing',
  explode: [0, 0, 0],
  build: ({ layout, rng }) => {
    const c = new Carpenter(layout, rng);
    const storeys = layout.storeys;

    // Joist zone at the top of each storey that carries a jetty above it.
    const joistZone = storeys.map((st) => st.joistZone);

    storeys.forEach((st, s) => {
      const yTop = st.y1 - joistZone[s];
      if (st.style === 'timber') frameStorey(c, st, yTop);
      if (s > 0) storeyBoundary(c, storeys[s - 1], st, storeys[s - 1].y1 - joistZone[s - 1]);
    });
    return c.builders();
  },
};

// ---------------------------------------------------------------------------
// Dimensions & house-wide choices
// ---------------------------------------------------------------------------

/**
 * Front faces (w) of the depth layers. Members in a later layer may tuck
 * behind members of an earlier one; members within a layer only abut.
 */
const W = {
  /** Sills, plates, storey bands, edge rafters. */
  plate: 0.045,
  /** Corner posts, window posts, studs, king posts. */
  post: 0.04,
  /** Rails and collars. */
  rail: 0.035,
  /** Braces and struts: 5 mm behind the posts and rails they meet. */
  brace: 0.03,
  /** Joist ends under a jetty (relative to the upper wall's face). */
  joist: 0.03,
  /** Back face of members lying on the wall face (2 cm into the plaster). */
  back: -0.02,
} as const;

/** How far braces and rails run underneath the members in front of them. */
const TUCK = 0.015;
/** Narrowest plaster panel worth keeping next to a post. */
const MIN_PANEL = 0.22;

interface Dims {
  /** Width of posts and studs. */
  post: number;
  /** Corner post section (square, wraps the corner). */
  corner: number;
  sill: number;
  plate: number;
  rail: number;
  brace: number;
  /** Edge rafter width, measured perpendicular to the slope. */
  rafter: number;
  collar: number;
  joistW: number;
  joistH: number;
  joistSpacing: number;
  /** Widest plaster panel before a stud is added. */
  maxPanel: number;
}

type CornerStyle = 'k' | 'strebe' | 'feet';
type PanelStyle = 'cross' | 'vee' | 'diag' | 'none';

interface FrameStyle {
  /** Bracing in the bays next to the corner posts. */
  corner: CornerStyle;
  /** Low panels under windows and rails (the parapet zone). */
  parapet: PanelStyle;
  /** Tall middle panels between the rails of windowless bays. */
  middle: PanelStyle;
}

// ---------------------------------------------------------------------------
// 2D polygons in wall-local (u, y)
// ---------------------------------------------------------------------------

type P2 = [number, number];
type Poly = P2[];

/** A brace: a strip of the house's brace width along the segment a → b. */
interface Strip {
  a: P2;
  b: P2;
  width: number;
}

function rectPoly(u0: number, u1: number, y0: number, y1: number): Poly {
  return [
    [u0, y0],
    [u1, y0],
    [u1, y1],
    [u0, y1],
  ];
}

/** Keep the part of a convex polygon where nx·u + ny·y ≤ d (Sutherland–Hodgman step). */
function clipHalf(poly: Poly, nx: number, ny: number, d: number): Poly {
  const out: Poly = [];
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

function clipRect(poly: Poly, r: Rect): Poly {
  let p = clipHalf(poly, -1, 0, -r.u0);
  p = clipHalf(p, 1, 0, r.u1);
  p = clipHalf(p, 0, -1, -r.y0);
  return clipHalf(p, 0, 1, r.y1);
}

function grow(r: Rect, left: number, right = left, bottom = left, top = left): Rect {
  return { u0: r.u0 - left, u1: r.u1 + right, y0: r.y0 - bottom, y1: r.y1 + top };
}

/** Unit direction and left normal of a strip. */
function stripFrame(s: Strip): { tx: number; ty: number; nx: number; ny: number } {
  const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1;
  const tx = (s.b[0] - s.a[0]) / len;
  const ty = (s.b[1] - s.a[1]) / len;
  return { tx, ty, nx: -ty, ny: tx };
}

/** The strip as a long rectangle (overshooting both ends; callers clip it). */
function stripPoly(s: Strip, overshoot = 1): Poly {
  const { tx, ty, nx, ny } = stripFrame(s);
  const h = s.width / 2;
  const a: P2 = [s.a[0] - tx * overshoot, s.a[1] - ty * overshoot];
  const b: P2 = [s.b[0] + tx * overshoot, s.b[1] + ty * overshoot];
  return [
    [a[0] - nx * h, a[1] - ny * h],
    [b[0] - nx * h, b[1] - ny * h],
    [b[0] + nx * h, b[1] + ny * h],
    [a[0] + nx * h, a[1] + ny * h],
  ];
}

/** The convex pieces of `poly` left on either side of a strip (poly minus strip). */
function minusStrip(poly: Poly, s: Strip): Poly[] {
  const { nx, ny } = stripFrame(s);
  const d = nx * s.a[0] + ny * s.a[1];
  const h = s.width / 2;
  // Left of the strip: n·p ≥ d + h  →  -n·p ≤ -(d + h). Right: n·p ≤ d - h.
  return [clipHalf(poly, -nx, -ny, -(d + h)), clipHalf(poly, nx, ny, d - h)].filter((p) => p.length >= 3);
}

function signedArea(p: Poly): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

function perimeter(p: Poly): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    s += Math.hypot(q[0] - p[i][0], q[1] - p[i][1]);
  }
  return s;
}

/** Big enough to be worth a beam: some area, and not a hair-thin sliver. */
function isSolid(p: Poly, minArea = 0.002): boolean {
  if (p.length < 3) return false;
  const a = Math.abs(signedArea(p));
  return a >= minArea && a / perimeter(p) >= 0.012;
}

function bounds(p: Poly): Rect {
  const us = p.map((v) => v[0]);
  const ys = p.map((v) => v[1]);
  return { u0: Math.min(...us), u1: Math.max(...us), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Drop consecutive (near-)duplicate vertices. */
function dedupe(p: Poly): Poly {
  const out: Poly = [];
  for (const v of p) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(v[0] - last[0], v[1] - last[1]) > 1e-4) out.push(v);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-4) out.pop();
  return out;
}

/** Offset a CCW polygon inwards by c (mitred; very sharp corners are limited). */
function inset(p: Poly, c: number): Poly {
  const n = p.length;
  return p.map((v, i) => {
    const prev = p[(i - 1 + n) % n];
    const next = p[(i + 1) % n];
    const l1 = Math.hypot(v[0] - prev[0], v[1] - prev[1]) || 1;
    const l2 = Math.hypot(next[0] - v[0], next[1] - v[1]) || 1;
    // Inward (left) normals of the two edges meeting at v.
    const n1x = -(v[1] - prev[1]) / l1;
    const n1y = (v[0] - prev[0]) / l1;
    const n2x = -(next[1] - v[1]) / l2;
    const n2y = (next[0] - v[0]) / l2;
    const k = Math.max(0.25, 1 + n1x * n2x + n1y * n2y);
    return [v[0] + ((n1x + n2x) * c) / k, v[1] + ((n1y + n2y) * c) / k] as P2;
  });
}

// ---------------------------------------------------------------------------
// Geometry: a polygon extruded along z with softly rounded cap edges
// ---------------------------------------------------------------------------

/**
 * Prism over polygon `poly` (x, y) from z = z0 to z = z1. The rim of the
 * front cap (z1) — and of the back cap when `chamferBack` > 0 — is cut by a
 * small chamfer whose normals blend from the side to the cap, so it shades
 * like a rounded edge at a fraction of the triangles of a rounded box
 * (20 triangles for a rectangular beam).
 */
function prismGeometry(poly: Poly, z0: number, z1: number, chamferFront: number, chamferBack = 0): THREE.BufferGeometry | null {
  let pts = dedupe(poly);
  if (pts.length < 3) return null;
  let area = signedArea(pts);
  if (Math.abs(area) < 1e-7 || !(z1 > z0)) return null;
  if (area < 0) {
    pts = pts.slice().reverse();
    area = -area;
  }
  const maxChamfer = (0.8 * area) / perimeter(pts);
  const cf = Math.max(0, Math.min(chamferFront, maxChamfer, (z1 - z0) * 0.45));
  const cb = Math.max(0, Math.min(chamferBack, maxChamfer, (z1 - z0) * 0.45));
  const front = cf > 0 ? inset(pts, cf) : pts;
  const back = cb > 0 ? inset(pts, cb) : pts;

  const pos: number[] = [];
  const nor: number[] = [];
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  type V = [number, number, number];
  const tri = (a: V, b: V, c: V, na: V, nb: V, nc: V) => {
    // Wind each triangle so its geometric normal agrees with its shading normals.
    va.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    vb.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    vc.crossVectors(va, vb);
    const want = vc.x * (na[0] + nb[0] + nc[0]) + vc.y * (na[1] + nb[1] + nc[1]) + vc.z * (na[2] + nb[2] + nc[2]);
    if (want < 0) {
      [b, c] = [c, b];
      [nb, nc] = [nc, nb];
    }
    pos.push(...a, ...b, ...c);
    nor.push(...na, ...nb, ...nc);
  };
  const quad = (a: V, b: V, c: V, d: V, na: V, nb: V, nc: V, nd: V) => {
    tri(a, b, c, na, nb, nc);
    tri(a, c, d, na, nc, nd);
  };

  // Caps: triangulate the outline once and reuse the indices for the insets.
  const faces = THREE.ShapeUtils.triangulateShape(
    pts.map(([x, y]) => new THREE.Vector2(x, y)),
    [],
  );
  const F: V = [0, 0, 1];
  const B: V = [0, 0, -1];
  for (const [i, j, k] of faces) {
    tri([front[i][0], front[i][1], z1], [front[j][0], front[j][1], z1], [front[k][0], front[k][1], z1], F, F, F);
    tri([back[i][0], back[i][1], z0], [back[j][0], back[j][1], z0], [back[k][0], back[k][1], z0], B, B, B);
  }

  // Rim: back chamfer → straight side → front chamfer, per edge.
  const zs0 = z0 + cb;
  const zs1 = z1 - cf;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const p = pts[i];
    const q = pts[j];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const o: V = [(q[1] - p[1]) / len, -(q[0] - p[0]) / len, 0]; // outward for CCW
    quad([p[0], p[1], zs0], [q[0], q[1], zs0], [q[0], q[1], zs1], [p[0], p[1], zs1], o, o, o, o);
    if (cf > 0) {
      const fi = front[i];
      const fj = front[j];
      quad([p[0], p[1], zs1], [q[0], q[1], zs1], [fj[0], fj[1], z1], [fi[0], fi[1], z1], o, o, F, F);
    }
    if (cb > 0) {
      const bi = back[i];
      const bj = back[j];
      quad([bi[0], bi[1], z0], [bj[0], bj[1], z0], [q[0], q[1], zs0], [p[0], p[1], zs0], B, B, o, o);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** Local prism axes (x, y, z) → wall-local (w, y, -u): for members seen in profile. */
const PROFILE = new THREE.Matrix4().makeRotationY(-Math.PI / 2);

// ---------------------------------------------------------------------------
// The carpenter: dimensions, style, colours and one builder per wall
// ---------------------------------------------------------------------------

class Carpenter {
  readonly d: Dims;
  readonly style: FrameStyle;
  private readonly byWall = new Map<string, PartBuilder>();

  constructor(
    readonly layout: HouseLayout,
    readonly rng: Rng,
  ) {
    const r = rng.fork('dims');
    this.d = {
      post: round(r.range(0.16, 0.2)),
      corner: round(r.range(0.23, 0.26)),
      sill: round(r.range(0.19, 0.22)),
      plate: round(r.range(0.17, 0.2)),
      rail: round(r.range(0.13, 0.15)),
      brace: round(r.range(0.14, 0.17)),
      rafter: round(r.range(0.19, 0.22)),
      collar: round(r.range(0.14, 0.16)),
      joistW: 0.12,
      joistH: 0.15,
      joistSpacing: round(r.range(0.42, 0.5)),
      maxPanel: round(r.range(1.0, 1.3)),
    };
    const s = rng.fork('style');
    this.style = {
      corner: s.weighted([
        ['k', 5],
        ['strebe', 3],
        ['feet', 2],
      ] as const),
      parapet: s.weighted([
        ['cross', 5],
        ['vee', 3],
        ['none', 2],
      ] as const),
      middle: s.weighted([
        ['none', 4],
        ['cross', 3],
        ['diag', 3],
      ] as const),
    };
  }

  builders(): PartBuilder[] {
    return [...this.byWall.values()];
  }

  builder(wall: WallSpec): PartBuilder {
    let b = this.byWall.get(wall.id);
    if (!b) {
      b = new PartBuilder(`timber:${wall.id}`);
      b.explode = wallExplode(wall, OUTWARD.timber);
      this.byWall.set(wall.id, b);
    }
    return b;
  }

  /** Per-beam colour: the palette's timber with a little hand-made variation. */
  timberColor(): THREE.Color {
    return vary(this.layout.params.palette.timber, this.rng, 0.04, 0.03, 0.006);
  }

  private chamfer(): number {
    return this.rng.range(0.015, 0.024);
  }

  /**
   * A member lying on the wall face: polygon in wall-local (u, y), from
   * w = back to w = front (the front varies by a few millimetres per member).
   * `owner` picks the builder (defaults to the wall the polygon is drawn on);
   * `endGrain` darkens the faces at the member's ends (horizontal members).
   */
  beam(wall: WallSpec, poly: Poly | null, front: number, back: number = W.back, opts: BeamOptions = {}): void {
    if (!poly || !isSolid(poly)) return;
    // Up to 2.5 mm proud of the layer behind, never past the layer's own front.
    const g = prismGeometry(poly, back, front - this.rng.range(0, 0.0025), this.chamfer(), opts.chamferBack ?? 0);
    if (!g) return;
    const paint = opts.endGrain ? endGrain(wall.dir.x, wall.dir.z) : undefined;
    this.builder(opts.owner ?? wall).add(g, 'timber', this.timberColor(), wall.frame, paint);
  }

  /**
   * A member seen in profile (joists, brackets): polygon in wall-local
   * (w, y), spanning u ∈ [u0, u1], rounded on both sides. `endGrain` darkens
   * the faces looking out of the wall (joist heads).
   */
  profile(wall: WallSpec, poly: Poly, u0: number, u1: number, opts: { mat?: 'timber' | 'wood'; color?: THREE.Color; endGrain?: boolean } = {}): void {
    const g = prismGeometry(poly, -u1, -u0, this.chamfer(), this.chamfer());
    if (!g) return;
    const m = wall.frame.clone().multiply(PROFILE);
    const paint = opts.endGrain ? endGrain(wall.normal.x, wall.normal.z) : undefined;
    this.builder(wall).add(g, opts.mat ?? 'timber', opts.color ?? this.timberColor(), m, paint);
  }
}

interface BeamOptions {
  owner?: WallSpec;
  chamferBack?: number;
  endGrain?: boolean;
}

/** Vertex painter: faces whose normal runs along the (horizontal) axis show darker end grain. */
function endGrain(ax: number, az: number): (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void {
  return (_p, n, out) => {
    if (Math.abs(n.x * ax + n.z * az) > 0.7) out.multiplyScalar(0.72);
  };
}

function round(v: number, step = 0.005): number {
  return Math.round(v / step) * step;
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

// ---------------------------------------------------------------------------
// Members that wrap the corners: sills, plates, bands, corner posts
// ---------------------------------------------------------------------------

/**
 * u-range and depth of a horizontal member that wraps the corners. Eave
 * walls (front/back) run past both corners and go as deep as the corner
 * posts, so their end grain shows on the gable face; gable walls stop
 * exactly where those ends begin.
 */
function wrapSpan(c: Carpenter, wall: WallSpec): { u0: number; u1: number; back: number } {
  const S = c.d.corner;
  const e = W.plate;
  if (wall.isGable) return { u0: S - e, u1: wall.length - S + e, back: W.back };
  return { u0: -e, u1: wall.length + e, back: e - S };
}

/** Parts of [u0, u1] not covered by an opening surround overlapping [y0, y1]. */
function freeSpans(wall: WallSpec, u0: number, u1: number, y0: number, y1: number): [number, number][] {
  let spans: [number, number][] = [[u0, u1]];
  for (const o of wall.openings) {
    const s = o.surround;
    if (s.y0 >= y1 - 1e-6 || s.y1 <= y0 + 1e-6) continue;
    spans = spans.flatMap(([a, b]): [number, number][] => {
      if (s.u1 <= a || s.u0 >= b) return [[a, b]];
      const out: [number, number][] = [];
      if (s.u0 > a) out.push([a, s.u0]);
      if (s.u1 < b) out.push([s.u1, b]);
      return out;
    });
  }
  return spans.filter(([a, b]) => b - a >= 0.06);
}

/** A sill, plate or storey band along a whole wall, interrupted by openings. */
function wrapBeam(c: Carpenter, wall: WallSpec, y0: number, y1: number, owner?: WallSpec): void {
  const span = wrapSpan(c, wall);
  for (const [a, b] of freeSpans(wall, span.u0, span.u1, y0, y1)) {
    c.beam(wall, rectPoly(a, b, y0, y1), W.plate, span.back, { owner, chamferBack: wall.isGable ? 0 : 0.012, endGrain: true });
  }
}

/** Square posts that wrap both corners of an eave wall (they cover the gable faces too). */
function cornerPosts(c: Carpenter, wall: WallSpec, y0: number, y1: number): void {
  const S = c.d.corner;
  const L = wall.length;
  const back = W.plate - S;
  c.beam(wall, rectPoly(-W.post, S - W.plate, y0, y1), W.post, back, { chamferBack: 0.015 });
  c.beam(wall, rectPoly(L - S + W.plate, L + W.post, y0, y1), W.post, back, { chamferBack: 0.015 });
}

// ---------------------------------------------------------------------------
// A timber storey
// ---------------------------------------------------------------------------

function frameStorey(c: Carpenter, st: StoreySpec, yTop: number): void {
  const d = c.d;
  const yBottom = st.index === 0 ? st.floorY : st.y0;
  // Lower the plate a little if the windows reach close to the top, so it
  // can run over them instead of being broken up.
  const winTop = Math.max(-Infinity, ...st.walls.flatMap((w) => w.openings.filter((o) => o.kind === 'window').map((o) => o.surround.y1)));
  const clearance = yTop - winTop;
  const plateH = clearance >= 0.1 && clearance < d.plate ? clearance : d.plate;
  for (const wall of st.walls) {
    frameWall(c, st, wall, yBottom, yTop, plateH);
    if (wall.gable) frameGable(c, wall);
  }
}

interface Bay {
  a: number;
  b: number;
  /** -1: a corner post is on the left (low u); 1: on the right; 0: none. */
  corner: -1 | 0 | 1;
}

interface Hole {
  a: number;
  b: number;
  y0: number;
  y1: number;
}

interface Rails {
  low: [number, number] | null;
  high: [number, number] | null;
}

function frameWall(c: Carpenter, st: StoreySpec, wall: WallSpec, yBottom: number, yTop: number, plateH: number): void {
  const d = c.d;
  const y0 = yBottom + d.sill; // top of the sill: posts stand here
  const y1 = yTop - plateH; // underside of the plate
  wrapBeam(c, wall, yBottom, y0);
  wrapBeam(c, wall, y1, yTop);
  if (!wall.isGable) cornerPosts(c, wall, y0, y1);

  const holes = openingHoles(wall, yBottom, yTop);
  const inner = { a: d.corner - W.plate, b: wall.length - d.corner + W.plate };
  const { posts, bays } = placePosts(c, holes, inner.a, inner.b);
  for (const p of posts) c.beam(wall, postPoly(c, p, y0, y1), W.post);

  const rails = railsFor(wall, st, y0, y1, d);
  for (const bay of bays) fillBay(c, wall, bay, y0, y1, rails);
  for (const h of holes) fillAroundOpening(c, wall, h, y0);
}

/** Opening surrounds within the storey as u-intervals (merged if they touch), sorted. */
function openingHoles(wall: WallSpec, yBottom: number, yTop: number): Hole[] {
  const hs = wall.openings
    .filter((o) => o.surround.y0 < yTop && o.surround.y1 > yBottom)
    .map((o) => ({ a: o.surround.u0, b: o.surround.u1, y0: o.surround.y0, y1: o.surround.y1 }))
    .sort((p, q) => p.a - q.a);
  const out: Hole[] = [];
  for (const h of hs) {
    const last = out[out.length - 1];
    if (last && h.a < last.b + 0.01) {
      last.b = Math.max(last.b, h.b);
      last.y0 = Math.min(last.y0, h.y0);
      last.y1 = Math.max(last.y1, h.y1);
    } else out.push({ ...h });
  }
  return out;
}

interface Post {
  a: number;
  b: number;
  /** Studs may lean a touch; posts next to openings stay plumb. */
  stud: boolean;
}

/**
 * Lay out the full-height posts between the corner posts: one each side of
 * every opening, then studs so no plaster bay is wider than `maxPanel`.
 * Returns the posts and the plaster bays between them.
 */
function placePosts(c: Carpenter, holes: Hole[], ua: number, ub: number): { posts: Post[]; bays: Bay[] } {
  const P = c.d.post;
  const posts: Post[] = [];
  const bays: Bay[] = [];

  // Free intervals between corners and openings.
  type Edge = 'corner' | 'hole';
  const free: { a: number; b: number; left: Edge; right: Edge }[] = [];
  let cursor = ua;
  let leftEdge: Edge = 'corner';
  for (const h of holes) {
    if (h.a > cursor) free.push({ a: cursor, b: Math.min(h.a, ub), left: leftEdge, right: 'hole' });
    cursor = Math.max(cursor, h.b);
    leftEdge = 'hole';
  }
  if (ub > cursor) free.push({ a: cursor, b: ub, left: leftEdge, right: 'corner' });

  for (const f of free) {
    const w = f.b - f.a;
    const needL = f.left === 'hole';
    const needR = f.right === 'hole';
    const nReq = Number(needL) + Number(needR);
    const cornerSide: Bay['corner'] = f.left === 'corner' ? -1 : f.right === 'corner' ? 1 : 0;
    if (w < 0.12) {
      // A sliver between two openings (or an opening and a corner): fill it.
      if (nReq > 0 && w > 0.02) posts.push({ a: f.a, b: f.b, stud: false });
      continue;
    }
    if (w < nReq * P + MIN_PANEL) {
      if (nReq === 2) {
        // Between two close openings: one wide post, or a pair of posts.
        if (w <= 0.45) posts.push({ a: f.a, b: f.b, stud: false });
        else {
          const m = (f.a + f.b) / 2;
          posts.push({ a: f.a, b: m, stud: false }, { a: m, b: f.b, stud: false });
        }
      } else if (nReq === 1) {
        if (w - P < 0.12) posts.push({ a: f.a, b: f.b, stud: false });
        else if (needL) {
          posts.push({ a: f.a, b: f.a + P, stud: false });
          bays.push({ a: f.a + P, b: f.b, corner: cornerSide });
        } else {
          posts.push({ a: f.b - P, b: f.b, stud: false });
          bays.push({ a: f.a, b: f.b - P, corner: cornerSide });
        }
      } else bays.push({ a: f.a, b: f.b, corner: cornerSide });
      continue;
    }
    let a = f.a;
    let b = f.b;
    if (needL) {
      posts.push({ a, b: a + P, stud: false });
      a += P;
    }
    if (needR) {
      posts.push({ a: b - P, b, stud: false });
      b -= P;
    }
    // Studs, evenly spaced.
    const span = b - a;
    const n = Math.max(0, Math.ceil((span - c.d.maxPanel) / (c.d.maxPanel + P)));
    const bw = (span - n * P) / (n + 1);
    for (let k = 0; k <= n; k++) {
      const u = a + k * (bw + P);
      const corner: Bay['corner'] = k === 0 && f.left === 'corner' ? -1 : k === n && f.right === 'corner' ? 1 : 0;
      bays.push({ a: u, b: u + bw, corner });
      if (k < n) posts.push({ a: u + bw, b: u + bw + P, stud: true });
    }
  }
  return { posts, bays };
}

/** A post between y0 and y1; studs lean by a few millimetres for a hand-made look. */
function postPoly(c: Carpenter, p: Post, y0: number, y1: number): Poly {
  const lean = p.stud ? c.rng.jitter(0.008) : 0;
  return [
    [p.a, y0],
    [p.b, y0],
    [p.b + lean, y1],
    [p.a + lean, y1],
  ];
}

/**
 * Rail heights for a wall: a low rail whose top lines up with the window
 * bottoms (the sill line) and a high rail matching the lintels, so the
 * horizontals run on around the house. Dropped where they would leave
 * slivers of plaster.
 */
function railsFor(wall: WallSpec, st: StoreySpec, y0: number, y1: number, d: Dims): Rails {
  const ref =
    wall.openings.find((o) => o.kind === 'window') ??
    st.walls.flatMap((w) => w.openings).find((o) => o.kind === 'window');
  const lowTop = ref ? ref.y0 : st.floorY + (st.index === 0 ? 0.85 : 0.8);
  const highBot = ref ? ref.lintel.y0 : lowTop + 1.2;
  const highTop = ref ? ref.lintel.y1 : highBot + 0.2;

  let low: Rails['low'] = [lowTop - d.rail, lowTop];
  if (low[0] - y0 < 0.18 || y1 - low[1] < 0.45) low = null;

  let high: Rails['high'] = [highBot, highTop];
  const gap = y1 - highTop;
  if (gap < 0) high = null;
  else if (gap < 0.07) high = [highBot, y1 + TUCK]; // close the sliver: run up under the plate
  else if (gap < 0.16) high = null;
  if (high && high[0] - (low ? low[1] : y0) < 0.4) high = null;
  return { low, high };
}

/** Rails, braces and panel decoration in a plaster bay between two posts. */
function fillBay(c: Carpenter, wall: WallSpec, bay: Bay, y0: number, y1: number, rails: Rails): void {
  const w = bay.b - bay.a;
  if (w < 0.12) return;
  const railRects = [rails.low, rails.high].filter((r): r is [number, number] => !!r);
  const bayRect: Rect = { u0: bay.a, u1: bay.b, y0, y1 };

  // Bays next to a corner post get the corner bracing; the rails butt into it.
  const cornerBraces = bay.corner !== 0 ? cornerBracing(c, bay, y0, y1, rails) : [];
  if (cornerBraces.length) {
    emitBraces(c, wall, cornerBraces, grow(bayRect, TUCK));
    for (const [ra, rb] of railRects) {
      let pieces: Poly[] = [railPoly(c, bay, ra, rb)];
      for (const s of cornerBraces) pieces = pieces.flatMap((p) => minusStrip(p, s));
      for (const p of pieces) c.beam(wall, p, W.rail);
    }
    return;
  }

  for (const [ra, rb] of railRects) c.beam(wall, railPoly(c, bay, ra, rb), W.rail);

  // Panels between the rails.
  const cuts = [y0, ...railRects.flat(), y1];
  const outward = (bay.a + bay.b) / 2 < wall.length / 2 ? -1 : 1;
  for (let i = 0; i + 1 < cuts.length; i += 2) {
    const panel: Rect = { u0: bay.a, u1: bay.b, y0: cuts[i], y1: cuts[i + 1] };
    const isLow = i === 0 && railRects.length > 0 && rails.low !== null;
    const isMiddle = i === 2 && rails.low !== null && rails.high !== null;
    const style = isLow ? c.style.parapet : isMiddle ? c.style.middle : 'none';
    decoratePanel(c, wall, panel, style, outward, { u0: true, u1: true, y0: true, y1: true });
  }
}

/**
 * A rail across a bay, tucked under the posts at both ends. Its top and
 * bottom edges wander by a few millimetres, like hand-hewn timber.
 */
function railPoly(c: Carpenter, bay: Bay, y0: number, y1: number): Poly {
  const j = () => c.rng.jitter(0.004);
  return [
    [bay.a - TUCK, y0 + j()],
    [bay.b + TUCK, y0 + j()],
    [bay.b + TUCK, y1 + j()],
    [bay.a - TUCK, y1 + j()],
  ];
}

/** The parapet panel under a window, between its posts. */
function fillAroundOpening(c: Carpenter, wall: WallSpec, h: Hole, y0: number): void {
  const outward = (h.a + h.b) / 2 < wall.length / 2 ? -1 : 1;
  if (h.y0 - y0 > 0.25) {
    // Parapet under a window: bounded by posts and sill; the top is the surround (no tucking).
    decoratePanel(c, wall, { u0: h.a, u1: h.b, y0, y1: h.y0 }, c.style.parapet, outward, { u0: true, u1: true, y0: true, y1: false });
  }
}

type TuckSides = { u0: boolean; u1: boolean; y0: boolean; y1: boolean };

/**
 * Braces in one rectangular panel. Sides flagged in `tuck` are bounded by
 * members, so braces may run underneath them; the others (opening surrounds)
 * are hard limits.
 */
function decoratePanel(c: Carpenter, wall: WallSpec, r: Rect, style: PanelStyle, outward: number, tuck: TuckSides): void {
  const w = r.u1 - r.u0;
  const h = r.y1 - r.y0;
  if (style === 'none' || w < 0.3 || h < 0.25) return;
  const bw = c.d.brace;
  const clip = grow(r, tuck.u0 ? TUCK : 0, tuck.u1 ? TUCK : 0, tuck.y0 ? TUCK : 0, tuck.y1 ? TUCK : 0);
  const jit = () => c.rng.jitter(0.012);

  if (style === 'cross') {
    if (w / h > 2.3 && w >= 0.9) {
      // Too flat for one cross: split with a short stud and cross both halves.
      const m = (r.u0 + r.u1) / 2;
      const sw = c.d.post * 0.8;
      c.beam(wall, rectPoly(m - sw / 2, m + sw / 2, r.y0 - (tuck.y0 ? TUCK : 0), r.y1 + (tuck.y1 ? TUCK : 0)), W.post);
      const left = { ...r, u1: m - sw / 2 };
      const right = { ...r, u0: m + sw / 2 };
      decoratePanel(c, wall, left, 'cross', outward, { ...tuck, u1: true });
      decoratePanel(c, wall, right, 'cross', outward, { ...tuck, u0: true });
      return;
    }
    if (w / h > 2.3 || h / w > 2.3) return;
    emitBraces(
      c,
      wall,
      [
        { a: [r.u0, r.y0 + jit()], b: [r.u1, r.y1 + jit()], width: bw * 0.9 },
        { a: [r.u1, r.y0 + jit()], b: [r.u0, r.y1 + jit()], width: bw * 0.9 },
      ],
      clip,
    );
  } else if (style === 'vee') {
    const m = (r.u0 + r.u1) / 2;
    if (w / 2 / h > 2.2 || h / (w / 2) > 2.2) return;
    emitBraces(
      c,
      wall,
      [
        { a: [m, r.y0], b: [r.u0, r.y1 + jit()], width: bw * 0.9 },
        { a: [m, r.y0], b: [r.u1, r.y1 + jit()], width: bw * 0.9 },
      ],
      clip,
    );
  } else if (style === 'diag') {
    if (w / h > 2.3 || h / w > 2.6) return;
    // Rising towards the nearer end of the wall, mirrored about the centre.
    const lowU = outward < 0 ? r.u1 : r.u0;
    const highU = outward < 0 ? r.u0 : r.u1;
    emitBraces(c, wall, [{ a: [lowU, r.y0], b: [highU, r.y1 + jit()], width: bw }], clip);
  }
}

/** Braces for a bay next to a corner post, in the house's corner style. */
function cornerBracing(c: Carpenter, bay: Bay, y0: number, y1: number, rails: Rails): Strip[] {
  const w = bay.b - bay.a;
  const h = y1 - y0;
  const bw = c.d.brace;
  const uc = bay.corner < 0 ? bay.a : bay.b; // at the corner post
  const dir = bay.corner < 0 ? 1 : -1; // from the corner inwards
  switch (c.style.corner) {
    case 'k': {
      // K-bracing: both braces meet the corner post at mid-height.
      const span = Math.min(w, 1.35);
      if (h / 2 / span > 2.3 || span < 0.45) return [];
      const ym = y0 + h * 0.5;
      const ui = uc + dir * span;
      return [
        { a: [uc, ym], b: [ui, y1], width: bw },
        { a: [uc, ym], b: [ui, y0], width: bw },
      ];
    }
    case 'strebe': {
      // One long brace from the inner foot up to the corner post's head.
      const span = Math.min(w, h * 0.9);
      if (h / span > 2.4) return [];
      return [{ a: [uc + dir * span, y0], b: [uc, y1], width: bw }];
    }
    case 'feet': {
      // Short foot and head braces against the corner post.
      const len = Math.min(0.62, w * 0.85, (rails.low ? rails.low[0] - y0 : h * 0.3) + 0.05);
      if (len < 0.3) return [];
      const lh = Math.min(0.62, w * 0.85, rails.high ? y1 - rails.high[1] + 0.05 : 0.62);
      const out: Strip[] = [{ a: [uc, y0 + len], b: [uc + dir * len, y0], width: bw * 0.9 }];
      if (lh >= 0.3) out.push({ a: [uc, y1 - lh], b: [uc + dir * lh, y1], width: bw * 0.9 });
      return out;
    }
  }
}

/** Emit braces clipped to `clip`; each later brace is cut where it crosses an earlier one. */
function emitBraces(c: Carpenter, wall: WallSpec, braces: Strip[], clip: Rect): void {
  const done: Strip[] = [];
  for (const s of braces) {
    let pieces: Poly[] = [clipRect(stripPoly(s), clip)];
    for (const prev of done) pieces = pieces.flatMap((p) => minusStrip(p, prev));
    for (const p of pieces) c.beam(wall, p, W.brace);
    done.push(s);
  }
}

// ---------------------------------------------------------------------------
// Gable triangle
// ---------------------------------------------------------------------------

/**
 * Framing in the gable triangle above the top plate: edge rafters along the
 * roof line, a king post (or posts around the attic window), studs, a collar
 * and struts. Everything stays 2 cm below the roof underside.
 */
function frameGable(c: Carpenter, wall: WallSpec): void {
  const g = wall.gable;
  if (!g) return;
  const d = c.d;
  const L = wall.length;
  const base = wall.y1;
  const mid = g.apexU;
  const tan = (g.apexY - base) / mid;
  const cos = 1 / Math.sqrt(1 + tan * tan);
  const roofGap = 0.02;
  const attic = wall.openings.find((o) => o.kind === 'attic');

  // Rafter depth (vertical), thinner if the attic window's lintel comes close.
  let rv = d.rafter / cos;
  if (attic) {
    const s = attic.surround;
    const clearance = Math.min(gableLine(s.u0), gableLine(s.u1)) - roofGap - s.y1;
    rv = clamp(Math.min(rv, clearance - 0.01), 0.1, rv);
  }
  function gableLine(u: number): number {
    return base + Math.min(u, L - u) * tan;
  }
  /** Below the two roof lines, lowered by `drop`. */
  const under = (p: Poly, drop: number): Poly =>
    clipHalf(clipHalf(p, -tan, 1, base - drop), tan, 1, base + tan * L - drop);
  /** Inside the triangle framed by the rafters (tucking `tuck` under them) and above the plate. */
  const inner = (p: Poly, tuck = TUCK): Poly =>
    clipRect(under(p, roofGap + rv - tuck), { u0: 0, u1: L, y0: base, y1: g.apexY });

  // Edge rafters, meeting at the apex in a plumb cut.
  const below = roofGap + rv;
  const leftRafter = clipHalf(under(rectPoly(0, mid, base, g.apexY), roofGap), tan, -1, -(base - below));
  const rightRafter = clipHalf(under(rectPoly(mid, L, base, g.apexY), roofGap), -tan, -1, -(base + tan * L - below));
  c.beam(wall, leftRafter, W.plate);
  c.beam(wall, rightRafter, W.plate);

  const P = d.post;
  const H = g.apexY - base;
  // The collar sits about half-way up. With an attic window it moves up to the
  // window head (doubling as its header) unless it clears the window comfortably.
  let collarY = base + H * 0.5;
  if (attic && collarY < attic.surround.y1 + 0.3) collarY = attic.surround.y1;
  const hasCollar = H > 1.3 && gableLine(mid) - below - (collarY + d.collar) > 0.25;

  // Central element: a king post, or posts either side of the attic window
  // with a short king post standing on the collar (or the window head).
  let uFoot: number; // outer edge of the central element at the base
  if (attic) {
    const s = attic.surround;
    c.beam(wall, inner(rectPoly(s.u0 - P, s.u0, base, g.apexY)), W.post);
    c.beam(wall, inner(rectPoly(s.u1, s.u1 + P, base, g.apexY)), W.post);
    uFoot = s.u0 - P;
    const kp0 = hasCollar ? collarY : s.y1;
    const kp = inner(rectPoly(mid - P / 2, mid + P / 2, kp0, g.apexY));
    if (kp.length && bounds(kp).y1 - kp0 > 0.18) c.beam(wall, kp, W.post);
  } else {
    c.beam(wall, inner(rectPoly(mid - P / 2, mid + P / 2, base, g.apexY)), W.post);
    uFoot = mid - P / 2;
  }

  // Studs, symmetric about the apex, so the lower panels stay narrow.
  const n = Math.max(1, Math.ceil(uFoot / d.maxPanel));
  for (let k = 1; k < n; k++) {
    const u = uFoot - (k * uFoot) / n;
    for (const uc of [u, L - u]) {
      const stud = inner(rectPoly(uc - P / 2, uc + P / 2, base, g.apexY));
      if (stud.length && bounds(stud).y1 - base > 0.4) c.beam(wall, stud, W.post);
    }
  }

  // Collar across the triangle (behind the posts).
  if (hasCollar) {
    const collar = inner(rectPoly(0, L, collarY, collarY + d.collar));
    if (!attic || !hitsOpening(wall, bounds(collar))) c.beam(wall, collar, W.rail);
  }

  // Struts from the foot of the central element up to the rafters.
  const phi = clamp(Math.PI / 2 - Math.atan(tan), 0.6, 1.0);
  const bw = d.brace;
  for (const side of [-1, 1]) {
    const footU = side < 0 ? uFoot : L - uFoot;
    // Centre line placed so the strip's inner edge starts at the post's foot.
    const a: P2 = [footU + (side * bw) / 2 / Math.sin(phi), base];
    const b: P2 = [a[0] + side * Math.cos(phi) * 6, base + Math.sin(phi) * 6];
    const limit: Rect = side < 0 ? { u0: 0, u1: footU + TUCK, y0: base - TUCK, y1: g.apexY } : { u0: footU - TUCK, u1: L, y0: base - TUCK, y1: g.apexY };
    const strut = clipRect(inner(stripPoly({ a, b, width: bw }, 0.5)), limit);
    if (isSolid(strut, 0.02)) c.beam(wall, strut, W.brace);
  }
}

// ---------------------------------------------------------------------------
// Between storeys: bands, jetty joists, brackets
// ---------------------------------------------------------------------------

/**
 * Where storey `upper` sits on storey `lower`: a floor band at the foot of
 * the upper storey (timber storeys get it as their sill), and under a jetty
 * the joist ends, edge joists, soffit boards and corner brackets.
 */
function storeyBoundary(c: Carpenter, lower: StoreySpec, upper: StoreySpec, lowerTop: number): void {
  const d = c.d;
  const Y = upper.y0;
  const J = upper.maxZ - lower.maxZ;
  const jH = Y - lowerTop;

  if (upper.style === 'plaster') for (const wall of upper.walls) wrapBeam(c, wall, Y, Y + d.sill);
  else if (upper.style === 'stone' && lower.style === 'plaster') {
    // A stone storey over plaster: the band goes on the lower storey's top.
    for (const wall of lower.walls) wrapBeam(c, wall, lowerTop - d.plate, lowerTop);
  }
  if (J <= 0.005) return;

  for (const wall of lower.walls) {
    const up = upper.walls.find((w) => w.side === wall.side);
    if (!up) continue;
    if (wall.isGable) {
      // The outermost joist runs along the gable face, out to both jetty faces.
      // On stone storeys it would clash with the stones; the corner joists stand in.
      if (lower.style !== 'stone') {
        c.beam(up, rectPoly(-W.joist, up.length + W.joist, Y - jH, Y), W.joist, W.joist - d.joistW, {
          owner: wall,
          chamferBack: 0.015,
          endGrain: true,
        });
      }
    } else {
      jettyJoists(c, wall, Y, jH, J, lower.style === 'stone');
      soffit(c, wall, Y, J);
      jettyBrackets(c, wall, Y - jH, J, lower.style);
    }
  }
}

/** Centres (u) of the two corner joists of an eave wall. */
function cornerJoists(c: Carpenter, wall: WallSpec): [number, number] {
  return [-W.joist + c.d.joistW / 2, wall.length + W.joist - c.d.joistW / 2];
}

/** Joist ends coming out of the lower wall and running out to the upper wall's face. */
function jettyJoists(c: Carpenter, wall: WallSpec, Y: number, jH: number, J: number, withCorners: boolean): void {
  const d = c.d;
  const [c0, c1] = cornerJoists(c, wall);
  const n = Math.max(1, Math.round((c1 - c0) / d.joistSpacing));
  for (let k = 0; k <= n; k++) {
    if (!withCorners && (k === 0 || k === n)) continue;
    const u = c0 + ((c1 - c0) * k) / n;
    const r: Rect = { u0: u - d.joistW / 2, u1: u + d.joistW / 2, y0: Y - jH, y1: Y };
    if (hitsOpening(wall, r, 0.005)) continue;
    c.profile(wall, rectPoly(-0.1, J + W.joist, Y - jH, Y), r.u0, r.u1, { endGrain: true });
  }
}

/**
 * Boards on top of the joists, closing the underside of the jetty. They run
 * in under the upper storey's sill band and stop 1 mm under its underside
 * (and the joist tops), so no crack shows and nothing is coplanar.
 */
function soffit(c: Carpenter, wall: WallSpec, Y: number, J: number): void {
  const pal = c.layout.params.palette;
  const color = vary(mix(pal.timber, pal.wood, 0.4), c.rng, 0.02, 0.02, 0.004).multiplyScalar(0.9);
  c.profile(wall, rectPoly(-0.05, J + 0.01, Y - 0.03, Y - 0.001), 0.02, wall.length - 0.02, { mat: 'wood', color });
}

/** Curved brackets (knee braces) under the corner joists of a jetty. */
function jettyBrackets(c: Carpenter, wall: WallSpec, yTop: number, J: number, lowerStyle: StoreySpec['style']): void {
  if (J < 0.08) return;
  // Against the corner post, in front of the stones, or on the plaster.
  const back = lowerStyle === 'timber' ? W.post : lowerStyle === 'stone' ? 0.06 : 0;
  const tip = J + W.joist - 0.04;
  if (tip - back < 0.08) return;
  const h = clamp(0.22 + J * 1.1, 0.3, 0.7);
  const drop = 0.05;
  const foot = 0.035;
  const yBot = yTop - h;
  // Straight back against the wall, flat top under the joist, a concave
  // quarter-ellipse from the tip down to a small foot.
  const rx = tip - back - foot;
  const ry = h - drop;
  const poly: Poly = [
    [back, yBot],
    [back, yTop],
    [tip, yTop],
    [tip, yTop - drop],
  ];
  const N = 8;
  for (let k = 1; k <= N; k++) {
    const t = Math.PI / 2 + (k / N) * (Math.PI / 2);
    poly.push([tip + rx * Math.cos(t), yBot + ry * Math.sin(t)]);
  }
  const half = 0.05;
  for (const u of cornerJoists(c, wall)) c.profile(wall, poly, u - half, u + half);
}
