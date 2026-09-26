import { assert } from 'chai';
import { describe, it } from 'mocha';
import { getMongoDatabaseName } from './mongo-url.js';

describe('Mongo connection URL parsing', () => {
  it('keeps query options out of the database name', () => {
    const url = 'mongodb://user:pass@db.example.test:27017/josk_test?tls=true&retryWrites=false';

    assert.equal(getMongoDatabaseName(url), 'josk_test');
  });

  it('parses the database name with comma-separated replica-set hosts', () => {
    const url = 'mongodb://host1.example.test:27017,host2.example.test:27017/josk_test?tls=true&replicaSet=rs0';

    assert.equal(getMongoDatabaseName(url), 'josk_test');
  });
});
