import { PartBuilder } from '../builder';
import type { PartDef } from '../house';

/** TODO: not implemented yet. */
export const part: PartDef = {
  name: 'stonework',
  label: 'Stonework',
  explode: [0, 0, 0],
  build: () => new PartBuilder('stonework'),
};
