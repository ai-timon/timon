/**
 * "codex" provider — Codex CLI, one shot per turn.
 *
 * `codex exec --json` runs non-interactively, takes the prompt as argv (or
 * stdin), emits JSONL events to stdout, then exits. Multi-turn = re-spawn
 * via `codex exec resume <thread_id> <prompt>`.
 *
 * To keep the orchestrator + UI ignorant of Codex's native event shapes,
 * `parseLine` rewrites Codex events into the Claude stream-json vocabulary
 * the rest of TIMON already speaks (`system:init`, `assistant`, `result`,
 * etc.). The mapping is lossy on purpose — we only surface what the UI
 * actually consumes (text, tool calls, usage, errors). See `events.js`.
 *
 * Permissions: Codex has no interactive approval flow in exec mode (the
 * stream is one-way). Sandboxing is hard, configured via `--sandbox`. We
 * map the agent's `permission_mode` to a sandbox mode so the agent config
 * surface stays uniform across backends.
 *
 * MCP: Codex reads MCP servers from `<CODEX_HOME>/config.toml`. We write a
 * per-mission CODEX_HOME with a fresh config.toml + linked auth.json
 * (so the ChatGPT subscription cookie is shared across missions but the
 * MCP set is cloistered per agent).
 *
 * Providers: that same config.toml is the injection point for a custom
 * provider (`[model_providers.<id>]`) declared by a profile — see the
 * product's profile table. The provider knows none by heart, it materialises
 * whatever it is handed.
 *
 * Written against `ctx.provider` only (`docs/PROVIDERS-SDK.md` § 11.1, volet 5e): Timon's MCP servers,
 * the mission's private folder, the account a launch runs on, the git folders a sandbox must open, the
 * base environment, the program's version and the pictures the CLI generated all come from the daemon.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexApiKey, codexAuthPath, inspectCodexAuth } from './auth.js';
import { codexContextSnapshot } from './context.js';
import { mapCodexEvent } from './events.js';
import { codexAccountLevels, codexAccountSlugs } from './models-cache.js';
import { createCodexUsage } from './usage.js';
import { codexLoginDriver } from './login.js';
import { manifestBackend } from './manifest.js';

/** What the core reads about this provider (C1, C2): the manifest's entry, the one place it is
 *  written (`manifest.js`; why its values are what they are: `profile.js`). */
const CODEX = manifestBackend('codex');
/** Variables of the daemon's environment that move the folder of the host's sign-in: the CLI's own
 *  error message tells people to set `CODEX_AUTH_DIR`, and a mission must keep finding it there. */
export const CODEX_CREDENTIAL_DIR_ENV = Object.freeze(['CODEX_AUTH_DIR']);

/** How many missions' folders the provider remembers for `enrich`, oldest forgotten first. */
const REMEMBERED_MISSIONS = 256;

/** Exported for the test: `dst` is a symlink that does not lead to `src`. */
export function linksElsewhere(dst, src) {
    try {
        if (!lstatSync(dst).isSymbolicLink())
            return false;
    }
    catch {
        return false;
    }
    try {
        return realpathSync(dst) !== realpathSync(src);
    }
    catch {
        // Dangling: whatever it pointed to is gone.
        return true;
    }
}

function parseVersion(text) {
    return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0] ?? null;
}

function olderThan(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0))
            return (pa[i] ?? 0) < (pb[i] ?? 0);
    }
    return false;
}

/** TOML string escaping (JSON is a strict subset of TOML's basic-string
 *  syntax — same convention as `tomlString` in mcp.ts). */
function toml(v) {
    return JSON.stringify(v);
}

/** `[sandbox_workspace_write]` of the per-mission config.toml.
 *
 *  `network_access = true` under workspace-write. Without it, the codex sandbox cuts outbound
 *  networking → the `timon` CLI (and the `timon` MCP server, both HTTP clients of the orchestrator
 *  on localhost) fail with "fetch failed": a GPT agent could neither create nor close a task, nor
 *  notify, nor ask the human anything. (Inert outside workspace-write; under danger-full-access
 *  the network is already open, under read-only it is ignored.)
 *
 *  `writable_roots`: git directories to make writable so that the agent can commit. Codex's
 *  `workspace-write` sandbox mounts the git directory as a READ-ONLY bind, even when `.git`
 *  physically sits inside the writable cwd — a guardrail against history rewriting, enforced by
 *  bwrap/Landlock, hence at kernel level and not bypassable from the agent. Declaring the
 *  directory in `writable_roots` lifts the block — it is the only lever. Without it, a codex agent
 *  (GPT, but also DeepSeek/Kimi through Ollama Cloud, which go through this same provider) can
 *  edit the files of a `code` task but never commit them. The daemon resolves them
 *  (`ctx.provider.git.writableRoots`): git itself, so a worktree, a subfolder and an externalised
 *  `.git` are covered. */
function sandboxToml(gitRoots) {
    return [
        '[sandbox_workspace_write]',
        'network_access = true',
        ...(gitRoots.length > 0 ? [`writable_roots = [${gitRoots.map(toml).join(', ')}]`] : []),
        '',
    ].join('\n');
}

/** Root keys of the file. They MUST come before any table: in TOML, a
 *  key/value pair written after a `[header]` belongs to that table, not to the
 *  root (a pitfall lived through — the key landed in
 *  `[mcp_servers.timon.env]` and codex refused to load the config).
 *
 *  `experimental_use_freeform_apply_patch = false` on third-party providers:
 *  otherwise codex exposes `apply_patch` as a `{"type":"custom"}` (freeform)
 *  tool, a type specific to the OpenAI API. The backends serving some models
 *  behind Ollama Cloud reject it — `invalid tool type: custom`, which becomes
 *  `function name is empty` as soon as there are other tools in the request.
 *  The mission dies on the first turn, 0 tokens, before even having read its
 *  brief (observed 3 times out of 3 on minimax-m3, bench of 2026-08-04; the
 *  same model answers normally once the flag is set). Left active for codex
 *  agents on OpenAI, where freeform is the optimal path. */
function providerRootToml(provider) {
    if (!provider)
        return '';
    return [
        `model_provider = ${toml(provider.id)}`,
        'experimental_use_freeform_apply_patch = false',
        '',
    ].join('\n');
}

/** `[windows]` table of the per-mission config.toml — empty off Windows.
 *
 *  Without `[windows] sandbox`, codex resolves its Windows sandbox to
 *  "disabled", and then refuses every shell command of a `read-only` or
 *  `workspace-write` turn under `approval_policy = never`: "blocked by policy",
 *  before the process even starts (TIM-0062 — a plan-mode agent could not run a
 *  single `Get-Content`). The user's `~/.codex/config.toml` may carry the key,
 *  but the mission home is a fresh one.
 *
 *  `unelevated`, never `elevated`, whatever the user picked for their own
 *  codex: the elevated backend keeps its setup marker and the passwords of the
 *  machine-wide `CodexSandboxOffline`/`Online` accounts per CODEX_HOME. A fresh
 *  mission home would therefore re-provision on every mission (one UAC prompt
 *  nobody answers in an unattended mission), and each provisioning rotates the
 *  passwords the user's own `~/.codex` relies on. Codex rejects junctions on
 *  those directories, so sharing them is not an option either. `unelevated`
 *  only sets ACLs as the current user. */
export function windowsSandboxToml(platform = process.platform) {
    if (platform !== 'win32')
        return '';
    return ['[windows]', `sandbox = ${toml('unelevated')}`, ''].join('\n');
}

/** The git folders the `[sandbox_workspace_write]` table opens, per platform — none on Windows.
 *
 *  Codex protects `<root>/.git` read-only under every writable root, and follows a worktree's
 *  `gitdir:` pointer to protect the folder it names. Every git root we declare therefore sits under,
 *  or on, one of those carve-outs: `.git` under the repository, the worktree's gitdir under the
 *  worktree's own pointer. Linux (bwrap) and macOS (Seatbelt) reopen such a descendant, which is what
 *  lets a codex agent commit. The Windows sandbox cannot: elevated and unelevated alike refuse the
 *  whole turn ("cannot reopen writable descendants under read-only carveouts directly; refusing to run
 *  unsandboxed", codex-cli 0.159), so not one command of a `workspace-write` mission ran in a git
 *  repository (TIM-0121). Without the roots the turn runs; only `git commit` stays refused by codex's
 *  own `.git` guard, which `bypassPermissions` (danger-full-access) lifts. */
export function workspaceWriteRoots(gitRoots, platform = process.platform) {
    return platform === 'win32' ? [] : gitRoots;
}

/** `[model_providers.<id>]` table of a custom provider.
 *
 *  Two constraints verified empirically on codex-cli 0.130 (see
 *  docs/BACKEND_PROFILES.md):
 *    - some IDs are RESERVED for built-in providers (`ollama` points hard-coded
 *      at http://localhost:11434/v1) and redeclaring them makes loading
 *      config.toml fail → a cloud profile must take another id;
 *    - `wire_api = "chat"` is no longer supported and makes startup fail; only
 *      `"responses"` goes through. */
function providerTableToml(provider) {
    if (!provider)
        return '';
    return [
        `[model_providers.${provider.id}]`,
        `name = ${toml(provider.name)}`,
        `base_url = ${toml(provider.baseUrl)}`,
        `env_key = ${toml(provider.envKey)}`,
        `wire_api = ${toml(provider.wireApi)}`,
        '',
    ].join('\n');
}

/**
 * The plan's servers without the mission's token. Codex does not let its MCP servers inherit its
 * environment, so Timon's servers ask for the variable BY NAME (`env_vars = ["TIMON_API_TOKEN"]`,
 * `serializeCodexMcpToml`'s `forward`), and the file on disk names no credential, as it never did.
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

/** The servers that ask codex for the mission's token, by name: Timon's own and the project's browser. */
const TOKEN_ASKERS = new Set(['timon', 'forms', 'browser']);

/** MIME → file extension for attached images. Codex infers the format from the
 *  content, but a correct extension avoids ambiguity. */
const IMAGE_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

/** Writes the current turn's base64 images as files under
 *  <CODEX_HOME>/images/ and returns their absolute paths. `codex exec` has no
 *  inline base64 input like claude's stream-json: it needs files on disk passed
 *  through `-i <FILE>`. The files live in the per-mission CODEX_HOME, cleaned
 *  up with it when the mission is killed. Unique names (uuid) → no collision
 *  between turns.
 *
 * @param {import('@timon-ai/sdk/provider').ProviderScratchDir} scratch
 * @param {Array<{ media_type: string, data: string }> | undefined} images
 * @returns {string[]}
 */
function writeTurnImages(scratch, images) {
    if (!images || images.length === 0)
        return [];
    const paths = [];
    for (const img of images) {
        const ext = IMAGE_EXT[img.media_type?.toLowerCase()] ?? 'png';
        paths.push(scratch.writeFile(`images/${randomUUID()}.${ext}`, Buffer.from(img.data, 'base64')));
    }
    return paths;
}

/** Positional the CLI reads as "the prompt is on stdin". Documented on both
 *  `codex exec` and `codex exec resume`. */
const STDIN_PROMPT = '-';
/**
 * The features a `readOnlyTools` launch switches off (TODO #469, #471), checked on codex-cli 0.159:
 * `shell_tool` and `unified_exec` are the shell (`exec_command`); `view_image` reads a file from any
 * path; `apps` and `plugins` are the account's ChatGPT connectors and the plugin installer, servers
 * the daemon never vouched for; `image_generation` sends what the mission read out. The web tool
 * (`web__run`) is a configuration key, not a feature: `web_search=disabled`. What stays reads no
 * file: the JS runtime of `exec` has no file system, the rest are Timon's MCP servers. An unknown
 * feature name stops codex at launch, never a launch with a tool left on.
 */
export const READ_ONLY_DISABLED_FEATURES = Object.freeze(['shell_tool', 'unified_exec', 'view_image', 'apps', 'plugins', 'image_generation']);

function combineSystemAndUser(systemPrompt, message) {
    // No --append-system-prompt in codex exec. We prepend the system prompt
    // to the user message under an "# Instructions" header so the model
    // treats it as durable scaffolding rather than a one-off ask.
    return `# Instructions\n${systemPrompt}\n\n# Task\n${message}`;
}

/**
 * The Codex provider, written against `ctx.provider` only.
 *
 * @param {import('@timon-ai/sdk/provider').ProviderServices} services `ctx.provider`
 * @param {{ warn(...args: unknown[]): void }} log `ctx.log`
 * @returns {import('@timon-ai/sdk/provider').NativeProviderDefinition}
 */
export function createCodexProvider(services, log) {
    const { runtime } = services;
    const { getCodexAccountUsage, getCodexUsage } = createCodexUsage(runtime);
    /** `codex --version`, once per daemon lifetime; null when unknown. */
    let cliVersion;
    /** Where each mission's CODEX_HOME is and when its running turn started: the `result` goes looking for the rollout and the pictures there. */
    const turns = new Map();
    const remember = (missionId, entry) => {
        turns.delete(missionId);
        turns.set(missionId, entry);
        for (const old of turns.keys()) {
            if (turns.size <= REMEMBERED_MISSIONS)
                break;
            turns.delete(old);
        }
    };

    /**
     * Refuses to spawn a CLI older than the profile's `minCliVersion`, with the
     * command that fixes it. An unreadable version (no binary, odd output) is
     * not a verdict: the spawn goes ahead and fails on its own terms.
     */
    async function assertCliVersion(cmd, min) {
        if (!min)
            return;
        if (cliVersion === undefined) {
            try {
                cliVersion = parseVersion(await services.binary.version(CODEX.binary.names[0]) ?? '');
            }
            catch {
                cliVersion = null;
            }
        }
        if (cliVersion && olderThan(cliVersion, min)) {
            throw new Error(`${cmd} CLI ${cliVersion} is older than ${min}, the oldest version known to accept the current model list. `
                + 'Update it (npm install -g @openai/codex@latest) and send the message again.');
        }
    }

    /**
     * Builds (or refreshes) the per-mission CODEX_HOME and returns its folder. Idempotent —
     * re-callable on follow-up turns of the same mission. The base Timon config (network + the
     * timon/timon_ask MCP servers, the project's index and browser, the agent's own servers) is
     * always written, and the profile's provider block (if there is one) is added without touching it.
     */
    async function ensureCodexHome(opts, profile, { useAuthFile, accountAuth }) {
        const scratch = await services.scratch.mission(opts);

        // auth.json → the sign-in of the host (or of the subscription account). A symlink keeps the
        // mission in step with the host's token refreshes. On Windows creating one needs a privilege
        // most accounts lack, and the old silent `catch` let the mission start without credentials:
        // codex answered 401 and the tester had no clue (TIM-0009). A hard link is the next best
        // thing (same volume, follows rewrites in place); a copy is the floor, and failing all
        // three is an error worth reading (`scratch.link` walks that chain).
        // A subscription account (TODO #52) links its own sign-in instead. A link left by an
        // earlier turn on another sign-in is replaced, including a hard link or copy. Remember the
        // source, not its contents: a credential refreshed by the CLI stays valid on the same account.
        const authSrc = accountAuth ?? codexAuthPath();
        if (useAuthFile && existsSync(authSrc)) {
            const source = realpathSync(authSrc);
            let previousSource;
            try { previousSource = readFileSync(scratch.resolve('.timon-auth-source'), 'utf8'); }
            catch { /* A mission adopted from the old dialect has no source marker yet. */ }
            if (previousSource !== source || linksElsewhere(scratch.resolve('auth.json'), authSrc))
                scratch.remove('auth.json');
            if (!scratch.has('auth.json')) {
                const method = scratch.link(authSrc, 'auth.json');
                if (method === 'copy') {
                    log.warn('codex: auth.json copied into the mission home (no link possible): a login refresh on the host will not reach running missions');
                }
            }
            scratch.writeFile('.timon-auth-source', source);
        }

        // The agent's opt-in servers come after Timon's in the plan; the daemon already removed from
        // them the ids that would produce a second `[mcp_servers.grepai]` table, invalid for the codex
        // CLI's parser. `permissionPrompt` stays off: codex has no `--permission-prompt-tool`, so the
        // forms server only serves its forms (a question, the Kanban planner).
        const plan = await services.mcp(opts);
        const servers = runtime.mcp.serializeCodexMcpToml(withoutToken(plan), {
            forward: (server) => (TOKEN_ASKERS.has(server.role) ? ['TIMON_API_TOKEN'] : []),
        });
        // config.toml. Rewritten every spawn so MCP toggles take effect on the next turn without
        // surgery. The provider's root key first (a TOML constraint), then the Windows sandbox, the
        // base Timon config, the servers, and the custom provider block — each stays independent.
        const gitRoots = workspaceWriteRoots(opts.cfg.cwd ? services.git.writableRoots(opts.cfg.cwd) : []);
        scratch.writeFile('config.toml', [
            providerRootToml(profile.providerConfig),
            windowsSandboxToml(),
            sandboxToml(gitRoots),
            servers ?? '',
            providerTableToml(profile.providerConfig),
        ].join('\n'));

        // `image_gen` writes here (`$CODEX_HOME/generated_images`) and announces nothing: the folder is
        // the only trace, so the turn's `result` goes looking for it (see `enrich`), and the agent may
        // show a picture from it (`chat_show_media`).
        const generated = scratch.resolve('generated_images');
        mkdirSync(generated, { recursive: true });
        services.media.allowShow(opts.missionId, generated);
        return { scratch, webSearch: plan.webSearch };
    }

    return {
        id: 'codex',
        // One turn = one process; the next turn is `codex exec resume <thread_id>`.
        transport: { kind: 'process-per-turn' },
        codec: {
            kind: 'lines',
            parseLine(line) {
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch {
                    return [];
                }
                return mapCodexEvent(parsed);
            },
            extractSessionId: runtime.events.extractInitSessionId,
            writeUserInput() {
                // One-shot backend: follow-ups re-spawn via launch. The orchestrator
                // never calls this for codex — images included, since they are handled in
                // launch (written to files and passed through `-i`) on every turn,
                // initial and resume alike.
            },
        },
        /* No `maxPromptBytes`: the prompt goes out through STDIN (`codex exec -`,
           see launch), never through argv. It used to travel as a positional
           argument, and Linux refuses any argument beyond MAX_ARG_STRLEN = 128 KiB
           — E2BIG, spawn dead before the CLI starts. That forced a ~48 KB cap on
           the message, which in turn forced a LOSSY summary on every backend
           switch out of a conversation of any length: the transport was deciding
           what the context could be. It no longer does. */
        async launch(opts, profile) {
            const { env: base } = await services.env(opts);
            const env = { ...base, ...profile.env };
            let apiKey;
            // A subscription account (TODO #52) runs on its own sign-in only: no key
            // from the environment may stand in for it, nor the host's login.
            const account = services.account.of(profile);
            const accountAuth = account ? join(account.configDir, 'auth.json') : undefined;
            if (account && !existsSync(accountAuth)) {
                throw new Error(`The codex account "${account.name}" is not signed in yet: sign it in before running missions on it.`);
            }
            // A missing local login is a configuration error before any CLI starts,
            // not a provider bounce: it must not trip the shared backend breaker.
            if (!profile.providerConfig && !account) {
                const auth = inspectCodexAuth(env);
                if (!auth.ok)
                    throw new Error(auth.detail);
                if (auth.source === 'environment')
                    apiKey = codexApiKey(env);
            }
            const { scratch, webSearch } = await ensureCodexHome(opts, profile, { useAuthFile: !apiKey && !profile.providerConfig, accountAuth });
            const imagePaths = writeTurnImages(scratch, opts.images);
            remember(opts.missionId, { home: scratch.path, since: Date.now() });
            await assertCliVersion(profile.cmd, profile.minCliVersion);
            const args = ['exec', '--json', '--skip-git-repo-check'];
            if (webSearch && webSearch.mode !== 'native') args.push('-c', 'web_search=disabled');
            // exec-level options: they must come before the `resume` subcommand.
            if (opts.readOnlyTools) {
                // No shell, no write and no file read, whatever the agent's mode: the read-only sandbox
                // refuses `apply_patch`, and the two features ARE the shell tool (`exec_command`).
                args.push('--sandbox', 'read-only');
                for (const feature of READ_ONLY_DISABLED_FEATURES)
                    args.push('--disable', feature);
                args.push('-c', 'web_search=disabled');
            }
            else {
                args.push('--sandbox', runtime.permissions.sandboxLevelForPermissionMode(opts.cfg.permission_mode));
            }
            if (opts.cfg.model)
                args.push('--model', opts.cfg.model);
            if (opts.cfg.reasoningEffort)
                args.push('-c', `model_reasoning_effort=${opts.cfg.reasoningEffort}`);
            // `-` in place of the positional prompt: both `exec` and `exec resume`
            // then read the instructions from stdin, which the runner closes right
            // after writing (one-shot backend → `proc.stdin.end()`).
            if (opts.resumeSession) {
                // codex exec [opts] resume <id> - [-i FILE ...]
                args.push('resume', opts.resumeSession, STDIN_PROMPT);
            }
            else {
                // codex exec [opts] - [-i FILE ...]
                args.push(STDIN_PROMPT);
            }
            // `-i` AFTER the positional prompt: `exec`'s `-i` is variadic (<FILE>...)
            // and would swallow the prompt if it came first. One `-i <path>` repeated
            // per image works for both branches (variadic exec + single-value resume).
            // Codex (fresh and resume alike) then sees the image.
            for (const p of imagePaths)
                args.push('-i', p);
            return {
                cmd: profile.cmd,
                args,
                cwd: opts.cfg.cwd,
                // CODEX_HOME first (per mission, non-negotiable), then the profile's env
                // — typically the key that the provider's `env_key` makes the CLI read.
                env: {
                    CODEX_HOME: scratch.path, ...profile.env, ...(apiKey ? { CODEX_API_KEY: apiKey } : {}),
                    // Blanked: an inherited key would override the account's sign-in.
                    ...(account ? { CODEX_API_KEY: '' } : {}),
                },
                initialStdin: combineSystemAndUser(opts.systemPrompt, opts.message),
            };
        },
        session: {
            // The rollout lives in the per-mission CODEX_HOME: the next turn resumes the thread
            // (`exec resume`), a killed mission included — the daemon keeps the folder until its
            // retention purge (TIM-0111). Measured on codex-cli 0.159.0 (#607): a new process resumes
            // the thread after a clean exit and after a SIGTERM mid-turn, the killed turn's message
            // included. So a closed mission wakes in place, like grok's. Should the rollout be missing
            // all the same (purged, or a backend switch), `notFound` makes the orchestrator replay
            // that turn on a fresh thread and keeps the failure out of the circuit breaker.
            store: 'per-mission',
            resumable: true,
            /** `codex exec resume` exits within ~150 ms naming the thread it cannot find:
             *  `thread/resume failed: no rollout found for thread id <id> (code -32600)`. */
            notFound(stderr) {
                return /no rollout found for thread id/i.test(stderr);
            },
        },
        // `codex exec` is one-way: no approval round trip during the turn. Rights are
        // frozen at spawn time by `--sandbox` (see sandboxLevelForPermissionMode) — no
        // Allow/Deny card, no classifier. The `timon_ask` MCP server is still
        // injected, but only for its forms (a question, the Kanban planner), not to
        // arbitrate a tool use.
        permission: { model: 'sandbox' },
        // A throttle or quota surfaces as `turn.failed`/`error`, normalised into a
        // `result:error` carrying a plain text message: never a window nor a
        // reopening time (see `rate-limit.ts`).
        limits: { reporting: 'textual' },
        mcp: { timon: true },
        usage: {
            // `options.force`: a person's ↻ (`UsageProbeOptions`), which skips the cache and a cached failure.
            async probe(profile, options) {
                const force = options?.force === true;
                // A third-party provider shares the dialect but not the ChatGPT account's quota.
                const account = services.account.of(profile);
                if (account)
                    return getCodexAccountUsage(account.configDir, { force });
                if (profile.providerConfig || Object.keys(profile.env).length > 0)
                    return null;
                return getCodexUsage({ force });
            },
        },
        lifecycle: {
            /** Forgets what is held in memory for the mission. The per-mission folder (config.toml + rollout)
             *  is the daemon's: it outlives a kill, so the thread stays resumable (TIM-0111). */
            dispose(missionId) {
                turns.delete(missionId);
            },
            /** A turn's `result` gains the context snapshot its summed usage cannot give: `context_tokens`
             *  (latest call) and the window the runtime reported, in the `modelUsage` shape the chat already
             *  reads — and the pictures `image_gen` wrote. */
            enrich(ev, missionId) {
                if (ev.type !== 'result')
                    return ev;
                const turn = turns.get(missionId);
                if (!turn)
                    return ev;
                const snap = codexContextSnapshot(turn.home);
                let media = [];
                try {
                    media = services.media.adoptSync(missionId, join(turn.home, 'generated_images'), turn.since);
                }
                catch (error) {
                    // A picture lost is not a turn lost.
                    log.warn(`codex: generated pictures could not be adopted (${error instanceof Error ? error.message : error})`);
                }
                if (!snap && media.length === 0)
                    return ev;
                const payload = ev.payload;
                return {
                    ...ev,
                    payload: {
                        ...payload,
                        ...(snap ? { context_tokens: snap.tokens } : {}),
                        ...(snap?.model && snap.window ? { modelUsage: { [snap.model]: { contextWindow: snap.window } } } : {}),
                        ...(media.length ? { generated_media: media } : {}),
                    },
                };
            },
        },
        declares: {
            binary: CODEX.binary,
            credentialDirs: CODEX.credentialDirs,
            credentialDirEnv: CODEX_CREDENTIAL_DIR_ENV,
            spans: 'stream-json',
            // No hosted connector: the agent only has the MCP servers TIMON declared in
            // the per-mission config.toml.
            hostedConnectors: false,
            /**
             * What a user-added profile may set on this provider (`LocalEnvPolicy`).
             *
             * `OPENAI_` is the family an OpenAI-compatible host reads. `BACKEND_` is
             * Timon's own: `providerConfig.envKey` must be UNIQUE per backend (the key is
             * granted `global`, so every backend's variable sits in the same environment),
             * hence the form files `BACKEND_<ID>_API_KEY`. Nothing on the machine reads
             * that family but the provider block we write for the CLI, which is what
             * makes it safe to open whole. `CODEX_HOME` is not here — it is where the CLI
             * reads its configuration, MCP servers included.
             */
            localEnv: { names: [], prefixes: ['OPENAI_', 'BACKEND_'], renameUnder: 'BACKEND_' },
            // codex nests MCP tools under `exec`, renamed `mcp__timon_browser__*`,
            // while its own web search sits at the top level: told only "the
            // `timon-browser` MCP tools", GPT opened pages with web search instead of
            // Timon's browser in most runs measured on codex-cli 0.159 (TODO #241).
            browserToolsHint: "- **Browser** = Timon's browser, NOT web search. Its tools are `mcp__timon_browser__*`; "
                + 'from `exec` call them as `tools.mcp__timon_browser__navigate_page({ url })`, then `take_snapshot`, '
                + '`click`, `fill`, `take_screenshot`. To go to, open, read, check or search a site, use them; your built-in '
                + 'web search (`web.run`, `open_page`) is not that browser and only finds pages. A browser error is reported '
                + 'as is, never worked around with web search.',
            // A local presence check, not a provider request or a token-expiry verdict.
            authStatus(env) {
                const report = inspectCodexAuth(env);
                return { ok: report.ok, detail: report.detail, signInCommand: report.ok ? null : 'codex login', path: report.path, source: report.source };
            },
            // The models the CLI lists for the signed-in account, read from the file it keeps beside its login.
            modelCache: { slugs: codexAccountSlugs, levels: codexAccountLevels },
            accounts: { login: codexLoginDriver },
            // An endpoint that speaks the OpenAI Responses API is reached through this CLI.
            protocols: ['openai-responses'],
        },
    };
}
