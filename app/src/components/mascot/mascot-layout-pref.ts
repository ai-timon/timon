/**
 * One display preference of the mascots, stored per account in a layout
 * scope of the daemon (`/api/ui/layout?scope=<scope>`) and read once per
 * page. "Animate mascots" and "Mascot style" are two of them.
 *
 * A preference the first-run screens offer before any account exists (the
 * welcome screen's 3D / 2D switch) names a `localKey`: until the daemon takes
 * a read or a write, the choice is kept in this browser and read back as the
 * starting value. The first read that succeeds hands it to the account when
 * the account holds nothing yet; from then on the account's value wins and
 * the browser copy is dropped.
 */
import { machineLocalStorage } from '@/lib/machines/machine-storage';
import { loadLayout, saveLayout, type LayoutIo } from '@/lib/ui-layout-store';

export type MascotLayoutPref<T> = {
  subscribe(fn: () => void): () => void;
  get(): T;
  /** `false` when the daemon did not take it; the page keeps the choice anyway. */
  set(value: T): Promise<boolean>;
};

export type MascotLayoutPrefSpec<T> = {
  scope: string;
  /** What the page shows before the daemon answers, and when nothing is stored. */
  initial: T;
  /** The stored row to a value; anything unexpected reads as `initial`. */
  read(raw: unknown): T;
  /** The value to the row written. */
  write(value: T): unknown;
  /** Browser key holding a choice the daemon could not take yet (no session). */
  localKey?: string;
};

type LocalStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type MascotLayoutPrefIo = Pick<LayoutIo, 'fetchImpl'> & {
  /** `null`: no browser copy. Defaults to this machine's `localStorage`. */
  storage?: LocalStorageLike | null;
};

function defaultStorage(): LocalStorageLike | null {
  try {
    // The account lives on one daemon: its pending choice belongs to that machine.
    return machineLocalStorage();
  } catch {
    return null;
  }
}

export function createMascotLayoutPref<T>(spec: MascotLayoutPrefSpec<T>, io: MascotLayoutPrefIo = {}): MascotLayoutPref<T> {
  const listeners = new Set<() => void>();
  const localKey = spec.localKey ?? '';
  const store = (): LocalStorageLike | null => (localKey ? (io.storage === undefined ? defaultStorage() : io.storage) : null);
  /** The row kept in this browser, or `undefined` when there is none. */
  const readLocal = (): unknown => {
    const storage = store();
    if (!storage) return undefined;
    try {
      const raw = storage.getItem(localKey);
      return raw === null ? undefined : (JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  };
  const writeLocal = (row: unknown): void => {
    try { store()?.setItem(localKey, JSON.stringify(row)); } catch { /* storage refused: the page still holds it */ }
  };
  const dropLocal = (): void => {
    try { store()?.removeItem(localKey); } catch { /* nothing to hand over next time anyway */ }
  };
  const kept = readLocal();
  let value = kept === undefined ? spec.initial : spec.read(kept);
  /** The account has been read: no further read is needed this page. */
  let loaded = false;
  let inFlight = false;
  /** A read was refused; asked again only while a browser choice waits to be handed over. */
  let refused = false;
  /** Bumped by each choice: a read that started before it never undoes it. */
  let choices = 0;
  const layoutIo: LayoutIo = { fetchImpl: io.fetchImpl, scope: spec.scope, storage: null };
  const emit = () => { for (const fn of listeners) fn(); };
  const load = () => {
    if (loaded || inFlight || (refused && readLocal() === undefined)) return;
    inFlight = true;
    const seen = choices;
    void loadLayout(layoutIo).then(async (r) => {
      inFlight = false;
      // No session yet (the welcome screen) or no daemon: a later subscriber asks again if a choice waits.
      if (!r.ok) { refused = true; return; }
      loaded = true;
      const local = readLocal();
      if (r.raw === null && local !== undefined) {
        // The account holds nothing yet: the choice made before it existed becomes its own.
        if (await saveLayout(local, layoutIo)) dropLocal();
        return;
      }
      if (local !== undefined) dropLocal();
      if (choices !== seen) return;
      const next = spec.read(r.raw);
      if (next === value) return;
      value = next;
      emit();
    });
  };
  return {
    subscribe(fn) {
      listeners.add(fn);
      load();
      return () => { listeners.delete(fn); };
    },
    get: () => value,
    async set(next) {
      choices += 1;
      if (next !== value) { value = next; emit(); }
      const row = spec.write(next);
      writeLocal(row);
      const ok = await saveLayout(row, layoutIo);
      if (ok) {
        // The account holds it now, and wins over any browser copy.
        loaded = true;
        dropLocal();
      }
      return ok;
    },
  };
}
