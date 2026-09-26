import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const temp = mkdtempSync(join(tmpdir(), 'josk-types-'));
const project = join(temp, 'project');
const packageDir = join(project, 'node_modules', 'josk');

try {
  mkdirSync(packageDir, { recursive: true });
  const tarball = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', temp, '--silent'], {
    cwd: resolve('.'),
    encoding: 'utf8'
  }).trim();
  execFileSync('tar', ['-xzf', join(temp, tarball), '-C', packageDir, '--strip-components=1']);
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: []
    },
    files: ['consumer.mts', 'consumer.cts']
  }));
  writeFileSync(join(project, 'consumer.mts'), `import { JoSk, PostgresAdapter } from 'josk';
const jobs = new JoSk({ adapter: new PostgresAdapter({ client: { query: async () => ({ rows: [], rowCount: 0 }) } }) });
jobs.destroy();
`);
  writeFileSync(join(project, 'consumer.cts'), `import josk = require('josk');
const jobs = new josk.JoSk({ adapter: new josk.PostgresAdapter({ client: { query: async () => ({ rows: [], rowCount: 0 }) } }) });
jobs.destroy();
`);
  const output = execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
    cwd: project,
    encoding: 'utf8'
  });
  process.stdout.write(output || 'Packed ESM and CJS declarations compile without unused drivers.\n');

  // Bun projects typically use bundler resolution with `module: Preserve`.
  writeFileSync(join(project, 'bun.ts'), `import { JoSk, PostgresAdapter } from 'josk';
import type { JoSkShutdownOption } from 'josk';
const opts: JoSkShutdownOption = { timeout: 1000 };
const jobs = new JoSk({ adapter: new PostgresAdapter({ client: { query: async () => ({ rows: [], rowCount: 0 }) } }) });
const drained: Promise<boolean> = jobs.shutdown(opts);
void drained;
`);
  writeFileSync(join(project, 'tsconfig.bun.json'), JSON.stringify({
    compilerOptions: {
      target: 'ESNext',
      module: 'Preserve',
      moduleResolution: 'bundler',
      verbatimModuleSyntax: true,
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: []
    },
    files: ['bun.ts']
  }));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.bun.json'], {
    cwd: project,
    stdio: 'inherit'
  });
  console.log('Packed declarations resolve with bundler resolution (Bun).');

  let onUse;
  const assets = [];
  runInNewContext(readFileSync('package.js', 'utf8'), {
    Package: {
      describe() {},
      onUse(callback) { onUse = callback; },
      onTest() {}
    },
    process
  });
  onUse({
    versionsFrom() {},
    use() {},
    mainModule() {},
    addAssets(paths) { assets.push(...(Array.isArray(paths) ? paths : [paths])); }
  });
  const meteorPackage = join(project, 'meteor-package');
  for (const asset of assets) {
    const destination = join(meteorPackage, asset);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    copyFileSync(asset, destination);
  }
  writeFileSync(join(project, 'meteor.ts'), `import { JoSk, MongoAdapter, RedisAdapter, PostgresAdapter } from 'meteor/ostrio:cron-jobs';
import type { JoSkAdapter, JoSkShutdownOption } from 'meteor/ostrio:cron-jobs';
type AssertAdapter<T extends JoSkAdapter> = T;
type MongoContract = AssertAdapter<MongoAdapter>;
type RedisContract = AssertAdapter<RedisAdapter>;
type PostgresContract = AssertAdapter<PostgresAdapter>;
const jobs = new JoSk({ adapter: new MongoAdapter({ db: { collection: () => ({}), command: async () => ({ ok: 1 }) } }) });
const options: JoSkShutdownOption = { timeout: 1000 };
const shutdownResult: Promise<boolean> = jobs.shutdown(options);
void shutdownResult;
// @ts-expect-error The shutdown timeout must be numeric.
jobs.shutdown({ timeout: '1000' });
// @ts-expect-error Shutdown is asynchronous, not a synchronous boolean.
const synchronousResult: boolean = jobs.shutdown();
`);
  writeFileSync(join(project, 'tsconfig.meteor.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
      paths: { 'meteor/ostrio:cron-jobs': ['./meteor-package/index.d.ts'] }
    },
    files: ['meteor.ts']
  }));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.meteor.json'], {
    cwd: project,
    stdio: 'inherit'
  });
  console.log('Meteor declaration assets type-check all adapter contracts and shutdown through the package import.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
