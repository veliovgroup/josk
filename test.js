;(() => {
  'use strict';
  const MongoClient = require('mongodb').MongoClient;
  const JoSk        = require('./index.js');
  const mongoAddr   = process.env.MONGO_URL;

  MongoClient.connect(mongoAddr, (error, db) => {
    if (error) {
      throw error;
    }

    const timestamps = {};

    const Job = new JoSk({
      db: db,
      prefix: 'testCase',
      // autoClear: true,
      onError(message, details) {
        if (message === 'One of your tasks is missing') {
          Job.clearTimeout(details.uid);
        }
        console.log(message, details);
      },
      onExecuted(uid, details) {
        if (!timestamps[uid]) {
          timestamps[uid] = details.timestamp;
          return;
        }

        console.log(uid, details.timestamp - timestamps[uid], +new Date() - timestamps[uid]);
        timestamps[uid] = details.timestamp;
      }
    });

    Job.setInterval((ready) => {
      ready();
    }, 30 * 1000, 'task-30');

    Job.setInterval((ready) => {
      ready();
    }, 60 * 1000, 'task-60');

    Job.setInterval((ready) => {
      ready();
    }, 90 * 1000, 'task-90');

    Job.setInterval((ready) => {
      setTimeout(ready, 15000);
    }, 15 * 1000, 'task-15-15s-delay');

    Job.setInterval((ready) => {
      process.nextTick(ready);
    }, 15 * 1000, 'task-15-nextTick');

    Job.setInterval(() => {
      return;
    }, 1000, '>>> zombie');
  });
})();
