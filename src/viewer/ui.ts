import GUI from 'lil-gui';
import { PALETTES, randomParams, type HouseParams } from '../gen/params';
import { PARTS } from '../gen/parts';
import type { Stage } from './stage';
import { CAMERA_PRESETS, type CameraPreset } from './cameras';

interface UIDeps {
  state: {
    params: HouseParams;
    explode: number;
    parts?: string[];
    gallery: number;
    autoRotate: boolean;
  };
  stage: Stage;
  rebuild: () => void;
  applyExplode: () => void;
  setCamera: (p: CameraPreset) => void;
  exportGLB: () => Promise<void>;
}

/** Control panel: house parameters, view options, export. */
export function createUI(d: UIDeps): GUI {
  const gui = new GUI({ title: 'Village house' });
  const p = d.state.params;
  const actions = {
    newHouse: () => {
      Object.assign(p, randomParams(p.seed + 1));
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      d.rebuild();
    },
    reroll: () => {
      Object.assign(p, randomParams(p.seed));
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      d.rebuild();
    },
    palette: Object.keys(PALETTES).find((k) => PALETTES[k].roof === p.palette.roof) ?? 'terracotta',
    camera: 'iso' as CameraPreset,
    export: () => void d.exportGLB(),
  };

  gui.add(actions, 'newHouse').name('🎲 New random house');
  const house = gui.addFolder('Shape');
  const r = () => d.rebuild();
  house.add(p, 'seed', 0, 9999, 1).name('Seed (detail)').onFinishChange(r);
  house.add(actions, 'reroll').name('Re-roll whole house from seed');
  house.add(p, 'width', 5, 14, 0.1).onFinishChange(r);
  house.add(p, 'depth', 4, 8, 0.1).onFinishChange(r);
  house.add(p, 'floors', 1, 3, 1).onFinishChange(r);
  house.add(p, 'storeyHeight', 2.4, 3.2, 0.05).name('storey height').onFinishChange(r);
  house.add(p, 'plinthHeight', 0.15, 0.8, 0.05).name('plinth').onFinishChange(r);
  house.add(p, 'wallThickness', 0.3, 0.6, 0.01).name('wall thickness').onFinishChange(r);
  house.add(p, 'jetty', 0, 0.45, 0.05).name('upper floor jetty').onFinishChange(r);
  house.add(p, 'groundStyle', ['stone', 'plaster', 'timber']).name('ground floor').onChange(r);
  house.add(p, 'upperStyle', ['stone', 'plaster', 'timber']).name('upper floors').onChange(r);

  const roof = gui.addFolder('Roof');
  roof.add(p, 'roofPitch', 25, 62, 1).name('pitch °').onFinishChange(r);
  roof.add(p, 'eaveOverhang', 0.1, 0.9, 0.05).name('eave overhang').onFinishChange(r);
  roof.add(p, 'gableOverhang', 0.1, 0.8, 0.05).name('gable overhang').onFinishChange(r);
  roof.add(p, 'chimney').onChange(r);
  roof.add(p, 'chimneySide', ['left', 'right']).name('chimney side').onChange(r);

  const details = gui.addFolder('Details');
  details.add(p, 'windowSpacing', 1.6, 4, 0.1).name('window spacing').onFinishChange(r);
  details.add(p, 'doorOffset', -1, 1, 0.05).name('door position').onFinishChange(r);
  details.add(p, 'archedDoor').name('arched door').onChange(r);
  details.add(p, 'shutters').onChange(r);
  details.add(p, 'flowerBoxes').name('flower boxes').onChange(r);
  details.add(p, 'props').name('props').onChange(r);
  details
    .add(actions, 'palette', Object.keys(PALETTES))
    .onChange((name: string) => {
      p.palette = { ...PALETTES[name], flowers: [...PALETTES[name].flowers] };
      d.rebuild();
    });
  details.addColor(p.palette, 'roof').name('roof colour').onFinishChange(r);
  details.addColor(p.palette, 'plaster').name('plaster colour').onFinishChange(r);
  details.addColor(p.palette, 'shutter').name('shutter colour').onFinishChange(r);

  const view = gui.addFolder('View');
  view.add(d.state, 'explode', 0, 1, 0.01).name('exploded view').onChange(() => d.applyExplode());
  const visible: Record<string, boolean> = {};
  for (const part of PARTS) {
    visible[part.name] = !d.state.parts || d.state.parts.includes(part.name);
    view
      .add(visible, part.name)
      .name(`show ${part.label.toLowerCase()}`)
      .onChange(() => {
        d.state.parts = PARTS.filter((x) => visible[x.name]).map((x) => x.name);
        d.rebuild();
      });
  }
  view.add(d.state, 'gallery', 0, 12, 1).name('gallery (houses)').onFinishChange(() => {
    d.rebuild();
    d.setCamera(actions.camera);
  });
  view.add(actions, 'camera', [...CAMERA_PRESETS]).onChange((c: CameraPreset) => d.setCamera(c));
  view.add(d.state, 'autoRotate').name('auto-rotate');
  view.add(d.stage, 'ao').name('ambient occlusion');
  view.close();

  gui.add(actions, 'export').name('⬇ Export .glb');
  return gui;
}
