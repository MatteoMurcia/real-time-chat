const url = new URL('postgresql://db:5432');
for (const name of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
url.username = encodeURIComponent(process.env.POSTGRES_USER);
url.password = encodeURIComponent(process.env.POSTGRES_PASSWORD);
url.pathname = `/${encodeURIComponent(process.env.POSTGRES_DB)}`;
process.env.DATABASE_URL = url.href;
