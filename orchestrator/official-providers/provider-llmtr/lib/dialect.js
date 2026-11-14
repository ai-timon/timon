// @ts-check
/**
 * Remote dialect for LLMTR. Codex only accepts `wire_api = "responses"`, and
 * LLMTR's documented gateway is Chat Completions, so this dialect does not
 * ride on Codex and never calls `/v1/responses`.
 *
 * The host is fixed inside `chat.js`. The call goes through the plugin's
 * `ctx.fetch`, which enforces `pluginPolicy.http`. A missing client or a
 * refused host ends the turn and sends nothing. Redirects stay refused, and
 * there is no retry.
 */
import { randomUUID } from 'node:crypto';
import { LLMTR_API_KEY_ENV, llmtrChatCompletion } from './chat.js';

const CAPABILITIES = Object.freeze({ loadSession: false, resume: false, mcp: false, image: false });

/**
 * @param {import('@timon-ai/sdk/provider').ProviderRuntime} runtime
 * @param {{ fetch?: typeof fetch }} [options]
 * @returns {import('@timon-ai/sdk/provider').RemoteDialect}
 */
export function createLlmtrDialect(runtime, options = {}) {
  const { events } = runtime;
  const fetchImpl = options.fetch;

  /**
   * @param {import('@timon-ai/sdk/provider').RemoteSessionOpenArgs} args
   */
  function openSession({ spawn, host, env }) {
    const model = spawn.cfg?.model;
    const apiKey = env[LLMTR_API_KEY_ENV] ?? '';
    /** @type {{ role: string; content: string }[]} */
    const messages = [];
    if (typeof spawn.systemPrompt === 'string' && spawn.systemPrompt.trim() !== '') {
      messages.push({ role: 'system', content: spawn.systemPrompt });
    }
    /** @type {import('@timon-ai/sdk/provider').SessionInfo | null} */
    let info = null;
    let closed = false;
    /** @type {AbortController | null} */
    let running = null;

    const cancelledResult = () => {
      const base = events.resultSuccessEvent();
      return { type: /** @type {'result'} */ ('result'), payload: { .../** @type {Record<string, unknown>} */ (base.payload), subtype: 'cancelled' } };
    };

    return {
      get info() { return info; },

      async start() {
        if (closed) throw new Error('the session is closed');
        if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new Error('LLMTR_API_KEY is not set');
        if (typeof model !== 'string' || model.length === 0) throw new Error('LLMTR model id is missing');
        // Chat Completions has no server session to reopen. A requested resume
        // therefore starts a new conversation instead of claiming the old one.
        const sessionId = randomUUID();
        info = { sessionId, capabilities: CAPABILITIES, resumed: false };
        host.emit(events.systemInitEvent({ sessionId, backend: 'llmtr', model }));
        return info;
      },

      async prompt(text, images) {
        if (closed) throw new Error('the session is closed');
        if (!info || typeof model !== 'string' || model.length === 0) throw new Error('the session is not started');
        if (running) throw new Error('a turn is already running');
        if (images && images.length > 0) {
          host.emit(events.resultErrorEvent({ error: 'LLMTR chat does not accept images' }));
          return { stopReason: 'error' };
        }
        if (typeof fetchImpl !== 'function') {
          host.emit(events.resultErrorEvent({
            error: 'LLMTR cannot reach llmtr.com until that host is allowed in pluginPolicy.http.byPlugin for provider-llmtr, or in pluginPolicy.http.allow.',
          }));
          return { stopReason: 'error' };
        }
        messages.push({ role: 'user', content: text });
        const ctrl = new AbortController();
        running = ctrl;
        try {
          const { text: answer } = await llmtrChatCompletion({
            apiKey, model, messages, fetchImpl, signal: ctrl.signal,
          });
          if (closed) throw new Error('the session was closed');
          if (ctrl.signal.aborted) {
            messages.pop();
            host.emit(cancelledResult());
            return { stopReason: 'cancelled' };
          }
          messages.push({ role: 'assistant', content: answer });
          host.emit(events.assistantTextEvent(answer));
          host.emit(events.resultSuccessEvent());
          return { stopReason: 'end_turn' };
        } catch (err) {
          messages.pop();
          if (closed) throw new Error('the session was closed');
          if (ctrl.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
            host.emit(cancelledResult());
            return { stopReason: 'cancelled' };
          }
          const status = err instanceof Error && 'status' in err && typeof err.status === 'number' ? err.status : undefined;
          const raw = err instanceof Error && err.message ? err.message : 'LLMTR request failed';
          const message = raw.includes(apiKey) ? 'LLMTR refused the request' : raw;
          host.emit(events.resultErrorEvent({ error: message, ...(status !== undefined ? { apiErrorStatus: status } : {}) }));
          return { stopReason: 'error' };
        } finally {
          if (running === ctrl) running = null;
        }
      },

      async cancel() {
        running?.abort();
      },

      close() {
        if (closed) return;
        closed = true;
        running?.abort();
      },
    };
  }

  return {
    id: 'llmtr',
    transport: 'remote',
    // The transcript lives in this process only. A restart has nothing to resume.
    sessionResumable: false,
    sessionStore: 'per-mission',
    permissionModel: 'none',
    // HTTP status is reported on the result (`api_error_status`), including 429.
    rateLimitReporting: 'structured',
    hostedConnectors: false,
    // A chat gateway does not run on this machine: no worktree, no Timon tools.
    capabilities: { worktree: false, timonMcp: false, attachments: false, timonPreamble: false },
    // A user-added file on this dialect may name the key and nothing else.
    localEnv: { names: [LLMTR_API_KEY_ENV], prefixes: [] },
    extractSessionId: events.extractInitSessionId,
    openSession,
  };
}
