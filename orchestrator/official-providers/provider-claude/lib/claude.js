import { randomUUID } from 'node:crypto';
import { claudeThinking } from './thinking.js';
import { claudeAccountEnv } from './token.js';
import { claudeLoginDriver } from './login.js';
import { manifestBackend } from './manifest.js';

/**
 * A `readOnlyTools` launch offers NO built-in tool: no command, no write, no fetch, and no file read
 * either — a reader could copy a secret off the disk into what the mission writes (TODO #471). Only
 * the servers of `--mcp-config` stay: `--strict-mcp-config` drops the user's, the project's and the
 * account's own. `--tools=` keeps the empty value in one argument, which a Windows `.cmd` shim
 * would drop if it were a separate `""`.
 */
export const NO_TOOLS_ARGS = Object.freeze(['--tools=', '--strict-mcp-config']);

/** What the core reads about this provider (C1, C2); why its values are what they are: `profile.js`. */
const CLAUDE = manifestBackend('claude');

/** The persistent Claude stream-json protocol, entirely against ctx.provider. */
export function createClaudeProvider(services, token, usage) {
 const runtime = services.runtime;
 const { streamJsonUser, partialTextDelta } = runtime.streamJson;
 const { extractInitSessionId, providerRetryEvent } = runtime.events;
 const { streamJsonSpans } = runtime.spans;
 const { getClaudeUsage, getClaudeAccountUsage, claudeAuthStatus } = usage;
 const { claudeSpawnEnv } = token;
const CONTROL_TIMEOUT_MS = 10_000;
const pendingControl = new Map();
function settleControl(requestId, ok) {
    const p = pendingControl.get(requestId);
    if (!p)
        return false;
    pendingControl.delete(requestId);
    p.settle(ok);
    return true;
}

async function buildArgs(opts, thinkingArgs) {
 const cfg = opts.cfg;
 const scratch = await services.scratch.mission(opts);
 scratch.writeFile('system-prompt.md', opts.systemPrompt);
 const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
   '--append-system-prompt-file', scratch.resolve('system-prompt.md'), '--verbose', '--include-partial-messages'];
 if (cfg.model) args.push('--model', cfg.model);
 args.push(...thinkingArgs);
 if (cfg.permission_mode) args.push('--permission-mode', cfg.permission_mode);
 const prompts = opts.timonMcp !== false && (cfg.permission_mode ?? 'auto') !== 'bypassPermissions';
 const plan = await services.mcp(opts, { permissionPrompt: prompts });
 const search = plan.webSearch;
 const allowed = [...(cfg.allowed_tools ?? []), ...plan.preApprovedTools];
 if (search?.mode === 'parallel' && search.preApproved) allowed.push('mcp__timon-parallel-search__web_search');
 args.push('--allowedTools', [...new Set(allowed)].join(','));
 if (opts.oneShot && search?.mode === 'parallel') args.push('--strict-mcp-config');
 // MCP children inherit the mission token. It must never enter argv; user secrets live in a private file.
 const roles = ['user', 'forms', 'timon', 'grepai', 'browser'];
 const servers = [...plan.servers].sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role)).map((server) => {
   if (server.role === 'user' || server.type !== 'stdio') return server;
   const env = { ...server.env };
   delete env.TIMON_API_TOKEN;
   delete env.TIMON_MISSION_ID;
   delete env.TIMON_AGENT;
   return { ...server, env };
 });
 const config = JSON.parse(runtime.mcp.serializeMcpJson(servers) ?? '{"mcpServers":{}}');
 if (config.mcpServers.grepai?.env && !Object.keys(config.mcpServers.grepai.env).length) delete config.mcpServers.grepai.env;
 const mcpJson = JSON.stringify(config);
 // An external server may carry sealed credentials. They are materialised only by the daemon's scratch writer.
 if (servers.some((s) => s.role === 'user')) {
   scratch.writeFile('mcp-config.json', mcpJson);
   args.push('--mcp-config', scratch.resolve('mcp-config.json'));
 } else args.push('--mcp-config', mcpJson);
 if (plan.permissionTool) args.push('--permission-prompt-tool', plan.permissionTool);
 const disallowed = new Set([...(cfg.disallowed_tools ?? []), 'AskUserQuestion', 'Task', 'Agent', 'advisor']);
 if (search && search.mode !== 'native') disallowed.add('WebSearch');
 for (const name of plan.excludedServers ?? []) {
   const slug = name.replace(/[.\s]+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
   disallowed.add(`mcp__${slug}__*`);
 }
 // A mission that must run no shell and read or write no file: the built-in set is emptied, so a tool
 // a later CLI adds (or `PowerShell` on Windows) stays off too. MCP tools are not built-ins and stay.
 if (opts.readOnlyTools) args.push(...NO_TOOLS_ARGS);
 args.push('--disallowedTools', [...disallowed].join(','));
 return args;
}
function withThinkingEnv(env, thinking) {
    return Object.keys(thinking).length ? { ...(env ?? {}), ...thinking } : env;
}
const legacy = {
    id: 'claude',

    localEnv: { names: [], prefixes: ['ANTHROPIC_'] },
    defaultCmd: 'claude',
    persistentProcess: true,
    finishMissionOnExit: true,



    sessionResumable: true,


    sessionStore: 'global',


    permissionModel: 'mcp-bridge',


    rateLimitReporting: 'structured',

    thinkingControls: ['levels', 'budget', 'toggle'],


    hostedConnectors: true,

    // `options.force`: a person's ↻ (`UsageProbeOptions`), which skips the 60 s cache and a cached failure.
    async accountUsage(profile, options) {
        const force = options?.force === true;
        const account = services.account.of(profile);
        if (account) {


            if (process.platform === 'darwin')
                return null;
            return getClaudeAccountUsage(account.configDir, { force });
        }
        if (Object.keys(profile.env).length > 0)
            return null;
        return getClaudeUsage({ force });
    },
    async buildSpawn(opts, profile) {
        const thinking = claudeThinking(opts.cfg.reasoningEffort, await services.modelReasoning(profile, opts.cfg.model));
        const args = await buildArgs(opts, thinking.args);
        if (opts.resumeSession)
            args.push('--resume', opts.resumeSession);
        if (opts.memoryDir)
            args.push('--add-dir', opts.memoryDir);
        const account = services.account.of(profile);
        const env = account ? claudeAccountEnv(account.configDir) : claudeSpawnEnv(profile.env);
        return {
            cmd: profile.cmd,
            args,
            cwd: opts.cfg.cwd,




            env: withThinkingEnv(!account && process.env.CLAUDE_CONFIG_DIR
                ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ...env } : env, thinking.env),
            initialStdin: streamJsonUser(opts.message, opts.images),
        };
    },
    writeUserInput(proc, text, images) {
        proc.stdin.write(streamJsonUser(text, images));
    },
    parseLine(line) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {

            return [];
        }



        if (parsed === null || typeof parsed !== 'object')
            return [];
        const obj = parsed;
        const type = typeof obj.type === 'string' ? obj.type : 'unknown';




        if (type === 'control_response') {
            const resp = obj.response;
            const rid = typeof resp?.request_id === 'string'
                ? resp.request_id
                : typeof obj.request_id === 'string' ? obj.request_id : null;
            if (rid && settleControl(rid, resp?.subtype === 'success'))
                return [];
        }





        if (type === 'stream_event')
            return partialTextDelta(obj);
        // The CLI retries a failed API request itself and says so on each
        // attempt. Read as a `provider_retry`, the turn goes on in the chat
        // instead of looking stalled, and the daemon counts what was spent.
        if (type === 'system' && obj.subtype === 'api_retry') {
            const status = typeof obj.error_status === 'number' ? obj.error_status : null;
            const words = typeof obj.error === 'string' && obj.error ? obj.error : null;
            return [providerRetryEvent({
                attempt: typeof obj.attempt === 'number' ? obj.attempt : null,
                max: typeof obj.max_retries === 'number' ? obj.max_retries : null,
                delayMs: typeof obj.retry_delay_ms === 'number' ? obj.retry_delay_ms : null,
                status,
                cause: [status !== null ? `HTTP ${status}` : null, words].filter(Boolean).join(' ') || 'API request failed',
            })];
        }
        return [{ type, payload: parsed }];
    },
    spans: streamJsonSpans,
    extractSessionId: extractInitSessionId,






    isSessionNotFoundError(stderr) {
        return stderr.includes('No conversation found with session ID');
    },

    async setModel(proc, model) {
        if (!proc.stdin || proc.stdin.destroyed || !proc.stdin.writable)
            return false;
        const requestId = randomUUID();
        const frame = JSON.stringify({
            type: 'control_request',
            request_id: requestId,
            request: { subtype: 'set_model', model },
        }) + '\n';
        return new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                resolve(ok);
            };
            const timer = setTimeout(() => {
                pendingControl.delete(requestId);
                finish(false);
            }, CONTROL_TIMEOUT_MS);


            timer.unref?.();
            pendingControl.set(requestId, { settle: finish });
            try {
                proc.stdin.write(frame, (err) => {
                    if (!err)
                        return;
                    pendingControl.delete(requestId);
                    finish(false);
                });
            }
            catch {
                pendingControl.delete(requestId);
                finish(false);
            }
        });
    },
};

 return {
  id: 'claude', transport: { kind: 'stdio-persistent' },
  launch: legacy.buildSpawn,
  codec: { kind: 'lines', parseLine: legacy.parseLine, extractSessionId: legacy.extractSessionId, writeUserInput: legacy.writeUserInput },
  // `/compact` as a stream-json user message compacts the live session in place
  // (verified on Claude Code 2.1.310, 28/10/2026): `system/status` compacting,
  // `system/compact_boundary`, then a `result` with an empty text.
  session: { store: 'global', resumable: true, notFound: legacy.isSessionNotFoundError, setModel: legacy.setModel, compact: { command: '/compact' } },
  permission: { model: 'mcp-bridge' }, limits: { reporting: 'structured' }, mcp: { timon: true },
  reasoning: { controls: ['levels', 'budget', 'toggle'] }, usage: { probe: legacy.accountUsage },
  // The binary and the sign-in folder: the manifest's entry, the one place they are written (`manifest.js`).
  declares: { binary: CLAUDE.binary,
    credentialDirs: CLAUDE.credentialDirs, hostedConnectors: true, spans: 'stream-json', localEnv: legacy.localEnv,
    accounts: { login: claudeLoginDriver }, protocols: ['anthropic'], oneShot: { model: 'sonnet' },
    // Async: on macOS the sign-in lives in the keychain.
    authStatus: claudeAuthStatus },
 };
}
