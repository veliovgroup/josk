import josk = require('josk');

const adapter = {
  async acquireLock() {
    return true;
  },
  async releaseLock() {},
  async remove(_uid: string) {
    return true;
  },
  async add(_uid: string, _isInterval: boolean, _delay: number) {
    return true;
  },
  async update(_task: { uid: string }, _nextExecuteAt: Date) {
    return true;
  },
  async iterate(_nextExecuteAt: Date) {},
  async ping() {
    return {
      status: 'OK',
      code: 200,
      statusCode: 200
    };
  }
};

const jobs = new josk.JoSk({ adapter });

jobs.setImmediate(() => {}, 'cjs-task');
jobs.destroy();

const adapterCtor = josk.PostgresAdapter;
void adapterCtor;
