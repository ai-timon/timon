/**
 * A Radix menu that opens a dialog from one of its items must be non-modal. A
 * modal menu still closing while the dialog mounts leaves `pointer-events: none`
 * on <body>: nothing on screen, and no click works any more (TIM-0035 on the
 * context gauge, TIM-0010 on the teams menu, then the machine switcher and the
 * appearance menu, TODO #540; any dialog since TODO #604).
 *
 * Static on purpose: every such menu would need its own jsdom harness, and a
 * new one is exactly the menu nobody thinks of testing.
 *
 * Syntax only, no type checker (a full program costs tens of seconds). A handler
 * read from a context or a data object (`host.onRemove()`, `onSelect={item.run}`)
 * is followed by the NAME of the field, to the object literals that provide one: a
 * homonym can report a menu that is innocent, and the answer is the same
 * `modal={false}`. What stays out of sight: a field name too common to mean anything
 * (`MAX_FIELD_PROVIDERS`), a prop spread from an object literal, and an opener hiding
 * behind a global store that `OPENERS` does not name.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Imperative dialog openers: they show no `<Dialog open={…}>` at the call site. */
const OPENERS = ['openSettingsFromAnywhere', 'settingsHref', 'openAgentEditor', 'askToSaveDocument'];
const HANDLERS = new Set(['onSelect', 'onClick', 'onCheckedChange', 'onValueChange']);
const DIALOG_NAME = /(?:Dialog|Sheet|Modal)$/;
const DIALOG_MODULE = /^(?:@radix-ui\/react-(?:alert-)?dialog|.*\/ui\/(?:dialog|sheet))$/;
const MENU_MODULE = /^@radix-ui\/react-(?:dropdown-menu|context-menu)$/;
const UI_MENU_MODULE = /\/ui\/dropdown-menu$/;
/** `open`, `close`, `update`… sit on dozens of unrelated objects: following them reports everything. */
const MAX_FIELD_PROVIDERS = 4;

type Fn = ts.FunctionLikeDeclaration;
type Jsx = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
type Finding = { file: string; menu: string; why: string };

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function isJsx(node: ts.Node): node is Jsx {
  return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
}

function jsxAttr(el: Jsx, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

function attrValue(attr: ts.JsxAttribute | undefined): ts.Expression | undefined {
  const value = attr?.initializer;
  return value && ts.isJsxExpression(value) ? value.expression : undefined;
}

function enclosingFn(node: ts.Node): Fn | undefined {
  for (let up = node.parent; up; up = up.parent) if (ts.isFunctionLike(up) && 'body' in up) return up as Fn;
  return undefined;
}

function mentions(node: ts.Node, names: Set<string>): boolean {
  let found = false;
  walk(node, (n) => { if (ts.isIdentifier(n) && names.has(n.text)) found = true; });
  return found;
}

/** The function behind a declaration's initializer: `() => …`, `useCallback(() => …, [])`, `memo(function …)`. */
function fnOf(init: ts.Expression | undefined): Fn | undefined {
  if (!init) return undefined;
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  if (ts.isCallExpression(init) && /^(?:useCallback|memo|forwardRef|React\.memo|React\.forwardRef)$/.test(init.expression.getText())) {
    return fnOf(init.arguments[0]);
  }
  return undefined;
}

function componentName(fn: Fn): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  for (let up: ts.Node = fn.parent; up; up = up.parent) {
    if (ts.isVariableDeclaration(up)) return up.name.getText();
    if (!ts.isCallExpression(up) && !ts.isParenthesizedExpression(up)) return undefined;
  }
  return undefined;
}

/** What a name is, read from the scope around the reference. */
type Binding =
  | { kind: 'fn'; fn: Fn }
  | { kind: 'state-setter'; state: string; owner: Fn }
  | { kind: 'prop'; owner: Fn; prop: string }
  | { kind: 'settings-open' }
  | { kind: 'settings-nav' }
  | { kind: 'field'; name: string }
  | { kind: 'value' }
  | { kind: 'import'; module: string; imported: string };

function bindingOfDeclaration(decl: ts.VariableDeclaration, name: string): Binding | null {
  const init = decl.initializer;
  const hook = init && ts.isCallExpression(init) ? init.expression.getText() : '';
  if (ts.isIdentifier(decl.name)) {
    if (decl.name.text !== name) return null;
    if (hook === 'useSettingsNavigation') return { kind: 'settings-nav' };
    const fn = fnOf(init);
    return fn ? { kind: 'fn', fn } : { kind: 'value' };
  }
  if (ts.isArrayBindingPattern(decl.name)) {
    const [state, setter] = decl.name.elements;
    const declares = decl.name.elements.some((e) => ts.isBindingElement(e) && e.name.getText() === name);
    if (!declares) return null;
    const owner = enclosingFn(decl);
    if (/^(?:React\.)?useState$/.test(hook) && setter && ts.isBindingElement(setter) && setter.name.getText() === name
      && state && ts.isBindingElement(state) && owner) return { kind: 'state-setter', state: state.name.getText(), owner };
    return { kind: 'value' };
  }
  for (const element of decl.name.elements) {
    if (element.name.getText() !== name) continue;
    const key = (element.propertyName ?? element.name).getText();
    if (hook === 'useSettingsNavigation' && key === 'open') return { kind: 'settings-open' };
    // `const { onPick } = props;`, or out of a `...rest` of the props.
    const source = init && ts.isIdentifier(init) ? resolve(decl, init.text) : null;
    if (source?.kind === 'prop') return { kind: 'prop', owner: source.owner, prop: key };
    return { kind: 'field', name: key };
  }
  return null;
}

/** Climbs the scopes of `from`; the first declaration of `name` wins, as in the language. */
function resolve(from: ts.Node, name: string): Binding | null {
  for (let scope = from.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const first = scope.parameters[0];
      for (const param of scope.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === name) return param === first && 'body' in scope ? { kind: 'prop', owner: scope as Fn, prop: '' } : null;
        if (ts.isObjectBindingPattern(param.name)) {
          for (const element of param.name.elements) {
            if (element.name.getText() !== name) continue;
            return param === first && 'body' in scope ? { kind: 'prop', owner: scope as Fn, prop: (element.propertyName ?? element.name).getText() } : null;
          }
        }
      }
    }
    const statements = ts.isBlock(scope) || ts.isSourceFile(scope) ? scope.statements : null;
    for (const statement of statements ?? []) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { kind: 'fn', fn: statement };
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          const binding = bindingOfDeclaration(decl, name);
          if (binding) return binding;
        }
      }
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const module = statement.moduleSpecifier.text;
        const clause = statement.importClause;
        if (clause?.name?.text === name) return { kind: 'import', module, imported: 'default' };
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) return { kind: 'import', module, imported: '*' };
        if (bindings && ts.isNamedImports(bindings)) {
          for (const spec of bindings.elements) {
            if (spec.name.text === name) return { kind: 'import', module, imported: (spec.propertyName ?? spec.name).text };
          }
        }
      }
    }
  }
  return null;
}

/** The source tree the scan reads: real files, or fixtures in the tests below. */
type Tree = { files: string[]; read: (path: string) => string | null };

function realTree(root: string, overlay: Map<string, string> = new Map()): Tree {
  const list = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return list(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
  const texts = new Map<string, string | null>();
  return {
    files: list(root),
    read: (path) => {
      if (overlay.has(path)) return overlay.get(path)!;
      if (!texts.has(path)) texts.set(path, existsSync(path) ? readFileSync(path, 'utf8') : null);
      return texts.get(path)!;
    },
  };
}

/** By content, so that the scans of the counter-proof only parse the file they change. */
const PARSED = new Map<string, ts.SourceFile>();

function scan(tree: Tree, root: string): { offenders: Finding[]; modalMenus: number; nonModalMenus: number } {
  const parse = (path: string): ts.SourceFile | null => {
    const text = tree.read(path);
    if (text === null) return null;
    const key = `${path}\0${text}`;
    let sf = PARSED.get(key);
    if (!sf) {
      sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      PARSED.set(key, sf);
    }
    return sf;
  };

  /** `@/x` and relative specifiers, to the file that exists. */
  const moduleFile = (from: ts.SourceFile, specifier: string): ts.SourceFile | null => {
    const base = specifier.startsWith('@/') ? join(root, specifier.slice(2))
      : specifier.startsWith('.') ? join(dirname(from.fileName), specifier) : null;
    if (!base) return null;
    for (const path of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
      const sf = parse(path);
      if (sf) return sf;
    }
    return null;
  };

  const exportedFn = (sf: ts.SourceFile, name: string): Fn | undefined => {
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.body && (name === 'default'
        ? statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
        : statement.name?.text === name)) return statement;
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (decl.name.getText() === name) {
            const fn = fnOf(decl.initializer);
            if (fn) return fn;
          }
        }
      }
    }
    return undefined;
  };

  /** The function behind a JSX tag or a callee, in this file or the one it imports. */
  const followFn = (from: ts.Node, name: string): Fn | undefined => {
    const binding = resolve(from, name);
    if (binding?.kind === 'fn') return binding.fn;
    if (binding?.kind === 'import' && binding.imported !== '*') {
      const sf = moduleFile(from.getSourceFile(), binding.module);
      return sf ? exportedFn(sf, binding.imported) : undefined;
    }
    return undefined;
  };

  const tagIs = (el: Jsx, modules: RegExp, named: string[]): boolean => {
    const tag = el.tagName.getText();
    const [head, member] = tag.split('.');
    const binding = resolve(el, head!);
    if (binding?.kind !== 'import' || !modules.test(binding.module)) return false;
    return binding.imported === '*' ? member === 'Root' : named.includes(binding.imported);
  };

  const isMenuRoot = (el: Jsx): boolean => tagIs(el, MENU_MODULE, ['Root']) || tagIs(el, UI_MENU_MODULE, ['DropdownMenu']);
  const isDialogRoot = (el: Jsx): boolean => tagIs(el, DIALOG_MODULE, ['Root', 'Dialog', 'Sheet']);
  const isDialogLike = (el: Jsx): boolean => {
    const tag = el.tagName.getText();
    return isDialogRoot(el) || (/^[A-Z]/.test(tag) && !tag.includes('.') && DIALOG_NAME.test(tag));
  };

  /** A component with another name that takes `open` and hands it to a dialog of its own. */
  const rendersDialog = (el: Jsx): boolean => {
    const fn = followFn(el, el.tagName.getText());
    let found = false;
    if (fn) walk(fn, (n) => { if (isJsx(n) && isDialogLike(n)) found = true; });
    return found;
  };

  /** Does the state behind this setter open a dialog in its component? */
  const stateDrivesDialog = (state: string, owner: Fn): string | null => {
    const names = new Set([state]);
    // Derived values: `const editing = items.find((i) => i.id === editingId)`.
    for (let grew = true; grew;) {
      grew = false;
      walk(owner, (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && !names.has(n.name.text) && n.initializer && !fnOf(n.initializer) && mentions(n.initializer, names)) {
          names.add(n.name.text);
          grew = true;
        }
      });
    }
    let why: string | null = null;
    walk(owner, (n) => {
      if (why || !isJsx(n)) return;
      const tag = n.tagName.getText();
      const open = attrValue(jsxAttr(n, 'open'));
      if (open && mentions(open, names) && (isDialogLike(n) || (/^[A-Z]/.test(tag) && rendersDialog(n)))) {
        why = `state "${state}" opens <${tag}>`;
        return;
      }
      if (!isDialogLike(n)) return;
      for (let up: ts.Node = n.parent; up && up !== owner; up = up.parent) {
        const test = ts.isConditionalExpression(up) ? up.condition
          : ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? up.left : null;
        if (test && mentions(test, names)) {
          why = `state "${state}" mounts <${tag}>`;
          return;
        }
      }
    });
    return why;
  };

  const closesOnly = (call: ts.CallExpression): boolean => {
    const arg = call.arguments[0];
    return arg !== undefined && (arg.kind === ts.SyntaxKind.FalseKeyword || arg.kind === ts.SyntaxKind.NullKeyword);
  };

  const seen = new Set<ts.Node>();

  const usagesOf = (component: string, prop: string, asked = new Set<string>()): ts.Expression[] => {
    const out: ts.Expression[] = [];
    if (asked.has(component)) return out;
    asked.add(component);
    for (const path of tree.files) {
      if (!tree.read(path)?.includes(`<${component}`)) continue;
      const sf = parse(path);
      if (!sf) continue;
      walk(sf, (n) => {
        if (!isJsx(n) || n.tagName.getText() !== component) return;
        const value = attrValue(jsxAttr(n, prop));
        if (value) out.push(value);
        // Passed along untouched: `function Menu({ a, ...actions }) { <Panel {...actions} /> }`.
        for (const attr of n.attributes.properties) {
          if (value || !ts.isJsxSpreadAttribute(attr) || !ts.isIdentifier(attr.expression)) continue;
          const spread = resolve(attr, attr.expression.text);
          const outer = spread?.kind === 'prop' ? componentName(spread.owner) : undefined;
          if (outer) out.push(...usagesOf(outer, prop, asked));
        }
      });
    }
    return out;
  };

  /** Every object literal field of the tree, by name: what a context or a data object can hold. */
  let fields: Map<string, ts.Node[]> | null = null;
  const fieldValues = (name: string): ts.Node[] => {
    if (!fields) {
      const index = new Map<string, ts.Node[]>();
      const add = (key: string, value: ts.Node): void => {
        const values = index.get(key);
        if (values) values.push(value);
        else index.set(key, [value]);
      };
      for (const path of tree.files) {
        const sf = parse(path);
        if (!sf) continue;
        walk(sf, (n) => {
          if (ts.isShorthandPropertyAssignment(n)) add(n.name.text, n.name);
          else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) add(n.name.text, n.initializer);
          else if (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent) && ts.isIdentifier(n.name)) add(n.name.text, n);
        });
      }
      fields = index;
    }
    return fields.get(name) ?? [];
  };

  const opensThroughField = (name: string): string | null => {
    const values = fieldValues(name);
    if (values.length > MAX_FIELD_PROVIDERS) return null;
    for (const value of values) {
      const why = opensFrom(value);
      if (why) return why;
    }
    return null;
  };

  /** `object.member`, called or handed over. A global (`window.open`) or a module (`toast.error`) is no such field. */
  const opensByMember = (at: ts.Node, object: string, member: string): string | null => {
    const binding = resolve(at, object);
    if (!binding || binding.kind === 'import') return null;
    if (binding.kind === 'settings-nav') return member === 'open' ? 'opens Settings' : null;
    const component = binding.kind === 'prop' && !binding.prop ? componentName(binding.owner) : undefined;
    if (!component) return opensThroughField(member);
    for (const value of usagesOf(component, member)) {
      const why = opensFrom(value);
      if (why) return why;
    }
    return null;
  };

  /** A name in callee or handler position: what running it leads to. */
  const opensByName = (at: ts.Node, name: string, call?: ts.CallExpression): string | null => {
    if (OPENERS.includes(name)) return `calls ${name}()`;
    const binding = resolve(at, name);
    switch (binding?.kind) {
      case 'settings-open':
        return 'opens Settings';
      case 'state-setter':
        return call && closesOnly(call) ? null : stateDrivesDialog(binding.state, binding.owner);
      case 'fn':
        return opensFrom(binding.fn);
      case 'import': {
        const fn = followFn(at, name);
        return fn ? opensFrom(fn) : null;
      }
      case 'field':
        return opensThroughField(binding.name);
      case 'prop': {
        const component = componentName(binding.owner);
        if (!component || !binding.prop) return null;
        for (const value of usagesOf(component, binding.prop)) {
          const why = opensFrom(value);
          if (why) return why;
        }
        return null;
      }
      default:
        return null;
    }
  };

  /** Everything a handler expression (or function body) can run. */
  function opensFrom(node: ts.Node): string | null {
    if (seen.has(node)) return null;
    seen.add(node);
    if (ts.isIdentifier(node)) return opensByName(node, node.text);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) return opensByMember(node, node.expression.text, node.name.text);
    let why: string | null = null;
    walk(node, (n) => {
      if (why || !ts.isCallExpression(n)) return;
      const callee = n.expression;
      if (ts.isIdentifier(callee)) {
        why = opensByName(callee, callee.text, n);
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        why = opensByMember(callee, callee.expression.text, callee.name.text);
      }
      // Handed over rather than called: `.then(setDone)`, `startTransition(run)`.
      for (const arg of n.arguments) if (!why && ts.isIdentifier(arg)) why = opensByName(arg, arg.text);
    });
    return why;
  }

  /** Handlers of the elements under a menu, inside its local and imported components too. */
  const menuOpens = (node: ts.Node): string | null => {
    if (seen.has(node)) return null;
    seen.add(node);
    if (ts.isJsxElement(node) && /Trigger$/.test(node.openingElement.tagName.getText())) return null;
    let why: string | null = null;
    if (isJsx(node)) {
      const tag = node.tagName.getText();
      if (/DialogTrigger$/.test(tag)) return `mounts <${tag}> inside the menu`;
      for (const prop of node.attributes.properties) {
        if (!why && ts.isJsxAttribute(prop) && HANDLERS.has(prop.name.getText())) {
          const value = attrValue(prop);
          if (value) why = opensFrom(value);
        }
      }
      if (!why && /^[A-Z]/.test(tag) && !tag.includes('.')) {
        const fn = followFn(node, tag);
        if (fn) why = menuOpens(fn);
      }
    }
    ts.forEachChild(node, (child) => { why ??= menuOpens(child); });
    return why;
  };

  const offenders: Finding[] = [];
  let modalMenus = 0;
  let nonModalMenus = 0;
  for (const path of tree.files) {
    const text = tree.read(path);
    if (!text || !/react-(?:dropdown|context)-menu|ui\/dropdown-menu/.test(text)) continue;
    const sf = parse(path);
    if (!sf) continue;
    walk(sf, (n) => {
      if (!ts.isJsxElement(n) || !isMenuRoot(n.openingElement)) return;
      const modal = attrValue(jsxAttr(n.openingElement, 'modal'));
      if (modal?.kind === ts.SyntaxKind.FalseKeyword) {
        nonModalMenus += 1;
        return;
      }
      modalMenus += 1;
      seen.clear();
      const why = menuOpens(n);
      // Named with `/` on every OS, like the known menus listed above.
      if (why) offenders.push({ file: relative(root, path).split(sep).join('/'), menu: n.openingElement.tagName.getText(), why });
    });
  }
  return { offenders, modalMenus, nonModalMenus };
}

function fixture(files: Record<string, string>): Finding[] {
  const root = join(SRC, '__fixture__');
  const byPath = new Map(Object.entries(files).map(([name, text]) => [join(root, name), text]));
  return scan({ files: [...byPath.keys()], read: (path) => byPath.get(path) ?? null }, root).offenders;
}

const MENU_IMPORTS = `
  import { useState, useCallback } from 'react';
  import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
  import { Dialog } from '@/components/ui/dialog';
`;

test('a menu item that sets the state of a Dialog is caught, wherever the state is read', () => {
  for (const [label, body] of Object.entries({
    'open prop': `const [open, setOpen] = useState(false);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => setOpen(true)} /></DropdownMenu><Dialog open={open} /></>;`,
    'expression in the open prop': `const [id, setId] = useState(null);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => setId('a')} /></DropdownMenu><Dialog open={id !== null} /></>;`,
    'derived value': `const [id, setId] = useState(null);
      const item = items.find((i) => i.id === id);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => setId('a')} /></DropdownMenu><Dialog open={Boolean(item)} /></>;`,
    'mounted under a condition': `const [open, setOpen] = useState(false);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => setOpen(true)} /></DropdownMenu>{open && <FooDialog />}</>;`,
    'mounted under a ternary': `const [open, setOpen] = useState(false);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => setOpen(true)} /></DropdownMenu>{open ? <FooModal /> : null}</>;`,
    'through a named handler': `const [open, setOpen] = useState(false);
      function start() { setOpen(true); }
      return <><DropdownMenu><DropdownMenuItem onSelect={start} /></DropdownMenu><Dialog open={open} /></>;`,
    'through useCallback': `const [open, setOpen] = useState(false);
      const start = useCallback(() => setOpen(true), []);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => start()} /></DropdownMenu><Dialog open={open} /></>;`,
    'after an await': `const [open, setOpen] = useState(false);
      const pick = async () => { await choose(); setOpen(true); };
      return <><DropdownMenu><DropdownMenuItem onSelect={() => void pick()} /></DropdownMenu><Dialog open={open} /></>;`,
    'handed to a promise': `const [open, setOpen] = useState(false);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => { void load().then(setOpen); }} /></DropdownMenu><Dialog open={open} /></>;`,
    'on a click': `const [open, setOpen] = useState(false);
      return <><DropdownMenu><button onClick={() => setOpen(true)} /></DropdownMenu><Dialog open={open} /></>;`,
    'a modal prop that is not literally false': `const [open, setOpen] = useState(false);
      return <><DropdownMenu modal={narrow}><DropdownMenuItem onSelect={() => setOpen(true)} /></DropdownMenu><Dialog open={open} /></>;`,
  })) {
    assert.equal(fixture({ 'a.tsx': `${MENU_IMPORTS} export function A() { ${body} }` }).length, 1, label);
  }
});

test('every Radix menu root counts, whatever its import is called', () => {
  const dialog = `const [open, setOpen] = useState(false); return <>`;
  const end = `<Dialog open={open} /></>;`;
  for (const [imports, root, item] of [
    [`import * as Dropdown from '@radix-ui/react-dropdown-menu';`, 'Dropdown.Root', 'Dropdown.Item'],
    [`import * as Menu from '@radix-ui/react-dropdown-menu';`, 'Menu.Root', 'Menu.Item'],
    [`import * as Ctx from '@radix-ui/react-context-menu';`, 'Ctx.Root', 'Ctx.Item'],
    [`import { DropdownMenu as M, DropdownMenuItem as I } from '@/components/ui/dropdown-menu';`, 'M', 'I'],
  ] as const) {
    const source = `${MENU_IMPORTS.replace(/import \{ DropdownMenu.*\n/, '')} ${imports}
      export function A() { ${dialog}<${root}><${item} onSelect={() => setOpen(true)} /></${root}>${end} }`;
    assert.equal(fixture({ 'a.tsx': source }).length, 1, root);
  }
});

test('a dialog behind a component of another name counts when it takes `open`', () => {
  assert.equal(fixture({ 'a.tsx': `${MENU_IMPORTS}
    function Review({ open }) { return <Dialog open={open} />; }
    export function A() { const [open, setOpen] = useState(false);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => setOpen(true)} /></DropdownMenu><Review open={open} /></>; }` }).length, 1);
});

test('a handler received as a prop is followed to whoever passes it', () => {
  const menu = `${MENU_IMPORTS} export function Menu({ onPick }) {
    return <DropdownMenu><DropdownMenuItem onSelect={onPick} /></DropdownMenu>; }`;
  const parent = (open: string) => `${MENU_IMPORTS} import { Menu } from './menu';
    export function P() { const [open, setOpen] = useState(false);
      return <><Menu onPick={${open}} /><Dialog open={open} /></>; }`;
  assert.equal(fixture({ 'menu.tsx': menu, 'parent.tsx': parent('() => setOpen(true)') }).length, 1, 'arrow');
  assert.equal(fixture({ 'menu.tsx': menu, 'parent.tsx': parent('setOpen') }).length, 1, 'bare setter');
  assert.deepEqual(fixture({ 'menu.tsx': menu, 'parent.tsx': parent('() => setOpen(false)') }), [], 'closing it');
  assert.equal(fixture({ 'menu.tsx': `${MENU_IMPORTS} export function Menu(props) {
    return <DropdownMenu><DropdownMenuItem onSelect={() => props.onPick()} /></DropdownMenu>; }`, 'parent.tsx': parent('() => setOpen(true)') }).length, 1, 'props.x');
  assert.equal(fixture({ 'menu.tsx': `${MENU_IMPORTS}
    function Panel({ onPick }) { return <DropdownMenuItem onSelect={onPick} />; }
    export function Menu({ title, ...actions }) { return <DropdownMenu><Panel {...actions} /></DropdownMenu>; }`, 'parent.tsx': parent('() => setOpen(true)') }).length, 1, 'through a rest spread');
  assert.equal(fixture({ 'menu.tsx': `${MENU_IMPORTS} export function Menu({ title, ...actions }) {
    const { onPick } = actions;
    return <DropdownMenu><DropdownMenuItem onSelect={onPick} /></DropdownMenu>; }`, 'parent.tsx': parent('() => setOpen(true)') }).length, 1, 'destructured from the rest');
});

test('items living in a local or an imported component are read too', () => {
  const dialog = `const [open, setOpen] = useState(false);`;
  assert.equal(fixture({ 'a.tsx': `${MENU_IMPORTS}
    function Items({ onPick }) { return <DropdownMenuItem onSelect={onPick} />; }
    export function A() { ${dialog} return <><DropdownMenu><Items onPick={() => setOpen(true)} /></DropdownMenu><Dialog open={open} /></>; }` }).length, 1, 'local');
  assert.equal(fixture({
    'items.tsx': `${MENU_IMPORTS} export function Items({ onPick }) { return <DropdownMenuItem onSelect={onPick} />; }`,
    'a.tsx': `${MENU_IMPORTS} import { Items } from './items';
      export function A() { ${dialog} return <><DropdownMenu><Items onPick={() => setOpen(true)} /></DropdownMenu><Dialog open={open} /></>; }`,
  }).length, 1, 'imported');
});

test('the imperative openers are caught, and followed through a helper', () => {
  const nav = `import { useSettingsNavigation, openSettingsFromAnywhere, settingsHref } from '@/lib/settings-navigation';`;
  for (const [label, body] of Object.entries({
    'hook, destructured': `const { open: openSettings } = useSettingsNavigation();
      return <DropdownMenu><DropdownMenuItem onSelect={() => openSettings()} /></DropdownMenu>;`,
    'hook, as an object': `const settings = useSettingsNavigation();
      return <DropdownMenu><DropdownMenuItem onSelect={() => settings.open({ category: 'a', tab: null })} /></DropdownMenu>;`,
    'from anywhere': `return <DropdownMenu><DropdownMenuItem onSelect={() => openSettingsFromAnywhere()} /></DropdownMenu>;`,
    'through the url': `return <DropdownMenu><DropdownMenuItem onSelect={() => router.push(settingsHref())} /></DropdownMenu>;`,
  })) {
    assert.equal(fixture({ 'a.tsx': `${MENU_IMPORTS} ${nav} export function A() { ${body} }` }).length, 1, label);
  }
  assert.equal(fixture({
    'helper.ts': `import { openSettingsFromAnywhere } from '@/lib/settings-navigation';
      export function goToKeys() { openSettingsFromAnywhere({ category: 'keys', tab: null }); }`,
    'a.tsx': `${MENU_IMPORTS} import { goToKeys } from './helper';
      export function A() { return <DropdownMenu><DropdownMenuItem onSelect={() => goToKeys()} /></DropdownMenu>; }`,
  }).length, 1, 'helper');
});

test('a handler read from a context or a data object is followed by its field name', () => {
  const provider = (field: string) => `${MENU_IMPORTS} export function P() { const [open, setOpen] = useState(false);
    const value = { ${field} };
    return <><Ctx.Provider value={value} /><Dialog open={open} /></>; }`;
  const menu = (body: string) => `${MENU_IMPORTS} export function Menu() { ${body} }`;
  for (const [label, body] of Object.entries({
    'destructured from a hook': `const { start } = useCtx();
      return <DropdownMenu><DropdownMenuItem onSelect={() => start(true)} /></DropdownMenu>;`,
    'destructured from a local': `const c = useCtx(); const { start } = c;
      return <DropdownMenu><DropdownMenuItem onSelect={start} /></DropdownMenu>;`,
    'called on the object': `const host = useCtx();
      return <DropdownMenu><DropdownMenuItem onSelect={() => host.start()} /></DropdownMenu>;`,
    'handed over from the object': `const host = useCtx();
      return <DropdownMenu><DropdownMenuItem onSelect={host.start} /></DropdownMenu>;`,
    'read from a mapped item': `return <DropdownMenu>{items.map((item) => <DropdownMenuItem onSelect={item.start} />)}</DropdownMenu>;`,
  })) {
    assert.equal(fixture({ 'menu.tsx': menu(body), 'p.tsx': provider('start: () => setOpen(true)') }).length, 1, label);
  }
  assert.equal(fixture({
    'menu.tsx': menu(`const { setOpen } = useCtx(); return <DropdownMenu><DropdownMenuItem onSelect={() => setOpen(true)} /></DropdownMenu>;`),
    'p.tsx': provider('setOpen'),
  }).length, 1, 'shorthand field');
  assert.deepEqual(fixture({
    'menu.tsx': menu(`const host = useCtx(); return <DropdownMenu><DropdownMenuItem onSelect={() => host.start()} /></DropdownMenu>;`),
    'p.tsx': provider('start: () => setOpen(false)'),
  }), [], 'a field that closes the dialog');
  assert.deepEqual(fixture({
    'menu.tsx': `${MENU_IMPORTS} import { toast } from 'sonner';
      export function Menu() { return <DropdownMenu><DropdownMenuItem onSelect={() => { window.start(); toast.start(); }} /></DropdownMenu>; }`,
    'p.tsx': provider('start: () => setOpen(true)'),
  }), [], 'a global and a module are not that field');
});

test('a dialog trigger inside the menu is caught', () => {
  assert.equal(fixture({ 'a.tsx': `${MENU_IMPORTS} import { DialogTrigger } from '@/components/ui/dialog';
    export function A() { return <DropdownMenu><DialogTrigger /></DropdownMenu>; }` }).length, 1);
});

test('nothing is reported when no dialog opens from a modal menu', () => {
  for (const [label, body] of Object.entries({
    'non-modal': `const [open, setOpen] = useState(false);
      return <><DropdownMenu modal={false}><DropdownMenuItem onSelect={() => setOpen(true)} /></DropdownMenu><Dialog open={open} /></>;`,
    'state unrelated to the dialog': `const [open, setOpen] = useState(false); const [other, setOther] = useState(false);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => setOther(true)} /></DropdownMenu><Dialog open={open} /></>;`,
    'closing the dialog': `const [open, setOpen] = useState(true);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => setOpen(false)} /></DropdownMenu><Dialog open={open} /></>;`,
    'clearing the dialog target': `const [id, setId] = useState('a');
      return <><DropdownMenu><DropdownMenuItem onSelect={() => setId(null)} /></DropdownMenu><Dialog open={id !== null} /></>;`,
    'dialog opened from outside the menu': `const [open, setOpen] = useState(false);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => copy()} /></DropdownMenu><button onClick={() => setOpen(true)} /><Dialog open={open} /></>;`,
    'state of a non-dialog element': `const [open, setOpen] = useState(false);
      return <><DropdownMenu><DropdownMenuItem onSelect={() => setOpen(true)} /></DropdownMenu><Details open={open} /></>;`,
    'not a menu at all': `const [open, setOpen] = useState(false);
      return <><ul onClick={() => setOpen(true)} /><Dialog open={open} /></>;`,
    'an unrelated local component named like a menu': `const [open, setOpen] = useState(false);
      const Dropdown = { Root: 'div' };
      return <><Dropdown.Root onClick={() => setOpen(true)} /><Dialog open={open} /></>;`,
    'a same-named setter in another component': `return <DropdownMenu><DropdownMenuItem onSelect={() => setOpen(true)} /></DropdownMenu>;`,
  })) {
    const other = `function Other() { const [open, setOpen] = useState(false); return <Dialog open={open} />; }`;
    assert.deepEqual(fixture({ 'a.tsx': `${MENU_IMPORTS} ${other} export function A() { ${body} }` }), [], label);
  }
});

/** The menus known to open a dialog: taking their `modal={false}` away must fail the guard. */
const KNOWN_DIALOG_MENUS = [
  'plugins-client/machines/switcher.tsx',
  'components/theme-toggle.tsx',
  'plugins-client/bots/bots-rail.tsx',
  'components/chat/context-gauge-menu.tsx',
  'components/plugin-install-panel.tsx',
];

test('the real tree: no modal menu opens a dialog', () => {
  const { offenders, modalMenus, nonModalMenus } = scan(realTree(SRC), SRC);
  assert.ok(modalMenus >= 10 && nonModalMenus >= KNOWN_DIALOG_MENUS.length, `the scan still finds the menus (${modalMenus} modal, ${nonModalMenus} not)`);
  assert.deepEqual(offenders, []);
});

test('counter-proof on real code: each known menu is caught once it is modal again', () => {
  for (const name of KNOWN_DIALOG_MENUS) {
    const path = join(SRC, name);
    const text = readFileSync(path, 'utf8');
    assert.match(text, /modal=\{false\}/, name);
    const { offenders } = scan(realTree(SRC, new Map([[path, text.replace(/\s*modal=\{false\}/g, '')]])), SRC);
    assert.ok(offenders.some((o) => o.file === name), `${name} is not caught: ${JSON.stringify(offenders)}`);
  }
});

test('the imperative openers still exist under the names the scan looks for', () => {
  const all = realTree(SRC);
  const lib = readFileSync(join(SRC, 'lib', 'settings-navigation.ts'), 'utf8');
  for (const name of OPENERS) {
    const declared = new RegExp(`export (?:async )?function ${name}\\b`);
    assert.ok(declared.test(lib) || all.files.some((path) => declared.test(all.read(path) ?? '')), name);
  }
});
