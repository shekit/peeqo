// Worker thread for tools/build-clearance.mjs: measures batches of sample points and posts the distances back.

import { parentPort, workerData } from 'node:worker_threads';
import { createMeasurer } from './clearance.mjs';

const measurer = await createMeasurer(workerData.glbPath);
parentPort.on('message', ({ id, kind, args }) => {
  try {
    parentPort.postMessage({ id, values: measurer[kind](...args) });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.stack : String(error) });
  }
});
