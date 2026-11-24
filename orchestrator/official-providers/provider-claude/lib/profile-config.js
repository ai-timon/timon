/**
 * The claude CLI keeps its sessions, debug logs and settings in its config folder: the one
 * `CLAUDE_CONFIG_DIR` names, else `~/.claude`, where the user's own Claude sign-in lives. The fence
 * opens `~/.claude` to the `claude` profile only, so every other profile on this dialect that runs
 * without an account (Kimi, an API-key profile, a user's file) is given a folder of its own,
 * kept across its missions so that a new mission still resumes another's session (TODO #1104).
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLAUDE_PROFILE } from './profile.js';

/** The longest folder name the CLI keeps as is (Claude Code 2.1.322, `VL`): a longer one is cut and hashed. */
const SLUG_MAX = 200;

/** A session id as the CLI mints them (a UUID), held to one safe path segment. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Whether a launch of `profile` with no account gets a config folder of its own rather than `~/.claude`.
 * By the id before `@`: an instance of `claude` whose account is not found keeps the CLI's own folder.
 */
export function needsOwnConfigDir(profile) {
  return profile.id.split('@', 1)[0] !== CLAUDE_PROFILE.id;
}

/** The 32-bit string hash the CLI appends to a cut slug, in base 36. */
function slugHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

/** The folder name under `projects/` the CLI files a session of `cwd` in: every non-alphanumeric character becomes `-`. */
export function claudeProjectSlug(cwd) {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return slug.length <= SLUG_MAX ? slug : `${slug.slice(0, SLUG_MAX)}-${slugHash(cwd)}`;
}

/** The config folder of the daemon's own user, where a session started before this folder existed was kept. */
export function userClaudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
}

function realOr(path) {
  try { return realpathSync.native(path); } catch { return path; }
}

/**
 * Brings a session the CLI kept in the user's config folder into the profile's own, once: before
 * this folder existed (Windows, or a mission without the fence), a Kimi mission's session went to
 * `~/.claude/projects/<slug>/<id>.jsonl`, and `--resume` would no longer find it. Only that file is
 * copied, nothing else of the user's folder, and never over a file already there. Whatever goes
 * wrong leaves the launch alone: the CLI then says it has no such session and a fresh one starts.
 * Returns whether a file was copied.
 */
export function adoptSession({ dir, cwd, sessionId, sourceConfigDir = userClaudeConfigDir() }) {
  if (!sessionId || !cwd || !SESSION_ID.test(sessionId)) return false;
  try {
    const real = realOr(cwd);
    const name = join('projects', claudeProjectSlug(real), `${sessionId}.jsonl`);
    if (dir.has(name)) return false;
    // The CLI files by the folder it runs in, links resolved; a session written from the link's own spelling counts too.
    for (const spelling of new Set([real, cwd])) {
      const source = join(sourceConfigDir, 'projects', claudeProjectSlug(spelling), `${sessionId}.jsonl`);
      let stat;
      try { stat = lstatSync(source); } catch { continue; }
      // A link would hand the profile's missions whatever it leads to.
      if (!stat.isFile()) continue;
      // Bytes, so that the folder's writer copies them untouched.
      dir.writeFile(name, readFileSync(source));
      return true;
    }
  } catch { /* the CLI starts a fresh session */ }
  return false;
}
