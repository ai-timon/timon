/**
 * Le manifeste est la porte d'entrée du produit : ces tests décrivent ce qui
 * passe et ce qui est refusé, avec quel code. Trois d'entre eux sont des
 * critères de sortie de la Phase P (§10.9) — `apiVersion` inconnue refusée avec
 * un message clair, et `inject` qui nomme `db` refusé en `forbidden-inject`.
 */
// Isole TIMON_HOME AVANT tout module qui touche à l'état TIMON (cf. test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../brand.js';
import {
  readManifest, PLUGIN_API_VERSION, ALLOWED_INJECT, PLUGIN_PERMISSIONS, SENSITIVE_PLUGIN_PERMISSIONS, ORDINARY_PLUGIN_PERMISSIONS,
  dictationEgressLines, PluginManifestSchema, PLUGIN_KINDS,
} from './manifest.js';

/** Un `package.json` de plugin, dont on ne surcharge que ce que le test observe. */
function pkg(manifest: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'acme-crm-sync',
    version: '1.0.0',
    main: 'lib/index.js',
    [BRAND.manifestKey]: { id: 'acme-crm-sync', apiVersion: PLUGIN_API_VERSION, ...manifest },
  };
}

test('users:read is a valid manifesto permission (M.7)', () => {
  const res = readManifest(pkg({ permissions: ['users:read'] }));
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.deepEqual(res.manifest.permissions, ['users:read']);
});

test('un manifeste complet est accepté tel quel', () => {
  const res = readManifest(
    pkg({
      permissions: ['missions:spawn', 'kanban:write', 'http:outbound'],
      client: { slots: ['nav.item', 'cockpit.widget'] },
      settings: [{ key: 'apiUrl', type: 'string', label: "URL de l'API", default: '' }],
      license: { required: true },
    }),
    { inject: ['http', 'kanban', 'events', 'storage'] },
  );
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.equal(res.manifest.id, 'acme-crm-sync');
  assert.deepEqual(res.manifest.permissions, ['missions:spawn', 'kanban:write', 'http:outbound']);
  assert.equal(res.manifest.license.required, true);
  assert.equal(res.manifest.client?.mode, 'esm', 'iframe ne peut jamais être le défaut');
  assert.deepEqual(res.manifest.client?.external, []);
});

test('un manifeste minimal reçoit des défauts sûrs', () => {
  const res = readManifest(pkg({}));
  assert.ok(res.ok);
  assert.deepEqual(res.manifest.permissions, [], 'aucune permission par défaut');
  assert.deepEqual(res.manifest.settings, []);
  assert.equal(res.manifest.license.required, false);
  assert.equal(res.manifest.client, undefined, 'pas de moitié navigateur sans `client`');
});

test('la clé lue est celle de la marque, jamais une autre', () => {
  // The former internal identifier is not the public contract: the manifest
  // is read under `timon` (BRAND.manifestKey). public-name-ok: refused by name
  const res = readManifest({ name: 'x', pkos: { id: 'acme-crm-sync', apiVersion: PLUGIN_API_VERSION } });
  assert.ok(!res.ok);
  assert.equal(res.code, 'manifest');
  assert.match(res.message, new RegExp(BRAND.manifestKey));
});

test('un paquet sans champ de manifeste est refusé, pas ignoré', () => {
  const res = readManifest({ name: 'lodash', version: '4.0.0' });
  assert.ok(!res.ok);
  assert.equal(res.code, 'manifest');
});

test("une apiVersion trop récente est refusée avec un message qui nomme les deux versions", () => {
  const res = readManifest(pkg({ apiVersion: PLUGIN_API_VERSION + 1 }));
  assert.ok(!res.ok);
  assert.equal(res.code, 'api-version');
  assert.match(res.message, new RegExp(`apiVersion ${PLUGIN_API_VERSION + 1}`));
  assert.match(res.message, new RegExp(`contract ${PLUGIN_API_VERSION}`));
});

test("une apiVersion plus ANCIENNE est acceptée : la surface ne fait que grandir", () => {
  // La promesse open-core (§10.15) : élargir le SDK n'invalide pas ce qui est
  // déjà installé. Un plugin écrit pour le contrat 1 tourne sur un daemon 2.
  for (let version = 1; version <= PLUGIN_API_VERSION; version += 1) {
    const res = readManifest(pkg({ apiVersion: version }));
    assert.ok(res.ok, `apiVersion ${version} aurait dû être acceptée`);
  }
});

test('un `inject` qui nomme une capacité interdite est refusé en forbidden-inject', () => {
  const res = readManifest(pkg({}), { inject: ['http', 'db', 'bus'] });
  assert.ok(!res.ok);
  assert.equal(res.code, 'forbidden-inject');
  assert.match(res.message, /capability \(db, bus\)/, 'le message nomme les capacités fautives, et elles seules');
});

test('toute la liste blanche est injectable', () => {
  const res = readManifest(pkg({}), { inject: ALLOWED_INJECT });
  assert.ok(res.ok, res.ok ? '' : res.message);
});

test('une apiVersion trop récente prime sur un inject interdit', () => {
  // Le message doit désigner la vraie cause : un plugin écrit pour un contrat
  // futur peut légitimement injecter des services qui n'existent pas encore.
  const res = readManifest(pkg({ apiVersion: PLUGIN_API_VERSION + 1 }), { inject: ['db'] });
  assert.ok(!res.ok);
  assert.equal(res.code, 'api-version');
});

test('un id hors format est refusé en nommant la clé fautive', () => {
  for (const id of ['AB', 'ac', 'acme_crm', 'Acme-Crm', 'a'.repeat(41)]) {
    const res = readManifest({ [BRAND.manifestKey]: { id, apiVersion: PLUGIN_API_VERSION } });
    assert.ok(!res.ok, `id \`${id}\` aurait dû être refusé`);
    assert.equal(res.code, 'manifest');
    assert.match(res.message, /^invalid .* field — id: /);
  }
});

test('une permission inconnue est refusée — pas de permission tacite', () => {
  const res = readManifest(pkg({ permissions: ['db:write'] }));
  assert.ok(!res.ok);
  assert.equal(res.code, 'manifest');
  assert.match(res.message, /permissions\.0/);
});

// The Google agenda left the public product (docs/SDK-COMPAT.md § 111): its
// permission is gone with `ctx.agenda`, and a manifest naming it is refused
// rather than granted a facade that no longer exists.
test('agenda:read was removed with ctx.agenda and is refused like any unknown permission', () => {
  const res = readManifest(pkg({ permissions: ['agenda:read'] }));
  assert.ok(!res.ok);
  assert.equal(res.code, 'manifest');
  assert.match(res.message, /permissions\.0/);
});

test('secrets:read is a declared permission, not a tacit grant', () => {
  const res = readManifest(pkg({ permissions: ['secrets:read'] }));
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.deepEqual(res.manifest.permissions, ['secrets:read']);
});

test('un slot inconnu du runtime est accepté — un layout tiers déclare les siens', () => {
  const res = readManifest(pkg({ client: { slots: ['acme.sidebar.widget'] } }));
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.deepEqual(res.manifest.client?.slots, ['acme.sidebar.widget']);
});

test('une clé inconnue du manifeste est ignorée, pas fatale', () => {
  // Forward-compat : un champ ajouté par une version future du contrat ne doit
  // pas produire un refus qui envoie le tiers chercher au mauvais endroit.
  const res = readManifest(pkg({ futureKey: { anything: true } }));
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.equal((res.manifest as Record<string, unknown>)['futureKey'], undefined);
});

test('un manifeste qui n\'est pas un objet est refusé sans throw', () => {
  for (const bad of [null, undefined, 42, 'plugin', [], { [BRAND.manifestKey]: 'oui' }]) {
    const res = readManifest(bad);
    assert.ok(!res.ok);
    assert.equal(res.code, 'manifest');
  }
});

// ---------------------------------------------------------------------------
// Phase U — ce qu'un plugin déclare être (§10.12).
// ---------------------------------------------------------------------------

test('`kind` string est du sucre : la forme lue est toujours une liste', () => {
  const res = readManifest(pkg({ kind: 'widget', client: { slots: ['cockpit.widget'] } }));
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.deepEqual(res.manifest.kind, ['widget']);
});

test('un plugin peut être widget ET overlay — deux insertions, une identité', () => {
  const res = readManifest(
    pkg({ kind: ['widget', 'overlay'], client: { slots: ['cockpit.widget', 'overlay'] } }),
  );
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.deepEqual(res.manifest.kind, ['widget', 'overlay']);
});

test('`kind: overlay` exige le slot `overlay` — une zone `*.widget` ne le remplace pas', () => {
  // L'admission d'`overlay` est exacte (slot-compat.ts) : une mascotte ne se
  // glisse pas dans un rail parce qu'elle sait être une carte ailleurs.
  const res = readManifest(pkg({ kind: 'overlay', client: { slots: ['cockpit.widget'] } }));
  assert.ok(!res.ok);
  assert.equal(res.code, 'manifest');
  assert.match(res.message, /overlay/);
});

test('`kind: widget` sans zone `*.widget` est refusé', () => {
  const res = readManifest(pkg({ kind: 'widget', client: { slots: ['nav.item'] } }));
  assert.ok(!res.ok);
  assert.match(res.message, /\*\.widget/);
});

test('`kind: island` requires the exact `island.content` slot, not a widget zone', () => {
  const ok = readManifest(pkg({ kind: 'island', client: { slots: ['island.content'] } }));
  assert.ok(ok.ok, ok.ok ? '' : ok.message);
  assert.deepEqual(ok.manifest.kind, ['island']);

  const missing = readManifest(pkg({ kind: 'island', client: { slots: ['cockpit.widget'] } }));
  assert.ok(!missing.ok);
  assert.equal(missing.code, 'manifest');
  assert.match(missing.message, /island\.content/);
});

test('a plugin can be both widget and island content by declaring both kinds and slots', () => {
  const both = readManifest(
    pkg({ kind: ['widget', 'island'], client: { slots: ['cockpit.widget', 'island.content'] } }),
  );
  assert.ok(both.ok, both.ok ? '' : both.message);
  assert.deepEqual(both.manifest.kind, ['widget', 'island']);

  // Island content cannot grant widget admission: it is not a `*.widget` zone.
  const widgetOnly = readManifest(pkg({ kind: 'widget', client: { slots: ['island.content'] } }));
  assert.ok(!widgetOnly.ok);
  assert.match(widgetOnly.message, /\*\.widget/);
});

test('`island.content` without `kind` infers `island` instead of `behavior`', () => {
  const inferred = readManifest(pkg({ client: { slots: ['island.content'] } }));
  assert.ok(inferred.ok, inferred.ok ? '' : inferred.message);
  assert.deepEqual(inferred.manifest.kind, ['island']);
});

test('`kind` absent est déduit des slots — les manifestes de la Phase P restent valides', () => {
  const hello = readManifest(pkg({ client: { slots: ['nav.item', 'cockpit.widget'] } }));
  assert.ok(hello.ok, hello.ok ? '' : hello.message);
  assert.deepEqual(hello.manifest.kind, ['widget']);

  const layout = readManifest(pkg({ client: { slots: ['root'] } }));
  assert.ok(layout.ok, layout.ok ? '' : layout.message);
  assert.deepEqual(layout.manifest.kind, ['layout']);

  const headless = readManifest(pkg({}));
  assert.ok(headless.ok, headless.ok ? '' : headless.message);
  assert.deepEqual(headless.manifest.kind, ['behavior'], 'un plugin sans UI est un comportement, pas une erreur');
});

test('un bundle installe `contains` et n\'occupe rien', () => {
  const res = readManifest(pkg({ kind: 'bundle', contains: ['example-page', 'example-widget'] }));
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.deepEqual(res.manifest.contains, ['example-page', 'example-widget']);
  assert.deepEqual(res.manifest.kind, ['bundle']);
});

test('`bundle` est exclusif et ne se mélange à aucune autre nature', () => {
  const mixed = readManifest(
    pkg({ kind: ['bundle', 'widget'], contains: ['example-widget'], client: { slots: ['cockpit.widget'] } }),
  );
  assert.ok(!mixed.ok);
  assert.match(mixed.message, /bundle/);

  const slotted = readManifest(
    pkg({ kind: 'bundle', contains: ['example-widget'], client: { slots: ['cockpit.widget'] } }),
  );
  assert.ok(!slotted.ok, 'un bundle n\'a pas de moitié navigateur');
});

test('un bundle vide et un `contains` hors bundle sont refusés', () => {
  const empty = readManifest(pkg({ kind: 'bundle' }));
  assert.ok(!empty.ok);
  assert.match(empty.message, /contains/);

  const stray = readManifest(pkg({ contains: ['example-widget'], client: { slots: ['cockpit.widget'] } }));
  assert.ok(!stray.ok);
  assert.match(stray.message, /contains/);
});

test('une page porte sa route, et la route ne vit que sur une page', () => {
  const page = readManifest(
    pkg({ kind: 'page', route: '/example', declares: { 'example.widget': 'list' }, client: { slots: ['page'] } }),
  );
  assert.ok(page.ok, page.ok ? '' : page.message);
  assert.equal(page.manifest.route, '/example');
  assert.deepEqual(page.manifest.declares, { 'example.widget': 'list' });

  const routeless = readManifest(pkg({ kind: 'page', client: { slots: ['page'] } }));
  assert.ok(!routeless.ok);
  assert.match(routeless.message, /route/);

  const stray = readManifest(pkg({ kind: 'widget', route: '/example', client: { slots: ['cockpit.widget'] } }));
  assert.ok(!stray.ok);
  assert.match(stray.message, /route/);
});

test('une route ou une cover hors format est refusée', () => {
  for (const route of ['example', '/Example', '/example?x=1', '//example']) {
    const res = readManifest(pkg({ kind: 'page', route, client: { slots: ['page'] } }));
    assert.ok(!res.ok, `route \`${route}\` aurait dû être refusée`);
  }
  for (const cover of ['https://acme.test/cover.png', '/etc/passwd', '../../secret.png', 'cover.exe']) {
    const res = readManifest(pkg({ cover }));
    assert.ok(!res.ok, `cover \`${cover}\` aurait dû être refusée`);
    assert.match(res.message, /cover/);
  }
});

test("les champs d'identité de la galerie sont lus tels quels", () => {
  const res = readManifest(
    pkg({ label: 'Mascotte', description: 'Un calque in-app.', cover: 'assets/cover.webp', modifies: ['theme'] }),
  );
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.equal(res.manifest.label, 'Mascotte');
  assert.equal(res.manifest.description, 'Un calque in-app.');
  assert.equal(res.manifest.cover, 'assets/cover.webp');
  assert.deepEqual(res.manifest.modifies, ['theme']);
});

test('screenshots sont des fichiers du paquet, comme cover', () => {
  const ok = readManifest(pkg({ cover: 'cover.jpg', screenshots: ['still-1.jpg', 'still-2.jpg'] }));
  assert.ok(ok.ok, ok.ok ? '' : ok.message);
  assert.deepEqual(ok.manifest.screenshots, ['still-1.jpg', 'still-2.jpg']);
  const remote = readManifest(pkg({ screenshots: ['https://acme.test/a.png'] }));
  assert.ok(!remote.ok);
});

test('icon is an SVG of the package, never a URL nor a raster', () => {
  const ok = readManifest(pkg({ icon: 'assets/icon.svg' }));
  assert.ok(ok.ok, ok.ok ? '' : ok.message);
  assert.equal(ok.manifest.icon, 'assets/icon.svg');
  for (const icon of ['https://acme.test/icon.svg', '/etc/icon.svg', '../icon.svg', 'icon.png']) {
    const res = readManifest(pkg({ icon }));
    assert.ok(!res.ok, `icon \`${icon}\` should have been refused`);
    assert.match(res.message, /icon/);
  }
});

test('les gabarits `examples/plugin-*` sont acceptés par le schéma', async () => {
  // Ils sont la documentation exécutable du contrat : si le schéma les refuse,
  // c'est le schéma qui a tort, pas le gabarit.
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const examples = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples');
  const dirs = readdirSync(examples).filter((d) => d.startsWith('plugin-'));
  assert.ok(dirs.length >= 5, 'les gabarits doivent être là');
  for (const dir of dirs) {
    const json = JSON.parse(readFileSync(join(examples, dir, 'package.json'), 'utf8')) as unknown;
    const res = readManifest(json);
    assert.ok(res.ok, `${dir} : ${res.ok ? '' : res.message}`);
  }
});

test('realtime permission is closed: invented neighbours are refused', () => {
  assert.equal(readManifest(pkg({ permissions: ['realtime:broadcast'] })).ok, false);
  assert.equal(readManifest(pkg({ permissions: ['realtime:publish'] })).ok, true);
});

test('a plugin may declare the chat document slot (MCPUI, ADR D8): the name passes the slot form', () => {
  const res = readManifest(pkg({ apiVersion: 9, client: { slots: ['chat.document'] } }));
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.deepEqual(res.manifest.client?.slots, ['chat.document']);
  // The name the ADR first gave it would have been refused at install.
  assert.equal(readManifest(pkg({ client: { slots: ['chat.ui-document'] } })).ok, false);
});

// A permission added to PLUGIN_PERMISSIONS must be classified, with its reason, in
// exactly one of the two lists: a volet can no longer forget to ask whether the
// new right acts on other people's work or validates an action.
test('every plugin permission is classified sensitive or ordinary, once', () => {
  const sensitive: readonly string[] = SENSITIVE_PLUGIN_PERMISSIONS;
  const ordinary: readonly string[] = ORDINARY_PLUGIN_PERMISSIONS;
  const all: readonly string[] = PLUGIN_PERMISSIONS;
  assert.deepEqual(all.filter((p) => !sensitive.includes(p) && !ordinary.includes(p)), [],
    'classify the new permission in SENSITIVE_PLUGIN_PERMISSIONS or ORDINARY_PLUGIN_PERMISSIONS (manifest.ts), with a one-line reason');
  assert.deepEqual(all.filter((p) => sensitive.includes(p) && ordinary.includes(p)), [], 'a permission cannot be both');
  assert.deepEqual([...sensitive, ...ordinary].filter((p) => !all.includes(p)), [], 'a classified name that is not a permission');
  assert.equal(new Set(sensitive).size, sensitive.length, 'duplicate in the sensitive list');
  assert.equal(new Set(ordinary).size, ordinary.length, 'duplicate in the ordinary list');
  assert.equal(sensitive.length + ordinary.length, all.length);
});

test('the permissions that act on other people\'s work or validate an action are sensitive', () => {
  for (const permission of [
    'questions:answer', 'missions:control', 'missions:transcript', 'kanban:delete', 'kanban:read:project', 'triggers:write', 'triggers:execute',
    'routines:write', 'pipelines:write', 'pipelines:run', 'workflows:run', 'memory:write', 'chat:command', 'agents:manage', 'messages:send', 'host:exec',
    'projects:manage', 'memory:read', 'chat:media', 'secrets:read', 'mcp:issue', 'connections:users:read', 'accounts:manage', 'plugins:manage',
    'browser:control', 'browser:annotations:read', 'browser:annotations:write', 'dictation:engine',
  ]) assert.ok((SENSITIVE_PLUGIN_PERMISSIONS as readonly string[]).includes(permission), permission);
  // Public documentation is not a secret.
  assert.ok(!(SENSITIVE_PLUGIN_PERMISSIONS as readonly string[]).includes('docs:read'));
});

const DOCS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public-docs', 'docs');

/**
 * Both pages below are committed: a missing one is a regression (deleted, or a
 * `gen:sdk` run that stopped emitting it), so the guards fail instead of
 * returning early and passing green over absent documentation (TODO #642).
 */
function readDocsPage(...segments: string[]): string {
  const page = join(DOCS_ROOT, ...segments);
  assert.ok(existsSync(page), `public-docs/docs/${segments.join('/')} is missing — regenerate it (npm run gen:sdk) or restore it`);
  return readFileSync(page, 'utf8');
}

test('a docs guard fails when its page is missing instead of passing in silence', () => {
  assert.throws(() => readDocsPage('plugins', 'no-such-page.md'), /public-docs\/docs\/plugins\/no-such-page\.md is missing/);
});

// The public page is what a plugin author and an operator read; it must name the
// same permissions as the code, in the same order.
test('the public permissions page lists the sensitive permissions in the order of the code', () => {
  const text = readDocsPage('plugins', 'permissions.md');
  const start = text.indexOf('## Sensitive permissions');
  assert.notEqual(start, -1, 'permissions.md has no "Sensitive permissions" section');
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);
  const listed = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(listed, [...SENSITIVE_PLUGIN_PERMISSIONS]);
});

// TODO #578: the SDK reference showed `PluginManifest` as `Omit<PluginManifestFields, 'kind'> & …`
// over an unexported base, so TypeDoc listed none of its fields. The page is
// generated (`npm run gen:sdk`): a field added to the schema without
// regenerating it fails here too.
test('the SDK reference page of PluginManifest lists every field of the manifest', () => {
  const text = readDocsPage('plugins', 'api-reference', 'type-aliases', 'PluginManifest.md');
  const listed = [...text.matchAll(/^### (\w+)\??$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, Object.keys(PluginManifestSchema.shape).sort());
  const kind = /^> \*\*kind\*\*: (.+)$/m.exec(text)?.[1] ?? '';
  for (const value of PLUGIN_KINDS) assert.ok(kind.includes(`"${value}"`), `the kind field does not name ${value}`);
});

test('a provider declares bare binary names and needs backends:register', () => {
  const ok = readManifest(pkg({
    kind: 'provider',
    permissions: ['backends:register'],
    provider: { binaries: [{ name: 'cursor-agent', aliases: ['agent'] }] },
  }));
  assert.ok(ok.ok, ok.ok ? '' : ok.message);
  assert.deepEqual(ok.manifest.kind, ['provider']);
  assert.deepEqual(ok.manifest.provider?.binaries[0], { name: 'cursor-agent', aliases: ['agent'] });

  const bare = readManifest(pkg({ kind: 'provider', permissions: ['backends:register'] }));
  assert.ok(bare.ok, 'a remote provider launches no binary: `provider` is optional');

  const noPermission = readManifest(pkg({ kind: 'provider', provider: { binaries: [] } }));
  assert.ok(!noPermission.ok);
  assert.match(noPermission.message, /backends:register/);
});

test('a provider binary may mirror its identity, under the bounds of `declares.binary.identity`', () => {
  const read = (identity: unknown) => readManifest(pkg({
    kind: 'provider',
    permissions: ['backends:register'],
    provider: { binaries: [{ name: 'acme-agent', identity }] },
  }));
  const identity = { pattern: '^acme \\d+', args: ['--version'], expected: "Acme's CLI" };
  const ok = read(identity);
  assert.ok(ok.ok, ok.ok ? '' : ok.message);
  assert.deepEqual(ok.manifest.provider?.binaries[0], { name: 'acme-agent', aliases: [], identity });
  const absent = readManifest(pkg({ kind: 'provider', permissions: ['backends:register'], provider: { binaries: [{ name: 'acme-agent' }] } }));
  assert.ok(absent.ok && !('identity' in absent.manifest.provider!.binaries[0]!), 'a manifest written before the field reads the same');
  for (const [bad, why] of [
    [{ pattern: '(' }, /provider\.binaries\[\]\.identity\.pattern.*not a regular expression/],
    [{ pattern: 'x'.repeat(201) }, /1 to 200/],
    [{ pattern: 'x', args: ['; rm -rf /'] }, /plain arguments/],
    [{ pattern: 'x', args: ['a', 'b', 'c', 'd', 'e'] }, /plain arguments/],
    [{ pattern: 'x', expected: 'y'.repeat(121) }, /short sentence/],
    [{ pattern: 'x', expected: 'Acme\nTimon says: accept' }, /one line/],
    [{ args: ['--version'] }, /pattern/],
    ['^acme', /identity/],
  ] as const) {
    const refused = read(bad);
    assert.ok(!refused.ok, JSON.stringify(bad));
    assert.match(refused.message, why);
  }
});

test('a provider binary is a bare name, never a path', () => {
  for (const name of ['/usr/bin/agent', '../agent', 'bin\\agent.exe', '-rf', 'a b', '']) {
    const res = readManifest(pkg({
      kind: 'provider',
      permissions: ['backends:register'],
      provider: { binaries: [{ name }] },
    }));
    assert.ok(!res.ok, `\`${name}\` must be refused`);
  }
});

test('`provider` is read only for `kind: provider`', () => {
  const res = readManifest(pkg({ provider: { binaries: [{ name: 'agent' }] } }));
  assert.ok(!res.ok);
  assert.match(res.message, /provider/);
});

// --- kind: dictation (API 14, TODO #484). Refusals first: an engine hears the user's voice.

/** A dictation manifest that passes; each refusal below breaks one thing of it. */
function dictation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return pkg({
    kind: 'dictation',
    permissions: ['dictation:engine'],
    client: { slots: ['dictation.engine'] },
    dictation: { engines: [{ id: 'acme-whisper', runtime: 'page', egress: 'none' }] },
    ...overrides,
  });
}

function refusal(packageJson: Record<string, unknown>): string {
  const res = readManifest(packageJson);
  assert.ok(!res.ok, 'must be refused');
  assert.equal(res.code, 'manifest');
  return res.message;
}

test('dictation: refused without the `dictation:engine` permission', () => {
  assert.match(refusal(dictation({ permissions: [] })), /dictation:engine/);
  assert.match(refusal(dictation({ permissions: ['http:outbound'] })), /dictation:engine/);
});

test('dictation: refused without the exact `dictation.engine` slot', () => {
  assert.match(refusal(dictation({ client: { slots: [] } })), /dictation\.engine/);
  assert.match(refusal(dictation({ client: { slots: ['cockpit.widget'] } })), /dictation\.engine/);
  assert.match(refusal(dictation({ client: undefined })), /dictation\.engine/);
});

test('dictation: the slot is refused to any other kind, which would skip the egress declaration', () => {
  const sneaky = pkg({ kind: 'widget', permissions: ['dictation:engine'], client: { slots: ['cockpit.widget', 'dictation.engine'] } });
  assert.match(refusal(sneaky), /dictation\.engine/);
});

test('dictation: an egress to hosts needs `http:outbound`', () => {
  const hosts = { engines: [{ id: 'acme-cloud', runtime: 'page', egress: ['api.acme.com'] }] };
  assert.match(refusal(dictation({ dictation: hosts })), /http:outbound/);
  const daemonHosts = { engines: [{ id: 'acme-cloud', runtime: 'daemon', egress: ['api.acme.com'] }] };
  assert.match(refusal(dictation({ dictation: daemonHosts })), /http:outbound/);
});

test('dictation: `models` must be a JSON file inside the package', () => {
  for (const models of ['../models.json', '/etc/models.json', 'packs/../../models.json', 'C:\\models.json', 'packs\\models.json',
    'https://acme.com/models.json', 'models.bin', '']) {
    refusal(dictation({ dictation: { models } }));
  }
});

test('dictation: an egress is a bare hostname, never a URL, a port or a path', () => {
  for (const host of ['https://api.acme.com', 'api.acme.com:443', 'api.acme.com/v1', 'API.ACME.COM', 'localhost', '*', '*.com.', 'a b.com', '']) {
    refusal(dictation({
      permissions: ['dictation:engine', 'http:outbound'],
      dictation: { engines: [{ id: 'acme-cloud', runtime: 'page', egress: [host] }] },
    }));
  }
  refusal(dictation({
    permissions: ['dictation:engine', 'http:outbound'],
    dictation: { engines: [{ id: 'acme-cloud', runtime: 'page', egress: [] }] },
  }));
});

test('dictation: the block is mandatory, and says something', () => {
  assert.match(refusal(dictation({ dictation: undefined })), /dictation/);
  assert.match(refusal(dictation({ dictation: { engines: [] } })), /engine/);
});

test('dictation: a daemon engine cannot claim the voice stays in the window', () => {
  assert.match(refusal(dictation({ dictation: { engines: [{ id: 'acme', runtime: 'daemon', egress: 'none' }] } })), /egress/);
});

test('dictation: unknown runtime or egress, duplicate engine ids are refused', () => {
  refusal(dictation({ dictation: { engines: [{ id: 'acme', runtime: 'desktop', egress: 'none' }] } }));
  refusal(dictation({ dictation: { engines: [{ id: 'acme', runtime: 'page', egress: 'cloud' }] } }));
  refusal(dictation({ dictation: { engines: [{ id: 'acme', runtime: 'page', egress: 'none' }, { id: 'acme', runtime: 'page', egress: 'none' }] } }));
});

test('dictation: the block is read only for `kind: dictation`', () => {
  assert.match(refusal(pkg({ dictation: { engines: [{ id: 'acme', runtime: 'page', egress: 'none' }] } })), /kind: dictation/);
});

test('dictation: a manifest below API 14 is refused with a message naming the version', () => {
  assert.match(refusal(dictation({ apiVersion: 13 })), /apiVersion: 14/);
});

test('dictation: a page engine, a daemon engine and a models pack are admitted', () => {
  const page = readManifest(dictation());
  assert.ok(page.ok, page.ok ? '' : page.message);
  assert.deepEqual(page.manifest.kind, ['dictation']);
  assert.deepEqual(page.manifest.dictation?.engines, [{ id: 'acme-whisper', runtime: 'page', egress: 'none' }]);

  const both = readManifest(dictation({
    kind: ['dictation', 'widget'],
    permissions: ['dictation:engine', 'http:outbound'],
    client: { slots: ['dictation.engine', 'cockpit.widget'] },
    dictation: {
      engines: [
        { id: 'acme-local', runtime: 'daemon', egress: 'daemon' },
        { id: 'acme-cloud', runtime: 'daemon', egress: ['api.acme.com', '*.eu.acme.com'] },
      ],
      models: 'packs/dictation-models.json',
    },
  }));
  assert.ok(both.ok, both.ok ? '' : both.message);
  assert.equal(both.manifest.dictation?.models, 'packs/dictation-models.json');

  const pack = readManifest(dictation({ dictation: { models: 'dictation-models.json' } }));
  assert.ok(pack.ok, pack.ok ? '' : pack.message);
});

test('dictation: `dictation.engine` alone infers `kind: dictation`, with its checks', () => {
  const inferred = readManifest(pkg({ permissions: ['dictation:engine'], client: { slots: ['dictation.engine'] },
    dictation: { engines: [{ id: 'acme', runtime: 'page', egress: 'none' }] } }));
  assert.ok(inferred.ok, inferred.ok ? '' : inferred.message);
  assert.deepEqual(inferred.manifest.kind, ['dictation']);
  assert.match(refusal(pkg({ client: { slots: ['dictation.engine'] } })), /dictation:engine/);
});

test('dictation: the install sheet says where the voice goes, engine by engine', () => {
  const res = readManifest(dictation({
    permissions: ['dictation:engine', 'http:outbound'],
    dictation: {
      engines: [
        { id: 'in-page', runtime: 'page', egress: 'none' },
        { id: 'on-daemon', runtime: 'daemon', egress: 'daemon' },
        { id: 'cloud', runtime: 'page', egress: ['api.acme.com'] },
      ],
      models: 'models.json',
    },
  }));
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.deepEqual(dictationEgressLines(res.manifest), [
    'in-page: your voice stays in this window',
    'on-daemon: your voice is sent to the daemon of the active machine',
    'cloud: your voice is sent to api.acme.com',
    'models: brings models for the built-in engine; your voice stays on this machine',
  ]);
  const other = readManifest(pkg({}));
  assert.ok(other.ok);
  assert.deepEqual(dictationEgressLines(other.manifest), []);
});

// TODO #599: the manifest names the vault entries and the hosts it will ask
// for, so the install sheet can show them. A declaration the plugin cannot act
// on (no permission behind it) is refused at the door.
test('secrets and http.hosts: a manifest written before them is admitted unchanged', () => {
  const res = readManifest(pkg({ permissions: ['secrets:read', 'secrets:broker', 'http:outbound'] }));
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.equal(res.manifest.secrets, undefined);
  assert.equal(res.manifest.http, undefined);
});

test('secrets and http.hosts: declared with their permissions, they are admitted as written', () => {
  const res = readManifest(pkg({
    permissions: ['secrets:read', 'secrets:broker', 'http:outbound'],
    secrets: [
      { name: 'ACME_TOKEN', mode: 'read', why: 'Signs the calls to the Acme API.' },
      { name: 'ACME_DEPLOY_KEY', mode: 'broker' },
    ],
    http: { hosts: [{ host: 'api.acme.com', why: 'The Acme API.' }, { host: '*.acme-cdn.net' }] },
  }));
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.deepEqual(res.manifest.secrets, [
    { name: 'ACME_TOKEN', mode: 'read', why: 'Signs the calls to the Acme API.' },
    { name: 'ACME_DEPLOY_KEY', mode: 'broker' },
  ]);
  assert.deepEqual(res.manifest.http, { hosts: [{ host: 'api.acme.com', why: 'The Acme API.' }, { host: '*.acme-cdn.net' }] });
});

test('secrets: a mode is refused without the permission that uses it', () => {
  assert.match(refusal(pkg({ permissions: ['secrets:broker'], secrets: [{ name: 'ACME_TOKEN', mode: 'read' }] })),
    /ACME_TOKEN.*secrets:read/);
  assert.match(refusal(pkg({ permissions: ['secrets:read'], secrets: [{ name: 'ACME_TOKEN', mode: 'broker' }] })),
    /ACME_TOKEN.*secrets:broker/);
});

test('secrets: a name is a vault name, a mode is read or broker, a name appears once', () => {
  const ok = { permissions: ['secrets:read'] };
  for (const name of ['acme_token', '1TOKEN', 'ACME-TOKEN', 'ACME TOKEN', '']) {
    refusal(pkg({ ...ok, secrets: [{ name, mode: 'read' }] }));
  }
  refusal(pkg({ ...ok, secrets: [{ name: 'ACME_TOKEN', mode: 'inject' }] }));
  refusal(pkg({ ...ok, secrets: [{ name: 'ACME_TOKEN' }] }));
  refusal(pkg({ permissions: ['secrets:read', 'secrets:broker'],
    secrets: [{ name: 'ACME_TOKEN', mode: 'read' }, { name: 'ACME_TOKEN', mode: 'broker' }] }));
});

test('secrets and http.hosts: `why` is one line of text', () => {
  for (const why of ['', 'first line\nsecond line', 'tab\there', 'x'.repeat(201)]) {
    refusal(pkg({ permissions: ['secrets:read'], secrets: [{ name: 'ACME_TOKEN', mode: 'read', why }] }));
    refusal(pkg({ permissions: ['http:outbound'], http: { hosts: [{ host: 'api.acme.com', why }] } }));
  }
});

test('http.hosts: refused without `http:outbound`', () => {
  assert.match(refusal(pkg({ http: { hosts: [{ host: 'api.acme.com' }] } })), /api\.acme\.com.*http:outbound/);
});

test('http.hosts: a host has the form of a dictation egress, never a URL, a port or a path', () => {
  const ok = { permissions: ['http:outbound'] };
  for (const host of ['https://api.acme.com', 'api.acme.com:443', 'api.acme.com/v1', 'API.ACME.COM', 'localhost', '*', '*.com.', 'a b.com', '']) {
    refusal(pkg({ ...ok, http: { hosts: [{ host }] } }));
    // Same form as the dictation egress: what one refuses, the other refuses.
    refusal(dictation({
      permissions: ['dictation:engine', 'http:outbound'],
      dictation: { engines: [{ id: 'acme-cloud', runtime: 'page', egress: [host] }] },
    }));
  }
  refusal(pkg({ ...ok, http: { hosts: [] } }));
  refusal(pkg({ ...ok, http: { hosts: [{ host: 'api.acme.com' }, { host: 'api.acme.com' }] } }));
});

// --- Mascot packs (API 15): the ids in the manifest, the drawing in `mascot.parts`.

function mascotPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return pkg({
    kind: 'behavior',
    client: { slots: ['mascot.parts'] },
    mascot: { acc: ['cap', 'scarf'], color: ['midnight'], eyes: ['sparkle'] },
    ...overrides,
  });
}

test('mascot: a pack declares its parts by look field', () => {
  const res = readManifest(mascotPack());
  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.deepEqual(res.manifest.mascot, { acc: ['cap', 'scarf'], color: ['midnight'], eyes: ['sparkle'] });
});

test('mascot: ids without the slot that draws them, or the slot without ids, are refused', () => {
  assert.match(refusal(mascotPack({ client: { slots: [] } })), /does not name `mascot\.parts`/);
  assert.match(refusal(mascotPack({ client: undefined })), /does not name `mascot\.parts`/);
  assert.match(refusal(pkg({ client: { slots: ['mascot.parts'] } })), /no `mascot` block/);
});

test('mascot: a bad slug, a duplicate or an empty block is refused', () => {
  assert.match(refusal(mascotPack({ mascot: { acc: ['Cap'] } })), /invalid mascot part/);
  assert.match(refusal(mascotPack({ mascot: { acc: ['acme:cap'] } })), /invalid mascot part/);
  assert.match(refusal(mascotPack({ mascot: { acc: ['-cap'] } })), /invalid mascot part/);
  assert.match(refusal(mascotPack({ mascot: { acc: ['cap', 'cap'] } })), /duplicate mascot part/);
  assert.match(refusal(mascotPack({ mascot: {} })), /at least one part/);
  assert.match(refusal(mascotPack({ mascot: { acc: Array.from({ length: 33 }, (_, i) => `p${i}`) } })), /mascot/);
});

test('mascot: needs the API that knows it', () => {
  assert.match(refusal(mascotPack({ apiVersion: 14 })), /`mascot` needs `apiVersion: 15`/);
});

test('`root` outside a layout is refused, whatever the other kind', () => {
  // `root` is the whole interface: a non-layout naming it would replace the
  // shell for everyone, with no choice in the appearance settings.
  for (const extra of [
    { kind: 'behavior' },
    { kind: 'widget', client: { slots: ['cockpit.widget', 'root'] } },
    { kind: 'page', route: '/acme' },
    { kind: 'overlay', client: { slots: ['overlay', 'root'] } },
    { kind: 'theme', client: { slots: ['theme', 'root'] } },
  ]) {
    const res = readManifest(pkg({ client: { slots: ['root'] }, ...extra }));
    assert.ok(!res.ok, JSON.stringify(extra));
    assert.equal(res.code, 'manifest');
    assert.match(res.message, /`client\.slots` names `root` but `kind` is not `layout`/);
  }
  const layout = readManifest(pkg({ kind: ['layout', 'widget'], client: { slots: ['root', 'cockpit.widget'] } }));
  assert.ok(layout.ok, layout.ok ? '' : layout.message);
});
