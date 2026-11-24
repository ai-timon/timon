import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGACY_LAYOUT_KEY, loadLayout, saveLayout, storeLayout, type LayoutVersion } from './ui-layout-store';

type Call = { url: string; init?: RequestInit };

/** A daemon in memory: holds one layout, records every call. */
function fakeDaemon(opts: { layout?: unknown; putOk?: boolean } = {}) {
  const calls: Call[] = [];
  let stored: unknown = opts.layout ?? null;
  const putOk = opts.putOk ?? true;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ scope: 'cockpit', layout: stored, updatedAt: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!putOk) return new Response('nope', { status: 500 });
    stored = JSON.parse(String(init?.body)).layout;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { calls, fetchImpl, puts: () => calls.filter((c) => c.init?.method === 'PUT'), read: () => stored };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => { map.delete(k); },
  };
}

test('empty daemon and empty browser: null layout, no write', async () => {
  const daemon = fakeDaemon();
  const out = await loadLayout({ fetchImpl: daemon.fetchImpl, storage: fakeStorage() });
  assert.deepEqual(out, { raw: null, ok: true, migrated: false, updatedAt: null });
  assert.equal(daemon.puts().length, 0);
});

test('daemon filled in: its value is returned as is', async () => {
  const layout = [{ id: 'agenda', rail: 'droite' }];
  const daemon = fakeDaemon({ layout });
  const out = await loadLayout({ fetchImpl: daemon.fetchImpl, storage: fakeStorage() });
  assert.deepEqual(out.raw, layout);
  assert.equal(out.ok, true);
});

test('migration: the browser layout is pushed, then the key goes away', async () => {
  const legacy = [{ id: 'agenda', rail: 'gauche', rang: 0, hauteur: 200 }];
  const daemon = fakeDaemon();
  const storage = fakeStorage({ [LEGACY_LAYOUT_KEY]: JSON.stringify(legacy) });

  const first = await loadLayout({ fetchImpl: daemon.fetchImpl, storage });
  assert.equal(first.migrated, true);
  assert.deepEqual(first.raw, legacy);
  assert.deepEqual(daemon.read(), legacy);
  assert.equal(storage.getItem(LEGACY_LAYOUT_KEY), null, 'the consumed source must go away');

  // Second load: the daemon already answers, nothing left to migrate.
  const before = daemon.puts().length;
  const second = await loadLayout({ fetchImpl: daemon.fetchImpl, storage });
  assert.equal(second.migrated, false);
  assert.equal(daemon.puts().length, before, 'the migration must run only once');
});

test('migration: a daemon that refuses the PUT does not lose the key', async () => {
  const legacy = [{ id: 'agenda' }];
  const daemon = fakeDaemon({ putOk: false });
  const storage = fakeStorage({ [LEGACY_LAYOUT_KEY]: JSON.stringify(legacy) });

  const out = await loadLayout({ fetchImpl: daemon.fetchImpl, storage });
  assert.equal(out.migrated, false);
  assert.deepEqual(out.raw, legacy, 'la session en cours garde son placement');
  assert.equal(storage.getItem(LEGACY_LAYOUT_KEY), JSON.stringify(legacy));
});

test('daemon filled in: the browser layout does not overwrite it', async () => {
  const server = [{ id: 'serveur' }];
  const daemon = fakeDaemon({ layout: server });
  const storage = fakeStorage({ [LEGACY_LAYOUT_KEY]: JSON.stringify([{ id: 'navigateur' }]) });

  const out = await loadLayout({ fetchImpl: daemon.fetchImpl, storage });
  assert.deepEqual(out.raw, server);
  assert.equal(daemon.puts().length, 0);
  assert.equal(storage.getItem(LEGACY_LAYOUT_KEY), JSON.stringify([{ id: 'navigateur' }]));
});

test('daemon unreachable: ok=false, so that the caller refrains from writing', async () => {
  const out = await loadLayout({
    fetchImpl: async () => { throw new Error('offline'); },
    storage: fakeStorage(),
  });
  assert.deepEqual(out, { raw: null, ok: false, migrated: false });
});

test('saveLayout sends a PUT and reports the failure without throwing', async () => {
  const ok = fakeDaemon();
  assert.equal(await saveLayout([{ id: 'a' }], { fetchImpl: ok.fetchImpl }), true);
  assert.deepEqual(ok.read(), [{ id: 'a' }]);

  const ko = fakeDaemon({ putOk: false });
  assert.equal(await saveLayout([{ id: 'a' }], { fetchImpl: ko.fetchImpl }), false);
});

/** A daemon whose responses are held open, so a test decides in which order the
 *  in-flight requests come back. */
function slowDaemon() {
  const bodies: unknown[] = [];
  const pending: Array<() => void> = [];
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)).layout);
    await new Promise<void>((resolve) => { pending.push(resolve); });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return {
    bodies,
    fetchImpl,
    inFlight: () => pending.length,
    /** Releases the n-th request still open (0 = the oldest). */
    answer: (n = 0) => {
      const release = pending.splice(n, 1)[0];
      assert.ok(release, 'no open request at this rank');
      release();
    },
  };
}

/** Lets the pending microtasks run before the assertion resumes. */
const tick = () => new Promise<void>((r) => { setTimeout(r, 0); });

test('two saves do not overtake each other: one request at a time', async () => {
  const daemon = slowDaemon();
  const io = { scope: 'serie', fetchImpl: daemon.fetchImpl };

  const first = saveLayout([{ id: 'a' }], io);
  const second = saveLayout([{ id: 'b' }], io);
  await tick();

  assert.equal(daemon.inFlight(), 1, 'the second waits its turn, it does not start in parallel');
  assert.deepEqual(daemon.bodies, [[{ id: 'a' }]]);

  daemon.answer();
  await tick();
  assert.deepEqual(daemon.bodies, [[{ id: 'a' }], [{ id: 'b' }]], 'le second layout part ensuite');

  daemon.answer();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('answers in reverse order: the last layout asked for stays the last written', async () => {
  // The daemon answers the first request AFTER the second. Without serialisation
  // both PUTs would start together, "a" would arrive last, and that stale
  // placement is what the next reload would show.
  const received: unknown[] = [];
  const delays = [30, 0];
  let index = 0;
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const delay = delays[index++] ?? 0;
    await new Promise<void>((r) => { setTimeout(r, delay); });
    received.push(JSON.parse(String(init?.body)).layout);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const first = saveLayout([{ id: 'a' }], { scope: 'inverse', fetchImpl });
  const second = saveLayout([{ id: 'b' }], { scope: 'inverse', fetchImpl });
  await Promise.all([first, second]);

  assert.deepEqual(received, [[{ id: 'a' }], [{ id: 'b' }]]);
  assert.deepEqual(received.at(-1), [{ id: 'b' }], 'the last written is the last asked for');
});

test('a failed PUT does not block the next saves', async () => {
  // The "in flight" flag is released on error too: otherwise a passing network
  // outage would freeze the persistence of the placement for good.
  const received: unknown[] = [];
  let firstCall = true;
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    if (firstCall) {
      firstCall = false;
      throw new Error('offline');
    }
    received.push(JSON.parse(String(init?.body)).layout);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  assert.equal(await saveLayout([{ id: 'a' }], { scope: 'panne', fetchImpl }), false);
  assert.equal(await saveLayout([{ id: 'b' }], { scope: 'panne', fetchImpl }), true);
  assert.deepEqual(received, [[{ id: 'b' }]]);
});

test('the pending saves are merged: only the most recent one leaves', async () => {
  const daemon = slowDaemon();
  const io = { scope: 'fusion', fetchImpl: daemon.fetchImpl };

  const expected = [saveLayout([{ id: 'a' }], io)];
  for (const id of ['b', 'c', 'd']) expected.push(saveLayout([{ id }], io));
  await tick();

  daemon.answer();
  await tick();
  daemon.answer();
  assert.deepEqual(await Promise.all(expected), [true, true, true, true]);

  assert.deepEqual(
    daemon.bodies,
    [[{ id: 'a' }], [{ id: 'd' }]],
    'the intermediate placements never reach the network',
  );
});

test('saves serialised by scope: two scopes do not wait for each other', async () => {
  const daemon = slowDaemon();
  const a = saveLayout([{ id: 'a' }], { scope: 'gauche', fetchImpl: daemon.fetchImpl });
  const b = saveLayout([{ id: 'b' }], { scope: 'droite', fetchImpl: daemon.fetchImpl });
  await tick();

  assert.equal(daemon.inFlight(), 2, 'each scope has its own queue');
  daemon.answer();
  daemon.answer();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
});

test('return to a view waits for its pending save before reading', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let stored: unknown = null;
  const methods: string[] = [];
  const io = { scope: 'return-to-view', storage: null, fetchImpl: async (_url: string, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    if (init?.method === 'PUT') { await gate; stored = JSON.parse(String(init.body)).layout; return new Response('{}'); }
    return new Response(JSON.stringify({ layout: stored }));
  } };
  const save = saveLayout({ open: true }, io);
  const read = loadLayout(io);
  await Promise.resolve();
  assert.deepEqual(methods, ['PUT']);
  release();
  await save;
  assert.deepEqual((await read).raw, { open: true });
  assert.deepEqual(methods, ['PUT', 'GET']);
});

/** A daemon that versions its row and refuses a write made on an old read, as `/api/layout?expected=` does. */
function versionedDaemon(initial: unknown) {
  let stored = initial;
  let version = 10;
  const sent: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const expected = new URL(url, 'http://localhost').searchParams.get('expected');
    const method = init?.method ?? 'GET';
    if (method === 'GET') return Response.json({ layout: stored, updatedAt: version });
    sent.push(`${method} expected=${expected}`);
    if (expected !== null && Number(expected) !== version) return Response.json({ error: 'conflict' }, { status: 409 });
    stored = method === 'DELETE' ? null : JSON.parse(String(init?.body)).layout;
    version += 1;
    return Response.json({ ok: true, updatedAt: version });
  };
  return { fetchImpl, sent, read: () => stored, elsewhere(layout: unknown) { stored = layout; version += 1; } };
}

test('a guarded write carries the version read, and chains on the version it produced', async () => {
  const daemon = versionedDaemon(['a']);
  const read = await loadLayout({ scope: 'guarded.chain', fetchImpl: daemon.fetchImpl, storage: null });
  assert.equal(read.updatedAt, 10);
  const version: LayoutVersion = { value: read.updatedAt };
  const io = { scope: 'guarded.chain', fetchImpl: daemon.fetchImpl, version };
  // Three drops of one drag: the second is coalesced behind the first, and
  // must leave with the version the first produced, not the one it was queued with.
  const results = await Promise.all([storeLayout(['b'], io), storeLayout(['c'], io), storeLayout(['d'], io)]);
  assert.deepEqual(results, ['ok', 'ok', 'ok']);
  assert.deepEqual(daemon.sent, ['PUT expected=10', 'PUT expected=11']);
  assert.equal(version.value, 12);
  assert.deepEqual(daemon.read(), ['d']);
});

test('a guarded write made on a copy another window rewrote is refused, not applied', async () => {
  const daemon = versionedDaemon(['chat']);
  const read = await loadLayout({ scope: 'guarded.stale', fetchImpl: daemon.fetchImpl, storage: null });
  daemon.elsewhere(['chat', 'files']);
  const version: LayoutVersion = { value: read.updatedAt };
  const io = { scope: 'guarded.stale', fetchImpl: daemon.fetchImpl, version };
  assert.equal(await storeLayout(['chat', 'moved'], io), 'conflict');
  assert.equal(await storeLayout(null, io), 'conflict', 'an erasure is guarded too');
  assert.deepEqual(daemon.read(), ['chat', 'files']);
  // `saveLayout` keeps its boolean, unguarded contract.
  assert.equal(await saveLayout(['forced'], { scope: 'guarded.stale', fetchImpl: daemon.fetchImpl }), true);
  assert.deepEqual(daemon.sent.at(-1), 'PUT expected=null');
});

test('nothing stored is guarded as none', async () => {
  const daemon = versionedDaemon(null);
  const calls: string[] = [];
  const spy = async (url: string, init?: RequestInit) => { calls.push(url); return daemon.fetchImpl(url, init); };
  await storeLayout({ x: 1 }, { scope: 'guarded.none', fetchImpl: spy, version: { value: null } });
  assert.match(calls[0] ?? "", /expected=none/);
});

test('two writers guarding different reads are never merged into one request', async () => {
  const daemon = versionedDaemon(['start']);
  const desktop: LayoutVersion = { value: 10 };
  const stale: LayoutVersion = { value: 9 };
  const first = storeLayout(['desktop-1'], { scope: 'guarded.mix', fetchImpl: daemon.fetchImpl, version: desktop });
  const second = storeLayout(['stale'], { scope: 'guarded.mix', fetchImpl: daemon.fetchImpl, version: stale });
  const third = storeLayout(['desktop-2'], { scope: 'guarded.mix', fetchImpl: daemon.fetchImpl, version: desktop });
  assert.deepEqual(await Promise.all([first, second, third]), ['ok', 'conflict', 'ok']);
  assert.deepEqual(daemon.read(), ['desktop-2']);
});

test('a daemon that does not report versions turns the guard off instead of refusing', async () => {
  const daemon = fakeDaemon({ layout: ['old'] });
  const version: LayoutVersion = { value: 3 };
  assert.equal(await storeLayout(['new'], { scope: 'cockpit', fetchImpl: daemon.fetchImpl, version }), 'ok');
  assert.equal(version.value, undefined);
});
