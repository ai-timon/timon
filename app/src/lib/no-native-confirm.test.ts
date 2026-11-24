import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * No browser `confirm()` anywhere in the app or the plugin templates (TODO
 * #781): it freezes the page, names the site rather than Timon, cannot be
 * themed, and a browser told to stop showing dialogs answers "no" without
 * asking anyone. Every confirmation goes through `confirmAction()`
 * (`components/confirm-dialog/confirm-dialog-context.ts`), painted by the
 * `confirm.dialog` slot. All 36 calls were migrated on 03/11/2026: the count
 * is zero, and there is no exception to admit.
 *
 * Comments are skipped (a `//` line, a ` * ` doc line, text in backticks):
 * they explain why the call is gone.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = resolve(here, '..');
const examples = resolve(here, '..', '..', '..', 'examples');

const NATIVE = /(^|[^A-Za-z0-9_.$])(?:window\.|globalThis\.|self\.)?confirm\s*\(/;

function walk(dir: string, out: string[]): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?|mjs)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function offenders(files: string[], root: string): string[] {
  const found: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const code = line.replace(/`[^`]*`/g, '``').replace(/'[^']*'/g, "''");
      // A function declared or called by that name is not the browser's.
      if (/function confirm\s*\(|\bvoid confirm\(\)/.test(code)) return;
      if (NATIVE.test(code)) found.push(`${relative(root, file)}:${i + 1}: ${trimmed}`);
    });
  }
  return found;
}

test('no browser confirm() in app/src', () => {
  assert.deepEqual(offenders(walk(appSrc, []), appSrc), [], 'ask with confirmAction() from components/confirm-dialog');
});

test('no browser confirm() in the plugin templates', () => {
  assert.deepEqual(offenders(walk(examples, []), examples), [], 'a template asks with confirmAction() from @timon/ui');
});

test('the check catches the forms it bans', () => {
  const lines = ['if (!confirm(msg)) return;', 'const ok = window.confirm(x);', 'globalThis.confirm(y)'];
  for (const line of lines) assert.ok(NATIVE.test(line), line);
  for (const line of ['await confirmAction({ title })', 'question.confirm()', 'onConfirm(x)']) assert.ok(!NATIVE.test(line), line);
});
