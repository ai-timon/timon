/**
 * The published half of the SDK (`@timon-ai/sdk/provider`, `/testing`) re-exports
 * modules that live in the daemon's tree. That is only safe while every module it
 * reaches is a LEAF: no database, no host adapter, no settings, no license. One
 * stray import (a helper that reads `paths.ts`, a type taken from `agent.ts`)
 * would drag the daemon into a third-party plugin — executing `paths.ts` at load
 * time, or shipping `license/` in the package — and nothing would say so.
 *
 * So the closure of both entry points is pinned by name. Adding a module to it is
 * a decision: read it, then add it here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const ENTRIES = ['packages/sdk/src/provider.ts', 'packages/sdk/src/testing.ts'];

/** Every module the two entry points reach, with who pulled it in. */
function closure(): { files: Map<string, string | null>; bare: Map<string, string>; unresolved: string[] } {
  const files = new Map<string, string | null>();
  const bare = new Map<string, string>();
  const unresolved: string[] = [];
  const queue = ENTRIES.map((entry) => resolve(REPO, entry));
  for (const entry of queue) files.set(entry, null);
  while (queue.length) {
    const file = queue.shift()!;
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName } of importedFiles) {
      if (!fileName.startsWith('.')) { bare.set(fileName, file); continue; }
      let target = resolve(dirname(file), fileName).replace(/\.js$/, '.ts');
      if (!existsSync(target)) {
        const index = resolve(dirname(file), fileName, 'index.ts');
        if (existsSync(index)) target = index; else { unresolved.push(`${fileName} from ${relative(REPO, file)}`); continue; }
      }
      if (!files.has(target)) { files.set(target, file); queue.push(target); }
    }
  }
  return { files, bare, unresolved };
}

const rel = (p: string): string => relative(REPO, p).split('\\').join('/');

/** What the published SDK may be made of. */
const ALLOWED = new Set([
  'packages/sdk/src/provider.ts',
  'packages/sdk/src/testing.ts',
  'packages/sdk/src/dictation.ts',
  'packages/sdk/src/product-credential-dirs.ts',
  'packages/sdk/src/testing/bind.ts',
  'packages/sdk/src/testing/context.ts',
  'packages/sdk/src/testing/dictation.ts',
  'packages/sdk/src/testing/fake-cli.ts',
  'packages/sdk/src/testing/hostile.ts',
  'packages/sdk/src/testing/index.ts',
  'packages/sdk/src/testing/acp-checks.ts',
  'packages/sdk/src/testing/line-checks.ts',
  'packages/sdk/src/testing/remote-checks.ts',
  'packages/sdk/src/testing/runtime.ts',
  'packages/sdk/src/testing/transcript.ts',
  'packages/sdk/src/testing/types.ts',
  'orchestrator/src/ask-mcp.ts',
  'orchestrator/src/rate-limit.ts',
  'orchestrator/src/secrets/redact.ts',
  'orchestrator/src/backends/account-usage.ts',
  'orchestrator/src/backends/acp/auth.ts',
  'orchestrator/src/backends/acp/conversation-transport.ts',
  'orchestrator/src/backends/acp/driver.ts',
  'orchestrator/src/backends/acp/events.ts',
  'orchestrator/src/backends/acp/extensions.ts',
  'orchestrator/src/backends/acp/models.ts',
  'orchestrator/src/backends/acp/provider.ts',
  'orchestrator/src/backends/acp/transport.ts',
  'orchestrator/src/backends/acp/wire.ts',
  'orchestrator/src/backends/catalog-model.ts',
  'orchestrator/src/backends/session-questions.ts',
  'orchestrator/src/backends/codecs/acp-rpc.ts',
  'orchestrator/src/backends/codecs/events.ts',
  'orchestrator/src/backends/codecs/json-lines.ts',
  'orchestrator/src/backends/codecs/stream-json.ts',
  'orchestrator/src/backends/codex-mcp-approval.ts',
  'orchestrator/src/backends/command-policy.ts',
  'orchestrator/src/backends/credential-home-dirs.ts',
  'orchestrator/src/backends/dialect-check.ts',
  'orchestrator/src/backends/engine/definition.ts',
  'orchestrator/src/backends/engine/definition-check.ts',
  'orchestrator/src/backends/engine/driver-brand.ts',
  'orchestrator/src/backends/engine/engine.ts',
  'orchestrator/src/backends/engine/index.ts',
  'orchestrator/src/backends/engine/legacy.ts',
  'orchestrator/src/backends/engine/native.ts',
  'orchestrator/src/backends/engine/line-splitter.ts',
  'orchestrator/src/backends/engine/lines-driver.ts',
  'orchestrator/src/backends/mcp-paths.ts',
  'orchestrator/src/backends/mcp-preapproved.ts',
  'orchestrator/src/backends/mcp-serialize.ts',
  'orchestrator/src/backends/model-ids.ts',
  'orchestrator/src/backends/package-cache-env.ts',
  'orchestrator/src/backends/oauth-store.ts',
  'orchestrator/src/backends/permission-models.ts',
  'orchestrator/src/backends/provider-agent-config.ts',
  'orchestrator/src/backends/provider-plugin-context.ts',
  'orchestrator/src/backends/provider-declarations.ts',
  'orchestrator/src/backends/provider-runtime.ts',
  'orchestrator/src/backends/provider-services.ts',
  'orchestrator/src/backends/reasoning-control.ts',
  'orchestrator/src/backends/remote-session.ts',
  'orchestrator/src/backends/scratch-dir.ts',
  'orchestrator/src/backends/span-types.ts',
  'orchestrator/src/backends/stream-json-spans.ts',
  'orchestrator/src/backends/types.ts',
  'orchestrator/src/backends/usage-error.ts',
]);

test('the SDK entry points reach only the allowed leaf modules', () => {
  const { files, unresolved } = closure();
  assert.deepEqual(unresolved, [], 'imports that resolve to no file');
  const reached = [...files.keys()].map(rel).sort();
  const stray = reached.filter((f) => !ALLOWED.has(f));
  assert.deepEqual(
    stray.map((f) => `${f} (pulled in by ${rel(files.get(resolve(REPO, f)) ?? '?')})`), [],
    'a module joined the published SDK. If that is intended, it must be a leaf (no database, host, settings or license): add it to ALLOWED once checked.',
  );
  const missing = [...ALLOWED].filter((f) => !reached.includes(f));
  assert.deepEqual(missing, [], 'allowed modules the SDK no longer reaches: remove them from ALLOWED so the list stays the truth');
});

test('the only packages the SDK imports are node: builtins', () => {
  const { bare } = closure();
  const outside = [...bare].filter(([specifier]) => !specifier.startsWith('node:'));
  assert.deepEqual(outside.map(([s, from]) => `${s} (from ${rel(from)})`), []);
});
