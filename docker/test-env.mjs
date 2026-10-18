import './database-env.mjs';

if (!/^\w+_test$/.test(process.env.POSTGRES_DB)) throw new Error('Integration requires a dedicated _test database');
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;
