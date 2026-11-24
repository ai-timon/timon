/**
 * The plugin contract (`plugins/contract/`) is written by hand, so the daemon can
 * change without it: a field added to a schema, a value to a constant list. Where
 * a contract type has a twin in the implementation, a guard proves both are the
 * same type, `Assert<Equals<…>>` (`type-equality.ts`): identity, so a change on
 * either side turns `tsc` red (TODO #512, volet 4). This test makes the guard
 * mandatory rather than remembered.
 *
 * How a twin is found:
 *   - by name: a leaf exports a type or a constant, and a module outside
 *     `contract/` declares its own of the same name (`TaskType` in `db.ts`,
 *     `PluginManifest` in `manifest.ts`). Found mechanically: a new one without
 *     a guard fails here;
 *   - by derivation: the implementation has no type of that name, only what it is
 *     derived from (`typeof PLUGIN_TASK_EVENT_KINDS[number]`, the `ReturnType` of a
 *     function). Nothing can tell those apart from an unrelated type, so they are
 *     pinned in `DERIVED_TWINS`: a guard that disappears fails here, a new
 *     derivation is added by hand.
 *
 * Reading is syntactic: a guard names the contract type through an import of the
 * leaf that declares it, and its twin through its own declaration or an import
 * of the module that declares it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const SRC = resolve(import.meta.dirname, '..');
const CONTRACT = join(import.meta.dirname, 'contract');
const rel = (p: string): string => relative(SRC, p).split('\\').join('/');

/**
 * Contract types whose twin is derived, not declared under the same name, and
 * the module whose guard proves them. Adding a derivation is adding it here.
 */
const DERIVED_TWINS: Record<string, string> = {
  PluginAgentEventKind: 'plugins/agent-events.ts',
  PluginAgentAvatarMode: 'agent-look.ts',
  PluginAgentLook: 'agent-look.ts',
  PluginAutomationEventKind: 'plugins/automation-event-hub.ts',
  PluginBackendCatalog: 'plugins-bundled/backends/account-routes.ts',
  PluginBrowserAnnotationDetail: 'browser-annotations.ts',
  PluginBrowserAnnotationEventKind: 'plugins/browser-annotation-events.ts',
  PluginBrowserRecordingEventKind: 'plugins/browser-recording-events.ts',
  PluginMemoryEventKind: 'memory-rule-events.ts',
  PluginMissionEventKind: 'plugins/mission-events.ts',
  PluginProjectEventKind: 'plugins/project-events.ts',
  PluginQuestionEventKind: 'plugins/question-events.ts',
  PluginTaskEventKind: 'plugins/task-events.ts',
  PluginTodoEventKind: 'plugins/todo-events.ts',
  PluginUiDocumentEventKind: 'plugins/ui-document-events.ts',
  SeriesPlanBranch: 'series-plan.ts',
  SeriesPlanFinish: 'series-plan.ts',
};

/** Every non-test TypeScript source of the daemon. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const exported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Top-level names a module declares itself (not imports, not re-exports), with whether they are exported. */
function ownDeclarations(source: ts.SourceFile): Map<string, boolean> {
  const names = new Map<string, boolean>();
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      if (statement.name) names.set(statement.name.text, exported(statement));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.set(declaration.name.text, exported(statement));
      }
    }
  }
  return names;
}

/** `name` as `module:name`, the module being where it is declared (as far as the file says). */
type Ref = string;

/** What each local name of a module refers to: its own declaration, or the module it imports it from. */
function scope(file: string, source: ts.SourceFile): Map<string, Ref> {
  const refs = new Map<string, Ref>();
  for (const name of ownDeclarations(source).keys()) refs.set(name, `${rel(file)}:${name}`);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const target = resolve(dirname(file), specifier).replace(/\.js$/, '.ts');
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || !existsSync(target)) continue;
    for (const element of bindings.elements) {
      refs.set(element.name.text, `${rel(target)}:${(element.propertyName ?? element.name).text}`);
    }
  }
  return refs;
}

/** The names a side of a guard mentions: type references and `typeof` queries, at any depth. */
function mentioned(node: ts.Node, found: string[] = []): string[] {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) found.push(node.typeName.text);
  if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) found.push(node.exprName.text);
  ts.forEachChild(node, (child) => { mentioned(child, found); });
  return found;
}

type Guard = { file: string; sides: [Ref[], Ref[]] };

/** Every `Assert<Equals<A, B>>` of the daemon, each side resolved to what it names. */
function guards(files: readonly string[]): Guard[] {
  const found: Guard[] = [];
  for (const file of files) {
    const source = parse(file);
    if (!source.text.includes('Equals<')) continue;
    const refs = scope(file, source);
    const visit = (node: ts.Node): void => {
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Assert'
        && node.typeArguments?.length === 1) {
        const inner = node.typeArguments[0];
        if (ts.isTypeReferenceNode(inner) && ts.isIdentifier(inner.typeName) && inner.typeName.text === 'Equals'
          && inner.typeArguments?.length === 2) {
          const side = (n: ts.Node): Ref[] => mentioned(n).flatMap((name) => refs.get(name) ?? []);
          found.push({ file: rel(file), sides: [side(inner.typeArguments[0]), side(inner.typeArguments[1])] });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const contractDir = rel(CONTRACT) + '/';
const allSources = sources(SRC);
const leaves = allSources.filter((f) => dirname(f) === CONTRACT);
const implementation = allSources.filter((f) => dirname(f) !== CONTRACT && !f.endsWith('type-equality.ts'));

/** What the leaves export of their own, as `leaf:name`. */
const contractExports = new Map<string, Ref>();
for (const leaf of leaves) {
  for (const [name, isExported] of ownDeclarations(parse(leaf))) if (isExported) contractExports.set(name, `${rel(leaf)}:${name}`);
}

/** Twins by name: a module outside `contract/` declaring its own type or constant of a contract name. */
function namedTwins(): Array<{ contract: Ref; twin: Ref }> {
  const twins: Array<{ contract: Ref; twin: Ref }> = [];
  for (const file of implementation) {
    for (const name of ownDeclarations(parse(file)).keys()) {
      const contract = contractExports.get(name);
      if (contract) twins.push({ contract, twin: `${rel(file)}:${name}` });
    }
  }
  return twins;
}

const allGuards = guards(implementation);
const proves = (guard: Guard, a: Ref, b: Ref): boolean =>
  (guard.sides[0].includes(a) && guard.sides[1].includes(b)) || (guard.sides[0].includes(b) && guard.sides[1].includes(a));

test('every contract type with a twin of the same name is guarded with Assert<Equals<…>>', () => {
  const twins = namedTwins();
  assert.ok(twins.length >= 20, `the twin scan found only ${twins.length}: it no longer reads the sources`);
  const unguarded = twins.filter(({ contract, twin }) => !allGuards.some((guard) => proves(guard, contract, twin)));
  assert.deepEqual(unguarded.map(({ contract, twin }) => `${twin} ↔ ${contract}`), [],
    'a contract type has a twin in the daemon and nothing proves they agree: beside the twin, import the contract type from its leaf and add `type _XMatchesContract = Assert<Equals<X, ContractX>>` (type-equality.ts)');
});

test('every derived twin keeps its guard', () => {
  const lost = Object.entries(DERIVED_TWINS).filter(([name, file]) => {
    const contract = contractExports.get(name);
    if (!contract) return true;
    return !allGuards.some((guard) => guard.file === file && guard.sides.some((side) => side.includes(contract)));
  });
  assert.deepEqual(lost.map(([name, file]) => `${name} (${file})`), [],
    'a pinned derived twin lost its guard, or its contract type moved: restore the guard, or update DERIVED_TWINS if the type was renamed or removed');
});

test('every guard of the daemon names a contract type on one side and its twin on the other', () => {
  const orphans = allGuards.filter((guard) => {
    const contractSide = guard.sides.findIndex((side) => side.some((ref) => ref.startsWith(contractDir)));
    return contractSide === -1 || guard.sides[1 - contractSide].length === 0;
  });
  assert.deepEqual(orphans.map((guard) => `${guard.file}: ${guard.sides.map((s) => s.join(' ')).join(' ≡ ')}`), [],
    'a guard that names no contract type (or whose contract type is imported through another module) proves nothing this test can account for');
});

test('the scan sees every guard of a derived twin as such', () => {
  const named = new Set(namedTwins().map(({ contract }) => contract));
  const derived = new Set<string>();
  for (const guard of allGuards) {
    for (const ref of guard.sides.flat()) if (ref.startsWith(contractDir) && !named.has(ref)) derived.add(ref.slice(ref.lastIndexOf(':') + 1));
  }
  assert.deepEqual([...derived].sort(), Object.keys(DERIVED_TWINS).sort(),
    'the derived twins the guards prove differ from DERIVED_TWINS: pin a new one so its removal is caught (a lost one is named by the test above)');
});
