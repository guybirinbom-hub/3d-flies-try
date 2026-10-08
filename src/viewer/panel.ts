import { Color } from 'three';
import { PALETTES, randomParams, type HouseParams, type WallStyle } from '../gen/params';
import { PARTS } from '../gen/parts';
import type { Stage } from './stage';
import type { CameraPreset } from './cameras';

export interface ViewerState {
  params: HouseParams;
  explode: number;
  parts?: string[];
  gallery: number;
  autoRotate: boolean;
}

export interface PanelDeps {
  state: ViewerState;
  stage: Stage;
  /** Regenerate the house(s) from state. */
  rebuild: () => Promise<void>;
  applyExplode: () => void;
  setCamera: (p: CameraPreset) => void;
  /** Show/hide a generated layer without regenerating. */
  setLayerVisible: (part: string, on: boolean) => void;
  isLayerVisible: (part: string) => boolean;
  /** Called when the assembly animation starts (the camera follows it). */
  onAssemblyStart: () => void;
  /** Absent where downloads are impossible (the published artifact). */
  exportGLB?: () => Promise<void>;
}

export interface Panel {
  /** Re-read every control from state (after params were replaced). */
  refresh: () => void;
  setStats: (triangles: number, ms: number, houses: number) => void;
  /** Animate the exploded view from fully apart to assembled. */
  playAssembly: () => void;
}

const VIEWS: [CameraPreset, string][] = [
  ['iso', 'Corner'],
  ['iso2', 'Other corner'],
  ['front', 'Front'],
  ['back', 'Back'],
  ['right', 'Gable'],
  ['door', 'Door'],
  ['eave', 'Eaves'],
  ['top', 'Above'],
];

const STYLES: [WallStyle, string][] = [
  ['stone', 'Stone'],
  ['plaster', 'Plaster'],
  ['timber', 'Timber'],
];

/** The builder's sheet: every house parameter plus view controls. */
export function createPanel(sheet: HTMLElement, viewsBar: HTMLElement, readout: HTMLElement, d: PanelDeps): Panel {
  const p = () => d.state.params;
  const updaters: (() => void)[] = [];
  // Regenerate shortly after the last change (dragging a slider would
  // otherwise rebuild the whole house on every input event).
  let timer = 0;
  const rebuildSoon = () => {
    clearTimeout(timer);
    setBusy(true);
    timer = window.setTimeout(async () => {
      await d.rebuild();
      setBusy(false);
      refreshReadout();
    }, 140);
  };

  // ----- header: the two things people do most ---------------------------
  const head = el('div', 'sheet-head');
  const actions = el('div', 'row');
  const newHouse = button('New house', 'primary', () => {
    replaceParams(randomParams(p().seed + 1));
  });
  newHouse.title = 'Generate a different random house';
  const seedBox = el('div', 'segmented');
  seedBox.style.flex = '0 0 auto';
  const prev = button('‹', '', () => replaceParams(randomParams(Math.max(0, p().seed - 1))));
  prev.setAttribute('aria-label', 'Previous seed');
  const seedLabel = el('button', '');
  seedLabel.setAttribute('aria-label', 'Current seed');
  seedLabel.style.fontFamily = 'var(--font-data)';
  seedLabel.tabIndex = -1;
  const next = button('›', '', () => replaceParams(randomParams(p().seed + 1)));
  next.setAttribute('aria-label', 'Next seed');
  seedBox.append(prev, seedLabel, next);
  updaters.push(() => (seedLabel.textContent = `#${String(p().seed).padStart(4, '0')}`));
  actions.append(newHouse, seedBox);

  const explode = rangeField('Exploded view', 0, 1, 0.01, () => d.state.explode, (v) => {
    d.state.explode = v;
    d.applyExplode();
  }, (v) => (v < 0.01 ? 'assembled' : `${Math.round(v * 100)}%`));
  const updateExplode = updaters[updaters.length - 1];
  const replay = button('Play assembly', '', () => playAssembly());
  head.append(actions, explode, replay);

  // ----- body: parameter sections ------------------------------------------
  const body = el('div', 'sheet-body');
  // Village mode generates its own houses from consecutive seeds, so the
  // single-house controls step aside (and say why).
  const houseControls = el('div', 'house-controls');
  const villageNote = hint('');
  villageNote.classList.add('village-note');
  updaters.push(() => {
    const village = d.state.gallery > 0;
    houseControls.inert = village;
    houseControls.classList.toggle('muted', village);
    villageNote.hidden = !village;
    villageNote.textContent = `The village shows nine houses from seeds ${p().seed}–${p().seed + 8}. Use New house or the seed arrows to see another village; turn the village off to shape a single house.`;
    viewsBar.hidden = village;
  });

  houseControls.append(
    section('Footprint', true, [
      rangeParam('Length', 'width', 5, 14, 0.1, 'm'),
      rangeParam('Depth', 'depth', 4, 8, 0.1, 'm'),
      segmentedField(
        'Storeys',
        [
          [1, '1'],
          [2, '2'],
          [3, '3'],
        ],
        () => p().floors,
        (v) => setParam('floors', v),
      ),
      rangeParam('Storey height', 'storeyHeight', 2.4, 3.2, 0.05, 'm'),
      rangeParam('Plinth', 'plinthHeight', 0.15, 0.8, 0.05, 'm'),
      rangeParam('Jetty (upper floor overhang)', 'jetty', 0, 0.45, 0.05, 'm', undefined, () =>
        p().floors > 1 && p().upperStyle !== 'stone' ? '' : p().floors > 1 ? 'Stone storeys don’t jetty out' : 'Needs two storeys',
      ),
    ]),
    section('Walls', true, [
      segmentedField('Ground floor', STYLES, () => p().groundStyle, (v) => setParam('groundStyle', v)),
      segmentedField('Upper floors', STYLES, () => p().upperStyle, (v) => setParam('upperStyle', v)),
      rangeParam('Wall thickness', 'wallThickness', 0.3, 0.6, 0.01, 'm'),
      rangeParam('Window spacing', 'windowSpacing', 1.6, 4, 0.1, 'm'),
      rangeParam('Door position', 'doorOffset', -1, 1, 0.05, '', (v) =>
        Math.abs(v) < 0.03 ? 'centre' : `${v < 0 ? 'left' : 'right'} ${Math.round(Math.abs(v) * 100)}%`,
      ),
      switches([
        ['Arched door', 'archedDoor'],
        ['Shutters', 'shutters'],
        ['Flower boxes', 'flowerBoxes'],
      ]),
    ]),
    section('Roof', false, [
      rangeParam('Pitch', 'roofPitch', 25, 62, 1, '°'),
      rangeParam('Eave overhang', 'eaveOverhang', 0.1, 0.9, 0.05, 'm'),
      rangeParam('Gable overhang', 'gableOverhang', 0.1, 0.8, 0.05, 'm'),
      switches([['Chimney', 'chimney']]),
      segmentedField(
        'Chimney end',
        [
          ['left', 'Left'],
          ['right', 'Right'],
        ],
        () => p().chimneySide,
        (v) => setParam('chimneySide', v),
      ),
    ]),
    section('Colour & surroundings', false, [paletteField(), switches([['Garden props', 'props']])]),
  );
  body.append(
    villageNote,
    houseControls,
    section('Layers', false, [
      hint('Each layer is a separate generator reading the same plan. Hide some to see how the house is put together.'),
      layerSwitches(),
    ]),
    section('View', false, [
      switchesRaw([
        ['Village of nine', () => d.state.gallery > 0, async (v) => {
          d.state.gallery = v ? 9 : 0;
          setBusy(true);
          refresh();
          await d.rebuild();
          d.setCamera('iso');
          setBusy(false);
        }],
        ['Turntable', () => d.state.autoRotate, (v) => (d.state.autoRotate = v)],
        ['Soft shadows (AO)', () => d.stage.ao, (v) => (d.stage.ao = v)],
      ]),
      ...(d.exportGLB ? [button('Download .glb', '', () => void d.exportGLB!())] : []),
    ]),
  );

  // ----- footer -------------------------------------------------------------
  const foot = el('div', 'sheet-foot');
  const tris = el('span', '');
  const ms = el('span', '');
  foot.append(tris, ms);
  let lastMs = '';
  function setBusy(on: boolean) {
    sheet.classList.toggle('busy', on);
    ms.textContent = on ? 'building…' : lastMs;
  }

  // Phone bottom sheet can fold away.
  const grab = button('Hide controls', 'grabber', () => {
    sheet.classList.toggle('collapsed');
    grab.textContent = sheet.classList.contains('collapsed') ? 'Show controls' : 'Hide controls';
  });

  sheet.append(grab, head, body, foot);

  // ----- camera bar -----------------------------------------------------------
  const viewButtons = VIEWS.map(([preset, label]) => {
    const b = button(label, '', () => {
      d.setCamera(preset);
      viewButtons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    b.setAttribute('aria-pressed', String(preset === 'iso'));
    return b;
  });
  viewsBar.append(...viewButtons);

  // ----- helpers ----------------------------------------------------------
  function replaceParams(next: HouseParams) {
    Object.assign(d.state.params, next);
    refresh();
    rebuildSoon();
  }

  function setParam<K extends keyof HouseParams>(key: K, value: HouseParams[K]) {
    p()[key] = value;
    refresh();
    rebuildSoon();
  }

  function rangeParam(
    label: string,
    key: keyof HouseParams,
    min: number,
    max: number,
    step: number,
    unit: string,
    format?: (v: number) => string,
    /** Returns a reason when the control has no effect right now ('' = active). */
    inactive?: () => string,
  ) {
    const field = rangeField(
      label,
      min,
      max,
      step,
      () => p()[key] as number,
      (v) => {
        (p() as unknown as Record<string, number>)[key] = v;
        rebuildSoon();
      },
      format ?? ((v) => `${v.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)}${unit ? ` ${unit}`.replace(' °', '°') : ''}`),
    );
    if (inactive) {
      const note = hint('');
      field.append(note);
      const input = field.querySelector('input')!;
      updaters.push(() => {
        const why = inactive();
        input.disabled = why !== '';
        note.textContent = why;
        note.hidden = why === '';
      });
    }
    return field;
  }

  function rangeField(
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
    format: (v: number) => string,
  ) {
    const id = `f-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    const wrap = el('div', 'field');
    const top = el('div', 'field-top');
    const lab = el('label', '');
    lab.textContent = label;
    lab.htmlFor = id;
    const val = el('span', 'value');
    top.append(lab, val);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = format(v);
      set(v);
    });
    const update = () => {
      input.value = String(get());
      val.textContent = format(get());
    };
    updaters.push(update);
    wrap.append(top, input);
    return wrap;
  }

  function segmentedField<T extends string | number>(label: string, options: [T, string][], get: () => T, set: (v: T) => void) {
    const wrap = el('div', 'field');
    const lab = el('span', 'label');
    lab.textContent = label;
    const group = el('div', 'segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    const buttons = options.map(([value, text]) => {
      const b = button(text, '', () => set(value));
      b.dataset.value = String(value);
      return b;
    });
    group.append(...buttons);
    updaters.push(() => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(get())))));
    wrap.append(lab, group);
    return wrap;
  }

  function switches(list: [string, keyof HouseParams][]) {
    return switchesRaw(
      list.map(([label, key]) => [
        label,
        () => Boolean(p()[key]),
        (v: boolean) => setParam(key, v as never),
      ]),
    );
  }

  function switchesRaw(list: [string, () => boolean, (v: boolean) => void][]) {
    const wrap = el('div', 'switches');
    for (const [label, get, set] of list) {
      const row = el('label', 'switch');
      const text = el('span', '');
      text.textContent = label;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = `s-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
      input.addEventListener('change', () => set(input.checked));
      updaters.push(() => (input.checked = get()));
      row.append(text, input);
      wrap.append(row);
    }
    return wrap;
  }

  function layerSwitches() {
    return switchesRaw(
      PARTS.map((part) => [part.label, () => d.isLayerVisible(part.name), (on: boolean) => d.setLayerVisible(part.name, on)]),
    );
  }

  function paletteField() {
    const wrap = el('div', 'field');
    const lab = el('span', 'label');
    lab.textContent = 'Palette';
    const grid = el('div', 'swatches');
    const swatches = Object.entries(PALETTES).map(([name, pal]) => {
      const b = button('', 'swatch', () => {
        p().palette = { ...pal, flowers: [...pal.flowers] };
        refresh();
        rebuildSoon();
      });
      b.setAttribute('aria-label', `${name} palette`);
      b.title = name;
      const roof = el('span', '');
      roof.style.background = pal.roof;
      const lower = el('span', 'lower');
      const wall = el('span', '');
      wall.style.background = pal.plaster;
      const shutter = el('span', '');
      shutter.style.background = pal.shutter;
      lower.append(wall, shutter);
      b.append(roof, lower);
      b.dataset.roof = pal.roof;
      return b;
    });
    grid.append(...swatches);
    // Random houses drift their colours a little, so highlight the nearest palette.
    updaters.push(() => {
      const roof = new Color(p().palette.roof);
      let best: HTMLButtonElement | null = null;
      let bestD = 0.02;
      for (const sw of swatches) {
        const c = new Color(sw.dataset.roof);
        const dist = (c.r - roof.r) ** 2 + (c.g - roof.g) ** 2 + (c.b - roof.b) ** 2;
        if (dist < bestD) [best, bestD] = [sw, dist];
      }
      swatches.forEach((sw) => sw.setAttribute('aria-pressed', String(sw === best)));
    });
    wrap.append(lab, grid);
    return wrap;
  }

  function refreshReadout() {
    const q = p();
    readout.textContent =
      d.state.gallery > 0
        ? `VILLAGE · SEEDS ${q.seed}–${q.seed + d.state.gallery - 1}`
        : `SEED ${String(q.seed).padStart(4, '0')} · ${q.width.toFixed(1)} × ${q.depth.toFixed(1)} m · ${q.floors} ${
            q.floors === 1 ? 'STOREY' : 'STOREYS'
          } · ${Math.round(q.roofPitch)}° ROOF`;
  }

  function refresh() {
    updaters.forEach((u) => u());
    refreshReadout();
  }

  let anim = 0;
  function playAssembly() {
    cancelAnimationFrame(anim);
    d.onAssemblyStart();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      d.state.explode = 0;
      d.applyExplode();
      refresh();
      return;
    }
    const start = performance.now();
    const hold = 350;
    const dur = 2300;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start - hold) / dur));
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      d.state.explode = 1 - e;
      d.applyExplode();
      updateExplode();
      if (t < 1) anim = requestAnimationFrame(tick);
    };
    anim = requestAnimationFrame(tick);
  }

  refresh();
  return {
    refresh,
    playAssembly,
    setStats(triangles, msTotal, houses) {
      tris.textContent = `${Math.round(triangles / 1000)}k triangles${houses > 1 ? ` · ${houses} houses` : ''}`;
      lastMs = `built in ${msTotal} ms`;
      if (!sheet.classList.contains('busy')) ms.textContent = lastMs;
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className);
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function section(title: string, open: boolean, children: HTMLElement[]): HTMLDetailsElement {
  const det = el('details', '');
  det.open = open;
  const sum = el('summary', '');
  sum.textContent = title;
  const fields = el('div', 'fields');
  fields.append(...children);
  det.append(sum, fields);
  return det;
}

function hint(text: string): HTMLParagraphElement {
  const para = el('p', 'hint');
  para.textContent = text;
  return para;
}
