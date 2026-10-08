import { PartBuilder } from '../builder';
import type { PartDef } from '../house';

/** TODO: not implemented yet (see layout.roof.dormers). */
export const part: PartDef = {
  name: 'dormers',
  label: 'Dormers',
  explode: [0, 0, 0],
  build: () => new PartBuilder('dormers'),
};
