// @ts-check
/**
 * The conformance bench of `@timon-ai/sdk/testing` on the Cursor provider, plus what only this agent adds. No
 * `cursor-agent`, no account, no network: the agent is a scripted peer that plays `test/fixtures/*.jsonl`.
 *
 * THE FIXTURES ARE RECONSTRUCTED FROM CURSOR'S DOCUMENTATION, NOT RECORDED (see their header and README.md): green here
 * proves the provider speaks the protocol as Cursor documents it, not that Cursor does what it documents.
 *
 *   node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acpSessionChecks, bindDialect, createAcpReplayPeer, createProviderContext, defineConformanceTests, dialectConformance,
  FAKE_TOKEN_REFERENCE, loadAcpScript, providerRuntime,
} from '@timon-ai/sdk/testing'
import { apply } from '../lib/index.js'
import { CURSOR } from '../lib/cursor.js'

/** What the daemon checks at registration, run here: the declarations hold together. @param {any} definition */
const providerRuntimeProblems = (definition) => providerRuntime.check.declarationProblems(definition.declares, 'cursor')

const fixture = (/** @type {string} */ name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const SESSION = loadAcpScript(fixture('session.jsonl'))

const cwd = mkdtempSync(join(tmpdir(), 'cursor-conformance-'))
process.on('exit', () => rmSync(cwd, { recursive: true, force: true }))

// The plugin's own `apply`, against the stand-in `ctx`: what it registers is what the bench tests.
const ctx = createProviderContext()
await apply(ctx)
const dialect = ctx.registered.dialect('cursor')
const profile = ctx.registered.profiles[0]
const provider = bindDialect(dialect, { id: 'cursor', cmd: 'cursor-agent' })

/** The same session with the option kinds taken out: Cursor documents the ids, and a kind may not be sent. */
const withoutOptionKinds = SESSION.map((step) => ({
  ...step,
  send: step.send?.map((message) => {
    const params = /** @type {any} */ (message.params)
    return params?.options
      ? { ...message, params: { ...params, options: params.options.map((/** @type {any} */ { kind: _kind, ...option }) => option) } }
      : message
  }),
}))

const expectation = {
  script: SESSION,
  sessionId: 'cursor-session-0001',
  cmd: 'cursor-agent',
  args: ['acp'],
  says: "Le fichier src/index.ts exporte le point d'entrée du daemon.", // french-ok: a French answer the provider passes through untouched
  stopReason: 'end_turn',
  mcpServers: ['timon', 'timon_ask'],
  permission: { requestId: 'perm-1', tool: 'Edit src/index.ts', allowOptionId: 'allow-once', denyOptionId: 'reject-once' },
  signIn: {
    script: loadAcpScript(fixture('session-signed-out.jsonl')),
    message: /sign in first \(Cursor Login\) — run `cursor-agent login` in a terminal on this machine, then retry/,
  },
  // Cursor's own blocking requests, put to the person as Timon cards (reconstructed from the documentation too).
  extensions: [
    {
      script: loadAcpScript(fixture('session-ask-question.jsonl')),
      requestId: 'ask-1',
      answer: (/** @type {import('@timon-ai/sdk/provider').SessionAskRequest} */ card) => {
        assert.deepEqual(card.questions.map((q) => ({ question: q.question, header: q.header, labels: q.options?.map((o) => o.label) })), [
          { question: 'Which mode should I use?', header: 'Need input', labels: ['Agent', 'Plan'] },
        ])
        assert.equal(card.id, 'call_123', 'the card is tied to Cursor\'s own call id')
        return /** @type {import('@timon-ai/sdk/provider').SessionAskOutcome} */ ({ answered: true, answers: { 'Which mode should I use?': { picked: ['Plan'], text: null } } })
      },
      reply: { outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['plan'] }] } },
      unanswered: { outcome: { outcome: 'skipped', reason: 'nobody can answer a question in this session' } },
    },
    {
      script: loadAcpScript(fixture('session-create-plan.jsonl')),
      requestId: 'plan-1',
      answer: (/** @type {import('@timon-ai/sdk/provider').SessionAskRequest} */ card) => {
        const [question] = card.questions
        assert.match(question?.question ?? '', /^Refactor tabs layout\n\nTighten layout behavior[\s\S]*\n- Verify editor behavior$/)
        return /** @type {import('@timon-ai/sdk/provider').SessionAskOutcome} */ ({ answered: true, answers: { [question?.question ?? '']: { picked: [], text: 'Keep the old tabs' } } })
      },
      reply: { outcome: { outcome: 'rejected', reason: 'Keep the old tabs' } },
      unanswered: { outcome: { outcome: 'rejected', reason: 'nobody can answer a question in this session' } },
    },
  ],
}

defineConformanceTests(test, [
  // The declarations agree with each other (what registration enforces), then the shape a session driver must have.
  ...dialectConformance(dialect, { id: 'cursor', env: {} }, { transcript: '', sessionId: 'none', cmd: 'cursor-agent', model: 'none' }, { cwd, scratchDirs: [] }),
  ...acpSessionChecks(provider, expectation, { cwd }),
  ...acpSessionChecks(provider, { ...expectation, script: withoutOptionKinds, signIn: undefined }, { cwd }).filter((check) => /permission/.test(check.name)),
], '[cursor]')

test('a remark typed beside a pick reaches Cursor as words, since its answer has no field for them', async () => {
  const { askQuestion } = await import('../lib/extensions.js')
  /** @type {any} */
  const cards = {
    signal: new AbortController().signal,
    ask: async () => ({ outcome: 'answered', value: { q1: { selected: ['plan'], text: 'but keep it short' } } }),
  }
  const reply = await askQuestion({ toolCallId: 'c', questions: [{ id: 'q1', prompt: 'Which mode?', options: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }] }] }, cards)
  assert.deepEqual(reply, { outcome: { outcome: 'skipped', reason: 'The person answered in their own words. Which mode? — picked Plan; wrote: but keep it short' } })
  assert.deepEqual(await askQuestion({ questions: [{ id: 'q1' }] }, cards), { outcome: { outcome: 'skipped', reason: 'the question could not be read' } })
})

test('the plugin declares one provider and one profile, and nothing the user did not authorize', () => {
  assert.deepEqual([...ctx.registered.providers.keys()], ['cursor'])
  assert.deepEqual(ctx.registered.profiles.map((p) => ({ id: p.id, dialect: p.dialect, custom: p.custom, requiredBinary: p.requiredBinary })), [
    { id: 'cursor', dialect: 'cursor', custom: true, requiredBinary: 'cursor-agent' },
  ])
  const definition = /** @type {any} */ (ctx.registered.providers.get('cursor'))
  assert.deepEqual(definition.declares.binary.names, ['cursor-agent', 'agent'], 'the canonical name first, then the alias the identity guards')
  assert.deepEqual(definition.declares.credentialDirs, ['.cursor', '.config/cursor'])
  assert.deepEqual(definition.permission, { model: 'protocol', byAgent: false }, 'every tool use goes through the card and the classifier')
  assert.match('cursor-agent 2026.10.16-0a1b2c3', new RegExp(definition.declares.binary.identity.pattern, 'm'))
  assert.doesNotMatch('grok 1.0.13 (5e9a58528b76) [stable]', new RegExp(definition.declares.binary.identity.pattern, 'm'), 'grok\'s `agent` is not Cursor\'s')
  assert.deepEqual(definition.declares.unverified.map((/** @type {{ subject: string }} */ c) => c.subject),
    ['session', 'mcp', 'extension-requests', 'credential-dirs', 'binary-identity'], 'what was never seen work is said, and shown')
  assert.deepEqual(providerRuntimeProblems(definition), [])
  assert.equal(profile?.fallbackRank, undefined, 'a provider of unknown calibre is never chosen by the automatic fallback')
  assert.deepEqual(ctx.logs.filter((line) => line.level !== 'info'), [])
})

test('the manifest lists what the plugin declares: the program and the folders the operator authorizes', async () => {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).timon
  const definition = /** @type {any} */ (ctx.registered.providers.get('cursor'))
  assert.deepEqual(manifest.provider.binaries.flatMap((/** @type {{ name: string, aliases?: string[] }} */ b) => [b.name, ...(b.aliases ?? [])]), definition.declares.binary.names)
  // The click reads the manifest's copy, the launch the code's: two copies that differ would judge two programs.
  assert.deepEqual(manifest.provider.binaries[0].identity, definition.declares.binary.identity)
  assert.deepEqual(manifest.provider.credentialDirs, definition.declares.credentialDirs)
  assert.deepEqual(manifest.permissions, ['backends:register'])
})

test('`authenticate` is tried once after auth_required with cursor_login, and the session then opens', async () => {
  const peer = createAcpReplayPeer(loadAcpScript(fixture('session-authenticate.jsonl')))
  const driver = /** @type {any} */ (provider).openSession({
    io: peer.io, spawn: { agentName: 'a', systemPrompt: 's', message: 'm', resumeSession: null, missionId: 'm-1', cfg: { cwd } },
    host: { emit() {}, requestPermission: async () => ({ allow: true }) },
  })
  try {
    assert.equal((await driver.start()).sessionId, 'cursor-session-0001')
    const methods = peer.received.map((message) => message.method)
    assert.deepEqual(methods.filter((m) => m === 'authenticate' || m === 'session/new'), ['session/new', 'authenticate', 'session/new'])
    assert.deepEqual(peer.received.find((message) => message.method === 'authenticate')?.params, { methodId: 'cursor_login' })
  } finally {
    driver.close()
    peer.close()
  }
})

test('the models come from Cursor itself, through the program the manifest declared', async () => {
  const peer = createAcpReplayPeer(SESSION)
  const probing = createProviderContext({ binaries: { 'cursor-agent': { path: '/opt/cursor/bin/cursor-agent', converse: () => peer.conversation() } } })
  await apply(probing)
  const found = await /** @type {any} */ (probing.registered.providers.get('cursor')).models.discover({ id: 'cursor', cmd: 'cursor-agent', env: {}, knownModels: [] })
  assert.deepEqual(found.map((/** @type {{ slug: string }} */ model) => model.slug), ['auto', 'composer-2'])
  const request = peer.received.find((message) => message.method === 'session/new')
  assert.deepEqual(/** @type {any} */ (request?.params).mcpServers, [], 'a probe declares no tool to the agent')
})

test('an install that has only `agent` launches `agent`, still held to Cursor\'s identity', async () => {
  const aliasOnly = createProviderContext({ binaries: { agent: { path: '/home/me/.local/bin/agent' } } })
  await apply(aliasOnly)
  const definition = /** @type {any} */ (aliasOnly.registered.providers.get('cursor'))
  assert.deepEqual(definition.declares.binary.names, ['agent', 'cursor-agent'], 'the name that resolved comes first')
  assert.deepEqual(definition.declares.binary.identity, CURSOR.binary.identity)
  const [profile] = aliasOnly.registered.profiles
  assert.equal(profile?.cmd, 'agent')
  assert.equal(profile?.requiredBinary, 'agent')
})

test('Timon\'s MCP servers are declared to the agent through the session with a reference, not a token (reserve: unverified on Cursor)', async () => {
  const peer = createAcpReplayPeer(SESSION)
  const driver = /** @type {any} */ (provider).openSession({
    io: peer.io, spawn: { agentName: 'a', systemPrompt: 's', message: 'm', resumeSession: null, missionId: 'm-2', cfg: { cwd } },
    host: { emit() {}, requestPermission: async () => ({ allow: true }) },
    mcpEnv: { TIMON_API_TOKEN: FAKE_TOKEN_REFERENCE },
  })
  try {
    await driver.start()
    const servers = /** @type {any} */ (peer.received.find((message) => message.method === 'session/new')?.params).mcpServers
    assert.ok(servers.length >= 2)
    assert.ok(JSON.stringify(servers).includes(FAKE_TOKEN_REFERENCE))
  } finally {
    driver.close()
    peer.close()
  }
})
