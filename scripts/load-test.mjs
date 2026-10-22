import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadOptions, validateLocalDocker } from './load-metrics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = loadOptions(process.argv.slice(2));
const execute = promisify(execFile), abort = new AbortController();
const env = { ...process.env, BENCHMARK_PASSWORD: randomBytes(24).toString('hex') };
const compose = ['compose', '--project-name', 'chat-benchmark', '--file', 'compose.benchmark.yaml'];
const lockPath = join(tmpdir(), 'real-time-chat-benchmark.lock');
const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Benchmark lock exists. Check for a running benchmark before removing the temporary lock.'); });
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const report = { schemaVersion: 1, runId, options, status: 'failed', samples: [] };
let owned = false, sampling = false, sampler, sampleErrors = 0;
const run = async (command, args, cleanup = false) => (await execute(command, args, {
  cwd: root, env, timeout: 300000, maxBuffer: 32 * 1024 * 1024, ...(cleanup ? {} : { signal: abort.signal }),
})).stdout.trim();
const database = () => run('docker', [...compose, 'exec', '-T', 'db', 'psql', '-U', 'benchmark_local', '-d', 'chat_benchmark', '-Atc',
  `SELECT json_build_object('database', current_database(), 'role', current_user, 'postgresVersion', version(),
    'users', (SELECT count(*) FROM "User"), 'sessions', (SELECT count(*) FROM "Session"),
    'channels', (SELECT count(*) FROM "Channel"), 'messages', (SELECT count(*) FROM "Message"))`]);
const interrupted = () => abort.abort();
process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);

try {
  report.phase = 'local-context';
  if (env.DOCKER_HOST) throw new Error('DOCKER_HOST_OVERRIDE_REFUSED');
  const context = await run('docker', ['context', 'show']);
  validateLocalDocker(JSON.parse(await run('docker', ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'])));
  env.DOCKER_CONTEXT = context;
  for (const [noun, filter] of [['ps', '-aq'], ['network', 'ls'], ['volume', 'ls']]) {
    const args = noun === 'ps' ? ['ps', filter] : [noun, filter, '-q'];
    if (await run('docker', [...args, '--filter', 'label=com.docker.compose.project=chat-benchmark'])) throw new Error('PREEXISTING_BENCHMARK_RESOURCES');
  }
  report.source = { commit: await run('git', ['rev-parse', 'HEAD']), dirty: !!(await run('git', ['status', '--porcelain', '--',
    'apps/api', 'packages/contracts', 'scripts', 'compose.benchmark.yaml', 'package.json', 'package-lock.json', 'tsconfig.base.json', '.npmrc'])) };
  report.host = { os: platform(), release: release(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version };
  const info = JSON.parse(await run('docker', ['info', '--format', '{{json .}}']));
  report.docker = { version: info.ServerVersion, os: info.OperatingSystem, kernel: info.KernelVersion, architecture: info.Architecture, cpus: info.NCPU, memoryBytes: info.MemTotal };
  report.otherRunningContainers = (await run('docker', ['ps', '-q'])).split('\n').filter(Boolean).length;
  report.composeVersion = await run('docker', ['compose', 'version', '--short']);
  report.dependencies = JSON.parse(await readFile(join(root, 'apps/api/package.json'), 'utf8')).dependencies;
  owned = true;
  report.phase = 'build';
  report.storage = 'Fresh dedicated Docker named volume; default PostgreSQL durability settings';
  process.stderr.write('Building dedicated benchmark images and fresh PostgreSQL volume...\n');
  await run('docker', [...compose, '--profile', 'tools', 'build']);
  report.phase = 'startup';
  await run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '120', 'api']);
  const initial = JSON.parse(await database());
  if (initial.database !== 'chat_benchmark' || initial.role !== 'benchmark_local' || initial.users !== 0 || initial.messages !== 0) throw new Error('BENCHMARK_ISOLATION_FAILED');
  report.initialDataset = initial;
  report.images = await run('docker', ['inspect', '--format', '{{.Name}} {{.Image}}', 'chat-benchmark-api-1', 'chat-benchmark-db-1']);
  report.apiNode = await run('docker', [...compose, 'exec', '-T', 'api', 'node', '-p', 'process.version']);
  report.apiNpm = await run('docker', [...compose, 'exec', '-T', 'api', 'npm', '--version']);
  sampling = true;
  sampler = (async () => {
    while (sampling) {
      try {
        const output = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', 'chat-benchmark-api-1', 'chat-benchmark-db-1']);
        report.samples.push({ at: new Date().toISOString(), containers: output.split('\n').map(line => {
          const { Name, CPUPerc, MemUsage, NetIO, BlockIO, PIDs } = JSON.parse(line);
          return { name: Name, cpuPercent: CPUPerc, memory: MemUsage, networkIO: NetIO, blockIO: BlockIO, pids: PIDs };
        }) });
      } catch { sampleErrors++; }
      if (sampling) await sleep(1000);
    }
  })();
  process.stderr.write('Running fixture setup, warm-up and scheduled load...\n');
  report.phase = 'load';
  const args = Object.entries(options).flatMap(([key, value]) => [`--${key}`, String(value)]);
  report.workload = JSON.parse(await run('docker', [...compose, 'run', '--rm', '-T', '--no-deps', 'load', ...args]));
  report.phase = 'verify';
  report.finalDataset = JSON.parse(await database());
  const { dataset, delivery, measurement, warmup } = report.workload;
  report.correctness = report.finalDataset.messages === dataset.acknowledgedMessages
    && report.finalDataset.users === options.users && report.finalDataset.sessions === options.users && report.finalDataset.channels === 1
    && delivery.expected === delivery.received && delivery.missing === 0 && delivery.unacknowledged === 0 && delivery.mismatched === 0
    && delivery.duplicates === 0 && delivery.invalidEvents === 0 && delivery.disconnects === 0;
  const measuredSamples = report.samples.filter(sample => sample.at >= measurement.startedAt && sample.at <= measurement.endedAt);
  report.measuredResourceSamples = measuredSamples.length;
  report.status = report.correctness && measuredSamples.length > 0 && sampleErrors === 0
    && measurement.unsuccessfulScheduledRate === 0 && (!warmup || warmup.unsuccessfulScheduledRate === 0) ? 'passed' : 'failed';
} catch (error) {
  report.failure = abort.signal.aborted ? 'INTERRUPTED' : 'SETUP_OR_MEASUREMENT_FAILED';
  if (/^(LOCAL_DOCKER_REQUIRED|DOCKER_HOST_OVERRIDE_REFUSED|PREEXISTING_BENCHMARK_RESOURCES|BENCHMARK_ISOLATION_FAILED)$/.test(error.message)) report.failure = error.message;
  report.commandExit = typeof error.code === 'number' ? error.code : 'COMMAND_OR_HARNESS_ERROR';
  try { report.workerFailure = JSON.parse(error.stdout).failure; } catch { /* Build output is not a worker report. */ }
} finally {
  sampling = false; await sampler;
  report.sampleErrors = sampleErrors;
  report.cleanup = !owned;
  if (owned) {
    try { await run('docker', [...compose, '--profile', 'tools', 'down', '--volumes', '--remove-orphans'], true); report.cleanup = true; }
    catch { report.cleanup = false; report.status = 'failed'; }
  }
  const output = join(root, 'docs', 'benchmark-results', `${runId}.json`);
  try {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(`${report.status}: ${output}\n`);
  } finally { await lock.close(); await unlink(lockPath); }
  process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  if (report.status !== 'passed') process.exitCode = 1;
}
