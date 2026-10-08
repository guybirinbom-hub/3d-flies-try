import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * Renderer, camera, lights, sky and ground: everything around the house.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sun: THREE.DirectionalLight;
  private composer: EffectComposer;
  private aoPass: GTAOPass;
  private ground: THREE.Mesh;
  private _ao = true;
  /** Set whenever something visible changed; the viewer only draws when it is. */
  dirty = true;

  get ao(): boolean {
    return this._ao;
  }
  set ao(on: boolean) {
    this._ao = on;
    this.dirty = true;
  }

  constructor(container: HTMLElement, opts: { preserveDrawingBuffer?: boolean } = {}) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    // Plain PCF honours shadow.radius (PCFSoft ignores it): soft, painterly edges.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(35, container.clientWidth / container.clientHeight, 0.1, 500);
    this.camera.position.set(14, 8, 16);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 120;

    // World-space sky dome whose horizon is exactly the fog colour, so the
    // far meadow melts into the haze instead of meeting a hard seam.
    this.scene.background = new THREE.Color(HAZE);
    this.scene.fog = new THREE.Fog(HAZE, 60, 190);
    this.scene.add(makeSky());

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;

    const hemi = new THREE.HemisphereLight('#d6e6ff', '#7f8a6c', 1.25);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight('#fff0d8', 2.7);
    this.sun.position.set(9, 15, 11);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun, this.sun.target);

    this.ground = makeGround();
    this.scene.add(this.ground);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.aoPass = new GTAOPass(this.scene, this.camera, container.clientWidth, container.clientHeight);
    this.aoPass.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1.1, samples: 16 });
    this.aoPass.blendIntensity = 0.85;
    this.composer.addPass(this.aoPass);
    this.composer.addPass(new OutputPass());

  }

  /** Keep the canvas matched to its container (window resizes, panel folding). */
  observeResize(container: HTMLElement): void {
    new ResizeObserver(() => this.resize(container)).observe(container);
  }

  resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.dirty = true;
  }

  /** Fit the sun's shadow camera around a box. */
  fitShadow(min: THREE.Vector3, max: THREE.Vector3): void {
    const c = min.clone().add(max).multiplyScalar(0.5);
    const r = min.distanceTo(max) * 0.5 + 2;
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.5;
    cam.far = r * 4;
    this.sun.target.position.copy(c);
    // Afternoon sun from the front-left: the front and left gable are lit,
    // the right gable (seen in the default view) is in shade and the house
    // casts its shadow to the right and back.
    this.sun.position.copy(c).add(SUN_DIR.clone().multiplyScalar(r * 2));
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  /** Scale the haze with the size of what is being looked at. */
  setFogRange(near: number, far: number): void {
    const fog = this.scene.fog as THREE.Fog;
    fog.near = near;
    fog.far = far;
  }

  render(): void {
    this.controls.update();
    this.draw();
  }

  /** Draw a frame without stepping the controls. */
  draw(): void {
    if (this._ao) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }
}

const SUN_DIR = new THREE.Vector3(-0.6, 0.82, 0.55).normalize();

/** Pale warm haze at the horizon (fog and the bottom of the sky). */
const HAZE = '#e2e8dc';

function makeSky(): THREE.Mesh {
  const geom = new THREE.SphereGeometry(450, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: new THREE.Color('#86b3de') },
      mid: { value: new THREE.Color('#bcd5e6') },
      horizon: { value: new THREE.Color(HAZE) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // always at the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith;
      uniform vec3 mid;
      uniform vec3 horizon;
      varying vec3 vDir;
      void main() {
        float h = max(vDir.y, 0.0);
        vec3 c = mix(horizon, mid, smoothstep(0.0, 0.18, h));
        c = mix(c, zenith, smoothstep(0.15, 0.75, h));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(geom, mat);
  sky.name = 'sky';
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  sky.onBeforeRender = (_r, _s, camera) => sky.position.copy(camera.position);
  return sky;
}

/** Smooth 2D value noise in [0, 1]. */
function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const h = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = h(xi, zi) + (h(xi + 1, zi) - h(xi, zi)) * ux;
  const b = h(xi, zi + 1) + (h(xi + 1, zi + 1) - h(xi, zi + 1)) * ux;
  return a + (b - a) * uz;
}

function fbm(x: number, z: number): number {
  return 0.55 * valueNoise(x, z) + 0.3 * valueNoise(x * 2.1 + 17, z * 2.1 - 9) + 0.15 * valueNoise(x * 4.3 - 5, z * 4.3 + 21);
}

/**
 * Meadow: a polar grid (dense near the middle) so colour and height can vary
 * everywhere. Flat around the houses, rolling gently into the distance.
 */
function makeGround(): THREE.Mesh {
  const rings = 96;
  const segs = 144;
  const radius = 220;
  const positions: number[] = [];
  const colors: number[] = [];
  const index: number[] = [];
  const base = new THREE.Color('#7f9c52');
  const lush = new THREE.Color('#68893f');
  const dry = new THREE.Color('#a2a763');
  const clover = new THREE.Color('#5c7d3c');
  const c = new THREE.Color();
  for (let i = 0; i <= rings; i++) {
    const r = radius * Math.pow(i / rings, 2.2);
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const hills = (fbm(x * 0.012, z * 0.012) - 0.45) * 9 + (fbm(x * 0.04, z * 0.04) - 0.5) * 1.2;
      const lift = THREE.MathUtils.smoothstep(r, 22, 70);
      positions.push(x, hills * lift - 0.002, z);
      // Broad blotches of lush and dry grass, small clover patches.
      const broad = fbm(x * 0.07 + 3, z * 0.07 - 7);
      const fine = fbm(x * 0.35, z * 0.35);
      c.copy(base).lerp(broad > 0.5 ? dry : lush, Math.min(1, Math.abs(broad - 0.5) * 1.6));
      if (fine > 0.68) c.lerp(clover, Math.min(1, (fine - 0.68) * 4));
      colors.push(c.r, c.g, c.b);
      if (i > 0) {
        const cur = i * segs + j;
        const nxt = i * segs + ((j + 1) % segs);
        const prev = (i - 1) * segs + j;
        const prevN = (i - 1) * segs + ((j + 1) % segs);
        index.push(prev, nxt, cur, prev, prevN, nxt);
      }
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(index);
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  mesh.name = 'ground';
  mesh.receiveShadow = true;
  return mesh;
}
