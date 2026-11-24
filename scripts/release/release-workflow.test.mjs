/**
 * Static checks on .github/workflows/release.yml: what it may reach is fixed
 * by its text, and it cannot be run before it reaches GitHub. No YAML parser
 * at the repository root: the checks read the file line by line, which its
 * plain block style allows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (name) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');
const text = read('release.yml');
const lines = text.split('\n');
const uncomment = (line) => line.replace(/(^|\s)#.*$/, '');
/** Lines without their comment: a comment may explain what the workflow does not do. */
const code = lines.map(uncomment).join('\n');

const JOBS = ['check', 'build', 'attest', 'draft', 'publish'];
/** The secrets each job may name, and nothing else anywhere. */
const SECRETS = {
  build: ['TIMON_RELEASE_PRIVATE_KEY', 'TIMON_RELEASE_PUBLIC_KEY'],
  publish: ['TIMON_RELEASE_ED25519_KEY', 'TIMON_RELEASE_P256_KEY', 'RELEASE_PR_TOKEN'],
};
/** The write permissions each job may hold. */
const WRITES = { check: [], build: [], attest: ['attestations', 'id-token'], draft: ['contents'], publish: ['contents'] };

/** The jobs, by name, each with its own lines, comments removed (two-space indented keys under `jobs:`). */
function jobs() {
  const start = lines.indexOf('jobs:');
  assert.ok(start > 0, 'no jobs: block');
  const found = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { current = m[1]; found.set(current, []); continue; }
    if (current && (line.startsWith('    ') || !line.trim() || /^\s*#/.test(line))) found.get(current).push(uncomment(line));
    else if (current && /^\S/.test(line)) current = null;
  }
  return found;
}

/** The steps of a job, each as its lines (a `      - ` item and what it holds). */
function steps(body) {
  const found = [];
  let inSteps = false;
  for (const line of body) {
    if (/^ {4}steps:\s*$/.test(line)) { inSteps = true; continue; }
    if (!inSteps) continue;
    if (/^ {4}\S/.test(line)) { inSteps = false; continue; }
    if (/^ {6}- /.test(line)) found.push([line]);
    else if (found.length) found.at(-1).push(line);
  }
  return found;
}

/** The text of each `run:` block, single line or literal block. */
function runBlocks() {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] !== '|' && m[2] !== '>') { blocks.push(m[2]); continue; }
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
      body.push(lines[j]);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

const jobText = (name) => jobs().get(name).join('\n');
const stepNamed = (job, name) => {
  const found = steps(jobs().get(job)).find((step) => step.some((line) => line.includes(`name: ${name}`)));
  assert.ok(found, `no step "${name}" in ${job}`);
  return found.join('\n');
};

test('release.yml runs on a push to main that changes the version, or by hand: never for a pull request', () => {
  const on = /^on:\n((?: {2}.*\n|\s*\n)+)/m.exec(text);
  assert.ok(on, 'no on: block');
  const triggers = on[1].split('\n').map((line) => /^ {2}([a-z_]+):/.exec(line)?.[1]).filter(Boolean);
  assert.deepEqual(triggers, ['push', 'workflow_dispatch']);
  assert.match(on[1], /^ {2}push:\n {4}branches: \[main\]\n {4}paths: \[orchestrator\/package\.json\]\n/m);
  assert.doesNotMatch(on[1], /tags:|inputs:/);
  for (const forbidden of ['pull_request', 'pull_request_target', 'workflow_run', 'issue_comment', 'repository_dispatch']) {
    assert.doesNotMatch(code, new RegExp(`\\b${forbidden}\\b`), `${forbidden} would let someone else's code near the environments`);
  }
});

test('only main of this repository goes past the first job, and every later job depends on it', () => {
  const found = jobs();
  assert.deepEqual([...found.keys()], JOBS);
  const ifOf = (name) => found.get(name).map((line) => /^ {4}if:\s*(.+)$/.exec(line)?.[1]).find(Boolean) ?? '';
  assert.match(ifOf('check'), /github\.repository == 'ai-timon\/timon'/);
  assert.match(ifOf('check'), /github\.ref == 'refs\/heads\/main'/);
  for (const name of JOBS.slice(1)) {
    assert.match(ifOf(name), /^needs\.check\.outputs\.release == 'true' && github\.ref == 'refs\/heads\/main'$/, `job ${name}: ${ifOf(name)}`);
  }
  // No always() nor !cancelled(): a job whose predecessor failed must not run.
  assert.doesNotMatch(code, /always\(\)|cancelled\(\)|failure\(\)/);
  const needsOf = (name) => found.get(name).map((line) => /^ {4}needs:\s*(.+)$/.exec(line)?.[1]).find(Boolean);
  assert.equal(needsOf('build'), 'check');
  assert.equal(needsOf('attest'), '[check, build]');
  assert.equal(needsOf('draft'), '[check, build, attest]');
  assert.equal(needsOf('publish'), '[check, draft]');
});

test('the first job releases a final version only, changed by the push, with no tag yet', () => {
  const decide = stepNamed('check', 'Read the version and decide');
  assert.match(decide, /\^\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/, 'x.y.z only, no -rc');
  assert.match(decide, /git show "\$BEFORE:orchestrator\/package\.json"/);
  assert.match(decide, /git ls-remote --tags origin "refs\/tags\/v\$version"/);
  assert.match(decide, /release=true/);
  assert.match(jobText('check'), /--channel stable --no-expiry --output \.\.\/release-output --dry-run/);
});

test('the environments: release-build on the build, release on the publication, nowhere else', () => {
  const found = jobs();
  for (const name of JOBS) {
    const environments = found.get(name).map((line) => /^ {4}environment:\s*(.*)$/.exec(line)?.[1]).filter((value) => value !== undefined);
    const expected = { build: ['release-build'], publish: ['release'] }[name] ?? [];
    assert.deepEqual(environments, expected, `job ${name}`);
  }
});

test('each secret is named in its own job only, on the step that uses it', () => {
  const found = jobs();
  const named = new Set();
  for (const name of JOBS) {
    const body = found.get(name).join('\n');
    const secrets = [...body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(secrets)].sort(), [...(SECRETS[name] ?? [])].sort(), `job ${name}`);
    secrets.forEach((secret) => named.add(secret));
    // On a step's env, never the job's: the other steps of the job (checkout,
    // setup-node, artifact actions) do not see it.
    assert.ok(!found.get(name).some((line) => /^ {4}env:/.test(line)), `job ${name} has a job-wide env`);
    for (const step of steps(found.get(name))) {
      for (const line of step.filter((l) => /secrets\./.test(l))) assert.match(line, /^ {10}[A-Z0-9_]+: \$\{\{ secrets\.[A-Za-z0-9_]+ \}\}\s*$/, `not a step variable: ${line.trim()}`);
    }
  }
  assert.doesNotMatch(code.slice(0, code.indexOf('\njobs:')), /secrets\.|^env:/m, 'a secret or a variable for the whole workflow');
  assert.ok(!named.has('GITHUB_TOKEN'));
});

test('the build gets no GitHub token, and the token-bearing jobs install nothing', () => {
  const build = jobText('build');
  assert.doesNotMatch(build, /github\.token|GITHUB_TOKEN|GH_TOKEN|secrets\.GITHUB/);
  assert.doesNotMatch(build, /--publish\s+(always|onTag|onTagOrDraft)/);
  for (const name of ['check', 'attest']) assert.doesNotMatch(jobText(name), /github\.token|GH_TOKEN/, `job ${name}`);
  // The draft and the publication run publish.mjs, plain Node, from the built
  // commit: no npm, so no dependency's script runs next to the tokens and keys.
  for (const name of ['draft', 'publish']) {
    const body = jobText(name);
    assert.doesNotMatch(body, /\bnpm\b|\bnpx\b|cache: npm/, `job ${name} installs packages`);
    assert.match(body, /package-manager-cache: false/);
  }
  // The token of the pull request reaches git and gh, nothing else.
  const pr = stepNamed('publish', 'Open the pull request');
  assert.match(pr, /GH_TOKEN: \$\{\{ secrets\.RELEASE_PR_TOKEN \}\}/);
  assert.doesNotMatch(pr, /\bnode\b|\bnpm\b|\bnpx\b/);
  // The manifest keys reach publish.mjs only, never the pull request step.
  const publish = stepNamed('publish', 'Publish the release');
  assert.match(publish, /TIMON_RELEASE_ED25519_KEY: \$\{\{ secrets\.TIMON_RELEASE_ED25519_KEY \}\}/);
  assert.match(publish, /TIMON_RELEASE_P256_KEY: \$\{\{ secrets\.TIMON_RELEASE_P256_KEY \}\}/);
  assert.doesNotMatch(pr, /TIMON_RELEASE_/);
});

test('permissions: read by default, each job declares its own, and writes only what it needs', () => {
  assert.match(text, /^permissions:\n {2}contents: read\n/m, 'the workflow default is contents: read');
  assert.doesNotMatch(code, /write-all|read-all/);
  for (const [name, body] of jobs()) {
    const start = body.findIndex((line) => /^ {4}permissions:\s*$/.test(line));
    assert.ok(start >= 0, `job ${name} declares no permissions`);
    const granted = [];
    for (const line of body.slice(start + 1)) {
      const m = /^ {6}([a-z-]+):\s*(read|write|none)\s*$/.exec(line);
      if (!m) break;
      granted.push(m);
    }
    const writes = granted.filter((m) => m[2] === 'write').map((m) => m[1]).sort();
    assert.deepEqual(writes, WRITES[name], `job ${name} writes ${writes.join(', ')}`);
    assert.deepEqual(granted.filter((m) => m[2] === 'read').map((m) => m[1]), name === 'attest' || !writes.includes('contents') ? ['contents'] : [], `job ${name} reads more than contents`);
  }
});

test('the attestation token never shares a job with npm or the built code', () => {
  const body = jobText('attest');
  assert.match(body, /actions\/attest-build-provenance@/);
  assert.doesNotMatch(body, /actions\/checkout@|actions\/setup-node@/);
  assert.doesNotMatch(body, /\bnpm\b|\bnpx\b|\bnode\b/);
  assert.match(body, /sha256sum --strict -c SHA256SUMS/);
  assert.ok(body.indexOf('sha256sum') < body.indexOf('attest-build-provenance'), 'the sums are checked after the attestation');
  assert.match(body, /create-storage-record:\s*false/);
  assert.doesNotMatch(jobText('build'), /id-token|attestations:|attest-build-provenance/);
});

test('the build: three systems, stable without expiry, stopped as a whole when one fails', () => {
  const build = jobText('build');
  assert.match(build, /fail-fast:\s*true/);
  assert.doesNotMatch(build, /continue-on-error/);
  for (const [os, runner] of [['linux', 'ubuntu-latest'], ['mac', '\\[self-hosted, macOS, ARM64, timon-release\\]'], ['windows', 'windows-latest']]) {
    assert.match(build, new RegExp(`\\{ os: ${os}, runner: ${runner} \\}`));
  }
  assert.match(build, /node scripts\/release\/build-package\.mjs --version "\$VERSION" --channel stable --no-expiry --output \.\.\/release-output$/m);
  assert.doesNotMatch(code, /--expires|--channel beta|--key-dir/);
  assert.match(build, /actions\/upload-artifact@/);
  assert.match(build, /ref: \$\{\{ needs\.check\.outputs\.sha \}\}/, 'the build pins the commit the first job read');
  // The throwaway pair is for the dry run of the first job only.
  assert.doesNotMatch(build, /throwaway-keys/);
});

test('the draft goes without keys; the approved job publishes and opens the pull request of the lists', () => {
  const draft = stepNamed('draft', 'Create or complete the draft release');
  assert.match(draft, /node src\/scripts\/release\/publish\.mjs --version "\$VERSION" --input input --draft$/m);
  assert.match(draft, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  const publish = stepNamed('publish', 'Publish the release');
  assert.match(publish, /node src\/scripts\/release\/publish\.mjs --version "\$VERSION" --input input --manifests-dir site$/m);
  assert.doesNotMatch(publish, /--draft|--dry-run/);
  assert.match(jobText('publish'), /ref: main\n {10}path: site/, 'the lists are written on main as it is after the approval');
  const pr = stepNamed('publish', 'Open the pull request');
  assert.match(pr, /branch="chore\/releases-\$VERSION"/);
  assert.match(pr, /title="chore\(release\): publish the \$VERSION release lists"/);
  assert.match(pr, /git add releases\.json releases-install\.json$/m);
  assert.match(pr, /gh pr create -R "\$REPO" --base main --head "\$branch"/);
  assert.match(pr, /gh pr merge -R "\$REPO" "\$number" --auto --merge --match-head-commit "\$head"/);
  assert.match(pr, /echo "::add-mask::\$auth"/);
  assert.ok(stepNamed('publish', 'Check that only the release lists changed'));
});

test('the commit of the release lists passes the repository rules for a public message', () => {
  const pr = stepNamed('publish', 'Open the pull request');
  const messages = [...pr.matchAll(/-m "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /^\$title$/);
  for (const message of [messages[1], 'chore(release): publish the 0.1.9 release lists']) {
    assert.doesNotMatch(message, /[àâçéèêëîïôûùüÿœ]/i, 'messages are in English'); // french-ok: the letters that betray French
    assert.doesNotMatch(message, /co-authored-by|generated (with|by)|🤖/i, 'no attribution');
    assert.doesNotMatch(message, /\b[0-9a-f]{8}-[0-9a-f]{4}-|\/home\/|TODO\s*#/i, 'no internal reference');
  }
  assert.match('chore(release): publish the 0.1.9 release lists', /^[a-z]+\([a-z-]+\): \S/);
});

test('one release at a time, never cancelled half-way', () => {
  assert.match(text, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false\n/m);
});

test('every action is pinned on a full commit sha, its version in a comment, as in rc.yml', () => {
  const pins = (source) => {
    const found = new Map();
    for (const line of source.split('\n').filter((l) => /^\s*(?:- )?uses:/.test(l))) {
      const m = /^\s*(?:- )?uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([0-9a-f]{40})\s+#\s*(v\d+(?:\.\d+){0,2})\s*$/.exec(line);
      assert.ok(m, `not pinned on a sha with its version: ${line.trim()}`);
      const [, action, sha] = m;
      if (found.has(action)) assert.equal(found.get(action), sha, `${action} is pinned twice differently`);
      found.set(action, sha);
    }
    return found;
  };
  const release = pins(text);
  assert.ok(release.size >= 5);
  // The two release workflows move together: one update of an action pin covers both.
  const rc = pins(read('rc.yml'));
  for (const [action, sha] of release) if (rc.has(action)) assert.equal(sha, rc.get(action), `${action}: release.yml and rc.yml disagree`);
});

test('every checkout leaves no credential behind', () => {
  const checkouts = lines.map((line, i) => (/uses:\s*actions\/checkout@/.test(line) ? i : -1)).filter((i) => i >= 0);
  assert.ok(checkouts.length >= 4);
  for (const i of checkouts) {
    const block = [];
    for (let j = i + 1; j < lines.length && !/^\s*- /.test(lines[j]) && lines[j].trim(); j++) block.push(lines[j]);
    assert.ok(block.some((line) => /persist-credentials:\s*false/.test(line)), `checkout at line ${i + 1} keeps its credentials`);
  }
});

test('every job has a time limit', () => {
  for (const [name, body] of jobs()) {
    const limit = body.map((line) => /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(line)?.[1]).find(Boolean);
    assert.ok(limit, `job ${name} has no timeout-minutes`);
    assert.ok(Number(limit) > 0 && Number(limit) <= 180, `job ${name}: timeout ${limit}`);
  }
});

test('no expression is pasted into a shell script: values reach run blocks through env', () => {
  const blocks = runBlocks();
  assert.ok(blocks.length >= 10);
  for (const block of blocks) assert.doesNotMatch(block, /\$\{\{/, `expression inside run:\n${block}`);
});
