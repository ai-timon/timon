/**
 * scripts/run-tests.mjs — the limits actually stop a runaway test.
 *
 * Each case writes a throwaway test file, runs the real wrapper on it with
 * tight limits, and checks both the verdict and that no process survived.
 * The synchronous loop is the incident of 19/09/2026: a test holding the
 * event loop, run with no limit at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DAEMON_ENV_KEYS, defaultRssMb, splitArgs, withHeapCeiling, withoutDaemonEnv, withRssPreload, withTmpDir,
} from './run-tests.mjs';

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), 'run-tests.mjs');
const TMP_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'test-tmp-preload.mjs');
/** How long after its limit a run may end: what these bounds prove is that the
 *  limit acted, long before the defaults of 2 and 10 minutes. Node itself can
 *  take tens of seconds to start on a loaded machine. */
const SOON_MS = 60_000;

function runWrapper(cwd, file, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [WRAPPER, ...[file].flat()], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - started }));
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A SIGKILLed process stays signalable as a zombie until its new parent
 *  reaps it: give that a moment. */
async function gone(pid) {
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

function fixture(name, body) {
  const dir = mkdtempSync(join(tmpdir(), 'timon-run-tests-'));
  writeFileSync(join(dir, name), body);
  return dir;
}

const LOOP = `
  import { test } from 'node:test';
  import { writeFileSync } from 'node:fs';
  test('never returns', () => {
    writeFileSync('PIDFILE', String(process.pid));
    for (;;) { /* holds the event loop */ }
  });
`;

function loopPid(dir) {
  const pidFile = join(dir, 'PIDFILE');
  assert.ok(existsSync(pidFile), 'the looping test never started');
  return Number(readFileSync(pidFile, 'utf8'));
}

/** A limit starts when the process does: on a loaded machine Node may still be
 *  loading when a tight one fires, and that run says nothing about the loop
 *  (TODO #657). It is run again with room to spare, until the loop was reached. */
async function runLoopUnder(limits, envOf) {
  for (const limit of limits) {
    const dir = fixture('loop.test.mjs', LOOP);
    const run = await runWrapper(dir, 'loop.test.mjs', envOf(limit));
    // Killed between creating the file and writing it: not started either. A
    // pid of 0 would have `alive` signal this test's own process group.
    if (existsSync(join(dir, 'PIDFILE')) && loopPid(dir) > 0) return { ...run, limit, pid: loopPid(dir) };
  }
  return assert.fail(`the looping test never started under a limit of ${limits.at(-1)} ms`);
}

test('the per-test timeout stops a synchronous infinite loop', async () => {
  const { code, out, ms, limit, pid } = await runLoopUnder([1000, 4000, 16_000, 64_000], (budget) => ({ TIMON_TEST_TIMEOUT_MS: String(budget) }));
  assert.notEqual(code, 0, out);
  assert.match(out, new RegExp(`timed out after ${limit}ms`));
  assert.ok(ms < limit + SOON_MS, `took ${ms} ms`);
  assert.ok(await gone(pid), `test process ${pid} survived the wrapper`);
});

// The limit a test author lives with: it is the file that runs out of it, each
// of these tests staying well under it.
test('the per-test timeout covers the whole file, not each test', async () => {
  const dir = fixture('many.test.mjs', `
    import { test } from 'node:test';
    const wait = () => new Promise((r) => setTimeout(r, 400));
    for (let i = 0; i < 5; i++) test('under the limit ' + i, wait);
  `);
  const { code, out } = await runWrapper(dir, 'many.test.mjs', { TIMON_TEST_TIMEOUT_MS: '1000' });
  assert.notEqual(code, 0, out);
  assert.match(out, /many\.test\.mjs[\s\S]*timed out after 1000ms/);
});

test('the total limit kills a synchronous infinite loop with its whole process tree', async () => {
  const { code, out, ms, limit, pid } = await runLoopUnder([4000, 16_000, 64_000], (budget) => ({
    TIMON_TEST_TOTAL_TIMEOUT_MS: String(budget),
    TIMON_TEST_IDLE_TIMEOUT_MS: '600000',
    TIMON_TEST_TIMEOUT_MS: '600000',
  }));
  assert.equal(code, 124, out);
  assert.match(out, new RegExp(`KILLED: the test run ran for more than ${limit / 1000} s`));
  assert.match(out, /bug to fix/);
  assert.ok(ms < limit + SOON_MS, `took ${ms} ms`);
  assert.ok(await gone(pid), `test process ${pid} survived the wrapper`);
});

/** A test that floods its output, then waits: what a jsdom file printing an
 *  act() warning per render did to the CI of 05/11/2026. */
const FLOOD = `
  import { test } from 'node:test';
  import { writeFileSync } from 'node:fs';
  test('floods, then waits', async () => {
    writeFileSync('PIDFILE', String(process.pid));
    for (let i = 0; i < 5000; i++) console.error('Warning: an update inside a test was not wrapped in act(...) '.repeat(4) + i);
    await new Promise((r) => setTimeout(r, 600_000));
  });
`;

/** Windows makes a Node process's stdout pipe blocking (net.Socket, fd 1 and
 *  2), and `setBlocking(false)` does not undo it: a wrapper whose reader never
 *  reads waits inside a write, and no timer of its own can fire. A reader that
 *  reads slowly, the CI log of 05/11/2026, still lets the limits fire between
 *  two writes; one that never reads is what these cases build. */
const NEVER_READ = process.platform === 'win32'
  && 'Windows blocks a write to an unread stdout pipe, and the wrapper with it';

/** The wrapper with a reader that never reads: its pipes fill up and stay full. */
function runUnread(cwd, file, env, deadlineMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [WRAPPER, file], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 'still running', ms: Date.now() - started });
    }, deadlineMs);
    child.on('exit', (code) => {
      clearTimeout(deadline);
      // Drained now, so the pipes close and this test exits.
      child.stdout.resume();
      child.stderr.resume();
      resolve({ code, ms: Date.now() - started });
    });
  });
}

// CI run of 05/11/2026, cancelled by hand after 68 minutes: the GitHub log read
// slower than a flood of warnings came, the wrapper queued it all, and its
// verdict — the limit had fired — waited at the end of that queue.
test('the total limit ends the run even when nothing reads its output', { skip: NEVER_READ }, async () => {
  for (const limit of [3000, 12_000, 48_000]) {
    const dir = fixture('flood.test.mjs', FLOOD);
    const { code, ms } = await runUnread(dir, 'flood.test.mjs', {
      TIMON_TEST_TOTAL_TIMEOUT_MS: String(limit),
      TIMON_TEST_IDLE_TIMEOUT_MS: '600000',
      TIMON_TEST_TIMEOUT_MS: '600000',
    }, limit + SOON_MS);
    // Killed before the flood began: that run proves nothing about it.
    if (!existsSync(join(dir, 'PIDFILE')) || loopPid(dir) <= 0) continue;
    assert.equal(code, 124, `the wrapper did not end: ${code} after ${ms} ms`);
    assert.ok(ms < limit + SOON_MS, `took ${ms} ms`);
    const pid = loopPid(dir);
    assert.ok(await gone(pid), `test process ${pid} survived the wrapper`);
    return;
  }
  assert.fail('the flooding test never started');
});

test('a reader that stops reading trips the inactivity limit', { skip: NEVER_READ }, async () => {
  const dir = fixture('flood.test.mjs', FLOOD);
  const { code, ms } = await runUnread(dir, 'flood.test.mjs', {
    TIMON_TEST_TOTAL_TIMEOUT_MS: '600000',
    TIMON_TEST_IDLE_TIMEOUT_MS: '3000',
    TIMON_TEST_TIMEOUT_MS: '600000',
  }, SOON_MS);
  assert.equal(code, 124, `the wrapper did not end: ${code} after ${ms} ms`);
});

test('the output reaches a slow reader whole, in order', async () => {
  const dir = fixture('lines.test.mjs', `
    import { test } from 'node:test';
    test('prints', () => { for (let i = 0; i < 20_000; i++) console.log(i + ';'); });
  `);
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER, 'lines.test.mjs'], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    // Read in bursts, with pauses: the wrapper has to wait for the reader.
    const pace = setInterval(() => { child.stdout.resume(); setTimeout(() => child.stdout.pause(), 20); }, 100);
    child.stdout.on('data', (c) => { text += c; });
    child.stderr.on('data', (c) => { text += c; });
    child.on('close', (code) => { clearInterval(pace); resolve({ code, text }); });
  });
  assert.equal(out.code, 0, out.text);
  // node --test turns each chunk it reads from the file into a `# ` line, cut
  // anywhere: glued back, the pieces must give every number once, in order.
  const printed = out.text.split('\n').filter((l) => /^# [\d;]+$/.test(l)).map((l) => l.slice(2)).join('');
  assert.equal(printed, Array.from({ length: 20_000 }, (_, i) => `${i};`).join(''));
});

test('the inactivity limit catches a silent loop long before the total limit', async () => {
  const dir = fixture('silent.test.mjs', `
    import { test } from 'node:test';
    test('spins', () => { for (;;) {} });
  `);
  const { code, out, ms } = await runWrapper(dir, 'silent.test.mjs', {
    TIMON_TEST_TOTAL_TIMEOUT_MS: '600000',
    TIMON_TEST_IDLE_TIMEOUT_MS: '3000',
    TIMON_TEST_TIMEOUT_MS: '600000',
  });
  assert.equal(code, 124, out);
  assert.match(out, /printed nothing for 3 s/);
  assert.ok(ms < SOON_MS, `took ${ms} ms`);
});

test('a memory leak dies on the heap ceiling instead of growing unbounded', async () => {
  const dir = fixture('leak.test.mjs', `
    import { test } from 'node:test';
    test('leaks', () => {
      const hoard = [];
      for (;;) hoard.push(new Array(100_000).fill(Math.random()));
    });
  `);
  const { code, out, ms } = await runWrapper(dir, 'leak.test.mjs', {
    TIMON_TEST_MAX_OLD_SPACE_MB: '64',
    TIMON_TEST_TOTAL_TIMEOUT_MS: '60000',
  });
  assert.notEqual(code, 0, out);
  assert.notEqual(code, 124, 'the heap ceiling, not the clock, must stop a leak');
  assert.match(out, /heap ceiling/);
  assert.ok(ms < SOON_MS, `took ${ms} ms`);
});

// Buffers live outside the V8 heap: the heap ceiling alone let a jsdom test
// reach 12.4 GB of RSS and the mission's cgroup OOM-kill the agent. The loop
// is synchronous, like that runaway, and capped at 3 GB so a broken guard
// fails this test instead of eating the machine. Its pace is bounded (about
// 500 MB/s, the main thread still held): unpaced, a Mac fills 2 GB between
// two readings of the guard, and the bound below would measure the machine.
test('memory outside the heap is stopped by the RSS limit, not the heap ceiling', async () => {
  const dir = fixture('buffers.test.mjs', `
    import { test } from 'node:test';
    import { writeFileSync } from 'node:fs';
    test('hoards buffers', () => {
      writeFileSync('PIDFILE', String(process.pid));
      const hoard = [];
      const pace = new Int32Array(new SharedArrayBuffer(4));
      for (let i = 0; i < 300; i++) {
        hoard.push(Buffer.alloc(10 * 1024 * 1024, 1));
        Atomics.wait(pace, 0, 0, 20);
      }
      for (;;) { /* 3 GB reached: the guard failed, wait for the clock */ }
    });
  `);
  const { code, out, ms } = await runWrapper(dir, 'buffers.test.mjs', {
    TIMON_TEST_MAX_RSS_MB: '400',
    TIMON_TEST_MAX_OLD_SPACE_MB: '4096',
    TIMON_TEST_TIMEOUT_MS: '60000',
    TIMON_TEST_TOTAL_TIMEOUT_MS: '60000',
  });
  assert.equal(code, 137, out);
  assert.match(out, /KILLED: the test processes reached \d+ MB of resident memory, over the 400 MB limit/);
  assert.match(out, /not something to rerun/);
  assert.doesNotMatch(out, /heap ceiling \(TIMON/);
  const reached = Number(/reached (\d+) MB/.exec(out)[1]);
  assert.ok(reached < 1500, `stopped only at ${reached} MB`);
  assert.ok(ms < SOON_MS, `took ${ms} ms`);
  const pid = loopPid(dir);
  assert.ok(await gone(pid), `test process ${pid} survived the wrapper`);
});

// The limit is on the tree: parallel files each under it, together over it.
test('the RSS limit applies to the sum of the parallel test processes', async () => {
  const hoarder = `
    import { test } from 'node:test';
    test('holds 300 MB', async () => {
      const hoard = [];
      for (let i = 0; i < 30; i++) hoard.push(Buffer.alloc(10 * 1024 * 1024, 1));
      await new Promise((r) => setTimeout(r, 50_000));
      hoard.length = 0;
    });
  `;
  const dir = fixture('a.test.mjs', hoarder);
  writeFileSync(join(dir, 'b.test.mjs'), hoarder);
  const { code, out, ms } = await runWrapper(dir, ['--test-concurrency=2', 'a.test.mjs', 'b.test.mjs'], {
    TIMON_TEST_MAX_RSS_MB: '500',
    TIMON_TEST_TIMEOUT_MS: '60000',
    TIMON_TEST_TOTAL_TIMEOUT_MS: '60000',
  });
  assert.equal(code, 137, out);
  assert.doesNotMatch(out, /RSS-LIMIT: test process/, 'no single process was over the limit');
  assert.match(out, /over the 500 MB limit/);
  assert.ok(ms < SOON_MS, `took ${ms} ms`);
});

// The reporter rides NODE_OPTIONS, so a Node process a test spawns is part
// of the tree. Each child stays under the limit and reports nothing on its
// output (stdio ignored): only the wrapper's sum can catch them.
test('the RSS limit counts the Node processes a test spawns', async () => {
  const dir = fixture('spawner.test.mjs', `
    import { test } from 'node:test';
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const HOARD = 'const h = []; for (let i = 0; i < 30; i++) h.push(Buffer.alloc(10 * 1024 * 1024, 1));'
      + ' setTimeout(() => { h.length = 0; }, 50000);';
    test('spawns two hoarders', async () => {
      const pids = [1, 2].map(() => spawn(process.execPath, ['-e', HOARD], { stdio: 'ignore' }).pid);
      writeFileSync('CHILDREN', pids.join(','));
      await new Promise((r) => setTimeout(r, 50_000));
    });
  `);
  const { code, out, ms } = await runWrapper(dir, 'spawner.test.mjs', {
    TIMON_TEST_MAX_RSS_MB: '500',
    TIMON_TEST_TIMEOUT_MS: '60000',
    TIMON_TEST_TOTAL_TIMEOUT_MS: '60000',
  });
  assert.equal(code, 137, out);
  assert.match(out, /over the 500 MB limit/);
  assert.ok(ms < SOON_MS, `took ${ms} ms`);
  const children = readFileSync(join(dir, 'CHILDREN'), 'utf8').split(',').map(Number);
  for (const pid of children) assert.ok(await gone(pid), `spawned process ${pid} survived the wrapper`);
});

// TODO #581: the reporter's worker inherited `--input-type=module`, evaluated
// its CommonJS code as ESM and killed the child whenever it started before
// the child's script ended. The child waits here for its own report, so the
// worker always starts in time to lose; it gives up only past a generous limit,
// a fixed second having lost to a loaded machine (TODO #719).
test('a child spawned with --input-type=module survives the RSS reporter and is still counted', async () => {
  const dir = fixture('esm-child.test.mjs', `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    const CHILD = "import { existsSync } from 'node:fs'; import { join } from 'node:path';"
      + " const report = join(process.env.TIMON_TEST_RSS_DIR, String(process.pid));"
      + " const deadline = Date.now() + 30000;"
      + " while (!existsSync(report) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));"
      + " process.stdout.write(String(existsSync(report)));";
    test('esm child', async () => {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', CHILD]);
      assert.equal(stdout, 'true', 'the child reported its RSS');
    });
  `);
  const { code, out } = await runWrapper(dir, 'esm-child.test.mjs', { TIMON_TEST_TIMEOUT_MS: '60000' });
  assert.equal(code, 0, out);
  assert.match(out, /# pass 1/);
});

test('the RSS preload is set once in NODE_OPTIONS, whatever was there before', () => {
  const href = 'file:///opt/timon/scripts/test-rss-preload.mjs';
  assert.equal(withRssPreload(undefined, href), `--import=${href}`);
  assert.equal(
    withRssPreload(`--enable-source-maps --import ${href} --import=${href} --import=file:///x.mjs`, href),
    `--enable-source-maps --import=file:///x.mjs --import=${href}`,
  );
});

test('the default RSS limit is 8 GB, or half the RAM of a smaller machine', () => {
  const GB = 1024 ** 3;
  assert.equal(defaultRssMb(64 * GB), 8192);
  assert.equal(defaultRssMb(8 * GB), 4096);
});

test('a passing file passes through with exit code 0', async () => {
  const dir = fixture('ok.test.mjs', `
    import { test } from 'node:test';
    test('fine', () => {});
  `);
  const { code, out } = await runWrapper(dir, 'ok.test.mjs', {});
  assert.equal(code, 0, out);
  assert.match(out, /# pass 1/);
});

test('flags go to node --test, the rest are files', () => {
  assert.deepEqual(
    splitArgs(['--', 'src/a.test.ts', '--test-name-pattern=x', 'src/b.test.ts']),
    { flags: ['--test-name-pattern=x'], files: ['src/a.test.ts', 'src/b.test.ts'] },
  );
});

test('our heap ceiling replaces any earlier one and keeps other options', () => {
  assert.equal(
    withHeapCeiling('--enable-source-maps --max-old-space-size=99999', 4096),
    '--enable-source-maps --max-old-space-size=4096',
  );
  assert.equal(withHeapCeiling(undefined, 512), '--max-old-space-size=512');
});

// TODO #404: a shared `<tmp>/tsx-<uid>` of 235,000 entries cost each test
// file 2.5 s of CPU. The run gets a cache of its own; the test's scratch
// stays under the real temp dir, and the cache is gone once the run ends.
test('each run gets its own compile cache, apart from the scratch, removed at the end', async () => {
  const dir = fixture('probe.test.mjs', `
    import { test } from 'node:test';
    import { writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    test('probe', () => {
      writeFileSync('PROBE', JSON.stringify({ cache: globalThis.cacheTmp, scratch: tmpdir() }));
    });
  `);
  // Loaded where tsx would be: before the scratch preload, so it sees the cache.
  writeFileSync(join(dir, 'capture.mjs'), "import { tmpdir } from 'node:os'; globalThis.cacheTmp = tmpdir();");
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    timonTests: { imports: [pathToFileURL(join(dir, 'capture.mjs')).href, pathToFileURL(TMP_PRELOAD).href] },
  }));
  const { code, out } = await runWrapper(dir, 'probe.test.mjs', {});
  assert.equal(code, 0, out);
  const { cache, scratch } = JSON.parse(readFileSync(join(dir, 'PROBE'), 'utf8'));
  // The wrapper inherited this test's temp dir: that is its "real" one.
  const root = join(tmpdir(), 'timon-tests');
  assert.match(relative(root, cache), /^\d+-cache-[^\\/]+$/, cache);
  assert.match(relative(root, scratch), /^\d+-[0-9a-f]{6}$/, scratch);
  assert.ok(!scratch.startsWith(cache + sep), 'the scratch must not nest under the cache');
  assert.ok(!existsSync(cache), `cache ${cache} survived the run`);
});

test('the temp dir override replaces every casing of the three names', () => {
  const env = withTmpDir({ Temp: 'C:\\old', tmp: '/old', TMPDIR: '/old', PATH: '/bin' }, '/run', '/real');
  assert.deepEqual(env, { PATH: '/bin', TMPDIR: '/run', TMP: '/run', TEMP: '/run', TIMON_TEST_REAL_TMPDIR: '/real' });
});

// TODO #606: a suite run from a mission's shell inherited the address, token
// and identity of the live daemon. The fake daemon below stands for it: a
// test that follows TIMON_API (or a Node child it spawns, which inherits the
// test's env) would knock on it with the mission's token. It must hear nothing.
test('a test never inherits the live daemon address, token or mission identity', async () => {
  const hits = [];
  const daemon = createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization ?? null });
    res.end('{}');
  });
  await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${daemon.address().port}`;
  try {
    const dir = fixture('probe.test.mjs', `
      import { test } from 'node:test';
      import { spawnSync } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const leaked = (env) => Object.keys(env).filter((k) => /^timon_/i.test(k)).sort();
      test('probe', async () => {
        const call = async (env) => {
          const url = env.TIMON_API ?? env.TIMON_ORCH_URL;
          if (url) await fetch(url + '/api/tasks', { headers: { authorization: 'Bearer ' + env.TIMON_API_TOKEN } });
        };
        await call(process.env);
        const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { encoding: 'utf8' });
        const childEnv = JSON.parse(child.stdout);
        await call(childEnv);
        writeFileSync('ENV', JSON.stringify({ test: leaked(process.env), child: leaked(childEnv) }));
      });
    `);
    const mission = {
      TIMON_API: api,
      TIMON_ORCH_URL: api,
      TIMON_API_TOKEN: 'mission-token',
      TIMON_DAEMON_TOKEN: 'daemon-token',
      TIMON_MISSION_ID: 'm-1',
      TIMON_TRACE_ID: 't-1',
      TIMON_WORKFLOW_RUN_ID: 'w-1',
      TIMON_WORKFLOW_NODE_ID: 'n-1',
      TIMON_AGENT: 'timon.coder',
      TIMON_PROJECT: 'timon',
    };
    const { code, out } = await runWrapper(dir, 'probe.test.mjs', { ...mission, TIMON_TEST_KEEP_ME: '1' });
    assert.equal(code, 0, out);
    const seen = JSON.parse(readFileSync(join(dir, 'ENV'), 'utf8'));
    for (const where of ['test', 'child']) {
      for (const key of Object.keys(mission)) assert.ok(!seen[where].includes(key), `${key} reached the ${where}`);
      // Only the daemon's keys go: the knobs of the run itself stay.
      assert.ok(seen[where].includes('TIMON_TEST_KEEP_ME'), `the ${where} lost an unrelated TIMON_* variable`);
    }
    assert.deepEqual(hits, [], 'the fake daemon was called by the test run');
    // The fake daemon does answer: an empty `hits` is not a dead listener.
    await fetch(api);
    assert.equal(hits.length, 1);
  } finally {
    await new Promise((r) => daemon.close(r));
  }
});

test('the daemon variables go whatever their casing, the rest stays', () => {
  const env = withoutDaemonEnv({
    TIMON_API: 'x', timon_api_token: 'x', Timon_Mission_Id: 'x', TIMON_HOME: '/h', TIMON_TEST_TIMEOUT_MS: '1', PATH: '/bin',
  });
  assert.deepEqual(env, { TIMON_HOME: '/h', TIMON_TEST_TIMEOUT_MS: '1', PATH: '/bin' });
});

// A variable added to a mission's identity must be added to the list too,
// or the next suite run from a mission hands it to the tests again.
test('every variable of a mission identity is on the list', () => {
  const src = readFileSync(join(dirname(WRAPPER), '..', 'orchestrator', 'src', 'agent.ts'), 'utf8');
  const body = /export function missionIdentityEnv\([\s\S]*?\n\}\n/.exec(src);
  assert.ok(body, 'missionIdentityEnv not found in orchestrator/src/agent.ts');
  const keys = new Set([...body[0].matchAll(/\bTIMON_[A-Z_]+\b/g)].map((m) => m[0]));
  keys.add('TIMON_API_TOKEN');
  assert.ok(keys.has('TIMON_MISSION_ID') && keys.has('TIMON_API'), [...keys].join(','));
  for (const key of keys) assert.ok(DAEMON_ENV_KEYS.includes(key), `${key} is missing from DAEMON_ENV_KEYS`);
});

const ROOT = join(dirname(WRAPPER), '..');

/** A package script that starts a test run on its own: no memory ceiling, no
 *  time limit, and the daemon's address and credential handed to the tests. */
function bypassesWrapper(script) {
  return script.split(/&&|\|\||;/).some((command) => {
    if (/run-tests\.mjs|\bnpm (run )?test\b/.test(command)) return false;
    return /\s--test(\s|=|$)/.test(command)
      || /\.test\.[cm]?[jt]sx?\b/.test(command)
      || /\b(vitest|jest|mocha)\b/.test(command);
  });
}

test('the guard tells a bare test run from the wrapper', () => {
  for (const bare of [
    'node --test test/*.test.mjs',
    'node --import tsx --test src/a.ts',
    'npx tsx --test src/a.ts',
    'tsx tests/a.test.ts',
    'npm run build && node --test',
    'vitest run',
  ]) assert.ok(bypassesWrapper(bare), bare);
  for (const guarded of [
    'node ../scripts/run-tests.mjs',
    'node ../../scripts/run-tests.mjs test/a.test.mjs',
    'node ../scripts/run-tests.mjs --test-name-pattern=a',
    'cd ../../orchestrator && npm test -- src/plugins/a*.test.ts',
    'node scripts/runtime-node-smoke.mjs',
    'tsc --noEmit',
  ]) assert.ok(!bypassesWrapper(guarded), guarded);
});

test('every test script of every package goes through the wrapper', () => {
  const manifests = execFileSync('git', ['ls-files', '-z', '--', 'package.json', '**/package.json'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  assert.ok(manifests.includes('plugins/theme-timon/package.json'), `the listing is broken: ${manifests.length} manifests`);
  const offenders = [];
  for (const manifest of manifests) {
    const { scripts = {} } = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8'));
    for (const [name, script] of Object.entries(scripts)) {
      const unguardedTest = name === 'test' && !/run-tests\.mjs|\bnpm test\b/.test(script);
      if (bypassesWrapper(script) || unguardedTest) offenders.push(`${manifest}: ${name}: ${script}`);
    }
  }
  assert.deepEqual(offenders, [], 'route these through scripts/run-tests.mjs (TODO #615)');
});

// The guard above reads the scripts; these run them, through a shell as npm does:
// every plugin of this checkout whose test script calls the wrapper directly,
// the maintainers' private ones included (docs/internal/plugins/, when present).
const WRAPPED_PLUGINS = execFileSync('git', ['ls-files', '-z', '--', 'plugins/*/package.json', 'docs/internal/plugins/*/package.json'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean)
  .filter((manifest) => /^node (\.\.\/)+scripts\/run-tests\.mjs\b/.test(JSON.parse(readFileSync(join(ROOT, manifest), 'utf8')).scripts?.test ?? ''))
  .map((manifest) => manifest.slice(0, -'/package.json'.length));
for (const plugin of WRAPPED_PLUGINS) {
  test(`${plugin}: its test script arms the limits and drops the daemon's env`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'timon-run-tests-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const report = join(dir, 'report.json');
    const probe = join(dir, 'probe.test.mjs');
    writeFileSync(probe, `
      import { test } from 'node:test';
      import { writeFileSync } from 'node:fs';
      test('probe', () => {
        writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.env));
      });
    `);
    const cwd = join(ROOT, ...plugin.split('/'));
    const { scripts } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const env = {
      ...process.env,
      ...Object.fromEntries(DAEMON_ENV_KEYS.map((key) => [key, 'http://127.0.0.1:9'])),
    };
    // This file runs under the wrapper itself: what it hands down would pass
    // for limits the plugin's script never armed.
    for (const key of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'TIMON_TEST_RSS_DIR', 'TIMON_TEST_MAX_RSS_MB', 'TIMON_TEST_REAL_TMPDIR']) {
      delete env[key];
    }
    const { code, out } = await new Promise((resolve) => {
      const child = spawn(`${scripts.test} "${probe}"`, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      child.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(code, 0, out);
    const seen = JSON.parse(readFileSync(report, 'utf8'));
    for (const key of DAEMON_ENV_KEYS) assert.ok(!(key in seen), `${key} reached the test`);
    assert.match(seen.NODE_OPTIONS ?? '', /--max-old-space-size=\d+/, 'no heap ceiling');
    assert.match(seen.NODE_OPTIONS ?? '', /test-rss-preload\.mjs/, 'no RSS reporter');
    assert.ok(seen.TIMON_TEST_RSS_DIR, 'no RSS limit');
    assert.ok(seen.TIMON_TEST_REAL_TMPDIR, 'no scratch under the run');
  });
}
