import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createMaterials } from './gen/materials';
import { generateHouse, type GeneratedHouse } from './gen/house';
import { defaultParams, randomParams, type HouseParams } from './gen/params';
import { loadParts } from './gen/parts';
import { Rng } from './gen/rng';
import { Stage } from './viewer/stage';
import { cameraFor, CAMERA_PRESETS, type CameraPreset } from './viewer/cameras';
import { createPanel, type Panel, type ViewerState } from './viewer/panel';
import './viewer/panel.css';

/**
 * Viewer entry point. URL parameters (used by the screenshot harness too):
 *   seed=N         random house for seed N (default: hand-tuned default house)
 *   p.<key>=v      override one HouseParams field, e.g. p.floors=1
 *   cam=<preset>   iso | iso2 | front | back | left | right | top | door | eave | low
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

function disposeHouses(): void {
  for (const h of houses) {
    h.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
  world.clear();
  houses = [];
}

function rebuild(): void {
  disposeHouses();
  if (state.gallery > 0) {
    buildVillage(state.gallery);
  } else {
    const h = generateHouse(state.params, materials, { parts: state.parts });
    world.add(h.group);
    houses.push(h);
  }
  applyExplode();
  const box = new THREE.Box3().setFromObject(world);
  stage.fitShadow(box.min, box.max);
  panel?.setStats(
    houses.reduce((s, h) => s + h.stats.triangles, 0),
    houses.reduce((s, h) => s + h.stats.ms, 0),
    houses.length,
  );
}

/** Several random houses around a little green, each turned to face the middle. */
function buildVillage(n: number): void {
  const rng = new Rng(state.params.seed).fork('village');
  const ring = Math.max(14, n * 2.6);
  const centre = n > 6;
  for (let i = 0; i < n; i++) {
    const h = generateHouse(randomParams(state.params.seed + i), materials, { parts: state.parts });
    const inMiddle = centre && i === 0;
    const k = centre ? n - 1 : n;
    const a = ((i - (centre ? 1 : 0)) / k) * Math.PI * 2 + rng.jitter(0.12);
    const r = inMiddle ? 0 : ring * (0.85 + rng.next() * 0.3);
    h.group.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
    // A house's front faces +Z locally; turn each one to look at the green.
    h.group.rotation.y = inMiddle ? 0.3 : a + Math.PI + rng.jitter(0.25);
    world.add(h.group);
    houses.push(h);
  }
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

function setCamera(preset: CameraPreset): void {
  if (state.gallery > 0) {
    const box = new THREE.Box3().setFromObject(world);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const d = Math.max(size.x, size.z) * 1.05;
    stage.camera.position.copy(c).add(new THREE.Vector3(0.5, 0.62, 1).normalize().multiplyScalar(d));
    stage.controls.target.copy(c).setY(1.5);
  } else {
    const { position, target } = cameraFor(preset, houses[0].layout, stage.camera.fov, stage.camera.aspect);
    stage.camera.position.copy(position);
    stage.controls.target.copy(target);
  }
  stage.controls.update();
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
    // Downloads are blocked inside the published artifact's sandbox.
    exportGLB: __ARTIFACT__ ? undefined : async () => download(await exportGLB(), `house-${state.params.seed}.glb`),
  });
}

rebuild();
const camPreset = (CAMERA_PRESETS as readonly string[]).includes(q.get('cam') ?? '')
  ? (q.get('cam') as CameraPreset)
  : 'iso';
setCamera(camPreset);
stage.observeResize(container);

// Headless shots (ui=0) render on demand only: software WebGL is slow and a
// continuous loop would just queue frames nobody looks at.
function loop(): void {
  stage.controls.autoRotate = state.autoRotate;
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
