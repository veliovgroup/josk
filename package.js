Package.describe({
  name: 'ostrio:cron-jobs',
  version: '2.4.3',
  summary: 'Scheduler and manager for jobs and tasks in Node.js (Meteor.js) on multi-server and clusters setup',
  git: 'https://github.com/VeliovGroup/josk',
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
