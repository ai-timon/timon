/**
 * The adapter from a NATIVE `ProviderDefinition` — what a plugin registers with
 * `ctx.provider.registerProvider` — to the `Dialect` the registry and the runner
 * already speak. It is `fromLegacy` read the other way round, and for the same
 * reason: the runner is not touched (docs/PROVIDERS-SDK.md § 7.1, "Phase 1"), so
 * everything downstream — profiles, the catalogue, the dispatcher, the reaper —
 * sees a dialect and stays as it was.
 *
 * Mapping, the inverse of `legacy.ts`:
 *   - `remote` transport                  → `RemoteDialect`;
 *   - `stdio-persistent` + `driver` codec → `persistentProcess`, `openSession`;
 *   - `stdio-persistent` + `lines` codec  → `persistentProcess`, `parseLine`…;
 *   - `process-per-turn` + `lines`        → one process per turn;
 *   - `launch`                            → `buildSpawn`;
 *   - the process's pipes are `SessionStdio`, so `writeUserInput(proc)` of the
 *     dialect hands the codec `{ stdin, stdout }` and never the `ChildProcess`.
 *
 * A definition is checked (`definitionProblems`) BEFORE it is adapted; the
 * adapter assumes a coherent one.
 */

import { extractInitSessionId } from '../codecs/events.js';
import { streamJsonSpans } from '../stream-json-spans.js';
import type { AnyDialect, Dialect, RemoteDialect } from '../types.js';
import { isRemoteDefinition, type NativeProviderDefinition } from './definition.js';

export function dialectFromDefinition(def: NativeProviderDefinition): AnyDialect {
  const declares = def.declares ?? {};
  const spansDeclared = declares.spans ?? def.spans;
  const spans = spansDeclared === 'stream-json' ? streamJsonSpans : spansDeclared;

  const common = {
    id: def.id,
    sessionResumable: def.session.resumable,
    sessionStore: def.session.store,
    permissionModel: def.permission.model,
    rateLimitReporting: def.limits.reporting,
    hostedConnectors: declares.hostedConnectors ?? false,
    ...(declares.browserToolsHint ? { browserToolsHint: declares.browserToolsHint } : {}),
    ...(declares.permissionsHint ? { permissionsHint: declares.permissionsHint } : {}),
    ...(def.reasoning ? { thinkingControls: def.reasoning.controls } : {}),
    ...(def.permission.appliesMode === true ? { appliesPermissionMode: true } : {}),
    ...(def.permission.byAgent !== undefined && def.permission.byAgent !== false
      ? { permissionsByAgent: typeof def.permission.byAgent === 'function' ? def.permission.byAgent : () => true }
      : {}),
    ...(def.usage
      ? { accountUsage: (...[profile, options]: Parameters<NonNullable<Dialect['accountUsage']>>) => def.usage!.probe(profile, options) }
      : {}),
    ...(def.models ? { discoverModels: (profile: Parameters<NonNullable<Dialect['discoverModels']>>[0]) => def.models!.discover(profile) } : {}),
    ...(spans ? { spans } : {}),
    ...(def.lifecycle?.dispose ? { dispose: def.lifecycle.dispose } : {}),
    ...(def.lifecycle?.enrich ? { enrichEvent: def.lifecycle.enrich } : {}),
    ...(declares.capabilities ? { capabilities: declares.capabilities } : {}),
    ...(declares.localEnv ? { localEnv: declares.localEnv } : {}),
    ...(def.session.compact ? { nativeCompact: { command: def.session.compact.command } } : {}),
    ...(def.session.rewind ? { nativeRewind: def.session.rewind } : {}),
  };

  if (isRemoteDefinition(def)) {
    const remote: RemoteDialect = {
      ...common,
      transport: 'remote',
      extractSessionId: def.codec.extractSessionId ?? extractInitSessionId,
      openSession: (args) => def.codec.openSession(args),
    };
    return remote;
  }

  const persistent = def.transport.kind === 'stdio-persistent';
  const names = declares.binary?.names ?? [];
  const base = {
    ...common,
    persistentProcess: persistent,
    // The only two coherent combinations (`dialectProblems`): a process that lives for the whole mission ends it.
    finishMissionOnExit: persistent,
    defaultCmd: names[0] ?? def.id,
    buildSpawn: (opts: Parameters<Dialect['buildSpawn']>[0], profile: Parameters<Dialect['buildSpawn']>[1]) => def.launch(opts, profile),
    ...(def.session.notFound ? { isSessionNotFoundError: def.session.notFound } : {}),
    ...(def.session.maxPromptBytes !== undefined ? { maxPromptBytes: def.session.maxPromptBytes } : {}),
    ...(def.session.setModel
      ? { setModel: (proc: Parameters<NonNullable<Dialect['setModel']>>[0], model: string) => def.session.setModel!({ stdin: proc.stdin, stdout: proc.stdout }, model) }
      : {}),
  };

  if (def.codec.kind === 'driver') {
    const { openSession } = def.codec;
    const dialect: Dialect = {
      ...base,
      writeUserInput: () => { /* the driver owns the pipes */ },
      parseLine: () => [],
      extractSessionId: def.codec.extractSessionId ?? extractInitSessionId,
      openSession: (args) => openSession(args),
    };
    return dialect;
  }

  const { codec } = def;
  const dialect: Dialect = {
    ...base,
    // One process per turn: the next turn is a new launch, nothing to write.
    writeUserInput: persistent
      ? (proc, text, images) => codec.writeUserInput({ stdin: proc.stdin, stdout: proc.stdout }, text, images)
      : () => { /* a new launch carries the next turn */ },
    parseLine: (line) => codec.parseLine(line),
    extractSessionId: (ev) => codec.extractSessionId(ev),
  };
  return dialect;
}
