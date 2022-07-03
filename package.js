Package.describe({
  name: 'ostrio:cron-jobs',
  version: '3.0.2',
  summary: 'Jobs scheduler for multi-server and clusters setup',
  git: 'https://github.com/veliovgroup/josk',
  documentation: 'README.md'
});

Package.onUse((api) => {
  api.versionsFrom('1.6');
  api.use('ecmascript', 'server');
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  api.use(['ecmascript', 'mongo', 'practicalmeteor:chai', 'meteortesting:mocha'], 'server');
  api.addFiles('test/meteor.js', 'server');
});

// UNCOMMENT FOR METEOR_TESTS
// Npm.depends({
//   'cron-parser': '4.5.0'
// });
