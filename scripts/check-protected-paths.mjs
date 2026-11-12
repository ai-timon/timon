#!/usr/bin/env node
/**
 * Fails a pull request whose author is not a maintainer when it changes a
 * protected path (`.github/protected-paths`) or a field of a `package.json`
 * that says what the package is, what it pulls in, or runs at install time.
 *
 * Run by .github/workflows/protected-paths.yml on `pull_request_target`: this
 * file and the list come from main, never from the pull request, and the
 * changed files are read through the GitHub API. The pull request's code is
 * never checked out nor run, so it cannot edit the check to let itself through.
 *
 * A maintainer accepts a change after reading it by labelling the pull request
 * `protected-paths-approved` (only accounts with triage rights can label). The
 * approval holds for the commits it saw: a new push removes the label, and the
 * check fails again until a maintainer approves once more.
 *
 *   GH_TOKEN, REPO (owner/name), PR_NUMBER, PR_AUTHOR, BASE_SHA, HEAD_SHA,
 *   PR_LABELS (JSON names), EVENT_ACTION
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST = join(ROOT, '.github', 'protected-paths');
const API = 'https://api.github.com';

export const APPROVAL_LABEL = 'protected-paths-approved';

/** Fields that say what a package is and who publishes it. */
export const PACKAGE_IDENTITY_FIELDS = ['name', 'author', 'license', 'repository', 'publishConfig', 'bin', 'private'];
/** npm scripts that run on their own when the package is installed or published. */
export const PACKAGE_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];
/**
 * Fields that decide which third-party code gets installed. A dependency is
 * code nobody reads line by line, so even a version bump needs a maintainer.
 */
export const PACKAGE_DEPENDENCY_FIELDS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'bundleDependencies', 'bundledDependencies', 'overrides', 'resolutions', 'workspaces',
];

export function parseProtectedList(text) {
  const patterns = [];
  const allowed = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@')) allowed.push(line.slice(1).toLowerCase());
    else patterns.push(line);
  }
  return { patterns, allowed };
}

/** `**` crosses folders, `*` and `?` stay within one name; no slash = a file name anywhere. */
export function patternToRegExp(pattern) {
  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { body += '(?:.*/)?'; i += 2; } else { body += '.*'; i += 1; }
    } else if (c === '*') body += '[^/]*';
    else if (c === '?') body += '[^/]';
    else body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(pattern.includes('/') ? `^${body}$` : `^(?:.*/)?${body}$`);
}

export function protectedBy(path, patterns) {
  return patterns.find((pattern) => patternToRegExp(pattern).test(path)) ?? null;
}

function pick(pkg, field) {
  return JSON.stringify(pkg?.[field] ?? null);
}

/** `{}`, `[]`, `false` and an absent field pull nothing in. */
function declaresSomething(value) {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** What changed in a package.json, as `field` or `scripts.<name>` entries. */
export function packageFieldChanges(base, head, status) {
  if (status === 'removed') return ['the whole package.json (removed)'];
  const changes = [];
  if (status !== 'added') {
    for (const field of PACKAGE_IDENTITY_FIELDS) {
      if (pick(base, field) !== pick(head, field)) changes.push(field);
    }
  }
  for (const field of PACKAGE_DEPENDENCY_FIELDS) {
    const changed = status === 'added' ? declaresSomething(head?.[field]) : pick(base, field) !== pick(head, field);
    if (changed) changes.push(field);
  }
  for (const script of PACKAGE_LIFECYCLE_SCRIPTS) {
    if (pick(base?.scripts, script) !== pick(head?.scripts, script)) changes.push(`scripts.${script}`);
  }
  return changes;
}

/**
 * `files`: entries of the pull request files API (`filename`, `status`,
 * `previous_filename`), each package.json one carrying `base` and `head`
 * parsed contents. Returns the violations, empty when the author may change them.
 */
export function evaluate({ files, author, patterns, allowed }) {
  if (allowed.includes(String(author).toLowerCase())) return [];
  const violations = [];
  for (const file of files) {
    for (const path of [file.filename, file.previous_filename].filter(Boolean)) {
      const pattern = protectedBy(path, patterns);
      if (pattern) violations.push({ path, reason: `protected path (${pattern})` });
    }
    if (file.filename === 'package.json' || file.filename.endsWith('/package.json')) {
      const changes = packageFieldChanges(file.base, file.head, file.status);
      if (changes.length) violations.push({ path: file.filename, reason: `package fields: ${changes.join(', ')}` });
    }
  }
  return violations;
}

/**
 * `pass`: the check succeeds. `removeLabel`: the approval no longer covers the
 * pull request's commits and has to be withdrawn.
 */
export function decide({ violations, labels, action }) {
  if (violations.length === 0) return { pass: true, removeLabel: false, approved: false };
  const approved = labels.includes(APPROVAL_LABEL);
  if (approved && action === 'synchronize') return { pass: false, removeLabel: true, approved: false };
  return { pass: approved, removeLabel: false, approved };
}

async function github(path, token, accept = 'application/vnd.github+json', method = 'GET') {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'timon-protected-paths' },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${path}: ${response.status}`);
  return accept.endsWith('raw+json') ? response.text() : response.json();
}

async function packageAt(repo, path, ref, token) {
  const text = await github(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`, token, 'application/vnd.github.raw+json');
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return { unreadable: text.length }; }
}

async function main() {
  const { GH_TOKEN: token, REPO: repo, PR_NUMBER: number, PR_AUTHOR: author, BASE_SHA: base, HEAD_SHA: head } = process.env;
  if (!token || !repo || !number || !author || !base || !head) throw new Error('GH_TOKEN, REPO, PR_NUMBER, PR_AUTHOR, BASE_SHA and HEAD_SHA are required');
  const { patterns, allowed } = parseProtectedList(readFileSync(LIST, 'utf8'));
  const files = [];
  for (let page = 1; ; page++) {
    const batch = await github(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token);
    if (!batch || batch.length === 0) break;
    files.push(...batch);
    if (batch.length < 100) break;
  }
  for (const file of files) {
    if (file.filename === 'package.json' || file.filename.endsWith('/package.json')) {
      file.base = file.status === 'added' ? null : await packageAt(repo, file.previous_filename ?? file.filename, base, token);
      file.head = file.status === 'removed' ? null : await packageAt(repo, file.filename, head, token);
    }
  }
  const violations = evaluate({ files, author, patterns, allowed });
  let labels = [];
  try { labels = JSON.parse(process.env.PR_LABELS ?? '[]'); } catch { labels = []; }
  const verdict = decide({ violations, labels, action: process.env.EVENT_ACTION });
  if (violations.length === 0) {
    console.log(`No protected path changed (${files.length} files checked).`);
    return;
  }
  const list = violations.map((v) => `  - ${v.path}: ${v.reason}`);
  if (verdict.pass) {
    console.log([`A maintainer approved these protected changes (label ${APPROVAL_LABEL}):`, ...list].join('\n'));
    return;
  }
  if (verdict.removeLabel) {
    await github(`/repos/${repo}/issues/${number}/labels/${APPROVAL_LABEL}`, token, 'application/vnd.github+json', 'DELETE');
    console.log(`New commits arrived after the approval: label ${APPROVAL_LABEL} removed, a maintainer has to approve again.`);
  }
  for (const v of violations) console.log(`::error file=${v.path}::${v.path}: ${v.reason}`);
  console.log([
    '',
    `This pull request changes ${violations.length} protected item(s):`,
    ...list,
    '',
    'Licences, governance files, the keys and addresses Timon trusts, the identity of its packages',
    'and their dependencies are changed by the maintainers only. A maintainer reviews these changes and approves them with the',
    `label ${APPROVAL_LABEL}, or asks you to remove them from the pull request.`,
  ].join('\n'));
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`protected paths: ${error.message}`);
    process.exitCode = 1;
  });
}
