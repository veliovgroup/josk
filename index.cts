// CommonJS declaration entry point.
//
// This file is the input to TypeScript when generating `index.d.cts` for
// consumers that import JoSk via `require()`. The `.cts` extension tells
// TypeScript to treat the output as CommonJS-shaped (`index.d.cts`).
//
// The runtime CJS bundle (`index.cjs`) is generated separately by Rollup
// from `index.js`. Both expose the same named-export surface.
//
// Not published — see `.npmignore`.

export {
  JoSk,
  MongoAdapter,
  RedisAdapter,
  PostgresAdapter
} from './index.js';

export type {
  JoSkAdapter,
  JoSkOption,
  JoSkTask,
  JoSkLock,
  JoSkExecuteMode,
  JoSkPingResult,
  JoSkErrorDetails,
  JoSkExecutedDetails,
  JoSkOnError,
  JoSkOnExecuted,
  JoSkReady,
  JoSkReadyCallback,
  JoSkTaskHandler,
  JoSkStoredTask
} from './index.js';
