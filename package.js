Package.describe({
  name: 'ostrio:cron-jobs',
  version: '6.0.0',
  summary: 'Tasks/CRON scheduler and manager for horizontally scaled multi-server apps',
  git: 'https://github.com/veliovgroup/josk',
  documentation: 'README.md'
});

Package.onUse((api) => {
  api.versionsFrom(['1.6', '3.0.1', '3.4']);
  api.use('ecmascript', 'server');
  // TypeScript setup
  api.use(['zodern:types@1.0.13', 'typescript'], ['client', 'server'], { weak: true });
  // For zodern:types to pick up our published types.
  api.addAssets('index.d.ts', ['client', 'server']);
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  Npm.depends({
    'cron-parser': '5.5.0',
    chai: '5.3.3',
    redis: '4.7.1',
    pg: '8.16.3',
  });

  api.use(['ecmascript', 'mongo', 'zodern:types', 'typescript', 'meteortesting:mocha@3.3.0'], 'server');
  api.addFiles([
    'test/meteor.js',
    'test/meteor-types.ts',
  ], 'server');
});
