Package.describe({
  name: 'ostrio:cron-jobs',
  version: '4.1.0',
  summary: 'Tasks/CRON scheduler and manager for horizontally scaled multi-server apps',
  git: 'https://github.com/veliovgroup/josk',
  documentation: 'README.md'
});

Package.onUse((api) => {
  api.versionsFrom(['1.6', '3.0-beta.0']);
  api.use('ecmascript@0.16.8 || 0.16.8-beta300.0', 'server');
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  Npm.depends({
    'cron-parser': '4.9.0',
    chai: '4.4.1',
    redis: '4.6.13',
  });

  api.use(['ecmascript@0.16.8 || 0.16.8-beta300.0', 'mongo@1.6.19 || 2.0.0-beta300.0', 'meteortesting:mocha@2.1.0 || 3.1.0-beta300.0'], 'server');
  api.addFiles('test/meteor.js', 'server');
});
