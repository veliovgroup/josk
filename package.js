Package.describe({
  name: 'ostrio:cron-jobs',
  version: '5.1.0',
  summary: 'Tasks/CRON scheduler and manager for horizontally scaled multi-server apps',
  git: 'https://github.com/veliovgroup/josk',
  documentation: 'README.md'
});

Package.onUse((api) => {
  api.versionsFrom(['1.6', '3.0.0', '3.4']);
  api.use('ecmascript', 'server');
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  Npm.depends({
    'cron-parser': '4.9.0',
    chai: '4.4.1',
    redis: '4.6.13',
    pg: '8.13.1',
  });

  api.use(['ecmascript', 'mongo', 'meteortesting:mocha@3.3.0'], 'server');
  api.addFiles('test/meteor.js', 'server');
});
