/**
 * A Hermes gateway API server in a Node process, for the plugin's tests: no
 * network beyond 127.0.0.1, no Python. It replays the frames measured by the
 * probe of 10/10/2026 (`__fixtures__/hermes-frames.json`) and reproduces the
 * two stream generations:
 *
 *   - `0.21.0`: frames without `id:`, one reader per run — a second
 *     `GET …/events` answers 404 `run_not_found`;
 *   - `0.21.6`: `id: <seq>` on every frame, `Last-Event-ID` replays the rest.
 *
 * The run a message starts follows a script picked from its text: `tool`,
 * `approve`, `subagent`, `slow` (runs until stopped), `lost` (the terminal
 * frame never reaches the stream), anything else answers "Hello from the
 * fake model.".
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const FIXTURE = JSON.parse(readFileSync(new URL('./__fixtures__/hermes-frames.json', import.meta.url), 'utf8'));
const E = FIXTURE.events;
const TERMINAL = new Set(['run.completed', 'run.cancelled', 'run.failed']);

function script(input) {
  if (/\bapprove\b/.test(input)) {
    return [E.risky_started, { wait: 'approval', payload: E.approval_request }, { afterApproval: true }, E.delta_cleaned, E.completed_cleaned];
  }
  if (/\btool\b/.test(input)) return [E.delta_check, E.interim, E.tool_started, E.tool_completed, E.delta_done, E.completed_done];
  if (/\bsubagent\b/.test(input)) return [E.subagent_start, E.subagent_complete, E.delta_hello, E.delta_rest, E.completed_hello];
  if (/\bslow\b/.test(input)) return [E.delta_hello, { hold: true }];
  if (/\blong\b/.test(input)) {
    const words = Array.from({ length: 30 }, (_, i) => ({ event: 'message.delta', delta: `w${i} ` }));
    return [...words.slice(0, 10), { pause: 60 }, ...words.slice(10), { event: 'run.completed', output: words.map((w) => w.delta).join('') }];
  }
  if (/\blost\b/.test(input)) return [E.delta_hello, E.delta_rest, { silentTerminal: E.completed_hello }];
  return [E.delta_hello, E.delta_rest, E.reasoning, E.completed_hello];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ version?: string, key?: string, profiles?: Record<string, string>, maxRuns?: number,
 *           keepaliveMs?: number, stepMs?: number, retryAfter?: string, features?: Record<string, unknown> }} [options]
 */
export async function startFakeGateway(options = {}) {
  const opts = {
    version: '0.21.6', key: 'gateway-default-key-0001', profiles: { coder: 'gateway-coder-key-0002' },
    maxRuns: 10, keepaliveMs: 10_000, stepMs: 5, retryAfter: '1', features: FIXTURE.features, ...options,
  };
  const replay = opts.version !== '0.21.0';
  /** @type {Map<string, any>} */
  const runs = new Map();
  /** @type {Map<string, { messages: Array<{ role: string, content: string }> }>} */
  const sessions = new Map();
  const idempotency = new Map();
  const requests = [];
  const sockets = new Set();
  const state = { rateLimitNext: 0, failNext: 0 };

  function json(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  function statusView(run) {
    return {
      object: 'hermes.run', run_id: run.id, status: run.status, session_id: run.sessionId, model: run.profile,
      ...(run.output !== null ? { output: run.output } : {}),
      ...(run.status === 'waiting_for_approval' && run.pendingApproval ? { approval: run.pendingApproval } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.lastEvent ? { last_event: run.lastEvent } : {}),
    };
  }

  function frame(run, entry) {
    const data = { ...entry.payload, run_id: run.id, timestamp: 0, ...(replay ? { seq: entry.seq } : {}) };
    return `${replay ? `id: ${entry.seq}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
  }

  function publish(run, payload, { toStream = true } = {}) {
    const entry = { seq: run.log.length, payload };
    run.log.push(entry);
    run.lastEvent = payload.event;
    if (payload.event === 'message.delta') run.partial += payload.delta;
    if (toStream) for (const res of run.subscribers) res.write(frame(run, entry));
    if (TERMINAL.has(payload.event)) end(run, payload);
  }

  function end(run, payload) {
    if (payload.event === 'run.completed') { run.status = 'completed'; run.output = payload.output ?? ''; }
    if (payload.event === 'run.cancelled') run.status = 'cancelled';
    if (payload.event === 'run.failed') { run.status = 'failed'; run.error = payload.error ?? 'failed'; }
    const session = sessions.get(run.sessionId);
    if (session && run.output) session.messages.push({ role: 'assistant', content: run.output });
    for (const res of run.subscribers) res.end(': stream closed\n\n');
    run.subscribers.clear();
    run.release?.();
  }

  async function play(run) {
    for (const step of script(run.input)) {
      if (run.status !== 'running') return;
      if (step.wait === 'approval') {
        run.pendingApproval = step.payload;
        run.status = 'waiting_for_approval';
        publish(run, step.payload);
        const choice = await new Promise((resolve) => { run.answer = resolve; run.release = () => resolve(null); });
        if (choice === null) return;
        run.choice = choice;
        run.status = 'running';
        continue;
      }
      if (step.afterApproval) { publish(run, run.choice === 'deny' ? E.risky_blocked : E.risky_completed); continue; }
      if (step.hold) { await new Promise((resolve) => { run.release = resolve; }); return; }
      if (step.pause) { await sleep(step.pause); continue; }
      if (step.silentTerminal) {
        // The terminal frame is lost on the way: status says completed, the
        // stream stays open with keepalives only.
        run.log.push({ seq: run.log.length, payload: step.silentTerminal });
        run.status = 'completed';
        run.output = step.silentTerminal.output;
        return;
      }
      publish(run, step);
      await sleep(opts.stepMs);
    }
  }

  /** `/p/<profile>/…` → profile and rest; `null` when the profile is unknown. */
  function route(url) {
    const match = /^\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!match) return { profile: 'default', path: url.pathname, key: opts.key };
    const profile = decodeURIComponent(match[1]);
    if (!(profile in opts.profiles)) return null;
    return { profile, path: match[2], key: opts.profiles[profile] };
  }

  async function body(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    try { return { text, value: text ? JSON.parse(text) : {} }; } catch { return { text, value: null }; }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, headers: { ...req.headers } });
    if (url.pathname === '/health') return json(res, 200, { status: 'ok', platform: 'hermes-agent', version: opts.version });
    const target = route(url);
    if (!target) return json(res, 404, { error: { code: 'not_found', message: 'Unknown profile' } });
    if (req.headers.authorization !== `Bearer ${target.key}`) return json(res, 401, FIXTURE.errors.auth);
    const { path, profile } = target;

    if (req.method === 'GET' && path === '/v1/capabilities') {
      return json(res, 200, { object: 'hermes.api_server.capabilities', platform: 'hermes-agent', features: opts.features, runtime: { mode: 'server_agent' } });
    }
    if (req.method === 'GET' && path === '/v1/models') {
      return json(res, 200, { object: 'list', data: [{ id: profile === 'default' ? 'hermes-agent' : profile, object: 'model' }] });
    }
    let m = /^\/api\/sessions\/([^/]+)(\/messages)?$/.exec(path);
    if (req.method === 'GET' && m) {
      const session = sessions.get(decodeURIComponent(m[1]));
      if (!session) return json(res, 404, { error: { code: 'session_not_found', message: 'Session not found' } });
      return json(res, 200, m[2] ? { messages: session.messages } : { id: decodeURIComponent(m[1]) });
    }
    if (req.method === 'POST' && path === '/v1/runs') {
      const { text, value } = await body(req);
      if (!value) return json(res, 400, { error: { code: null, message: 'Invalid JSON' } });
      if (typeof value.input !== 'string' && !Array.isArray(value.input)) return json(res, 400, { error: { code: null, message: "Missing 'input' field" } });
      if (state.failNext > 0) { state.failNext -= 1; return json(res, 503, { error: { code: 'unavailable', message: 'busy' } }); }
      if (state.rateLimitNext > 0) { state.rateLimitNext -= 1; return json(res, 429, FIXTURE.errors.rate_limit, { 'retry-after': opts.retryAfter }); }
      const key = req.headers['idempotency-key'];
      if (typeof key === 'string' && idempotency.has(key)) {
        const known = idempotency.get(key);
        if (known.text !== text) return json(res, 409, FIXTURE.errors.idempotency_conflict);
        const run = runs.get(known.runId);
        return json(res, 202, { run_id: run.id, status: run.status, replayed: true }, { 'idempotency-replayed': 'true' });
      }
      const active = [...runs.values()].filter((r) => r.status === 'running' || r.status === 'waiting_for_approval').length;
      if (active >= opts.maxRuns) return json(res, 429, FIXTURE.errors.rate_limit, { 'retry-after': opts.retryAfter });
      const input = typeof value.input === 'string' ? value.input : JSON.stringify(value.input);
      const sessionId = typeof value.session_id === 'string' ? value.session_id : randomUUID();
      const session = sessions.get(sessionId) ?? { messages: [] };
      sessions.set(sessionId, session);
      session.messages.push({ role: 'user', content: input });
      const run = {
        id: `run_${randomUUID().slice(0, 8)}`, profile, sessionId, input, body: value, status: 'running', output: null, error: null,
        log: [], subscribers: new Set(), consumed: false, pendingApproval: null, answer: null, release: null, choice: null,
        lastEvent: null, partial: '', approvals: [], steers: [], stopped: false, sessionKey: req.headers['x-hermes-session-key'] ?? null,
      };
      runs.set(run.id, run);
      if (typeof key === 'string') idempotency.set(key, { text, runId: run.id });
      json(res, 202, { run_id: run.id, status: 'started', replayed: false });
      void play(run);
      return;
    }
    m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(path);
    const run = m ? runs.get(decodeURIComponent(m[1])) : undefined;
    if (m && (!run || run.profile !== profile || run.forgotten)) return json(res, 404, FIXTURE.errors.run_not_found);
    if (!m) return json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    const action = m[2] ?? '';

    if (req.method === 'GET' && action === '') return json(res, 200, statusView(run));
    if (req.method === 'GET' && action === '/events') {
      if (run.eventsLost || (!replay && run.consumed)) return json(res, 404, FIXTURE.errors.run_not_found);
      run.consumed = true;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': open\n\n');
      const from = replay && req.headers['last-event-id'] !== undefined ? Number(req.headers['last-event-id']) + 1 : 0;
      for (const entry of run.log.slice(from)) res.write(frame(run, entry));
      const terminal = run.log.some((e) => TERMINAL.has(e.payload.event));
      if (terminal) { res.end(': stream closed\n\n'); return; }
      run.subscribers.add(res);
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), opts.keepaliveMs);
      res.on('close', () => { clearInterval(keepalive); run.subscribers.delete(res); });
      return;
    }
    if (req.method === 'POST' && action === '/approval') {
      const { value } = await body(req);
      const choice = value?.choice;
      if (!['once', 'session', 'always', 'deny'].includes(choice)) return json(res, 400, FIXTURE.errors.invalid_approval_choice);
      if (run.status !== 'waiting_for_approval') {
        return json(res, 409, run.status === 'running' ? FIXTURE.errors.approval_not_pending : FIXTURE.errors.approval_not_active);
      }
      if (value.request_id && value.request_id !== run.pendingApproval.request_id) return json(res, 409, FIXTURE.errors.approval_not_pending);
      run.approvals.push({ choice, request_id: value.request_id ?? null });
      const requestId = run.pendingApproval.request_id;
      run.pendingApproval = null;
      publish(run, { event: 'approval.responded', choice, request_id: requestId, resolved: 1 });
      run.answer?.(choice);
      return json(res, 200, { object: 'hermes.run.approval_response', run_id: run.id, choice, request_id: requestId, resolved: 1 });
    }
    if (req.method === 'POST' && action === '/stop') {
      run.stopped = true;
      if (run.status === 'running' || run.status === 'waiting_for_approval') {
        run.status = 'stopping';
        json(res, 200, { run_id: run.id, status: 'stopping' });
        setTimeout(() => { run.release?.(); publish(run, E.cancelled); }, 5);
        return;
      }
      return json(res, 200, { run_id: run.id, status: run.status });
    }
    if (req.method === 'POST' && action === '/steer') {
      const { value } = await body(req);
      if (typeof value?.input !== 'string' || value.input.trim() === '') return json(res, 400, { error: { code: 'invalid_steer_input', message: 'input required' } });
      if (run.status !== 'running') return json(res, 409, { error: { code: 'run_not_accepting_steer', message: 'Run is not running' } });
      run.steers.push(value.input);
      publish(run, E.steered);
      return json(res, 200, { object: 'hermes.run.steer', run_id: run.id, accepted: true });
    }
    return json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    runs,
    sessions,
    requests,
    /** The next `n` POST /v1/runs answer 429 with `Retry-After`. */
    rateLimitNext(n) { state.rateLimitNext = n; },
    /** The next `n` POST /v1/runs answer 503. */
    failNext(n) { state.failNext = n; },
    /** Cut every open event stream of a run (a network blip). */
    cut(runId) {
      const run = runs.get(runId);
      for (const res of run?.subscribers ?? []) res.destroy();
      run?.subscribers.clear();
    },
    /**
     * A gateway restart: running runs end `interrupted` (with what they
     * streamed kept in the session), streams are cut, event buffers are lost;
     * statuses and idempotency survive.
     */
    restart() {
      for (const run of runs.values()) {
        for (const res of run.subscribers) res.destroy();
        run.subscribers.clear();
        run.eventsLost = true;
        if (run.status === 'running' || run.status === 'waiting_for_approval') {
          run.status = 'interrupted';
          run.error = FIXTURE.statuses.interrupted.error;
          run.lastEvent = 'run.interrupted';
          if (run.partial) sessions.get(run.sessionId)?.messages.push({ role: 'assistant', content: run.partial });
          run.release?.();
        }
      }
    },
    /** Finish a held (`slow`) run normally. */
    complete(runId) {
      const run = runs.get(runId);
      if (!run) return;
      run.release?.();
      publish(run, { event: 'message.delta', delta: 'finished.' });
      publish(run, { event: 'run.completed', output: 'Hello finished.', completed: true, partial: false, interrupted: false });
    },
    lastRun() { return [...runs.values()].at(-1); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
