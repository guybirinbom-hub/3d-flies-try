import { PartBuilder } from '../builder';
import type { PartDef } from '../house';

/** TODO: not implemented yet. */
export const part: PartDef = {
  name: 'props',
  label: 'Props',
  explode: [0, 0, 0],
  build: () => new PartBuilder('props'),
};
