# Village house generator — architecture & part contracts

The generator turns a small set of **parameters** into a **layout** (a plan made
of plain numbers), and then a set of independent **parts** turn the layout
into geometry. This split is what makes it a *generator* rather than a model:
a future village / Tiny-Glade-style tool drives the params or the layout, and
the parts take care of making it look hand-made.

```
HouseParams ──computeLayout──▶ HouseLayout ──parts──▶ PartBuilders ──merge──▶ THREE.Group ──▶ viewer / .glb
 (src/gen/params.ts)           (src/gen/layout.ts)    (src/gen/parts/*.ts)     (src/gen/house.ts)
```

## Coordinates

- Metres, **Y up**, ground at `y = 0`, house centred on the origin.
- The ridge runs along **X**. The front facade (with the door) faces **+Z**.
- Walls per storey are listed `front (+Z), right (+X), back (-Z), left (-X)`.
- **Wall-local coordinates `(u, y, w)`** — use these for anything on a wall:
  - `u` along the wall from `wall.start` (outer corner); seen from outside, `u` runs left → right.
  - `y` is world height (not relative to the storey).
  - `w` is the outward distance from the wall's **outer face**: `w = 0` outer face, `w = -thickness` inner face, `w > 0` in front of the wall.
  - `wall.frame` (Matrix4) maps `(u, y, w)` → world. It is a pure rotation + translation (never mirrored), so geometry built in wall-local space just needs `builder.add(geom, mat, color, mul(wall.frame, localMatrix))`.
  - Helpers: `wallPoint`, `wallMatrix`, `gableTopAt(wall, u)`, `hitsOpening(wall, rect)`.
- Front/back walls run the full length (`u ∈ [0, length]`); gable (left/right) wall bodies fit between them (`u ∈ [t, length - t]`) — see `wall.u0/u1`.
- Each storey: `y0` (bottom of its walls), `floorY` (interior floor; the plinth top for the ground floor), `y1` (top of its walls). Upper storeys may be wider in Z by `params.jetty * storeyIndex` on the front and back.
- Roof: gable roof, ridge along X. The roof **underside** meets the top storey's outer eave-wall face at `roof.eaveY` and rises with `tan(pitch)`: `roofUndersideY(roof, z)`. The deck is `roof.deckThickness` thick, deck + tiles `roof.coverThickness` (both perpendicular to the slope); `roofSurfaceY(roof, z)` is the top of the tiles. The top storey's gable walls end exactly at the underside.

## Who owns what (no two parts build the same thing)

| Part | Owns |
|---|---|
| `foundation` | The plinth band on the ground storey's outer faces, `y ∈ [0, plinthHeight]` for every wall style; door steps from the ground up to the door threshold, inside `layout.stoop`. |
| `walls` | The solid wall bodies (plaster, or mortar colour on stone storeys) with holes for openings, incl. gable triangles. |
| `stonework` | Individual stones on the outer face of every `style === 'stone'` wall from `floorY` (ground storey) or `y0` up to `y1` / the gable slope; corner quoins. Never inside an opening `surround`. |
| `timber` | Half-timber framing on every `style === 'timber'` wall (sill beam, top plate, corner posts, studs, braces, gable framing), plus floor bands / joist ends between storeys, especially under jetties. Never inside an opening `surround`. |
| `openings` | Everything inside each opening's `surround`: frames, glazing bars, glass, door leaf & ironwork, lintel (wood or stone, arched heads), sill; plus shutters, flower boxes and a door canopy, which may extend outside the surround because they sit in front of everything else. |
| `roof` | Deck (incl. soffit underside), tile courses, ridge cap, barge boards, fascia. Leaves a hole around the chimney footprint. |
| `chimney` | The stack from `chimney.y0` to `chimney.y1`, cap, pots, and flashing where it meets the roof. |
| `props` | Small things around the house: path (starting at the outer edge of `layout.stoop`), lantern by the door, bench/barrel/woodpile, potted plants, shrubs and flowers along the base. Never inside `layout.stoop`, never blocks the door. |

### Depth (w) budget — what sits in front of what

Wall-mounted layers must keep to these ranges so nothing z-fights or pokes through:

| Layer | w range (metres) |
|---|---|
| wall body | `[-t, 0]` |
| plinth band (foundation) | `[-0.05, +0.10]` |
| stones (stonework) | `[-0.05, +0.06]`, quoins up to `+0.07` |
| timber beams | `[-0.02, +0.045]` |
| lintels | up to `+0.07` |
| window sills | up to `+0.12` |
| shutters (open, flat against the wall) | back face `≥ +0.075` |
| flower boxes, canopy, lantern, props on the wall | `≥ +0.08` |

Opening frames and glass sit inside the hole around `w = opening.recess`.

## Building geometry

- `PartBuilder` (src/gen/builder.ts) collects geometry per **material slot** (`MatKey`) with **vertex colours**, and merges it into one mesh per slot. Materials are shared and white; all colour is vertex colour.
- Use `builder.box(mat, color, sx, sy, sz, matrix, radius)` for (rounded) boxes; `lumpify(geom, amount, seed)` for hand-made irregularity; `vary(color, rng, l, s, h)` for per-piece colour variation; `extrudeLocal(shape, depth, w0)` for wall-shaped slabs.
- Return **one builder per wall** (or per roof slope etc.) and set `builder.explode` with the helpers in `src/gen/explode.ts`, so the exploded view separates storeys and peels layers off the walls.
- Draw randomness only from the `rng` in the part context (it is private to the part). Same seed → same house.

## Art direction

Cozy, storybook, "Tiny Glade"-like:

- **Soft and chunky.** Everything has rounded edges (beams ~2 cm radius, stones 3–6 cm). Nothing razor sharp, nothing perfectly regular. Slightly exaggerated proportions: chunky beams, thick roof, generous overhangs.
- **Hand-made irregularity.** Small random rotations (1–3°), offsets and sizes per stone/tile/plank; per-piece colour variation with `vary()` (a few % lightness).
- **Palette** comes from `params.palette`; never pure black or white.
- **Readable at a distance**: a few strong shapes first, detail second.
- **Budget**: whole house ≲ 300k triangles. Rough per part: stonework 120k, roof 120k, openings 40k, foundation 25k, props 30k, timber 20k, chimney 10k.

## Tooling

- `npm run dev` — interactive viewer with controls.
- `node scripts/shoot.mjs --out shots/x name="query" …` — headless screenshots (software WebGL, ~5 s each). Query params: `seed`, `p.<param>=value`, `cam=iso|iso2|front|back|left|right|top|door|eave|low`, `parts=a,b`, `explode=0..1`, `gallery=N`, `ao=0`. Add `--glb` to also export `.glb`.
- `node scripts/sweep.mjs --count 300 [--parts a,b] [--set p.floors=3]` — generates many houses in Node and reports exceptions, console errors, NaNs and runaway geometry.
- `npx tsc --noEmit` — typecheck.
