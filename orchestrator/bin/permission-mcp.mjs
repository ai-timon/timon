#!/usr/bin/env node
/**
 * TIMON forms MCP server — registered as `timon_ask`.
 *
 * Every tool here opens something in the TIMON UI and blocks until the human
 * answers:
 *
 *   - `question`     a one-off decision, rendered as a form with buttons;
 *   - `kanban_plan`  the planner of a chantier: how it runs (here, in a fresh
 *                    mission, as Kanban tasks) and with which models;
 *   - `request`      the Allow/Deny card. Called by the harness, never by the
 *                    model: Claude Code reaches it through
 *                    `--permission-prompt-tool mcp__timon_ask__request` and
 *                    expects the decision in this shape:
 *
 *                      { behavior: "allow", updatedInput: <input> }
 *                      { behavior: "deny",  message: "..." }
 *
 * Why a separate process: a CLI only consults these tools via the stdio MCP
 * protocol — it doesn't expose hooks for "ask the host". This tiny shim is the
 * bridge between the agent's tool-use loop and the orchestrator's SSE bus /
 * chat UI.
 *
 * NAMES. The server used to be `timon_permission`, with `ask_user` and
 * `ask_series_plan`. "Permission" drew agents to the wrong form and "series"
 * is not a word a user says. The former tool names are still ANSWERED here
 * (a prompt, a memory or a resumed session may name them) but no longer
 * LISTED: the same tool under two names is a duplicate the model has to choose
 * between. The file kept its name, so a config written before the rename still
 * points at something. `orchestrator/src/ask-mcp.ts` holds the same names for
 * the daemon; `ask-mcp.test.ts` keeps the two in step.
 */
import readline from 'node:readline';
import http from 'node:http';
import { URL } from 'node:url';

const ORCH = process.env.TIMON_ORCH_URL || 'http://localhost:3000';
const MISSION_ID = process.env.TIMON_MISSION_ID || '';
const AGENT = process.env.TIMON_AGENT || '';
/**
 * Per-mission API token, injected in the child's environment by `missionEnv`
 * (agent.ts) and inherited here — the dialect's MCP entry only pins the URL.
 * Without it every card 401s as soon as the instance has user accounts: the
 * daemon tolerates an anonymous caller only while the users table is empty.
 *
 * Deliberately NO fallback to `~/.timon/daemon-token`, unlike bin/timon-mcp.mjs:
 * that token is the operator's superadmin credential, so asking for a
 * permission with it would let the mission act outside the very scope the card
 * exists to enforce. No token means no header, and the daemon answers 401 —
 * which is the correct answer, not something to work around from here.
 */
const API_TOKEN = (process.env.TIMON_API_TOKEN || '').trim();

/** Former tool name → current one. Answered on call, never listed. */
const LEGACY_TOOLS = { ask_user: 'question', ask_series_plan: 'kanban_plan' };

/**
 * `request` is left out of the list where no harness calls it, which the
 * dialect says through this variable (codex, grok, copilot, acp set it). There
 * a model would read "ask the UI for permission" next to the forms and pick it
 * to "open a permission request" — a call nothing gives a meaning to.
 *
 * Listed by DEFAULT, hidden on request, and not the other way round: this file
 * is read from the install directory at every spawn, so a daemon that was not
 * restarted yet runs it with the environment it has always passed. Hidden by
 * default, `--permission-prompt-tool` would name a tool that is not there and
 * every claude mission would lose its Allow/Deny cards until the restart.
 */
const LIST_REQUEST = process.env.TIMON_ASK_FORMS_ONLY !== '1';

/**
 * What a form card is called by the orchestrator, the database and the UI. It
 * is NOT the tool's public name and did not follow its rename: every past
 * mission's events carry it, and they must replay as they were.
 */
const FORM_CARD_TOOL = 'ask_user';

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * How often a call still waiting on the human tells its client it is alive.
 * The claude CLI aborts an MCP call that sent "no response or progress" for
 * 1800 s (TIM-0098): a question left for half an hour died on the agent's side
 * while its card stayed pending in the UI. Any `notifications/progress` resets
 * that idle clock, so one every 30 s keeps the call open as long as the human
 * takes. Overridable so a test does not wait half a minute per beat.
 */
const PROGRESS_MS = Number(process.env.TIMON_ASK_PROGRESS_MS) > 0
  ? Number(process.env.TIMON_ASK_PROGRESS_MS)
  : 30_000;

/** Calls in flight, keyed by JSON-RPC id, so `notifications/cancelled` can stop them. */
const INFLIGHT = new Map();

function abortError() {
  const err = new Error('cancelled by the client');
  err.name = 'AbortError';
  return err;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  function onAbort() { clearTimeout(timer); reject(abortError()); }
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * Single long-poll POST, via raw node:http (not undici's global fetch).
 * WHY node:http and not fetch: (A) Node 20's fetch has a 300s headersTimeout
 * that kills any request held open >5min (user asleep) → `fetch failed`.
 * (B) undici reuses sockets from a keep-alive pool; a half-dead socket reused
 * fails INSTANTLY (ECONNRESET). Here: `agent: false` → fresh socket closed on
 * every request (eliminates B), and no setTimeout on the socket (eliminates
 * A). Resolves {status, body}.
 *
 * `signal` closes the socket: the daemon reads that close as "nobody waits for
 * this card any more" and retires it once its grace delay is over.
 */
function postOnce(payload, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL('/api/permissions/request', ORCH);
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: 'POST',
        agent: false, // fresh socket on every call, no keep-alive pool
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          ...(API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('error', (err) => reject(signal?.aborted ? abortError() : err));
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(0); // never times out: we wait for the human's response
    req.on('error', (err) => reject(signal?.aborted ? abortError() : err));
    if (signal) {
      if (signal.aborted) { req.destroy(); return reject(abortError()); }
      signal.addEventListener('abort', () => req.destroy(), { once: true });
    }
    req.end(data);
  });
}

/**
 * Immortal long-poll: NEVER returns until the user has answered. On network
 * error (socket dropped, orchestrator restart), wait a short backoff then
 * re-POST the SAME tool_use_id — the orchestrator dedups by
 * (mission, tool_use_id) and returns the decision if one was already made.
 * We only propagate an error to Claude on a definitive non-2xx status (4xx,
 * e.g. 410 "mission ended"). Transient 5xx are retried like network errors.
 *
 * The one way out without an answer is `signal`: the client cancelled the call.
 * It must stop the loop too, not only the current socket — a destroyed socket
 * is a network error, which would otherwise be retried into a brand-new card.
 */
async function callOrchestrator(toolName, input, toolUseId, signal) {
  const payload = { mission_id: MISSION_ID, agent: AGENT, tool_name: toolName, input, tool_use_id: toolUseId };
  const backoffs = [2000, 5000, 10000];
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw abortError();
    let res;
    try {
      res = await postOnce(payload, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      await sleep(backoffs[Math.min(attempt, backoffs.length - 1)], signal);
      attempt++;
      continue;
    }
    if (res.status >= 200 && res.status < 300) {
      return JSON.parse(res.body);
    }
    // 4xx = definitive (invalid request or expired mission) → hand back to
    // Claude with the error. 5xx = transient → retry.
    if (res.status >= 400 && res.status < 500) {
      throw new Error(`orchestrator /api/permissions/request → ${res.status} ${res.body.slice(0, 200)}`);
    }
    await sleep(backoffs[Math.min(attempt, backoffs.length - 1)], signal);
    attempt++;
  }
}

const REQUEST_TOOL = {
  name: 'request',
  description:
    'Harness-only: the Allow/Deny round trip for a tool use, called by the CLI itself. Never call it yourself — '
    + 'to ask the human something use `question`, to plan Kanban work use `kanban_plan`.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input', 'tool_use_id'],
  },
};

/**
 * The `message` both forms take. Posted by the daemon as a NORMAL chat message
 * right above the card, never inside it: a long text a model writes in its turn
 * right before the call can end up in its reasoning and never be shown, while
 * a tool's arguments always arrive whole. Bound: `MAX_CHAT_POST_CHARS`
 * (`orchestrator/src/chat-post.ts`).
 */
const MESSAGE_PROPERTY = {
  type: 'string',
  maxLength: 20000,
  description:
    'Optional. A normal message (markdown: headings, lists, tables) posted in the chat right ABOVE the form, so the '
    + 'human has every piece of information needed to choose well: your report, a comparison, a table of the options. '
    + 'Put it here rather than in your turn\'s text: text written right before a tool call may never reach the human. '
    + 'Max 20000 characters.',
};

const MESSAGE_HINT =
  'To give the human what they need to choose (a report, a comparison table), put it in `message`: it is posted as a '
  + 'normal chat message right above the form. The text you write in your turn right before this call may never reach '
  + 'the human (it can end up in your reasoning, which is not shown), so do not rely on it. ';

const QUESTION_TOOL = {
  name: 'question',
  description:
    'Ask the human a ONE-OFF question and wait for the answer: a decision, an arbitration, a choice between options, a go / no-go, a confirmation. '
    + 'Opens a form with buttons in the TIMON chat and blocks until the human answers. '
    + 'Use it instead of the builtin AskUserQuestion tool and instead of a question typed as plain text: neither gives the human a button to click. '
    + 'NOT for planning work: to create or dispatch Kanban tasks, start a chantier or a series of tasks, run work in parallel, or choose models and fallbacks, call `kanban_plan`. '
    + '1–4 questions, each with 2–4 options, optional multiSelect. '
    + 'For an OPEN question (a name, a phrase, a value the human types — e.g. "What should the agent that handles your emails be called?"), omit `options`: the form shows a single text field, optionally hinted by `placeholder`, and the answer is the typed text. '
    + 'Every question with options also ends with a free-text field: the human may add a remark to a choice, or answer in their own words and tick nothing. '
    + 'When an option is an ACTION, say who carries it out with `actor` ("agent": you will do it; "user": the human will) and word the label in the infinitive ("Switch the repository to main"): the form shows the badge, the label no longer has to say "I" or "you". '
    + 'Returns {answers: {<question text>: <answer>}} once the human submits, keyed by the text of each question. <answer> is the picked label (a string), the picked labels (an array, multiSelect), or the typed text (open question). '
    + 'When the human also typed in the free-text field of a question with options, that question\'s answer becomes an object holding the text beside the pick — {"choice": <label>, "text": <typed>}, {"choices": [<labels>], "text": <typed>} on a multiSelect, or {"text": <typed>} when they ticked nothing; the text may qualify or override the pick, take it into account. '
    + 'Example: {"answers": {"Which branch?": "main", "Which checks?": ["lint", "types"], "Ship it now?": {"choice": "Wait", "text": "after the demo on Friday"}}}. '
    + 'If the human cancels, the tool errors. '
    + MESSAGE_HINT
    + '(Formerly `ask_user`.)',
  inputSchema: {
    type: 'object',
    properties: {
      message: MESSAGE_PROPERTY,
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Full question text, ending with `?`.' },
            header: { type: 'string', description: 'Very short label (max 12 chars), shown as a chip above the question.' },
            multiSelect: { type: 'boolean', default: false },
            placeholder: { type: 'string', description: 'Free-text question only: hint shown in the empty text field.' },
            options: {
              type: 'array',
              description: '2–4 choices. Omit it for a free-text question (one text field).',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short choice. An action is worded in the infinitive; `actor` says who carries it out.' },
                  description: { type: 'string' },
                  actor: {
                    type: 'string',
                    enum: ['agent', 'user'],
                    description: 'Who carries the option out when it is an action: "agent" (you) or "user" (the human). Shown as a badge before the label. Omit it for an option that is not an action.',
                  },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'header'],
        },
      },
    },
    required: ['questions'],
  },
};

const KANBAN_PLAN_TOOL = {
  name: 'kanban_plan',
  description:
    'Opens the KANBAN PLANNER in the TIMON UI and blocks until the human submits it. '
    + 'Call it FIRST, before creating anything, whenever the user wants to create or dispatch Kanban tasks, launch a chantier, a series of tasks or a large multi-part feature, run work in parallel, or choose which models and fallbacks do the work. '
    + 'The human picks how the work runs — sequentially in this mission, sequentially in one fresh mission, or as Kanban tasks (full pipeline, code-self, code-group) — so it covers the sequential modes too, not only the Kanban ones. '
    + "DO NOT ENUMERATE backends or models yourself, and do not ask about them with `question`: the UI builds its menus from the live catalog, your values would be stale. Send only the chantier's title and its volets. "
    + 'When the volets differ in difficulty, give each a short `group` name (e.g. "simple" / "complex", 6 groups max): the human can then pick models per group, the general settings staying the default. Still no model names from you. '
    + 'Returns {plan:{mode, roles:{<role>:{backend,model,fallbackBackend,fallbackModel}}, groups?:{<group>:{<role>:{…}}}}, commands:[...], note?} — `commands` being the exact `timon` commands to run, in order, to materialize the plan. If the human cancels, the tool errors. '
    + MESSAGE_HINT
    + '(Formerly `ask_series_plan`.)',
  inputSchema: {
    type: 'object',
    properties: {
      message: MESSAGE_PROPERTY,
      chantier: { type: 'string', description: 'Short chantier title, shown at the top of the form.' },
      volets: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        description: 'Proposed breakdown — one volet per code task in Kanban modes.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            group: {
              type: 'string',
              minLength: 1,
              maxLength: 60,
              description: 'Optional short group name shared by volets of similar difficulty; the human sets models per group. Omit when every volet is alike.',
            },
          },
          required: ['title'],
        },
      },
    },
    required: ['chantier', 'volets'],
  },
};

/** The form's input, with the agent's `message` beside it when there is one:
 *  the daemon posts it, then strips it from the card. */
function withMessage(input, args) {
  return args.message === undefined ? input : { ...input, message: args.message };
}

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // Notifications (no id) get no response.
  const id = msg.id;

  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'timon-ask', version: '1.0.0' },
      },
    });
  }

  if (msg.method === 'notifications/initialized') {
    return; // notification, no reply
  }

  if (msg.method === 'notifications/cancelled') {
    // The client gave up on a call (the user interrupted the turn): drop its
    // long-poll so the card does not outlive it. No reply, per the MCP spec.
    INFLIGHT.get(String(msg.params?.requestId))?.abort();
    return;
  }

  if (msg.method === 'tools/list') {
    return send({
      jsonrpc: '2.0', id,
      result: { tools: [...(LIST_REQUEST ? [REQUEST_TOOL] : []), QUESTION_TOOL, KANBAN_PLAN_TOOL] },
    });
  }

  if (msg.method === 'tools/call') {
    const called = msg.params?.name;
    const name = Object.hasOwn(LEGACY_TOOLS, called) ? LEGACY_TOOLS[called] : called;
    const args = msg.params?.arguments || {};
    const controller = new AbortController();
    const signal = controller.signal;
    INFLIGHT.set(String(id), controller);
    // Progress only for a client that asked for it: a token we were not given
    // would be an unknown token to it, not a heartbeat.
    const progressToken = msg.params?._meta?.progressToken;
    let beat = 0;
    const heartbeat = progressToken === undefined ? null : setInterval(() => {
      beat += 1;
      send({
        jsonrpc: '2.0', method: 'notifications/progress',
        params: { progressToken, progress: beat, message: 'waiting for the human to answer in Timon' },
      });
    }, PROGRESS_MS);
    try {
      if (name === 'request') {
        const decision = await callOrchestrator(args.tool_name, args.input, args.tool_use_id, signal);
        // Claude expects a single text content block whose JSON body is the
        // decision object.
        return send({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(decision) }] },
        });
      }
      if (name === 'question') {
        // The orchestrator special-cases the form card's tool name so the UI
        // renders the form instead of an Allow/Deny card. The user's
        // submission resolves as {behavior:'allow', updatedInput:{answers:{...}}};
        // cancel resolves as deny. We unwrap and present those as the
        // *result* of this tool call so claude reads the answers directly.
        const tuid = 'ask_user_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        const decision = await callOrchestrator(FORM_CARD_TOOL, withMessage({ questions: args.questions }, args), tuid, signal);
        if (decision?.behavior === 'allow') {
          const answers = decision.updatedInput?.answers ?? {};
          // The form no longer has a global note: each question carries its own
          // free text inside its answer. A note still comes from a plugin built
          // against the former answer shape; it reaches the agent rather than
          // being dropped on the floor.
          const note = decision.updatedInput?.note;
          const payload = note ? { answers, note } : { answers };
          return send({
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
          });
        }
        return send({
          jsonrpc: '2.0', id,
          result: {
            isError: true,
            content: [{ type: 'text', text: decision?.message || 'user declined to answer' }],
          },
        });
      }
      if (name === 'kanban_plan') {
        // Same channel as `question` on the orchestrator side (the same form
        // card), but a TYPED payload: the UI recognizes `form.kind` and
        // renders the planner instead of a stack of radio buttons. The
        // response is already validated and enriched with commands by the
        // orchestrator. `series_plan` is the form's persisted kind: like the
        // card's name, it did not follow the tool's rename.
        const tuid = 'ask_series_plan_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        const form = { kind: 'series_plan', chantier: args.chantier, volets: args.volets };
        const decision = await callOrchestrator(FORM_CARD_TOOL, withMessage({ form }, args), tuid, signal);
        if (decision?.behavior === 'allow') {
          const u = decision.updatedInput ?? {};
          const payload = { plan: u.plan, commands: u.commands ?? [] };
          if (u.note) payload.note = u.note;
          return send({
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
          });
        }
        return send({
          jsonrpc: '2.0', id,
          result: {
            isError: true,
            content: [{ type: 'text', text: decision?.message || 'user declined to answer' }],
          },
        });
      }
      throw new Error(`unknown tool: ${called}`);
    } catch (err) {
      // A cancelled request gets no response at all (MCP spec).
      if (signal.aborted) return;
      return send({
        jsonrpc: '2.0', id,
        error: { code: -32000, message: String(err?.message || err) },
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      INFLIGHT.delete(String(id));
    }
  }

  // Method not implemented — reply per JSON-RPC if this was a request.
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
});

// The client is gone (stdin closed): every call in flight is cancelled with
// it — an open long-poll socket would otherwise keep the process alive, and
// its card pending, with nobody left to read the answer. No `process.exit`:
// once the sockets and timers are gone the process ends by itself, without
// cutting a stdout write short on a platform where pipes are asynchronous.
rl.on('close', () => {
  for (const controller of INFLIGHT.values()) controller.abort();
});

// Keep alive; readline will hold stdin open as long as Claude is the parent.
process.stdin.resume();
