/**
 * The vault entries of the backends a user adds with "Add a provider"
 * (`custom-routes.ts`): their name, the mark that says who created them, and
 * their reservation to that backend (TODO #531, decision 5-B).
 *
 * Such a key used to be stored with a `global` grant, so it entered the vault
 * slice of every trusted mission, whatever backend it ran on. It is now stored
 * with `backend:<id>` alone: it enters that backend's process and nothing else
 * (`secrets/resolve.ts`). Keys stored before are moved over at boot, but only
 * when the backend's ownership is certain; anything else is left as it is and
 * the operator is asked.
 */
import { daemonMessage } from '../../daemon-message.js';
import { dbApi, type SecretWithGrants } from '../../db.js';
import { vaultEnabled } from '../../secrets/availability.js';
import type { SecretGrant } from '../../secrets/resolve.js';
import { formatSecretScope, updateSecret } from '../../secrets/store.js';
import { listLocalBackends, secretNamesOf, type LocalBackend } from '../../backends/local-profiles.js';

/**
 * The vault name — hence the variable the profile sets — derived from the id.
 * Runs of dashes are collapsed and the edges stripped: an id may carry them
 * (`acme--eu`, and `slugify` can leave one behind when it cuts at 40), while a
 * variable a profile sets is read by the `codex` provider block, where a
 * doubled underscore is just noise. The file door and the form door write the
 * same name for the same id.
 */
export function secretNameFor(id: string): string {
  const stem = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `BACKEND_${stem}_API_KEY`;
}

/** Marks the vault entries this surface created, so removing a backend takes
 *  its key along and never one the user filed under the same name. */
export function ownerNote(id: string): string {
  return `backend:${id}`;
}

/** The reservation a key of backend `id` carries — its only grant when created. */
export function backendKeyGrant(id: string): SecretGrant {
  return { scope_kind: 'backend', scope_ref: id };
}

/**
 * What the migration does with one entry this surface created:
 *  - `reserved`: already carries `backend:<id>` — nothing to do, whatever else
 *    it carries (the operator chose);
 *  - `migrate`: exactly the `global` grant the form used to write — the only
 *    shape whose meaning is certain, replaced by the reservation;
 *  - `daemon-only`: no grant — it reached no mission, nothing to close;
 *  - `ambiguous`: anything else (a project, an agent, another backend added by
 *    hand): someone shared it on purpose, so it is not touched and a card asks.
 */
export type KeyVerdict = 'reserved' | 'migrate' | 'daemon-only' | 'ambiguous';

export function classifyBackendKey(row: Pick<SecretWithGrants, 'grants'>, id: string): KeyVerdict {
  if (row.grants.some((grant) => grant.scope_kind === 'backend' && grant.scope_ref === id)) return 'reserved';
  if (row.grants.length === 0) return 'daemon-only';
  if (row.grants.length === 1 && row.grants[0]!.scope_kind === 'global') return 'migrate';
  return 'ambiguous';
}

/**
 * The entries backend `id` OWNS, verified three ways: the name this surface
 * derives from the id, the owner mark it writes in the note, and the backend's
 * own file referencing that name. A secret the user filed under the same name,
 * or one whose note they changed, is theirs and is never touched.
 */
export function ownedBackendKeys(entry: Pick<LocalBackend, 'id' | 'profile'>, rows: readonly SecretWithGrants[]): SecretWithGrants[] {
  if (!entry.profile) return [];
  const name = secretNameFor(entry.id);
  if (!secretNamesOf(entry.profile).includes(name)) return [];
  return rows.filter((row) => row.name === name && row.note === ownerNote(entry.id));
}

/** Replaces the legacy `global` grant of an owned entry by the reservation.
 *  False when the entry is not in that exact shape, or the vault refused. */
export function reserveBackendKey(id: string, row: SecretWithGrants): boolean {
  if (classifyBackendKey(row, id) !== 'migrate') return false;
  try {
    updateSecret(row.id, { grants: [backendKeyGrant(id)] });
    return true;
  } catch (err) {
    console.warn(`[backends] key of ${id} kept as it is: ${(err as Error).message}`);
    return false;
  }
}

export type KeyMigrationReport = { migrated: string[]; ambiguous: string[] };

/**
 * Moves the keys of "Add a provider" backends to their reservation. Runs at
 * every boot and is idempotent: a reserved entry is `reserved` the second time.
 * Never deletes, never copies a value, never widens a grant.
 */
export function migrateBackendKeys(backends: readonly LocalBackend[] = listLocalBackends()): KeyMigrationReport {
  const report: KeyMigrationReport = { migrated: [], ambiguous: [] };
  if (!vaultEnabled()) return report;
  const rows = dbApi.listSecrets();
  for (const entry of backends) {
    for (const row of ownedBackendKeys(entry, rows)) {
      const verdict = classifyBackendKey(row, entry.id);
      if (verdict === 'migrate' && reserveBackendKey(entry.id, row)) {
        report.migrated.push(row.id);
      } else if (verdict === 'migrate' || verdict === 'ambiguous') {
        // A refused migration (a name clash at the reservation) is asked too.
        report.ambiguous.push(row.id);
        askAboutSharedKey(entry.id, row);
      }
    }
  }
  if (report.migrated.length) console.log(`[backends] ${report.migrated.length} provider key(s) reserved to their backend`);
  return report;
}

/** Cards raised in this process, by anchor: a reload must not stack them. */
const ASKED = new Set<string>();

/** Test seam. */
export function resetBackendKeyCards(): void {
  ASKED.clear();
}

/**
 * The explicit choice the migration does not make. Once per process and
 * entry, replacing the previous boot's card rather than adding one: the
 * question stands until it is answered. Names and scopes only, never a value.
 */
function askAboutSharedKey(id: string, row: SecretWithGrants): void {
  const anchor = `backend-key:${id}:${row.id}`;
  if (ASKED.has(anchor)) return;
  ASKED.add(anchor);
  const scopes = row.grants.map(formatSecretScope).join(', ');
  void import('../../notifications.js')
    .then(({ createNotification, resolveAnchor }) => {
      resolveAnchor(anchor);
      createNotification({
        type: 'action_required',
        title: `The key of backend \`${id}\` is still shared outside it`,
        body: `\`${row.name}\` was created for backend \`${id}\` and is now granted to ${scopes}: `
          + 'it still enters those missions whatever backend they run on. '
          + `To keep it on this backend only, for the same missions: \`timon secret grant ${row.name} --scope backend:${id}\`. `
          + `To keep sharing it as it is, change its note in the Secrets page: it is then yours, and no longer removed with the backend.`,
        message: daemonMessage('backend_key_shared', { backend: id, name: row.name, scopes }),
        anchor,
      });
    })
    .catch(() => { /* no notification centre: the entry is untouched either way */ });
}
