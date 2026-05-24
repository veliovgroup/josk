Package.describe({
  name: 'ostrio:cron-jobs',
  version: '6.2.0',
  summary: 'Tasks/CRON scheduler and manager for horizontally scaled multi-server apps',
  git: 'https://github.com/veliovgroup/josk',
  documentation: 'README.md'
});

/**
 * Meteor test-packages runs package.js under each release's bundled Node.
 * @returns {{ npm: Record<string, string>, mocha: string, typescript: boolean }}
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
      typescript: true,
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
      mocha: 'meteortesting:mocha@2.5.3',
      typescript: true,
    };
  }

  // Meteor 1.12.x — Node 12
  return {
    npm: {
      'cron-parser': '4.9.0',
      chai: '4.4.1',
      redis: '4.7.1',
      pg: '8.7.3',
    },
    mocha: 'meteortesting:mocha@2.0.3',
    typescript: false,
  };
};

Package.onUse((api) => {
  // CI: 1.12.1, 2.14–2.16, 3.2 / 3.3.1 / 3.4 (skip 3.3.0)
  api.versionsFrom(['1.12', '2.14', '3.2']);
  api.use('ecmascript', 'server');
  // TypeScript setup
  api.use(['zodern:types@1.0.13', 'typescript'], ['client', 'server'], { weak: true });
  // For zodern:types to pick up our published types.
  api.addAssets('index.d.ts', ['client', 'server']);
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  const profile = meteorTestProfile();

  Npm.depends(profile.npm);

  const testUses = ['ecmascript', 'mongo', profile.mocha];
  if (profile.typescript) {
    testUses.push('zodern:types', 'typescript');
  }
  api.use(testUses, 'server');

  const suite = process.env.METEOR_TEST_SUITE;
  const defaultTests = profile.typescript
    ? ['test/meteor.js', 'test/meteor-types.ts']
    : ['test/meteor.js'];
  const testFiles = suite === 'mongo'
    ? ['test/meteor-ci-mongo.js']
    : suite === 'redis'
      ? ['test/meteor-ci-redis.js']
      : suite === 'postgres'
        ? ['test/meteor-ci-postgres.js']
        : defaultTests;

  api.addFiles(testFiles, 'server');
});
