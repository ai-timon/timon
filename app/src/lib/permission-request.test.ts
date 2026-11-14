/**
 * The permission card speaks the reader's language and names the tool so a
 * person can read it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionRequestText } from './permission-request';
import { setLocale } from './i18n';
import './i18n-test-locales';

test('the heading is translated and carries the tool', () => {
  try {
    setLocale('en');
    assert.equal(permissionRequestText('Bash', {}).heading, 'The agent asks permission to use Bash');
    setLocale('fr');
    assert.equal(permissionRequestText('Bash', {}).heading, "L'agent demande l'autorisation d'utiliser Bash");
  } finally {
    setLocale('en');
  }
});

test('an MCP tool reads by its server and action, its identifier kept apart', () => {
  setLocale('en');
  const text = permissionRequestText('mcp__timon__kanban_add', { title: 'x' });
  assert.equal(text.heading, 'The agent asks permission to use Timon · Kanban Add');
  assert.equal(text.rawName, 'mcp__timon__kanban_add');
  assert.equal(text.intent, null, 'the heading already says what it does');
});

test('a built-in tool keeps no identifier line, and says what the call does', () => {
  try {
    setLocale('fr');
    const write = permissionRequestText('Write', { file_path: '/work/stats.py', content: 'print(1)' });
    assert.equal(write.rawName, null);
    assert.equal(write.intent, 'Écrit stats.py');
    const shell = permissionRequestText('Bash', { command: 'python3 stats.py', description: 'Run the stats script' });
    assert.equal(shell.intent, 'Run the stats script', "the agent's own description comes first");
    assert.equal(permissionRequestText('Bash', { command: 'python3 stats.py' }).intent, 'Exécute python3');
  } finally {
    setLocale('en');
  }
});

test('an input that is not an object reads as no detail', () => {
  setLocale('en');
  const text = permissionRequestText('Bash', 'raw');
  assert.equal(text.intent, null);
  assert.equal(text.rawName, null);
});
