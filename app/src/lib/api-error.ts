/**
 * The one place the webview turns a daemon error into words (TODO #829,
 * docs/I18N.md, section `Erreurs d'API`).
 *
 * The daemon answers `{ error, code?, params? }`: `error` is English, `code` a
 * stable name. With a code the dictionary knows (`apiErrors.<code>`, read in
 * the reader's language down to English), the reader gets the translation;
 * otherwise the daemon's English, as before; with no message at all, the
 * caller's fallback, then a generic sentence with the HTTP status.
 */
import { hasKey, sourceText, t } from './i18n';
import { messageArguments } from './i18n-core';
import type { SettingsCategoryId } from './settings-layout';
import { settingsPath } from './settings-path';

/** Mirror of `ApiErrorBody` (orchestrator/src/plugins/contract/api-error.ts): the two packages share no code. */
export interface ParsedApiError {
  /** The daemon's English message, `''` when the body has none. */
  message: string;
  code: string | null;
  params: Record<string, string | number>;
}

const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** The error a body carries, or `null` when it carries none. */
export function parseApiError(body: unknown): ParsedApiError | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = body as { error?: unknown; code?: unknown; params?: unknown };
  const message = typeof raw.error === 'string' ? raw.error.trim() : '';
  const code = typeof raw.code === 'string' && CODE.test(raw.code) ? raw.code : null;
  if (!message && !code) return null;
  const params: Record<string, string | number> = {};
  if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
    for (const [name, value] of Object.entries(raw.params as Record<string, unknown>)) {
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) params[name] = value;
    }
  }
  return { message, code, params };
}

/** The dictionary key of a code, exported for the tests and the scanner. */
export function apiErrorKey(code: string): string {
  return `apiErrors.${code}`;
}

/**
 * What to show for an error body. `fallback` is read only when the body says
 * nothing; give the HTTP status rather than a sentence when you have it.
 */
export function apiErrorMessage(body: unknown, fallback?: string | { status: number }): string {
  const parsed = parseApiError(body);
  // A body that lacks a param of its message (an older daemon, a route that
  // forgot it) would show the raw `{name}`: the daemon's English says it whole.
  if (parsed?.code && speaks(apiErrorKey(parsed.code), parsed.params)) return t(apiErrorKey(parsed.code), parsed.params);
  if (parsed?.message) return parsed.message;
  if (typeof fallback === 'string' && fallback) return fallback;
  if (fallback && typeof fallback === 'object') return t('apiErrors.http_status', { status: fallback.status });
  return t('apiErrors.unknown');
}

/** Like `apiErrorMessage`, but `null` when the body carries no error: for callers that word that case themselves. */
export function apiErrorMessageOrNull(body: unknown): string | null {
  return parseApiError(body) ? apiErrorMessage(body) : null;
}

/**
 * The message of a failed `Response`, body read as JSON. The body is consumed:
 * call it instead of `res.json()`, not after.
 */
export async function responseErrorMessage(res: Response, fallback?: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  return apiErrorMessage(body, fallback || { status: res.status });
}

/**
 * A sentence the daemon stored in English beside its code (TODO #845): a task's
 * blocked reason, a notification's title and body. The code sits in a JSON
 * column (`tasks.blocked_reason_code`, `notifications.message_code`) or in the
 * payload of an orchestrator notice; its message lives under
 * `daemonMessages.<code>`, kept apart from `apiErrors`, whose keys all answer a
 * route.
 *
 * Mirror of `DaemonMessage` (orchestrator/src/daemon-message.ts).
 */
export interface StoredDaemonMessage {
  code: string;
  params: Record<string, string | number>;
  /** A notification whose body is another stored sentence (a task's blocked reason), one level deep. */
  body?: StoredDaemonMessage;
}

/** The stored code: a JSON string or the object itself; `null` when absent or malformed. */
export function parseDaemonMessage(stored: unknown): StoredDaemonMessage | null {
  let value = stored;
  if (typeof stored === 'string') {
    try { value = JSON.parse(stored); } catch { return null; }
  }
  const message = storedMessage(value);
  if (!message) return null;
  const body = storedMessage((value as { body?: unknown }).body);
  return body ? { ...message, body } : message;
}

function storedMessage(value: unknown): StoredDaemonMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { code?: unknown; params?: unknown };
  if (typeof raw.code !== 'string' || !CODE.test(raw.code)) return null;
  // Same filtering as a route error's params.
  const params = parseApiError({ code: raw.code, params: raw.params })?.params ?? {};
  return { code: raw.code, params };
}

/** The dictionary key of a stored code, exported for the tests and the scanner. */
export function daemonMessageKey(code: string): string {
  return `daemonMessages.${code}`;
}

/**
 * Stored sentences that send the user to a Settings tab. The reader writes the
 * path (`{settingsPath}`) from the labels the dialog shows now: a path stored
 * with the row would keep a tab's old name, and would stay in the daemon's
 * language.
 */
const SETTINGS_PLACES: Readonly<Record<string, readonly [SettingsCategoryId, string]>> = {
  integration_gave_up: ['secrets', 'connections'],
  backend_launch_unauthorized: ['models', 'backends'],
  device_paired: ['network', 'devices'],
};

/** Params the reader adds to a stored code's own: the daemon never sends them. Exported for the code scanner. */
export function daemonMessageReaderParams(code: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(SETTINGS_PLACES, code) ? ['settingsPath'] : [];
}

function readerParams(message: StoredDaemonMessage): Record<string, string | number> {
  const place = Object.prototype.hasOwnProperty.call(SETTINGS_PLACES, message.code) ? SETTINGS_PLACES[message.code] : undefined;
  return place ? { ...message.params, settingsPath: settingsPath(place[0], place[1]) } : message.params;
}

const ARGUMENTS = new Map<string, readonly string[] | null>();

/**
 * Whether `key` can say what the daemon sent or stored: a message exists, and
 * the params name every argument of its English (the languages name the same,
 * `locale-parity.test.ts`). A row or a route error from another daemon version
 * may lack one, and the formatter would then show the raw ICU text: the
 * English wins.
 */
function speaks(key: string, params: Record<string, string | number>): boolean {
  const english = sourceText(key);
  if (english === null || !hasKey(key)) return false;
  let args = ARGUMENTS.get(english);
  if (args === undefined) {
    try { args = messageArguments(english); } catch { args = null; }
    ARGUMENTS.set(english, args);
  }
  return args !== null && args.every((name) => Object.prototype.hasOwnProperty.call(params, name));
}

/** A stored sentence in the reader's language; the stored English when there is no code or no message for it. */
export function daemonMessageText(stored: unknown, english: string): string {
  const message = parseDaemonMessage(stored);
  if (!message) return english;
  const key = daemonMessageKey(message.code);
  const params = readerParams(message);
  return speaks(key, params) ? t(key, params) : english;
}

/**
 * A stored title and body in the reader's language, each falling back to its
 * own English: `daemonMessages.<code>.title` and `.body`.
 */
export function daemonNotificationText(
  stored: unknown,
  english: { title: string; body: string | null },
): { title: string; body: string | null } {
  const message = parseDaemonMessage(stored);
  if (!message) return english;
  const key = daemonMessageKey(message.code);
  const params = readerParams(message);
  const bodyKey = message.body ? daemonMessageKey(message.body.code) : null;
  const bodyParams = message.body ? readerParams(message.body) : null;
  let body = english.body;
  if (bodyKey && bodyParams && speaks(bodyKey, bodyParams)) body = t(bodyKey, bodyParams);
  else if (speaks(`${key}.body`, params)) body = t(`${key}.body`, params);
  return {
    title: speaks(`${key}.title`, params) ? t(`${key}.title`, params) : english.title,
    body,
  };
}
