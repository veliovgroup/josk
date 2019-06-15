Package.describe({
  name: 'ostrio:cron-jobs',
  version: '2.3.0',
  summary: 'Task scheduler. With support of clusters or multiple NodeJS instances.',
  git: 'https://github.com/VeliovGroup/josk',
  documentation: 'README.md'
});

Package.onUse(function (api) {
  api.versionsFrom('1.6');
  api.use('ecmascript', 'server');
  api.mainModule('index.js', 'server');
});

Package.onTest(function (api) {
  api.use(['ecmascript', 'accounts-base', 'ostrio:cron-jobs', 'practicalmeteor:mocha', 'practicalmeteor:chai', 'meteortesting:mocha', 'jquery'], 'server');
  api.use('jquery', 'client');
  api.addFiles('test-meteor.js', 'server');
});
