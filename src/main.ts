import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createMaterials } from './gen/materials';
import type { MatKey } from './gen/builder';
import { applyPainterly, PAINTERLY } from './gen/painterly';
import { generateHouse, type GeneratedHouse } from './gen/house';
import { defaultParams, randomParams, type HouseParams } from './gen/params';
import { loadParts } from './gen/parts';
import { Rng } from './gen/rng';
import { Stage } from './viewer/stage';
import { cameraFor, CAMERA_PRESETS, fitDistance, type CameraPreset } from './viewer/cameras';
import { placeAroundGreen, villageDressing } from './viewer/village';
import { createPanel, type Panel, type ViewerState } from './viewer/panel';
import './viewer/panel.css';

/**
 * Viewer entry point. URL parameters (used by the screenshot harness too):
 *   seed=N         random house for seed N (default: hand-tuned default house)
 *   p.<key>=v      override one HouseParams field, e.g. p.floors=1
 *   cam=<preset>   iso | iso2 | front | back | left | right | top | door | eave | low
 *                  | corner | stoop | peak | chimney (close-ups)
 *   eye=x,y,z&at=x,y,z   explicit camera position and target (world metres)
 *   parts=a,b      only build these parts
 *   explode=0..1   exploded view
 *   gallery=N      N houses (seed, seed+1, …) as a little village
 *   ao=0           disable ambient occlusion
 *   ui=0           bare viewport, render on demand (screenshots)
 */
const q = new URLSearchParams(location.search);
const live = q.get('ui') !== '0';
if (!live) document.body.classList.add('bare');
else loadFonts();

const container = document.getElementById('app')!;
const stage = new Stage(container, { preserveDrawingBuffer: !live });
stage.ao = q.get('ao') !== null ? q.get('ao') !== '0' : !live || container.clientWidth > 700;
const materials = createMaterials();
for (const [slot, opts] of Object.entries(PAINTERLY)) if (opts) applyPainterly(materials[slot as MatKey], opts);
await loadParts();

function paramsFromUrl(): HouseParams {
  const seed = q.get('seed');
  const p = seed !== null ? randomParams(Number(seed)) : defaultParams();
  for (const [k, v] of q) {
    if (!k.startsWith('p.')) continue;
    const key = k.slice(2) as keyof HouseParams;
    const cur = p[key];
    (p as unknown as Record<string, unknown>)[key] =
      typeof cur === 'number' ? Number(v) : typeof cur === 'boolean' ? v === '1' || v === 'true' : v;
  }
  return p;
}

const state: ViewerState = {
  params: paramsFromUrl(),
  explode: Number(q.get('explode') ?? 0),
  parts: q.get('parts')?.split(',').filter(Boolean),
  gallery: Number(q.get('gallery') ?? 0),
  autoRotate: false,
};

let houses: GeneratedHouse[] = [];
const world = new THREE.Group();
stage.scene.add(world);
let panel: Panel | null = null;
/** Layers hidden in the viewer (generated, just not shown). */
const hidden = new Set<string>();
let lastPreset: CameraPreset = 'iso';
/** True after the user orbits/zooms: then rebuilds and animations leave the camera alone. */
let userMoved = false;
/** The camera eases along with the assembly animation until the user takes over. */
let followExplode = false;
let buildId = 0;

function disposeWorld(): void {
  world.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
  world.clear();
  houses = [];
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Regenerate from state. Villages are built one house per frame so the page stays responsive. */
async function rebuild(): Promise<void> {
  const id = ++buildId;
  const before = houses.length === 1 ? houses[0].layout.bounds.max.clone() : null;
  if (state.gallery > 0) {
    const params = Array.from({ length: state.gallery }, (_, i) => randomParams(state.params.seed + i));
    const built: GeneratedHouse[] = [];
    for (const p of params) {
      built.push(generateHouse(p, materials, { parts: state.parts }));
      if (live) await nextFrame();
      if (id !== buildId) return; // a newer rebuild started
    }
    disposeWorld();
    const places = placeAroundGreen(
      built.map((h) => h.layout),
      new Rng(state.params.seed).fork('village'),
    );
    built.forEach((h, i) => {
      h.group.position.set(places[i].x, 0, places[i].z);
      h.group.rotation.y = places[i].rotY;
      world.add(h.group);
    });
    houses = built;
    world.add(villageDressing(built.map((h) => h.layout), places, materials, state.params.seed));
  } else {
    const h = generateHouse(state.params, materials, { parts: state.parts });
    if (id !== buildId) return;
    disposeWorld();
    world.add(h.group);
    houses = [h];
  }
  applyVisibility();
  applyExplode();
  const box = new THREE.Box3().setFromObject(world);
  stage.fitShadow(box.min, box.max);
  panel?.setStats(
    houses.reduce((s, h) => s + h.stats.triangles, 0),
    houses.reduce((s, h) => s + h.stats.ms, 0),
    houses.length,
  );
  // Re-frame when the house grew or shrank a lot, unless the user is steering.
  const after = houses.length === 1 ? houses[0].layout.bounds.max : null;
  if (before && after && !userMoved && (Math.abs(after.y / before.y - 1) > 0.15 || Math.abs(after.x / before.x - 1) > 0.15)) {
    setCamera(lastPreset);
  }
}

function applyVisibility(): void {
  for (const h of houses) for (const part of h.group.children) part.visible = !hidden.has(part.name);
}

function setLayerVisible(name: string, on: boolean): void {
  if (on) hidden.delete(name);
  else hidden.add(name);
  applyVisibility();
}

function applyExplode(): void {
  for (const h of houses) {
    for (const part of h.group.children) {
      for (const o of [part, ...part.children]) {
        const e = o.userData.explode as THREE.Vector3 | undefined;
        if (e) o.position.copy(e).multiplyScalar(state.explode);
      }
    }
  }
}

function setCamera(preset: CameraPreset, explode = 0): void {
  lastPreset = preset;
  userMoved = false;
  if (state.gallery > 0) {
    // Frame the houses (the trees around them may crop).
    const box = new THREE.Box3();
    for (const h of houses) box.expandByObject(h.group);
    const c = box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector3(0.45, 0.62, 1).normalize();
    const d = fitDistance(box, c, dir, stage.camera.fov, stage.camera.aspect, 1.0);
    stage.camera.position.copy(c).addScaledVector(dir, d);
    stage.controls.target.copy(c);
  } else {
    const { position, target } = cameraFor(preset, houses[0].layout, stage.camera.fov, stage.camera.aspect, explode);
    stage.camera.position.copy(position);
    stage.controls.target.copy(target);
  }
  stage.controls.update();
  // Haze scales with how far away we look from.
  const dist = stage.camera.position.distanceTo(stage.controls.target);
  stage.setFogRange(Math.max(60, dist * 1.8), Math.max(190, dist * 5.5));
}

stage.controls.addEventListener('start', () => {
  userMoved = true;
  followExplode = false;
});

/** `eye=x,y,z&at=x,y,z` in the URL overrides the preset (for reviewing any spot). */
function cameraFromUrl(): boolean {
  const eye = q.get('eye')?.split(',').map(Number);
  const at = q.get('at')?.split(',').map(Number);
  if (eye?.length !== 3 || at?.length !== 3 || [...eye, ...at].some((v) => !Number.isFinite(v))) return false;
  // Any angle, including looking up under the eaves.
  stage.controls.minPolarAngle = 0;
  stage.controls.maxPolarAngle = Math.PI;
  stage.camera.position.set(eye[0], eye[1], eye[2]);
  stage.controls.target.set(at[0], at[1], at[2]);
  stage.controls.update();
  return true;
}

async function exportGLB(): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  const target = houses.length === 1 ? houses[0].group : world;
  const result = await exporter.parseAsync(target, { binary: true });
  return result as ArrayBuffer;
}

function download(data: ArrayBuffer, name: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadFonts(): void {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href =
    'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..700&family=IBM+Plex+Mono:wght@400;500&family=Instrument+Sans:wght@400..700&display=swap';
  document.head.appendChild(link);
}

if (live) {
  panel = createPanel(document.getElementById('sheet')!, document.getElementById('views')!, document.getElementById('readout')!, {
    state,
    stage,
    rebuild,
    applyExplode,
    setCamera,
    setLayerVisible,
    isLayerVisible: (name) => !hidden.has(name),
    onAssemblyStart: () => {
      followExplode = state.gallery === 0;
    },
    // Downloads are blocked inside the published artifact's sandbox.
    exportGLB: __ARTIFACT__ ? undefined : async () => download(await exportGLB(), `house-${state.params.seed}.glb`),
  });
}

await rebuild();
const camPreset = (CAMERA_PRESETS as readonly string[]).includes(q.get('cam') ?? '')
  ? (q.get('cam') as CameraPreset)
  : 'iso';
if (!cameraFromUrl()) setCamera(camPreset, state.explode);
stage.observeResize(container);

// Headless shots (ui=0) render on demand only: software WebGL is slow and a
// continuous loop would just queue frames nobody looks at.
function loop(): void {
  stage.controls.autoRotate = state.autoRotate;
  if (followExplode && houses.length === 1) {
    const { position, target } = cameraFor(lastPreset, houses[0].layout, stage.camera.fov, stage.camera.aspect, state.explode);
    stage.camera.position.copy(position);
    stage.controls.target.copy(target);
    if (state.explode <= 0) followExplode = false;
  }
  stage.render();
  requestAnimationFrame(loop);
}
if (live) {
  loop();
  if (!q.has('explode')) {
    // Open on the house assembling itself from its generated layers.
    state.explode = 1;
    applyExplode();
    panel?.playAssembly();
  }
}

/** Render one frame and block until the GPU is done (for timing / screenshots). */
function renderSync(): number {
  const t = performance.now();
  stage.render();
  const gl = stage.renderer.getContext();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  return performance.now() - t;
}

// Hooks for the headless screenshot / export harness.
declare global {
  interface Window {
    __app: unknown;
  }
}
window.__app = {
  ready: true,
  stats: () => houses.map((h) => h.stats),
  layout: () => houses[0]?.layout,
  renderNow: () => renderSync(),
  exportGLBBase64: async () => {
    const buf = new Uint8Array(await exportGLB());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  },
};
