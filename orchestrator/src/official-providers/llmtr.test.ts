/**
 * LLMTR's own Chat Completions path: the URL, the bearer token, the untouched
 * model id, and the failures. The fetch is a stand-in. Nothing here contacts
 * llmtr.com, and no test value is a real key.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderContext } from '../../../packages/sdk/src/testing/index.js';
import { apply } from '../../official-providers/provider-llmtr/lib/index.js';
import { createLlmtrDialect } from '../../official-providers/provider-llmtr/lib/dialect.js';
import {
  LLMTR_CHAT_URL, LLMTR_DEFAULT_MODEL, LlmtrChatError, assertLlmtrChatUrl, llmtrAssistantText, llmtrChatCompletion,
} from '../../official-providers/provider-llmtr/lib/chat.js';
import { LLMTR_PROFILE } from '../../official-providers/provider-llmtr/lib/profile.js';

const KEY = 'llmtr-test-key';
const PREFIXED = 'llmtr/minimax/minimax-m3.1-flash';

type Seen = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function scriptedFetch(reply: (call: Seen) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init: init ?? {} };
    calls.push(call);
    return reply(call);
  };
  return { calls, fetchImpl };
}

function parsedBody(call: Seen): Record<string, unknown> {
  assert.equal(typeof call.init.body, 'string');
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

function authorization(call: Seen): string | null {
  return new Headers(call.init.headers).get('authorization');
}

const ctx = createProviderContext();
apply(ctx);
process.on('exit', () => ctx.cleanup());

test('the product profile is Chat Completions, with a public model list and no Responses transport', () => {
  const profile = ctx.registered.productProfiles.find((entry) => entry.id === 'llmtr');
  assert.ok(profile);
  assert.equal(profile.dialect, 'llmtr');
  assert.equal(profile.defaultModel, LLMTR_DEFAULT_MODEL);
  assert.deepEqual(profile.models.map((model) => model.slug), [LLMTR_DEFAULT_MODEL]);
  assert.equal(profile.models[0]?.contextWindow, undefined);
  assert.equal(profile.providerConfig, undefined);
  assert.deepEqual(profile.env.LLMTR_API_KEY, { secret: 'LLMTR_API_KEY' });
  assert.deepEqual(profile.envFrom, { LLMTR_API_KEY: 'LLMTR_API_KEY' });
  assert.deepEqual(profile.modelsEndpoint, { url: 'https://llmtr.com/v1/models', format: 'openai' });
  assert.equal(profile.fallbackRank, undefined);
  const dialect = ctx.registered.dialect('llmtr');
  assert.equal(dialect.transport, 'remote');
  assert.deepEqual(dialect.localEnv, { names: ['LLMTR_API_KEY'], prefixes: [] });
  assert.deepEqual(dialect.capabilities, { worktree: false, timonMcp: false, attachments: false, timonPreamble: false });
  assert.equal(LLMTR_PROFILE.modelsEndpoint && 'authFrom' in LLMTR_PROFILE.modelsEndpoint, false);
});

test('the chat URL is only https://llmtr.com/v1/chat/completions', () => {
  assert.doesNotThrow(() => assertLlmtrChatUrl(LLMTR_CHAT_URL));
  for (const url of [
    'https://evil.example/v1/chat/completions',
    'https://llmtr.com/v1/responses',
    'https://llmtr.com/v1/chat/completions?x=1',
    'http://llmtr.com/v1/chat/completions',
    'https://user:pw@llmtr.com/v1/chat/completions',
  ]) {
    assert.throws(() => assertLlmtrChatUrl(url), LlmtrChatError, url);
  }
});

test('a completion sends the model unchanged, a bearer token, and no tools', async () => {
  const { calls, fetchImpl } = scriptedFetch(() => jsonResponse({
    choices: [{ message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: ' visible ' }] } }],
  }));
  const out = await llmtrChatCompletion({
    apiKey: `  ${KEY}  `,
    model: PREFIXED,
    messages: [{ role: 'user', content: 'Say hi' }],
    maxTokens: 64,
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, LLMTR_CHAT_URL);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.redirect, 'manual');
  assert.equal(authorization(calls[0]!), `Bearer ${KEY}`);
  const body = parsedBody(calls[0]!);
  assert.equal(body.model, PREFIXED);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 64);
  assert.equal('tools' in body, false);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Say hi' }]);
  assert.equal(out.text, ' visible ');
  assert.equal(out.model, PREFIXED);
});

test('reasoning without assistant text is a failure, and a redirect is not followed', async () => {
  const reasoning = scriptedFetch(() => jsonResponse({
    choices: [{ message: { content: null, reasoning_content: 'only thinking' } }],
  }));
  await assert.rejects(
    llmtrChatCompletion({ apiKey: KEY, model: LLMTR_DEFAULT_MODEL, messages: [{ role: 'user', content: 'Hi' }], fetchImpl: reasoning.fetchImpl }),
    (err: unknown) => err instanceof LlmtrChatError && err.message === 'LLMTR returned no assistant text',
  );
  assert.equal(llmtrAssistantText({ content: null, reasoning_content: 'only thinking' }), '');

  const redirect = scriptedFetch(() => new Response('go away', { status: 302, headers: { Location: 'https://evil.example/steal' } }));
  await assert.rejects(
    llmtrChatCompletion({ apiKey: KEY, model: LLMTR_DEFAULT_MODEL, messages: [{ role: 'user', content: 'Hi' }], fetchImpl: redirect.fetchImpl }),
    (err: unknown) => err instanceof LlmtrChatError && /redirect was not followed/.test(err.message) && !err.message.includes(KEY) && !err.message.includes('evil.example'),
  );
  assert.equal(redirect.calls.length, 1);

  const refused = scriptedFetch(() => new Response(JSON.stringify({ error: KEY }), { status: 401 }));
  await assert.rejects(
    llmtrChatCompletion({ apiKey: KEY, model: LLMTR_DEFAULT_MODEL, messages: [{ role: 'user', content: 'Hi' }], fetchImpl: refused.fetchImpl }),
    (err: unknown) => err instanceof LlmtrChatError && err.status === 401 && err.message === 'LLMTR refused the API key (HTTP 401)' && !err.message.includes(KEY),
  );

  const down = scriptedFetch(() => { throw new TypeError(`connect ${KEY}`); });
  await assert.rejects(
    llmtrChatCompletion({ apiKey: KEY, model: LLMTR_DEFAULT_MODEL, messages: [{ role: 'user', content: 'Hi' }], fetchImpl: down.fetchImpl }),
    (err: unknown) => err instanceof LlmtrChatError && err.message === 'LLMTR did not answer' && !err.message.includes(KEY),
  );
});

test('a mission turn uses that request and keeps the model id, without max_tokens or tools', async () => {
  const runtime = ctx.provider.runtime;
  const { calls, fetchImpl } = scriptedFetch(() => jsonResponse({
    choices: [{ message: { content: 'hello from llmtr' } }],
  }));
  const dialect = createLlmtrDialect(runtime, { fetch: fetchImpl });
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const driver = dialect.openSession({
    spawn: {
      agentName: 'tester', systemPrompt: 'Be brief.', message: '', resumeSession: 'old-session',
      cfg: { model: PREFIXED }, missionId: 'mission-llmtr-1',
    },
    host: {
      emit: (ev) => { emitted.push(ev as { type: string; payload: Record<string, unknown> }); },
      requestPermission: async () => ({ allow: false }),
      end: () => {},
      saveResume: () => { throw new Error('LLMTR must not save a resume state'); },
    },
    env: { LLMTR_API_KEY: KEY },
    profileId: 'llmtr',
  });
  assert.equal(driver.info, null);
  assert.equal(emitted.length, 0);
  const info = await driver.start();
  assert.equal(info.resumed, false);
  assert.notEqual(info.sessionId, 'old-session');
  assert.equal(calls.length, 0, 'start() does not call the network');
  const outcome = await driver.prompt('Say hi');
  assert.equal(outcome.stopReason, 'end_turn');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, LLMTR_CHAT_URL);
  assert.equal(calls[0]!.init.redirect, 'manual');
  assert.equal(authorization(calls[0]!), `Bearer ${KEY}`);
  const body = parsedBody(calls[0]!);
  assert.equal(body.model, PREFIXED);
  assert.equal('max_tokens' in body, false);
  assert.equal('tools' in body, false);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Say hi' },
  ]);
  const assistant = emitted.find((ev) => ev.type === 'assistant');
  const content = (assistant?.payload.message as { content?: { text?: string }[] } | undefined)?.content;
  assert.equal(content?.[0]?.text, 'hello from llmtr');
  assert.equal(emitted.at(-1)?.type, 'result');
  assert.equal(emitted.at(-1)?.payload.is_error, false);

  const follow = await driver.prompt('And then?');
  assert.equal(follow.stopReason, 'end_turn');
  assert.equal(calls.length, 2);
  assert.deepEqual(parsedBody(calls[1]!).messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Say hi' },
    { role: 'assistant', content: 'hello from llmtr' },
    { role: 'user', content: 'And then?' },
  ]);
  driver.close();
  await assert.rejects(driver.prompt('after'), /closed/);
});

test('a refused key, a redirect and an image become a turn error and do not leak the key', async () => {
  const runtime = ctx.provider.runtime;
  const refused = scriptedFetch(() => new Response(JSON.stringify({ error: KEY }), { status: 403 }));
  const dialect = createLlmtrDialect(runtime, { fetch: refused.fetchImpl });
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const open = (fetchImpl: typeof fetch) => createLlmtrDialect(runtime, { fetch: fetchImpl }).openSession({
    spawn: {
      agentName: 'tester', systemPrompt: '', message: '', resumeSession: null,
      cfg: { model: LLMTR_DEFAULT_MODEL }, missionId: 'mission-llmtr-2',
    },
    host: {
      emit: (ev) => { emitted.push(ev as { type: string; payload: Record<string, unknown> }); },
      requestPermission: async () => ({ allow: false }),
      end: () => {},
      saveResume: () => {},
    },
    env: { LLMTR_API_KEY: KEY },
    profileId: 'llmtr',
  });
  const driver = open(refused.fetchImpl);
  await driver.start();
  const outcome = await driver.prompt('Hi');
  assert.equal(outcome.stopReason, 'error');
  const result = emitted.at(-1);
  assert.equal(result?.payload.is_error, true);
  assert.equal(result?.payload.api_error_status, 403);
  assert.equal(typeof result?.payload.error, 'string');
  assert.equal(String(result?.payload.error).includes(KEY), false);
  driver.close();

  emitted.length = 0;
  const redirect = scriptedFetch(() => new Response(null, { status: 301, headers: { Location: 'https://evil.example/x' } }));
  const redirected = open(redirect.fetchImpl);
  await redirected.start();
  const bounced = await redirected.prompt('Hi');
  assert.equal(bounced.stopReason, 'error');
  assert.equal(redirect.calls.length, 1);
  assert.equal(String(emitted.at(-1)?.payload.error).includes('evil.example'), false);
  redirected.close();

  emitted.length = 0;
  const images = scriptedFetch(() => jsonResponse({ choices: [{ message: { content: 'nope' } }] }));
  const pictured = open(images.fetchImpl);
  await pictured.start();
  const blocked = await pictured.prompt('Hi', [{ media_type: 'image/png', data: 'aaaa' }]);
  assert.equal(blocked.stopReason, 'error');
  assert.equal(images.calls.length, 0);
  assert.match(String(emitted.at(-1)?.payload.error), /does not accept images/);
  pictured.close();
});

test('cancelling aborts the request, and a missing key never calls the network', async () => {
  const runtime = ctx.provider.runtime;
  let seenSignal: AbortSignal | undefined;
  const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    seenSignal = init?.signal ?? undefined;
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const dialect = createLlmtrDialect(runtime, { fetch: hanging });
  const driver = dialect.openSession({
    spawn: {
      agentName: 'tester', systemPrompt: '', message: '', resumeSession: null,
      cfg: { model: LLMTR_DEFAULT_MODEL }, missionId: 'mission-llmtr-3',
    },
    host: {
      emit: (ev) => { emitted.push(ev as { type: string; payload: Record<string, unknown> }); },
      requestPermission: async () => ({ allow: false }),
      end: () => {},
      saveResume: () => {},
    },
    env: { LLMTR_API_KEY: KEY },
    profileId: 'llmtr',
  });
  await driver.start();
  const pending = driver.prompt('Hi');
  await driver.cancel();
  const outcome = await pending;
  assert.equal(outcome.stopReason, 'cancelled');
  assert.equal(seenSignal?.aborted, true);
  assert.equal(emitted.at(-1)?.payload.subtype, 'cancelled');
  assert.equal(emitted.at(-1)?.payload.is_error, false);
  driver.close();

  const calls: string[] = [];
  const missing = createLlmtrDialect(runtime, { fetch: async (input) => { calls.push(String(input)); return jsonResponse({}); } });
  const bare = missing.openSession({
    spawn: {
      agentName: 'tester', systemPrompt: '', message: '', resumeSession: null,
      cfg: { model: LLMTR_DEFAULT_MODEL }, missionId: 'mission-llmtr-4',
    },
    host: {
      emit: () => {},
      requestPermission: async () => ({ allow: false }),
      end: () => {},
      saveResume: () => {},
    },
    env: {},
    profileId: 'llmtr',
  });
  await assert.rejects(bare.start(), /LLMTR_API_KEY is not set/);
  assert.deepEqual(calls, []);
  bare.close();
});

test('the built-in profile is registered and stays inactive until the key exists', async () => {
  const previous = process.env.LLMTR_API_KEY;
  delete process.env.LLMTR_API_KEY;
  try {
    const { officialContext } = await import('../../tests/helpers/official-providers.js');
    const { getDialect, inactiveProfiles } = await import('../backends/registry.js');
    const { ctx: plugin } = await officialContext('provider-llmtr');
    apply(plugin);
    assert.equal(getDialect('llmtr')?.transport, 'remote');
    const reason = inactiveProfiles().find((entry) => entry.id === 'llmtr')?.reason ?? '';
    assert.match(reason, /LLMTR_API_KEY/);
    assert.doesNotMatch(reason, /llmtr-test-key|Bearer /);
  } finally {
    if (previous === undefined) delete process.env.LLMTR_API_KEY;
    else process.env.LLMTR_API_KEY = previous;
  }
});
