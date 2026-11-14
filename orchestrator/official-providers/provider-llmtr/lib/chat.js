// @ts-check
/**
 * LLMTR Chat Completions call.
 *
 * The destination is fixed: `https://llmtr.com/v1/chat/completions`. A redirect
 * is refused and not followed, so the bearer token cannot be sent on to another
 * host. There is no retry. The model id is copied into the body as given,
 * vendor prefix included.
 *
 * This module does not call `GET /v1/models`. That listing is public and says
 * nothing about the key.
 */

export const LLMTR_ORIGIN = 'https://llmtr.com';
export const LLMTR_BASE_URL = 'https://llmtr.com/v1';
export const LLMTR_CHAT_URL = 'https://llmtr.com/v1/chat/completions';
export const LLMTR_MODELS_URL = 'https://llmtr.com/v1/models';
export const LLMTR_DEFAULT_MODEL = 'minimax/minimax-m3.1-flash';
export const LLMTR_API_KEY_ENV = 'LLMTR_API_KEY';

const CHAT_TIMEOUT_MS = 60_000;

export class LlmtrChatError extends Error {
  /**
   * @param {string} message
   * @param {number | undefined} [status]
   */
  constructor(message, status) {
    super(message);
    this.name = 'LlmtrChatError';
    this.status = status;
  }
}

/**
 * Assistant text only. Reasoning parts and `reasoning_content` are not text:
 * a reply that contains nothing else is a failure.
 *
 * @param {unknown} message
 * @returns {string}
 */
export function llmtrAssistantText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = /** @type {{ content?: unknown }} */ (message).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const block = /** @type {{ type?: unknown; text?: unknown }} */ (part);
    return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }).join('');
}

/**
 * @param {string} url
 * @returns {void}
 */
export function assertLlmtrChatUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new LlmtrChatError('LLMTR chat refuses an unreadable URL');
  }
  if (parsed.origin !== LLMTR_ORIGIN || parsed.pathname !== '/v1/chat/completions' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new LlmtrChatError('LLMTR chat refuses a destination other than https://llmtr.com/v1/chat/completions');
  }
}

/**
 * @param {unknown} value
 * @returns {value is { role: string; content: string }}
 */
function isMessage(value) {
  if (!value || typeof value !== 'object') return false;
  const message = /** @type {{ role?: unknown; content?: unknown }} */ (value);
  return typeof message.role === 'string' && message.role.length > 0 && typeof message.content === 'string';
}

/**
 * One Chat Completions request. `fetchImpl` exists so a test can observe the
 * request without a network. The default talks to LLMTR and follows no redirect.
 *
 * @param {{
 *   apiKey: string;
 *   model: string;
 *   messages: readonly { role: string; content: string }[];
 *   maxTokens?: number;
 *   fetchImpl?: typeof fetch;
 *   signal?: AbortSignal;
 * }} options
 * @returns {Promise<{ text: string; model: string }>}
 */
export async function llmtrChatCompletion(options) {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (!apiKey) throw new LlmtrChatError('LLMTR_API_KEY is not set');
  if (typeof options.model !== 'string' || options.model.length === 0) {
    throw new LlmtrChatError('LLMTR model id is missing');
  }
  if (!Array.isArray(options.messages) || options.messages.length === 0 || options.messages.some((message) => !isMessage(message))) {
    throw new LlmtrChatError('LLMTR chat needs at least one message');
  }
  if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1)) {
    throw new LlmtrChatError('LLMTR max_tokens must be a positive whole number');
  }
  assertLlmtrChatUrl(LLMTR_CHAT_URL);
  /** @type {Record<string, unknown>} */
  const body = { model: options.model, messages: options.messages, stream: false };
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(LLMTR_CHAT_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // A policy refusal is not a transport failure: the caller must see it, and
    // must not retry. `PluginPolicyError` is named, not imported: this package
    // cannot reach the daemon.
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.name === 'PluginPolicyError')) throw err;
    throw new LlmtrChatError('LLMTR did not answer');
  }
  if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    await discard(response);
    throw new LlmtrChatError('LLMTR redirected the request; the redirect was not followed', response.status || undefined);
  }
  if (response.status === 401 || response.status === 403) {
    await discard(response);
    throw new LlmtrChatError(`LLMTR refused the API key (HTTP ${response.status})`, response.status);
  }
  if (!response.ok) {
    await discard(response);
    throw new LlmtrChatError(`LLMTR returned HTTP ${response.status}`, response.status);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new LlmtrChatError('LLMTR returned a response that is not JSON', response.status);
  }
  const choice = payload && typeof payload === 'object'
    ? /** @type {{ choices?: unknown }} */ (payload).choices
    : undefined;
  const message = Array.isArray(choice) ? /** @type {{ message?: unknown }} */ (choice[0])?.message : undefined;
  const text = llmtrAssistantText(message);
  if (text.trim() === '') throw new LlmtrChatError('LLMTR returned no assistant text', response.status);
  return { text, model: options.model };
}

/** Drop a body that must never be copied into an error or a log. */
async function discard(response) {
  try {
    await response.arrayBuffer();
  } catch {
    // The status is the only fact we keep.
  }
}
