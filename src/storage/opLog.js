import { MAX_OP_LOG } from '../constants.js';

// ============================================================
// Operation Logger (ring buffer)
// ============================================================
function createOperationLogger() {
  const log = [];
  return {
    add(entry) {
      log.push({
        timestamp: Date.now(),
        ...entry,
      });
      if (log.length > MAX_OP_LOG) log.shift();
    },
    getAll() {
      return [...log];
    },
    clear() {
      log.length = 0;
    },
  };
}

const operationLog = createOperationLogger();

export { operationLog };
