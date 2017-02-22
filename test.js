;(() => {
  'use strict';
  const MongoClient = require('mongodb').MongoClient;
  const JoSk        = require('./index.js');
  const mongoAddr   = process.env.MONGO_URL;

  MongoClient.connect(mongoAddr, (error, db) => {
    if (error) {
      throw error;
    }

    const Job = new JoSk({db: db});
    Job.setInterval((ready) => {
      console.log('30s', new Date());
      ready();
    }, 30 * 1000, 'task-30');

    Job.setInterval((ready) => {
      console.warn('60s', new Date());
      ready();
    }, 60 * 1000, 'task-60');

    Job.setInterval((ready) => {
      console.log('90s', new Date());
      ready();
    }, 90 * 1000, 'task-90');

    Job.setInterval(() => {
      console.log('>>> zombie', new Date());
    }, 1000, '>>> zombie');
  });
})();
