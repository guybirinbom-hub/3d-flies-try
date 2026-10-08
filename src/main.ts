import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createMaterials } from './gen/materials';
import { generateHouse, type GeneratedHouse } from './gen/house';
import { defaultParams, randomParams, type HouseParams } from './gen/params';
import { Stage } from './viewer/stage';
import { cameraFor, CAMERA_PRESETS, type CameraPreset } from './viewer/cameras';
import { createUI } from './viewer/ui';
import { loadParts } from './gen/parts';

/**
 * Viewer entry point. URL parameters (used by the screenshot harness too):
 *   seed=N         random house for seed N (default: hand-tuned default house)
 *   p.<key>=v      override one HouseParams field, e.g. p.floors=1
 *   cam=<preset>   iso | iso2 | front | back | left | right | top | door | eave | low
 *   parts=a,b      only build these parts
 *   explode=0..1   exploded view
 *   gallery=N      N houses (seed, seed+1, …) side by side
 *   ao=0           disable ambient occlusion
 *   ui=0           hide the control panel
 */
const q = new URLSearchParams(location.search);
const container = document.getElementById('app')!;
const stage = new Stage(container, { preserveDrawingBuffer: true });
stage.ao = q.get('ao') !== '0';
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

const state = {
  params: paramsFromUrl(),
  explode: Number(q.get('explode') ?? 0),
  parts: q.get('parts')?.split(',').filter(Boolean),
  gallery: Number(q.get('gallery') ?? 0),
  autoRotate: false,
};

let houses: GeneratedHouse[] = [];
const world = new THREE.Group();
stage.scene.add(world);

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
    const n = state.gallery;
    const cols = Math.ceil(Math.sqrt(n));
    const spacing = 17;
    for (let i = 0; i < n; i++) {
      const p = randomParams(state.params.seed + i);
      const h = generateHouse(p, materials, { parts: state.parts });
      const col = i % cols;
      const row = Math.floor(i / cols);
      h.group.position.set((col - (cols - 1) / 2) * spacing, 0, (row - (Math.ceil(n / cols) - 1) / 2) * spacing);
      h.group.rotation.y = ((i * 37) % 9) * 0.06 - 0.24;
      world.add(h.group);
      houses.push(h);
    }
  } else {
    const h = generateHouse(state.params, materials, { parts: state.parts });
    world.add(h.group);
    houses.push(h);
  }
  applyExplode();
  const box = new THREE.Box3().setFromObject(world);
  stage.fitShadow(box.min, box.max);
  stats.textContent = statsText();
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
    const d = Math.max(size.x, size.z) * 1.15;
    stage.camera.position.copy(c).add(new THREE.Vector3(0.55, 0.6, 1).normalize().multiplyScalar(d));
    stage.controls.target.copy(c);
  } else {
    const { position, target } = cameraFor(preset, houses[0].layout, stage.camera.fov, stage.camera.aspect);
    stage.camera.position.copy(position);
    stage.controls.target.copy(target);
  }
  stage.controls.update();
}

function statsText(): string {
  const tris = houses.reduce((s, h) => s + h.stats.triangles, 0);
  const ms = houses.reduce((s, h) => s + h.stats.ms, 0);
  return `${houses.length > 1 ? `${houses.length} houses · ` : ''}${(tris / 1000).toFixed(0)}k triangles · generated in ${ms} ms`;
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

const stats = document.createElement('div');
stats.className = 'stats';
container.appendChild(stats);

rebuild();
const camPreset = (CAMERA_PRESETS as readonly string[]).includes(q.get('cam') ?? '')
  ? (q.get('cam') as CameraPreset)
  : 'iso';
setCamera(camPreset);

if (q.get('ui') !== '0') {
  createUI({
    state,
    stage,
    rebuild,
    applyExplode,
    setCamera,
    exportGLB: async () => download(await exportGLB(), `house-${state.params.seed}.glb`),
  });
} else {
  stats.style.display = 'none';
}

// Headless shots (ui=0) render on demand only: software WebGL is slow and a
// continuous loop would just queue frames nobody looks at.
const live = q.get('ui') !== '0';
function loop(): void {
  stage.controls.autoRotate = state.autoRotate;
  stage.render();
  requestAnimationFrame(loop);
}
if (live) loop();

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
