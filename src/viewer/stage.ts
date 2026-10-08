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
  ao = true;

  constructor(container: HTMLElement, opts: { preserveDrawingBuffer?: boolean } = {}) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

    // Sky gradient background + matching fog.
    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog('#dfe9ec', 60, 180);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;

    const hemi = new THREE.HemisphereLight('#d6e6ff', '#8a8f5a', 1.25);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight('#fff0d8', 2.7);
    this.sun.position.set(9, 15, 11);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 3;
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

    window.addEventListener('resize', () => this.resize(container));
  }

  resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
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
    this.sun.position.copy(c).add(new THREE.Vector3(0.55, 0.85, 0.65).normalize().multiplyScalar(r * 2));
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  render(): void {
    this.controls.update();
    if (this.ao) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

function skyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#9cc3e6');
  grad.addColorStop(0.55, '#cfe2ee');
  grad.addColorStop(1, '#eef1e6');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Gently undulating grass disc, flat near the house. */
function makeGround(): THREE.Mesh {
  const geom = new THREE.CircleGeometry(160, 160, 0, Math.PI * 2);
  geom.rotateX(-Math.PI / 2);
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color('#8fae5d');
  const dry = new THREE.Color('#b5b971');
  const lush = new THREE.Color('#6f9a4f');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const d = Math.hypot(x, z);
    const n = Math.sin(x * 0.21) * Math.cos(z * 0.17) + Math.sin(x * 0.53 + z * 0.41) * 0.5;
    const lift = Math.max(0, d - 18) / 40;
    pos.setY(i, n * 0.35 * Math.min(1, lift) - 0.002);
    c.copy(base).lerp(n > 0 ? dry : lush, Math.min(1, Math.abs(n) * 0.45));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  mesh.name = 'ground';
  mesh.receiveShadow = true;
  return mesh;
}
