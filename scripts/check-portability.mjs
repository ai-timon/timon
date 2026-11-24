#!/usr/bin/env node
// Portability gate: flags source patterns known to break on Windows or macOS.
// Runs on the developer's machine, in seconds, with no dependency — the
// GitHub Actions matrix (docs/PROTOCOLE-TEST-MULTI-OS.md) is the proof on
// real kernels; this script is the daily signal that makes the proof green.
//
// Usage:
//   node scripts/check-portability.mjs            # whole tree
//   node scripts/check-portability.mjs --changed  # files touched vs HEAD (+ untracked)
//   node scripts/check-portability.mjs a.ts b.ts  # explicit files
//
// Opt-out, one line at a time, with a reason: append `// portability: <why>`
// on the flagged line or on the line just above it. A git ref, a URL or a
// container path is not a filesystem path — say so and the line is skipped.
// The `scripts` of each package.json are read too: portability-npm-scripts.mjs.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkedManifests, isCheckedManifest, npmScriptProblem } from './portability-npm-scripts.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const TREES = ['orchestrator/src', 'orchestrator/tests', 'app/src', 'desktop/src', 'packages/sdk/src', 'packages/sdk/scripts'];
const EXT = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs']);
const HOST_DIR = join('orchestrator', 'src', 'host') + sep;
const PRAGMA = /\/\/\s*portability:/;

const UNIX_CMDS = 'which|whoami|sed|awk|chmod|chown|ps|pgrep|pkill|kill|ls|cat|tail|sh|bash|systemctl|launchctl|schtasks|open|xdg-open';
const FS_CALLS = /\b(mkdirSync|mkdir|writeFileSync|writeFile|symlinkSync|symlink|readFileSync|readFile|existsSync|rmSync|rm|cpSync|cp|openSync|open|statSync|stat|readdirSync|readdir)\(/;
const URLISH = /https?:|:\/\/|\.well-known|encodeURIComponent|\bapi\/|\/api\b|\/\/\s|^\s*\*|^\s*\/\/|\bgit\(|rev-parse|refs\//;
// A "/" joined onto something that smells like a filesystem location.
const PATH_CTX = /\b(startsWith|statSync|existsSync|readFileSync|writeFileSync|readdirSync|mkdirSync|rmSync|realpathSync)\(|(?<![.\w])(join|resolve)\(/;
const PATHY_VAR = /\$\{[\w.]*(home|dir|root|cwd|path)[\w.]*\}\//i;

/** @type {{ id: string, re: RegExp, when: (f: FileInfo, line: string) => boolean, why: string }[]} */
const RULES = [
  {
    id: 'unix-exec',
    re: new RegExp(`\\b(execFile|execFileSync|spawn|spawnSync|exec|execSync)\\(\\s*['"](${UNIX_CMDS})['"]`),
    when: (f) => !f.test && !f.host,
    why: 'Unix command called directly; route it through orchestrator/src/host/ (one variant per OS)',
  },
  {
    id: 'path-concat',
    re: /\+\s*['"]\/['"]|['"]\/['"]\s*\+|\$\{[^}]+\}\//,
    when: (f, line) => !f.test && !f.rel.startsWith('app' + sep) && !URLISH.test(line)
      && (PATH_CTX.test(line) || PATHY_VAR.test(line)),
    why: 'path built with "/"; use join()/resolve()/sep from node:path (or mark the line: it is a URL, a git ref…)',
  },
  {
    id: 'tmp-literal',
    re: /['"`]\/tmp\b/,
    // In a test, "/tmp" as an opaque fixture string is harmless; it only bites
    // when handed to the filesystem as an argument.
    when: (f, line) => (f.test ? FS_CALLS.test(line) && /[(,]\s*['"`]\/tmp\b/.test(line) : !/^\s*(\*|\/\/)/.test(line)),
    why: '"/tmp" does not exist on Windows; use os.tmpdir() + mkdtempSync',
  },
  {
    id: 'home-env',
    re: /process\.env\.HOME\b|env\[['"]HOME['"]\]|\benv\.HOME\b/,
    when: (f, line) => !f.test && !f.host && !f.rel.endsWith('paths.ts') && !/USERPROFILE/.test(line),
    why: '$HOME is unset on Windows (USERPROFILE); use homedir() from node:os',
  },
  {
    id: 'tilde-literal',
    re: /['"]~\/[^'"]*['"]/,
    // The expander idiom (`startsWith('~/')` … `join(home, p.slice(2))`) is the fix, not the bug.
    when: (f, line) => !f.test && !f.host && !/homedir\(\)|startsWith\(['"]~\/|['"]~\/['"]\s*\+/.test(line) && (FS_CALLS.test(line) || PATH_CTX.test(line)),
    why: '"~" is not expanded by Node; resolve through homedir() (or mark the line if it is display text)',
  },
];

/** @typedef {{ abs: string, rel: string, test: boolean, host: boolean }} FileInfo */

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (EXT.has(extname(name))) out.push(abs);
  }
}

function changedFiles() {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim())
    .filter((p) => isCheckedManifest(p) || (EXT.has(extname(p)) && TREES.some((t) => p.startsWith(t + '/'))))
    .map((p) => join(ROOT, p));
}

function collect(argv) {
  if (argv.includes('--changed')) return changedFiles();
  const explicit = argv.filter((a) => !a.startsWith('--'));
  // `resolve`, not `join`: a path on another Windows drive than the checkout
  // stays absolute (`relative` cannot reach it from the root).
  if (explicit.length) return explicit.map((p) => resolve(ROOT, p));
  const out = [];
  for (const t of TREES) {
    try { walk(join(ROOT, t), out); } catch { /* tree absent in this checkout */ }
  }
  out.push(...checkedManifests(ROOT).map((rel) => join(ROOT, rel)));
  return out;
}

function info(abs) {
  const rel = relative(ROOT, abs);
  return { abs, rel, test: /\.test\.[cm]?[jt]sx?$/.test(rel) || rel.split(sep).includes('tests'), host: rel.startsWith(HOST_DIR) };
}

let findings = 0;
for (const abs of collect(process.argv.slice(2))) {
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { continue; }
  const f = info(abs);
  if (basename(abs) === 'package.json') {
    for (const [name, script] of Object.entries(JSON.parse(text).scripts ?? {})) {
      const problem = npmScriptProblem(script);
      if (!problem) continue;
      findings++;
      console.log(`${f.rel.split(sep).join('/')} [npm-script] "${name}": ${problem}; npm runs scripts under cmd.exe on Windows, move it to a node script`);
      console.log(`    ${script}`);
    }
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (PRAGMA.test(line) || (i > 0 && PRAGMA.test(lines[i - 1]))) return;
    for (const r of RULES) {
      if (!r.re.test(line) || !r.when(f, line)) continue;
      findings++;
      console.log(`${f.rel.split(sep).join('/')}:${i + 1} [${r.id}] ${r.why}`);
      console.log(`    ${line.trim()}`);
    }
  });
}

if (findings) {
  console.error(`\n${findings} portability finding(s). Fix, or justify with \`// portability: <reason>\` on the line.`);
  process.exit(1);
}
console.log('portability: OK');
