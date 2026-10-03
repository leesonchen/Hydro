process.env.CI = true;
const version = process.versions.node.split('.').map((i) => i.padStart(2, '0'));
version.pop();
if (+version.join('.') < 18.08) throw new Error('Tests only available in NodeJS>=18.8');
// Keep every temporary instance, including startup's initial URL probe, so
// integration tests can exit naturally and retain node:test's failure status.
const { MongoMemoryServer } = require('mongodb-memory-server');
const createMongo = MongoMemoryServer.create;
const mongoInstances = [];
MongoMemoryServer.create = async function (...args) {
    const instance = await createMongo.apply(this, args);
    mongoInstances.push(instance);
    return instance;
};
exports.stopMongoInstances = async () => {
    MongoMemoryServer.create = createMongo;
    await Promise.all(mongoInstances.map((instance) => instance.stop()));
};
require('hydrooj/bin/hydrooj');
require('./main');
