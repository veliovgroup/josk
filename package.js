Package.describe({
  name: 'ostrio:cron-jobs',
  version: '6.5.0',
  summary: 'Tasks/CRON manager for horizontally scaled multi-server apps. Runs on Redis, MongoDB, and PostgreSQL',
  git: 'https://github.com/veliovgroup/josk',
  documentation: 'README.md'
});

/**
 * Meteor test-packages runs package.js under each release's bundled Node.
 * @returns {{ npm: Record<string, string>, mocha: string }}
 */
const meteorTestProfile = () => {
  const nodeMajor = parseInt(String(process.versions.node).split('.')[0], 10);

  if (nodeMajor >= 18) {
    return {
      npm: {
        'cron-parser': '5.5.0',
        chai: '5.3.3',
        redis: '4.7.1',
        pg: '8.16.3',
      },
      mocha: 'meteortesting:mocha@3.3.0',
    };
  }

  if (nodeMajor >= 14) {
    return {
      npm: {
        'cron-parser': '4.9.0',
        chai: '4.4.1',
        redis: '4.7.1',
        pg: '8.11.3',
      },
      mocha: 'meteortesting:mocha@2.1.0',
    };
  }

  throw new Error(`ostrio:cron-jobs requires Node >= 14 (got ${process.version})`);
};

Package.onUse((api) => {
  // CI: 2.14–2.16, 3.2 / 3.3.1 / 3.4 (skip 3.3.0)
  api.versionsFrom(['2.14', '3.2']);
  api.use('ecmascript', 'server');
  // TypeScript setup
  api.use(['zodern:types@1.0.13', 'typescript'], ['client', 'server'], { weak: true });
  // Keep the root declaration and its relative adapter imports together.
  api.addAssets([
    'index.d.ts',
    'adapters/mongo.d.ts',
    'adapters/redis.d.ts',
    'adapters/postgres.d.ts'
  ], 'server');
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  const profile = meteorTestProfile();

  Npm.depends(profile.npm);

  api.use(['ecmascript', 'mongo', profile.mocha, 'zodern:types', 'typescript'], 'server');

  const suites = {
    mongo: ['test/meteor-ci-mongo.js'],
    redis: ['test/meteor-ci-redis.js'],
    postgres: ['test/meteor-ci-postgres.js']
  };
  const testFiles = suites[process.env.METEOR_TEST_SUITE] || ['test/meteor.js', 'test/meteor-types.ts'];

  api.addFiles(testFiles, 'server');
});
