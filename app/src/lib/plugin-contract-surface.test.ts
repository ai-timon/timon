/**
 * Snapshot of the BROWSER half of the SDK contract (§10.15): what
 * `clientContext` hands a plugin, and what `@timon/ui` exports.
 *
 * Same promise as `orchestrator/src/plugins/contract-surface.test.ts`, other
 * side of the wire. A plugin bundle is compiled against these names and
 * imported at runtime by a daemon it was not built with: removing one is a
 * broken plugin in a browser nobody is watching, so removal has to fail here
 * first.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { clientContext } from './plugin-host/loader';
import { UI_KIT } from './plugin-host/ui-kit';
import * as dialog from '../components/ui/dialog';
import * as select from '../components/ui/select';
import { HUD_SURFACE } from '../components/cockpit/hud-surface';
import { NativeViewCover } from './native-view-cover';
import { useOpenInNewWindow } from './open-window';
import { useGlassScope } from '../components/glass-scope';
import { useAgentMenuItem } from '../plugins-client/bots/agent-menu-slot';
import { useProviderPage } from '../components/provider-page/provider-page-context';
import { ProviderSection, ProviderSettingRow } from '../components/provider-page/provider-section';
import { useProviderRow } from '../components/provider-list/provider-row-context';
import { ProviderRow } from '../components/provider-list/provider-row';
import { useJobDialog } from '../plugins-client/kanban/job-dialog-context';
import { usePublishDialog } from '../plugins-client/kanban/publish-dialog-context';
import { GitStackProjectPicker, useGitStackProject } from '../plugins-client/kanban/git-stack-project';
import { useTodoOpener } from '../plugins-client/kanban/todo-opener';
import { useProjectSettings } from '../components/project-settings-slot';
import { useWidgetAttention, useWidgetCount, useWidgetInFront, useWidgetMenu } from '../components/widget-host/widget-self';
import { platformModuleExports } from './plugin-host/platform-modules';
import { PLATFORM_MODULES } from './plugin-host/modules';

type Entry = { type: string; arity?: number; since: number };
type Snapshot = {
  apiVersion: number;
  clientContext: Record<string, Entry>;
  modules: Record<string, Record<string, Entry>>;
};

const SNAPSHOT_FILE = join(process.cwd(), 'src/lib/plugin-host/contract-surface.json');

/**
 * `dispose` is deliberately absent from the snapshot: it belongs to the LOADER
 * (which calls it when unloading), not to the object typed `ClientContext` in
 * the SDK. Freezing it would promise plugins a member they must never call.
 */
const LOADER_ONLY = new Set(['dispose']);

function describeSurface(value: object, prefix = ''): Record<string, { type: string; arity?: number }> {
  const out: Record<string, { type: string; arity?: number }> = {};
  for (const key of Object.keys(value).sort()) {
    if (!prefix && LOADER_ONLY.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const member = (value as Record<string, unknown>)[key];
    if (typeof member === 'function') { out[path] = { type: 'function', arity: member.length }; continue; }
    if (Array.isArray(member)) { out[path] = { type: 'array' }; continue; }
    if (member !== null && typeof member === 'object' && Object.getPrototypeOf(member) === Object.prototype) {
      out[path] = { type: 'object' };
      Object.assign(out, describeSurface(member, path));
      continue;
    }
    out[path] = { type: member === null ? 'null' : typeof member };
  }
  return out;
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as Snapshot;

function actualContext(): Record<string, { type: string; arity?: number }> {
  return describeSurface(clientContext('surface-probe', ['cockpit.widget']));
}

function actualModules(): Record<string, string[]> {
  return Object.fromEntries(
    Object.keys(snapshot.modules).map((module) => [module, platformModuleExports(module)]),
  );
}

if (process.env.TIMON_SURFACE_UPDATE === '1') {
  // Additive only, like the daemon-side updater: a member that vanished still
  // fails, because that is the regression this file exists to catch.
  const context = { ...snapshot.clientContext };
  for (const [path, entry] of Object.entries(actualContext())) {
    if (!(path in context)) context[path] = { ...entry, since: snapshot.apiVersion };
  }
  const modules: Snapshot['modules'] = { ...snapshot.modules };
  for (const [module, names] of Object.entries(actualModules())) {
    const known = { ...(modules[module] ?? {}) };
    for (const name of names) if (!(name in known)) known[name] = { type: 'export', since: snapshot.apiVersion };
    modules[module] = known;
  }
  snapshot.clientContext = Object.fromEntries(Object.entries(context).sort(([a], [b]) => a.localeCompare(b)));
  snapshot.modules = modules;
  writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
}

test('no member of ClientContext disappears or changes shape', () => {
  const actual = actualContext();
  for (const [path, entry] of Object.entries(snapshot.clientContext)) {
    const found = actual[path];
    assert.ok(found, `\`clientCtx.${path}\` has disappeared — every installed plugin compiled against it breaks.`);
    assert.equal(found.type, entry.type, `\`clientCtx.${path}\` changed type`);
    assert.equal(found.arity, entry.arity, `\`clientCtx.${path}\` changed arity`);
  }
});

test('a member added to ClientContext is recorded with the version that introduced it', () => {
  const undocumented = Object.keys(actualContext()).filter((path) => !(path in snapshot.clientContext));
  assert.deepEqual(undocumented, [],
    'add these members to `src/lib/plugin-host/contract-surface.json`, and read `docs/SDK-COMPAT.md`');
});

test('no export of a platform module disappears', () => {
  for (const [module, entries] of Object.entries(snapshot.modules)) {
    const names = new Set(platformModuleExports(module));
    for (const name of Object.keys(entries)) {
      assert.ok(names.has(name), `\`${module}\` no longer exports \`${name}\``);
    }
  }
});

test('an export added to a platform module is recorded', () => {
  for (const [module, names] of Object.entries(actualModules())) {
    const known = snapshot.modules[module] ?? {};
    assert.deepEqual(names.filter((name) => !(name in known)), [],
      `record the new exports of \`${module}\` in \`src/lib/plugin-host/contract-surface.json\``);
  }
});

test('every recorded member states the apiVersion that introduced it', () => {
  const entries = [
    ...Object.entries(snapshot.clientContext),
    ...Object.values(snapshot.modules).flatMap((m) => Object.entries(m)),
  ];
  for (const [path, entry] of entries) {
    assert.ok(Number.isInteger(entry.since) && entry.since >= 1 && entry.since <= snapshot.apiVersion,
      `\`${path}\` : \`since\` must be an apiVersion between 1 and ${snapshot.apiVersion}`);
  }
});

test('UI_KIT shares the product dialog, select, cockpit surface and native view cover exports', () => {
  const declarations = readFileSync(join(process.cwd(), '../packages/sdk/src/ui.d.ts'), 'utf8');
  for (const [name, component] of Object.entries({ ...dialog, ...select, HUD_SURFACE, NativeViewCover })) {
    assert.equal(UI_KIT[name as keyof typeof UI_KIT], component, name);
    assert.ok(platformModuleExports('ui.js').includes(name), name);
    assert.ok(declarations.includes(`export const ${name}:`), `SDK declaration for ${name}`);
  }
});

test('V5: UI_KIT opens a page in a new window with the product\'s own hook', () => {
  const declarations = readFileSync(join(process.cwd(), '../packages/sdk/src/ui.d.ts'), 'utf8');
  assert.equal(UI_KIT.useOpenInNewWindow, useOpenInNewWindow);
  assert.ok(platformModuleExports('ui.js').includes('useOpenInNewWindow'));
  assert.equal(snapshot.modules['ui.js']?.useOpenInNewWindow?.since, 14);
  assert.ok(declarations.includes('export function useOpenInNewWindow(): ((route?: string) => Promise<boolean>) | null;'));
});

test('UI_KIT tells a widget where the frosted glass sits, with the product\'s own hook', () => {
  const declarations = readFileSync(join(process.cwd(), '../packages/sdk/src/ui.d.ts'), 'utf8');
  assert.equal(UI_KIT.useGlassScope, useGlassScope);
  assert.ok(platformModuleExports('ui.js').includes('useGlassScope'));
  assert.equal(snapshot.modules['ui.js']?.useGlassScope?.since, 15);
  assert.ok(declarations.includes("export function useGlassScope(): 'island' | 'widgets' | 'both' | null;"));
});

test('UI_KIT hands an agent menu entry the agent it is rendered for, with the product\'s own hook', () => {
  const declarations = readFileSync(join(process.cwd(), '../packages/sdk/src/ui.d.ts'), 'utf8');
  assert.equal(UI_KIT.useAgentMenuItem, useAgentMenuItem);
  assert.ok(platformModuleExports('ui.js').includes('useAgentMenuItem'));
  assert.equal(snapshot.modules['ui.js']?.useAgentMenuItem?.since, 15);
  assert.ok(declarations.includes('export function useAgentMenuItem(): AgentMenuItem | null;'));
});

test('UI_KIT hands a provider page section the provider on screen, and the frame of the product\'s sections', () => {
  const declarations = readFileSync(join(process.cwd(), '../packages/sdk/src/ui.d.ts'), 'utf8');
  assert.equal(UI_KIT.useProviderPage, useProviderPage);
  assert.equal(UI_KIT.ProviderSection, ProviderSection);
  assert.equal(UI_KIT.ProviderSettingRow, ProviderSettingRow);
  for (const name of ['useProviderPage', 'ProviderSection', 'ProviderSettingRow']) {
    assert.ok(platformModuleExports('ui.js').includes(name), name);
    assert.equal(snapshot.modules['ui.js']?.[name]?.since, 16, name);
  }
  assert.ok(declarations.includes('export function useProviderPage(): {'));
  assert.ok(declarations.includes('export const ProviderSection: PlatformComponent;'));
  assert.ok(declarations.includes('export const ProviderSettingRow: PlatformComponent;'));
});

test('UI_KIT hands a provider row its provider, and the host that paints one', () => {
  const declarations = readFileSync(join(process.cwd(), '../packages/sdk/src/ui.d.ts'), 'utf8');
  assert.equal(UI_KIT.useProviderRow, useProviderRow);
  assert.equal(UI_KIT.ProviderRow, ProviderRow);
  for (const name of ['useProviderRow', 'ProviderRow']) {
    assert.ok(platformModuleExports('ui.js').includes(name), name);
    assert.equal(snapshot.modules['ui.js']?.[name]?.since, 16, name);
  }
  assert.ok(declarations.includes('export function useProviderRow(): {'));
  assert.ok(declarations.includes('export const ProviderRow: PlatformComponent;'));
});

test('the notice cards and the update window open wave 17, after 0.1.8 shipped API 16', () => {
  // A plugin that imports them must declare 17, or a 0.1.8 host would load it
  // and its browser half would die on the missing export.
  assert.ok(snapshot.apiVersion >= 17);
  for (const name of ['useNotices', 'useNotice', 'useUpdateDialog']) {
    assert.equal(snapshot.modules['ui.js']?.[name]?.since, 17, name);
  }
  for (const path of ['notices', 'notices.push', 'notices.remove']) {
    assert.equal(snapshot.clientContext[path]?.since, 17, path);
  }
});

test('the job and Publish on GitHub dialogs join wave 19, still unreleased', () => {
  // 0.1.9 shipped API 17 and 18 is the provider profile folder: a plugin
  // importing these hooks must declare 19.
  const declarations = readFileSync(join(process.cwd(), '../packages/sdk/src/ui.d.ts'), 'utf8');
  assert.ok(snapshot.apiVersion >= 19);
  assert.equal(UI_KIT.useJobDialog, useJobDialog);
  assert.equal(UI_KIT.usePublishDialog, usePublishDialog);
  for (const name of ['useJobDialog', 'usePublishDialog']) {
    assert.ok(platformModuleExports('ui.js').includes(name), name);
    assert.equal(snapshot.modules['ui.js']?.[name]?.since, 19, name);
  }
  assert.ok(declarations.includes('export function useJobDialog(): JobDialogValue | null;'));
  assert.ok(declarations.includes('export function usePublishDialog(): PublishDialogValue | null;'));
});

test('the Git stack\'s project, the TO DO opener and the project settings row join wave 19, still unreleased', () => {
  // A host 18 exports none of them: the github-issues plugin's browser half,
  // which reads all four, declares 19.
  const declarations = readFileSync(join(process.cwd(), '../packages/sdk/src/ui.d.ts'), 'utf8');
  assert.equal(snapshot.apiVersion, 19);
  assert.equal(UI_KIT.useGitStackProject, useGitStackProject);
  assert.equal(UI_KIT.GitStackProjectPicker, GitStackProjectPicker);
  assert.equal(UI_KIT.useTodoOpener, useTodoOpener);
  assert.equal(UI_KIT.useProjectSettings, useProjectSettings);
  for (const name of ['useGitStackProject', 'GitStackProjectPicker', 'useTodoOpener', 'useProjectSettings']) {
    assert.ok(platformModuleExports('ui.js').includes(name), name);
    assert.equal(snapshot.modules['ui.js']?.[name]?.since, 19, name);
  }
  assert.ok(declarations.includes('export function useGitStackProject(): GitStackProject;'));
  assert.ok(declarations.includes('export const GitStackProjectPicker: PlatformComponent;'));
  assert.ok(declarations.includes('export function useTodoOpener(): TodoOpener;'));
  assert.ok(declarations.includes('export function useProjectSettings(): ProjectSettingsValue | null;'));
});

test('a widget\'s tab count, dot, menu and front state join wave 19, still unreleased', () => {
  // The Issues tab of the Git stack is a third party's (github-issues): its
  // count and its reload button need the hooks the product's own tabs read.
  assert.equal(UI_KIT.useWidgetCount, useWidgetCount);
  assert.equal(UI_KIT.useWidgetAttention, useWidgetAttention);
  assert.equal(UI_KIT.useWidgetMenu, useWidgetMenu);
  assert.equal(UI_KIT.useWidgetInFront, useWidgetInFront);
  for (const name of ['useWidgetCount', 'useWidgetAttention', 'useWidgetMenu', 'useWidgetInFront']) {
    assert.ok(platformModuleExports('ui.js').includes(name), name);
    assert.equal(snapshot.modules['ui.js']?.[name]?.since, 19, name);
  }
  const declarations = readFileSync(join(process.cwd(), '../packages/sdk/src/ui.d.ts'), 'utf8');
  assert.ok(declarations.includes('export function useWidgetCount(count: number | null | undefined): boolean;'));
  assert.ok(declarations.includes('export function useWidgetAttention(label: string | null | undefined): boolean;'));
  assert.ok(declarations.includes('export function useWidgetMenu(items: readonly WidgetMenuItem[]): boolean;'));
  assert.ok(declarations.includes('export function useWidgetInFront(): boolean;'));
});

/** Platform names a client bundle imports, per module file (`ui.js`, …). */
function platformImports(source: string): Map<string, string[]> {
  const byModule = new Map<string, string[]>();
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const url = (PLATFORM_MODULES as Record<string, string>)[match[2]!];
    if (!url) continue;
    const module = url.slice(url.lastIndexOf('/') + 1);
    const clause = match[1]!;
    const names: string[] = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (name) names.push(name);
      }
    }
    if (/^[\w$]+/.test(clause.trim()) && !clause.trim().startsWith('*')) names.push('default');
    byModule.set(module, [...(byModule.get(module) ?? []), ...names]);
  }
  return byModule;
}

test('an example plugin declares at least the apiVersion of every platform export it imports', () => {
  // The manifest's apiVersion is what an older daemon checks before loading
  // the plugin: declaring less than an import needs lets it load, then the
  // browser half dies on a missing export nobody sees.
  const examples = join(process.cwd(), '../examples');
  const checked: string[] = [];
  for (const dir of readdirSync(examples)) {
    const manifestFile = join(examples, dir, 'package.json');
    if (!existsSync(manifestFile)) continue;
    const pkg = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
      exports?: Record<string, string>;
      timon?: { apiVersion?: number };
    };
    const client = pkg.exports?.['./client'];
    const declared = pkg.timon?.apiVersion;
    if (!client || typeof declared !== 'number') continue;
    const source = readFileSync(join(examples, dir, client), 'utf8');
    for (const [module, names] of platformImports(source)) {
      for (const name of names) {
        const entry = snapshot.modules[module]?.[name];
        assert.ok(entry, `${dir} imports \`${name}\` from \`${module}\`, which the platform does not export`);
        assert.ok(entry.since <= declared,
          `${dir} declares apiVersion ${declared} but imports \`${name}\` (since ${entry.since}) — raise its minimum`);
      }
    }
    checked.push(dir);
  }
  assert.ok(checked.includes('plugin-quota-monitor'), 'the quota monitor is checked');
});
