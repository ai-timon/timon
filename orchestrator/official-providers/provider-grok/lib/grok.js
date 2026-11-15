/**
 * "grok" dialect — Grok Build CLI (xAI), one shot per turn.
 *
 * The CLI is backed by the host's SuperGrok / X Premium+ subscription
 * (`grok login` → ~/.grok/auth.json), not by the per-token x.ai API: that is
 * what makes it eligible for TIMON's economic principle, just like claude and
 * codex.
 *
 * ── What was verified against the binary (grok 1.0.5) ─────────────────────
 *
 *  1. `--output-format streaming-messages-json --include-partial-messages`
 *     emits EXACTLY claude's stream-json vocabulary: `system:init` (with
 *     `session_id`, `tools`, `mcp_servers`), `stream_event` carrying the
 *     Anthropic deltas, `assistant`, `user` (tool_result), and a final
 *     `result` whose `modelUsage[*].contextWindow` feeds the context gauge.
 *     Hence a `parseLine` that reuses claude's splitting as is — the only
 *     difference is the missing `control_request` channel (no hot model
 *     switch: `setModel` stays unimplemented).
 *
 *  2. No `--input-format stream-json`: the CLI does not take successive turns
 *     on stdin. Multi-turn = re-spawn with `-r <session_id>`, like codex. The
 *     id is PRESERVED from one turn to the next (verified), so there is
 *     nothing to rewrite on the mission side after a resume.
 *
 *  3. The system prompt goes through NEITHER an `--append-system-prompt` flag
 *     (which does not exist) NOR `--rules` (which does, but travels through
 *     argv, and the TIMON preamble + skills + memory weighs tens of KB while
 *     Linux refuses any argument beyond 128 KiB). It is written to
 *     `<GROK_HOME>/rules/timon.md`, which the CLI always loads, for every
 *     project. Verified: an instruction placed there is indeed followed.
 *
 *  4. The user message goes out through `--prompt-file`, for the same reason —
 *     and that is what exempts this dialect from declaring a `maxPromptBytes`.
 *     Text-only turns write `prompt.txt`; multimodal turns write ACP content
 *     blocks to `prompt.json` (`--prompt-file` parses `.json` files as
 *     content-block arrays, so images stay out of argv as well).
 *
 *  5. MCP: `<GROK_HOME>/config.toml`, section `[mcp_servers.<name>]`. Same role
 *     as the per-mission CODEX_HOME — TIMON servers are partitioned per
 *     mission, auth stays shared through a symlink.
 *
 *  6. claude/cursor compat TURNED OFF (see `compatToml`). By default the CLI
 *     sucks in the host's `~/.claude/CLAUDE.md`, `~/.claude/skills/`,
 *     `~/.claude.json` (MCP) and `~/.claude/settings.json` (hooks +
 *     permissions): a TIMON agent would inherit the user's personal rules and
 *     MCP servers TIMON never declared, and so would not behave like the same
 *     agent served by another backend.
 *
 *  7. A PRIVATE HOME for the CLI (see `privateHomeEnv`). The compat cells do not
 *     cover everything: grok 1.0.77 still loads the *permission rules* of
 *     `~/.claude/settings.json` and `settings.local.json` (67 rules on the
 *     maintainer's machine, `grok inspect` → permissions.loaded), the user's
 *     subagents of `~/.claude/agents/` and the plugins of `~/.claude/plugins/`,
 *     with every `compat.claude.*` at false. A `deny` or an `ask` written there
 *     for Claude Code applied silently to every grok agent. No setting, no
 *     `CLAUDE_CONFIG_DIR` and no `XDG_CONFIG_HOME` moves that read: the CLI takes
 *     `~` from HOME. So the process runs with HOME pointing at an empty folder of
 *     the mission (`grok inspect`: 0 rule, 0 Claude subagent, 0 plugin) and
 *     everything it starts gets the real one back: its shell through
 *     `[shell_environment_policy] set` (git, ssh, gh, the `timon` CLI find their
 *     files again), its MCP servers through their `env`, and its login shell
 *     through relay rc files that restore HOME and source the user's own.
 *     Auth does not depend on HOME: it lives in GROK_HOME.
 *
 *     Still read, on purpose or out of reach: the project's own
 *     `.claude/settings*.json` (a claude agent reads them too), and Claude's
 *     machine-wide managed settings (`/etc/claude-code/…`), which an
 *     organisation deploys to bind every tool on the machine.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGrokUsage } from './usage.js';
import { manifestBackend } from './manifest.js';

/** What the core reads about this provider (C1, C2): the manifest's entry, the one place it is
 *  written (`manifest.js`; why its values are what they are: `profile.js`). */
const GROK = manifestBackend('grok');

/** Variables of the daemon's environment that move the folder of the host's sign-in. Declared
 *  (C2 bis) so the daemon lets `scratch.link` take the auth from there: an operator who set
 *  `GROK_AUTH_DIR` outside `~/.grok` otherwise saw every grok mission start signed out. */
export const GROK_CREDENTIAL_DIR_ENV = Object.freeze(['GROK_AUTH_DIR']);

/** Source of truth for subscription auth (`grok login`). The scratch folder links
 *  from it, and only from a folder this provider declared (`.grok` of the home, or
 *  the folder `GROK_AUTH_DIR` names): anything else is refused by the daemon and
 *  logged, never followed. */
function grokAuthSource() {
    return process.env.GROK_AUTH_DIR ?? join(homedir(), '.grok');
}

/**
 * The only two modes this CLI can honour headless. Declared to Timon as
 * `permission.supportedModes`: the screens offer only these, the permission
 * ceiling judges the mode an agent really runs in, and any other mode reaches
 * `launch` already resolved to `plan`.
 */
const GROK_SUPPORTED_MODES = ['plan', 'bypassPermissions'];
/**
 * `agent.permission_mode` → grok's `--permission-mode`.
 *
 * ── Why only `plan` and `bypassPermissions` ("always-approve") ─────────────
 *
 * The CLI's other modes send every batch of tool calls through its approval
 * pipeline. Headless, that pipeline has nobody to talk to (no
 * `--permission-prompt-tool`, and its ACP mode never sends
 * `session/request_permission` either), and it does not merely fail politely:
 *
 *  1. LATENCY. In `auto`, the CLI submits the batch to its safety check before
 *     running it. Measured on grok 1.0.5 (gap between
 *     `shell.turn.inference_done` and `shell.tool.exec_done` in
 *     `<GROK_HOME>/logs/unified.jsonl`): 6 to 12 s per batch, for tools that
 *     then run in 0–200 ms. Over a four-batch turn, that is ~40 s of pure
 *     latency.
 *  2. KILLED TURNS. When that check hits a call it cannot decide on, the call
 *     is cancelled (`User cancelled the execution for tool`) AND the whole turn
 *     stops: `result.stop_reason = "cancelled"`, exit 1, mission
 *     `failed`/`crash`. No Allow/Deny card, no resume. Reproduced outside TIMON
 *     with a dummy MCP server — three parallel `use_tool` calls are enough to
 *     trigger the cancellation, a single one goes through.
 *
 * So no guarded mode is usable as such, and raising one to always-approve
 * would hand the agent more than it was given. The mapping is fail-closed, the
 * same rule the daemon applies to `supportedModes`: an explicit
 * `bypassPermissions` gets always-approve, everything else (`default`, `auto`,
 * `acceptEdits`, `dontAsk`, another dialect's word, nothing) runs in `plan`,
 * which runs no tool and so has nothing to get approved. Applied here too so
 * the plugin stays read-only on a daemon that does not resolve the mode. The
 * `--deny` rules below stay in force under always-approve (deny wins over
 * everything else).
 */
function permissionModeForGrok(permissionMode) {
    if (permissionMode === 'bypassPermissions')
        return 'bypassPermissions';
    return 'plan';
}
/**
 * Hard guardrails, applied whatever the mode — a `deny` wins over automatic
 * approval, over `allow` rules and over remembered grants. This is the
 * counterpart of automatic approval: we no longer arbitrate case by case, so we
 * forbid outright what no agent has a legitimate reason to do.
 *
 * Deliberately short: every superfluous rule removes a capability with no right
 * of appeal (there is no channel to ask for an exception). Syntax: that of
 * `--deny` (user-guide/22, "Rule Matching Reference").
 */
const GROK_DENY_RULES = [
    // Recursive destruction outside the project's perimeter.
    'Bash(rm -rf /*)',
    'Bash(rm -rf ~*)',
    'Bash(rm -rf $HOME*)',
    // Privilege escalation and machine-level operations.
    'Bash(sudo *)',
    'Bash(mkfs*)',
    'Bash(shutdown*)',
    'Bash(reboot*)',
    // A task runs UNDER the orchestrator: restarting it kills its own mission
    // mid-flight (see AGENTS.md rule 1). That is ops, never agent work.
    'Bash(systemctl --user restart timon-orchestrator*)',
    'Bash(systemctl --user stop timon-orchestrator*)',
    // The ancestor's unit, for the opposite reason: it is stopped and disabled,
    // but still `loaded`, so an explicit start would bring it back up and let it
    // write into the archive's home, frozen because it holds data no other
    // copy has (AGENTS.md rule 3). public-name-ok: the archive guard refuses it by name
    'Bash(systemctl --user restart pkos-orchestrator*)',
    'Bash(systemctl --user stop pkos-orchestrator*)',
    'Bash(systemctl --user start pkos-orchestrator*)',
];
export { permissionModeForGrok, GROK_DENY_RULES, GROK_SUPPORTED_MODES };

/**
 * Turns off discovery of the host's Claude Code and Cursor configurations.
 * Every cell defaults to `true`; setting them to `false` is the only way to get
 * an agent whose context comes ENTIRELY from TIMON.
 *
 * `agents = false` does NOT hide the repository's own `CLAUDE.md` /
 * `AGENTS.md` (the CLI recognises them as generic instruction files): that is
 * intended, a claude agent reads them too.
 */
function compatToml() {
    return [
        '[compat.claude]',
        'skills = false',
        'rules = false',
        'agents = false',
        'mcps = false',
        'hooks = false',
        '',
        '[compat.cursor]',
        'skills = false',
        'rules = false',
        'agents = false',
        'mcps = false',
        'hooks = false',
        '',
    ].join('\n');
}
/** The mission's folder grok takes for `~` (relative to GROK_HOME). */
const PRIVATE_HOME_DIR = 'home';
/**
 * The variables a program reads its home from: HOME everywhere, USERPROFILE too on Windows, where
 * Git Bash and most native tools look there first.
 *
 * @param {NodeJS.Platform} platform
 */
function homeEnvKeys(platform) {
    return platform === 'win32' ? ['HOME', 'USERPROFILE'] : ['HOME'];
}
/**
 * The home variables as `value` for each of them.
 *
 * @param {string} value
 * @param {NodeJS.Platform} platform
 * @returns {Record<string, string>}
 */
function homeEnv(value, platform) {
    return Object.fromEntries(homeEnvKeys(platform).map((key) => [key, value]));
}
/**
 * The grok process's own home: the mission's empty folder, so that `~/.claude` names nothing
 * (see 7. above). Only the CLI sees it; `realHomeEnv` gives the user's back to its children.
 *
 * @param {string} privateHome
 * @param {NodeJS.Platform} [platform]
 */
function privateHomeEnv(privateHome, platform = process.platform) {
    return homeEnv(privateHome, platform);
}
/** The user's real home, for everything grok starts. @param {NodeJS.Platform} [platform] */
function realHomeEnv(platform = process.platform) {
    return homeEnv(homedir(), platform);
}
/** A value as a POSIX shell single-quoted word: nothing inside is expanded. @param {string} value */
function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
/**
 * The rc files of the private home. grok captures its login shell's environment for its bash tool,
 * and that shell starts under the CLI's HOME: without these relays it would read no rc file of the
 * user's, and an agent would lose what they put on PATH there (nvm, Homebrew). Each one puts the
 * real HOME back, then sources the file the shell would have read, so the shell ends up exactly as
 * under the user's home. zsh reads the rest of its files from ZDOTDIR.
 *
 * @param {string} realHome
 * @returns {Record<string, string>}
 */
function relayRcFiles(realHome) {
    const restore = `# Written by Timon: grok runs with a private HOME so it cannot read ~/.claude.\nexport HOME=${shellQuote(realHome)}\n`;
    const source = (/** @type {string} */ name) => `if [ -f "$HOME/${name}" ]; then . "$HOME/${name}"; fi\n`;
    return {
        // bash as a login shell reads the first of these three, and only it.
        '.bash_profile': `${restore}if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"; elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login"; elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi\n`,
        '.profile': restore + source('.profile'),
        '.bashrc': restore + source('.bashrc'),
        '.zshenv': `${restore}export ZDOTDIR="$HOME"\n${source('.zshenv')}`,
    };
}
/**
 * `[shell_environment_policy]`: grok forces these values into the environment of the commands its
 * shell runs, so the agent's `git`, `ssh` or `timon` see the user's home, not the CLI's. A TOML
 * basic string takes JSON's string syntax.
 *
 * @param {Record<string, string>} env
 */
function shellPolicyToml(env) {
    const pairs = Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ');
    return ['[shell_environment_policy]', `set = { ${pairs} }`, ''].join('\n');
}
/**
 * The plan's stdio servers with the user's home: grok starts them with its own environment, whose
 * HOME is the private one. A server that sets its own home keeps it.
 *
 * @param {ReadonlyArray<import('@timon-ai/sdk/provider').ProviderMcpPlan['servers'][number]>} servers
 * @param {Record<string, string>} home
 */
function withRealHome(servers, home) {
    return servers.map((server) => server.type === 'stdio'
        ? { ...server, env: { ...home, ...server.env } }
        : server);
}
export { privateHomeEnv, realHomeEnv, relayRcFiles, PRIVATE_HOME_DIR };

/**
 * The plan's servers without the mission's token. The CLI starts its MCP servers with its own environment,
 * which already carries the token (the daemon gives it to an official provider's process): the file on disk
 * names no credential, as it never did. Copilot keeps the same rule by writing `${TIMON_API_TOKEN}`.
 *
 * @param {import('@timon-ai/sdk/provider').ProviderMcpPlan} plan
 */
function withoutToken(plan) {
    const tokenRef = plan.identityEnv.TIMON_API_TOKEN;
    if (tokenRef === undefined)
        return plan.servers;
    return plan.servers.map((server) => server.type === 'stdio'
        ? { ...server, env: Object.fromEntries(Object.entries(server.env).filter(([, value]) => value !== tokenRef)) }
        : server);
}
/**
 * The base of the mission's `config.toml`: the discovery switches, the real home for the
 * agent's shell, then the servers Timon composed for this mission (`ctx.provider.mcp`,
 * serialized in grok's TOML). The mission's token is not in it (see `withoutToken`): this
 * plugin never holds it.
 *
 * @param {string | null} servers
 * @param {Record<string, string>} realHome
 */
function configToml(servers, realHome) {
    return [compatToml(), shellPolicyToml(realHome), servers ?? ''].join('\n');
}

/**
 * ACP content blocks for a multimodal turn, written to `<GROK_HOME>/prompt.json`
 * and passed via `--prompt-file` (which dispatches `.json` files to the CLI's
 * content-block JSON parser without sending base64 through argv).
 *
 * @param {string} message
 * @param {Array<{ media_type: string, data: string }>} images
 * @returns {string}
 */
function promptJson(message, images) {
    const blocks = [];
    if (message)
        blocks.push({ type: 'text', text: message });
    for (const img of images) {
        blocks.push({ type: 'image', data: img.data, mimeType: img.media_type });
    }
    return JSON.stringify(blocks);
}

/**
 * HTTP status of an API error buried in a `result`'s `errors[]`, or null.
 *
 * The CLI does not surface the status as a field: it stringifies the whole
 * error, JSON included, into an entry of that array:
 *
 *   "Internal error: {\n  \"message\": \"API error (status 402 Payment
 *    Required): Grok Build usage balance exhausted\",\n  \"http_status\": 402\n}"
 *
 * Hoisting it to `api_error_status` (the field every other dialect fills) is
 * what lets `rate-limit.ts` conclude on an INTEGER. On the night of
 * 2026-09-01, five missions died in 295 ms each on that very message without
 * any fallback firing: the sentence matched no pattern, and the only usable
 * signal was sitting inside a string nobody opened.
 *
 * A regex fallback backs up the JSON parse, because the wrapping prose
 * ("Internal error: …") is not part of any contract.
 */
function apiErrorStatusFromErrors(errors) {
    if (!Array.isArray(errors))
        return null;
    for (const entry of errors) {
        if (typeof entry !== 'string')
            continue;
        const start = entry.indexOf('{');
        const end = entry.lastIndexOf('}');
        if (start !== -1 && end > start) {
            try {
                const parsed = JSON.parse(entry.slice(start, end + 1));
                const status = parsed?.http_status;
                if (typeof status === 'number' && Number.isInteger(status))
                    return status;
            }
            catch { /* not JSON, fall through to the regex */ }
        }
        const m = /"?http_status"?\s*[:=]\s*(\d{3})/.exec(entry)
            ?? /\(status (\d{3})\b/.exec(entry);
        if (m?.[1])
            return Number(m[1]);
    }
    return null;
}

/**
 * The Grok Build provider, written against `ctx.provider` only. Everything it needs
 * from the daemon arrives through `services`: the MCP servers of the mission, the
 * private folder it keeps per mission, the codecs and the OAuth store.
 *
 * @param {import('@timon-ai/sdk/provider').ProviderServices} services `ctx.provider`
 * @param {{ warn(...args: unknown[]): void }} log `ctx.log`
 * @returns {import('@timon-ai/sdk/provider').NativeProviderDefinition}
 */
export function createGrokProvider(services, log) {
    const { runtime } = services;
    const { getGrokUsage } = createGrokUsage(runtime);

    /**
     * Builds (or refreshes) the mission's GROK_HOME and returns its folder. Idempotent:
     * called again on every turn, it rewrites config.toml and the rules so that enabling
     * an MCP server or editing the system prompt takes effect on the next turn with no
     * intervention.
     */
    async function ensureGrokHome(opts) {
        const scratch = await services.scratch.mission(opts);
        // auth.json → the host's ~/.grok/auth.json. Without it the CLI asks for a
        // browser login again, which is impossible from a mission. The scratch folder
        // tries a symbolic link, then a hard link, then a copy: Windows without the
        // privilege refuses the first.
        const authSrc = join(grokAuthSource(), 'auth.json');
        if (existsSync(authSrc) && !scratch.has('auth.json')) {
            try {
                scratch.link(authSrc, 'auth.json');
            }
            catch (error) {
                log.warn(`grok: the sign-in file could not be exposed to the mission (${error instanceof Error ? error.message : error}) — the CLI will ask to sign in again`);
            }
        }
        // `grepai` and the browser are part of the plan when the cwd carries a `.grepai`
        // or a project browser runs, and the agent's own servers come after them: the
        // daemon removed from the agent's list the ids that would produce a second
        // `[mcp_servers.grepai]` TOML table, invalid for the grok CLI's parser
        // (immediate crash, exit 1, before any answer).
        // `permissionPrompt` stays off: grok has no `--permission-prompt-tool`, so the
        // forms server only serves its forms (a question, the Kanban planner).
        const realHome = realHomeEnv();
        const plan = await services.mcp(opts);
        scratch.writeFile('config.toml', configToml(runtime.mcp.serializeGrokMcpToml(withRealHome(withoutToken(plan), realHome)), realHome));
        // The CLI's private home (see 7. above), rewritten on every turn like the rest: the
        // user's home can move between two turns (a daemon restarted with another HOME).
        for (const [name, content] of Object.entries(relayRcFiles(homedir())))
            scratch.writeFile(join(PRIVATE_HOME_DIR, name), content);
        // System prompt: `$GROK_HOME/rules/` is always scanned, across all projects.
        // A single file, rewritten on every turn.
        scratch.writeFile('rules/timon.md', opts.systemPrompt);
        return scratch;
    }

    return {
        id: 'grok',
        // No multi-turn input: one turn = one process, the rest goes through `-r`.
        transport: { kind: 'process-per-turn' },
        codec: {
            kind: 'lines',
            parseLine(line) {
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch {
                    // Banner or non-JSON line before the stream starts.
                    return [];
                }
                if (parsed === null || typeof parsed !== 'object')
                    return [];
                const obj = parsed;
                const type = typeof obj.type === 'string' ? obj.type : 'unknown';
                // Same as claude: out of the API's raw events we keep only the text. The
                // rest is plumbing that the final `assistant` message sums up, and letting
                // it through would persist it line by line into `events`.
                if (type === 'stream_event')
                    return runtime.streamJson.partialTextDelta(obj);
                // An API error status only exists as text here: we normalise it so the
                // rest of TIMON reads it like any other dialect's. Never overwrites a
                // status the CLI would already have provided.
                if (type === 'result' && obj.is_error === true && obj.api_error_status === undefined) {
                    const status = apiErrorStatusFromErrors(obj.errors);
                    if (status !== null)
                        return [{ type, payload: { ...obj, api_error_status: status } }];
                }
                return [{ type, payload: parsed }];
            },
            extractSessionId: runtime.events.extractInitSessionId,
            writeUserInput() {
                // One shot: the following turns re-spawn through `launch`, images
                // included. The orchestrator never calls this for grok.
            },
        },
        /* No `maxPromptBytes`: the message goes out through `--prompt-file`, never
           through argv (see `launch`). */
        async launch(opts, profile) {
            const grokHome = await ensureGrokHome(opts);
            const args = [
                '--output-format', 'streaming-messages-json',
                // Text deltas during generation (same role as on the claude side:
                // showing the answer as it comes). The extra `stream_event` lines are
                // filtered out in parseLine.
                '--include-partial-messages',
                // A mission must never be interrupted by a CLI update decided in the
                // background.
                '--no-auto-update',
                '--permission-mode', permissionModeForGrok(opts.cfg.permission_mode),
            ];
            // Without `--verbatim`, a message starting with `/` would be read as a CLI
            // command instead of being passed on to the model. A native compaction
            // turn (`session.compact`) is the one message that IS a command: `grok -p
            // /compact -r <id>` compacts the session in place (verified on grok 1.0.13,
            // 28/10/2026: `system/compact_boundary`, then the thread still remembers).
            if (!opts.agentCommand)
                args.push('--verbatim');
            for (const rule of GROK_DENY_RULES)
                args.push('--deny', rule);
            if (opts.cfg.model)
                args.push('-m', opts.cfg.model);
            if (opts.cfg.reasoningEffort)
                args.push('--reasoning-effort', opts.cfg.reasoningEffort);
            if (opts.resumeSession)
                args.push('-r', opts.resumeSession);
            // File rewritten on every turn: the CLI reads it at startup, it does not
            // have to outlive the process. Multimodal turns write ACP blocks to `.json`
            // so `--prompt-file` invokes the CLI's JSON parser without touching argv.
            const promptPath = opts.images?.length
                ? grokHome.writeFile('prompt.json', promptJson(opts.message, opts.images))
                : grokHome.writeFile('prompt.txt', opts.message);
            args.push('--prompt-file', promptPath);
            return {
                cmd: profile.cmd,
                args,
                cwd: opts.cfg.cwd,
                // GROK_HOME and the private home first (per mission), then the profile's env.
                env: { GROK_HOME: grokHome.path, ...privateHomeEnv(grokHome.resolve(PRIVATE_HOME_DIR)), ...profile.env },
                initialStdin: null,
            };
        },
        session: {
            // `<GROK_HOME>/sessions/`: the scratch belongs to the mission. Resumable as
            // long as we stay INSIDE that mission; invisible from a fresh one.
            store: 'per-mission',
            // `/compact` without `--verbatim` (see `launch`).
            compact: { command: '/compact' },
            // One shot but resumable: the per-mission GROK_HOME (hence `sessions/`) is
            // only cleaned up on an explicit kill, and `-r <session_id>` finds the thread
            // there days later (verified on a session from the day before). Net in case
            // the scratch was cleaned: `notFound` + a retry without resume.
            resumable: true,
            /** The CLI exits with an error naming the session it cannot find. This
             *  happens when the mission's GROK_HOME was cleaned up between two turns
             *  (kill then restart): the orchestrator then replays the turn without a
             *  resume. */
            notFound(stderr) {
                return /session not found|no session (with id|found)/i.test(stderr);
            },
        },
        // No approval round trip during the turn: rights are frozen at spawn time by
        // `--permission-mode` plus the `--deny` rules (see permissionModeForGrok and
        // GROK_DENY_RULES). No Allow/Deny card, no classifier — exactly codex's
        // situation, with two modes only: read-only or run-everything.
        permission: { model: 'sandbox', supportedModes: GROK_SUPPORTED_MODES },
        // Two shapes, and only one of them is structured. An API error travels as
        // JSON inside `errors[]` and carries its `http_status`, which `parseLine`
        // hoists to `api_error_status` — that is what makes a 402 (no credit left)
        // detectable on an integer rather than on a sentence. A SUBSCRIPTION limit,
        // on the other hand, is still a plain sentence with no window and no reopen
        // time. So this stays `textual`: the flag qualifies SILENCE and drives the
        // "unknown window" wording (cf. describeInterruption), and claiming
        // `structured` would promise a reopen time this CLI never gives.
        limits: { reporting: 'textual' },
        mcp: { timon: true },
        // `options.force`: a person's ↻ (`UsageProbeOptions`), which skips the cache and a cached failure.
        usage: { probe: async (_profile, options) => getGrokUsage({ force: options?.force === true }) },
        declares: {
            binary: GROK.binary,
            credentialDirs: GROK.credentialDirs,
            credentialDirEnv: GROK_CREDENTIAL_DIR_ENV,
            spans: 'stream-json',
            // No hosted connector: the agent only has the MCP servers TIMON wrote into
            // the mission's config.toml (discovery of the host's claude.ai MCP servers is
            // explicitly turned off, see compatToml).
            hostedConnectors: false,
        },
    };
}
