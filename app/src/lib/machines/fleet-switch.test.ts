import assert from 'node:assert/strict';
import test from 'node:test';
import { switchToMachine } from './fleet';
import { MACHINE_ATTRIBUTE } from './machine-storage';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

type Globals = { document?: unknown; window?: unknown; fetch: typeof fetch };
const g = globalThis as unknown as Globals;
const realFetch = g.fetch;

/** A page of `machine` showing `path`, a fleet that answers `switchStatus`
 *  and a machine where the paths of `gone` answer 404. */
function scene(machine: string | undefined, path: string, local: MemoryStorage, switchStatus = 200, gone: string[] = [],
  desktop?: { set: (id: string, request?: { route?: string }) => Promise<unknown> }) {
  const url = new URL(path, 'http://app.test');
  const assigned: string[] = [];
  const calls: string[] = [];
  const reloads: number[] = [];
  const listeners = new Map<string, Array<(event: { persisted: boolean }) => void>>();
  /** The browser shows this page again: from the back/forward cache when `persisted`. */
  const pageshow = (persisted: boolean) => {
    const waiting = listeners.get('pageshow') ?? [];
    listeners.delete('pageshow');
    for (const listener of waiting) listener({ persisted });
  };
  g.document = { documentElement: { getAttribute: (name: string) => (name === MACHINE_ATTRIBUTE ? machine ?? null : null) } };
  g.window = {
    localStorage: local,
    sessionStorage: new MemoryStorage(),
    location: {
      pathname: url.pathname, search: url.search,
      assign: (to: string) => { assigned.push(to); },
      reload: () => { reloads.push(1); },
    },
    // Every listener of these tests is registered `once`: `pageshow` drops it.
    addEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    ...(desktop ? { timonDesktop: { windowMachine: desktop } } : {}),
  };
  g.fetch = (async (input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${input}${typeof init?.body === 'string' ? ` ${init.body}` : ''}`);
    if (input === '/api/ui/machines/active') {
      const body = switchStatus === 200 ? { id: 'x', warning: null } : { error: 'machine_unreachable', status: 'unreachable' };
      return new Response(JSON.stringify(body), { status: switchStatus });
    }
    return new Response('{}', { status: gone.includes(input) ? 404 : 200 });
  }) as typeof fetch;
  return { assigned, calls, reloads, pageshow, listening: () => listeners.get('pageshow')?.length ?? 0 };
}

test.afterEach(() => {
  delete g.document;
  delete g.window;
  g.fetch = realFetch;
});

test('a switch remembers the page left and lands on the last page of the machine entered', async () => {
  const local = new MemoryStorage();
  // On the VPS, reading a mission.
  scene('vps', '/chat?agent=a&mission=m1', local);
  // Back home: the VPS page is remembered, local was never seen.
  const home = scene('vps', '/chat?agent=a&mission=m1', local);
  assert.deepEqual(await switchToMachine('local'), { ok: true, kept: false });
  assert.deepEqual(home.assigned, ['/']);
  // On local, the Kanban; then to the VPS again.
  const back = scene(undefined, '/kanban?settings=machines', local);
  assert.deepEqual(await switchToMachine('vps'), { ok: true, kept: false });
  assert.deepEqual(back.assigned, ['/chat?agent=a&mission=m1']);
  // And local kept its Kanban, without the Settings dialog it was switched from.
  const again = scene('vps', '/missions', local);
  assert.deepEqual(await switchToMachine('local'), { ok: true, kept: false });
  assert.deepEqual(again.assigned, ['/kanban']);
});

test('a page naming an object gone on the machine entered lands on its section root', async () => {
  const local = new MemoryStorage();
  local.setItem('m:vps:timon:last-route', '/chat?agent=a&mission=gone');
  const { assigned, calls } = scene(undefined, '/', local, 200, ['/api/ui/missions/gone?view=status']);
  assert.deepEqual(await switchToMachine('vps'), { ok: true, kept: false });
  assert.deepEqual(assigned, ['/chat']);
  // The probe follows the switch: it is asked of the machine entered.
  assert.equal(calls[0], 'POST /api/ui/machines/active {"id":"vps"}');
});

test('a refused switch stays on the page', async () => {
  const local = new MemoryStorage();
  local.setItem('m:vps:timon:last-route', '/kanban');
  const { assigned } = scene(undefined, '/missions', local, 502);
  const failure = await switchToMachine('vps');
  assert.equal(failure.ok, false);
  assert.equal(failure.ok ? null : failure.error, 'machine_unreachable');
  assert.deepEqual(assigned, []);
});

test('multi-window V3: in a desktop window the switch pins that window, without the cookie, before the probes', async () => {
  const local = new MemoryStorage();
  local.setItem('m:vps:timon:last-route', '/kanban');
  const pinned: string[] = [];
  let calls: string[] = [];
  const desktop = { set: async (id: string) => { pinned.push(id); calls.push(`pin ${id}`); return { id }; } };
  const run = scene(undefined, '/missions', local, 200, [], desktop);
  calls = run.calls;
  assert.deepEqual(await switchToMachine('vps'), { ok: true, kept: false });
  assert.deepEqual(pinned, ['vps']);
  assert.equal(calls[0], 'POST /api/ui/machines/active {"id":"vps","scope":"window"}');
  assert.equal(calls[1], 'pin vps', 'the window is pinned before anything is asked of the machine entered');
  assert.deepEqual(run.assigned, ['/kanban']);
});

test('multi-window V3: a refused switch, or a shell that cannot pin, leaves the window where it is', async () => {
  const local = new MemoryStorage();
  const pinned: string[] = [];
  const refused = scene(undefined, '/missions', local, 502, [], { set: async (id) => { pinned.push(id); } });
  const refusal = await switchToMachine('vps');
  assert.equal(refusal.ok ? null : refusal.error, 'machine_unreachable');
  assert.deepEqual(pinned, []);
  assert.deepEqual(refused.assigned, []);
  const broken = scene(undefined, '/missions', local, 200, [], { set: async () => { throw new Error('closed'); } });
  assert.equal((await switchToMachine('vps')).ok, false);
  assert.deepEqual(broken.assigned, []);
});

test('multi-window V4: a desktop window that keeps pages switches without reloading, and names the page a new view opens on', async () => {
  const local = new MemoryStorage();
  local.setItem('m:vps:timon:last-route', '/chat?agent=a&mission=m1');
  const asked: { id: string; route?: string }[] = [];
  const desktop = { set: async (id: string, request?: { route?: string }) => { asked.push({ id, route: request?.route }); return { id, shown: true }; } };
  const run = scene(undefined, '/kanban?settings=machines', local, 200, ['/api/ui/missions/m1?view=status'], desktop);
  assert.deepEqual(await switchToMachine('vps'), { ok: true, kept: true }, 'the caller learns its page stays alive (TIM-0139)');
  assert.deepEqual(asked, [{ id: 'vps', route: '/chat?agent=a&mission=m1' }]);
  assert.deepEqual(run.assigned, [], 'the page is hidden alive, it does not load itself again');
  assert.deepEqual(run.calls, ['POST /api/ui/machines/active {"id":"vps","scope":"window"}'], 'no probe leaves a page pinned to the machine it leaves');
  assert.equal(local.getItem('timon:last-route'), '/kanban', 'the page left is remembered for its own machine');
});

test('TODO #788: the page a switch left, restored by Back from the back/forward cache, loads itself again', async () => {
  const local = new MemoryStorage();
  const run = scene(undefined, '/missions', local);
  assert.deepEqual(await switchToMachine('vps'), { ok: true, kept: false });
  assert.deepEqual(run.reloads, [], 'nothing reloads before the page comes back');
  run.pageshow(true);
  assert.deepEqual(run.reloads, [1], 'not left on "Switching to…", rendered for the machine it left');
  run.pageshow(true);
  assert.deepEqual(run.reloads, [1], 'once: the document loaded again has no such listener');
});

test('TODO #788: a page shown again without the back/forward cache is left alone', async () => {
  const run = scene(undefined, '/missions', new MemoryStorage());
  assert.deepEqual(await switchToMachine('vps'), { ok: true, kept: false });
  run.pageshow(false);
  assert.deepEqual(run.reloads, []);
});

test('TODO #788: a refused switch, or a page the desktop keeps alive, waits for no restore', async () => {
  const refused = scene(undefined, '/missions', new MemoryStorage(), 502);
  assert.equal((await switchToMachine('vps')).ok, false);
  assert.equal(refused.listening(), 0);
  const desktop = { set: async (id: string) => ({ id, shown: true }) };
  const kept = scene(undefined, '/missions', new MemoryStorage(), 200, [], desktop);
  assert.deepEqual(await switchToMachine('vps'), { ok: true, kept: true });
  assert.equal(kept.listening(), 0, 'shown again by the shell as it was left (TIM-0139)');
});
