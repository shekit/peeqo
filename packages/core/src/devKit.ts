import { ClearanceModel } from './clearance.ts';
import { DEV_KIT_CLEARANCE_DATA } from './devKitClearance.ts';

/** Collision tables for the 2019 dev kit, computed from its CAD (apps/sim/tools/build-clearance.mjs). */
export const DEV_KIT_CLEARANCE = new ClearanceModel(DEV_KIT_CLEARANCE_DATA);

/** The tables used unless told otherwise: the real robot's. */
export const DEFAULT_CLEARANCE: ClearanceModel | null = DEV_KIT_CLEARANCE;
