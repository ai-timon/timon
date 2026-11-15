/**
 * The `SessionDriver` of an ACP agent: transport + event mapping, assembled
 * behind the contract the runner speaks (`../types.ts`, "Bidirectional session
 * drivers").
 *
 * What lives here and nowhere else:
 *  - the handshake, and which way a stored session is reopened, decided by what
 *    THIS agent announced (`session/resume` when it can, else `session/load`,
 *    else a fresh session — never a failure for want of history);
 *  - the history an agent replays while reopening (Hermes does it even on
 *    `resume`): dropped until the call returns, or the transcript would show
 *    the old conversation again;
 *  - `session/request_permission` → `SessionHost.requestPermission` (the
 *    classifier and the Allow/Deny card), and the way back to the agent's own
 *    option ids;
 *  - the turn's time limits, which `session/prompt` does not have on the wire,
 *    and a cancellation that cannot leave the agent hanging.
 *
 * The driver never touches the process: the runner owns it and kills it.
 */

import type {
  ImageAttachment, NormalizedEvent, PermissionDecision, PermissionRequest, SessionCapabilities, SessionHost,
  SessionInfo, SessionDriver, SessionStdio, TurnOutcome,
} from '../types.js';
import {
  AcpRpcError, AcpTransport, AcpTransportError,
  type AcpContentBlock, type AcpMcpServer, type AcpPermissionOption, type AcpPermissionRequest,
  type AcpPermissionResponse, type AcpRecord,
} from './transport.js';
import { signInAdvice, type AcpSignIn } from './auth.js';
import { AcpEventMapper, acpInitEvent, acpUpdateSessionId, toolName } from './events.js';
import { acpExtensionCards, type AcpExtensionHandler } from './extensions.js';

/** JSON-RPC code ACP uses for "authenticate first". */
export const RPC_AUTH_REQUIRED = -32000;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Silence, not duration: a long turn that keeps talking never trips it. Kept
 *  under the runner's own hung-turn reaper (45 min), which would otherwise be
 *  the one to kill the mission with no `result` written. */
const DEFAULT_TURN_IDLE_MS = 30 * 60_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;
/** `authenticate` after an `auth_required`: a method that reuses a stored sign-in answers at once; one that waits on a human is not ours to wait for. */
const AUTHENTICATE_TIMEOUT_MS = 30_000;
/** A card nobody answers. The host bounds it too (autonomous missions); this is
 *  the floor under a host that does not, so the agent is never blocked on us. */
const DEFAULT_PERMISSION_WAIT_MS = 40 * 60_000;
const MAX_ERROR_CHARS = 500;

export type AcpDriverOptions = {
  io: SessionStdio;
  host: SessionHost;
  cwd: string;
  /** ACP has no system prompt: it rides in front of the first message of a
   *  session that starts from scratch. */
  systemPrompt: string;
  /** Model to select after the session opens, or null for the agent's default. */
  model: string | null;
  /** Thinking level to select once the model is, or null/absent for the
   *  model's own default. */
  reasoningEffort?: string | null;
  /** Session to reopen, or null for a fresh one. */
  resumeSession: string | null;
  /** MCP servers of the session, resolved lazily: building them reads the
   *  user's configuration and may refresh a token. */
  mcpServers: () => Promise<AcpMcpServer[]>;
  /** This agent never asks (cf. `SessionCapabilities.permissionsByAgent`). */
  permissionsByAgent: boolean;
  /** Only for the messages and the init event: which profile this is. */
  profileId: string;
  /** What to tell a user whose agent wants a sign-in (the provider's own data). */
  signIn?: AcpSignIn;
  /**
   * The auth method to try once when `session/new` answers `auth_required` AND the agent announced it in
   * `initialize`. Never called ahead of time: a method may start a browser flow, and an agent already
   * signed in does not need it.
   */
  authenticateWith?: string;
  /**
   * The agent runs inside the mission fence: `authenticateWith` is then never tried. A sign-in method may
   * open a browser and wait for its redirect, which a fenced process cannot reach (no display, no keychain
   * bus): the wait would end only at its timeout, with the user's message unanswered meanwhile.
   */
  fenced?: () => boolean;
  /** The agent's own blocking requests the provider answers (`AcpAgentSpec.extensionRequests`). */
  extensionRequests?: Readonly<Record<string, AcpExtensionHandler>>;
  clientVersion?: string;
  requestTimeoutMs?: number;
  turnIdleTimeoutMs?: number;
  cancelGraceMs?: number;
  permissionWaitMs?: number;
  /** Called once, when the driver lets go of the pipes. */
  onClose?: () => void;
};

type Turn = {
  cancelled: boolean;
  timedOut: boolean;
  idleTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
  /** Settles the turn without the agent's reply (cancel that was not obeyed). */
  force: () => void;
};

function asRecord(v: unknown): AcpRecord | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as AcpRecord) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** One line, bounded: an error that ends up in the chat and in `result`. */
function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > MAX_ERROR_CHARS ? `${one.slice(0, MAX_ERROR_CHARS)}…` : one;
}

function describe(err: unknown): string {
  if (err instanceof AcpRpcError || err instanceof AcpTransportError) return clip(err.message);
  return 'the agent session failed unexpectedly';
}

/** What the handshake says the agent can do. Reported as announced: a stdio MCP
 *  server works on both known agents whatever they announce (cf. `mcp`). */
function parseCapabilities(init: AcpRecord, permissionsByAgent: boolean): SessionCapabilities {
  const caps = asRecord(init.agentCapabilities) ?? {};
  const prompt = asRecord(caps.promptCapabilities);
  const session = asRecord(caps.sessionCapabilities);
  return {
    loadSession: caps.loadSession === true,
    resume: session !== null && asRecord(session.resume) !== null,
    // Verified on opencode and Hermes by handing them a stdio server, against
    // announcements that say the opposite (http/sse only; nothing).
    mcp: true,
    image: prompt !== null && prompt.image === true,
    ...(permissionsByAgent ? { permissionsByAgent: true } : {}),
  };
}

function authHint(init: AcpRecord): string {
  const methods = Array.isArray(init.authMethods) ? init.authMethods : [];
  const names: string[] = [];
  for (const m of methods.slice(0, 5)) {
    const r = asRecord(m);
    const name = str(r?.name) ?? str(r?.id);
    if (name) names.push(name.slice(0, 80));
  }
  return names.length ? ` (${names.join(', ')})` : '';
}

/** The model the session says it runs, in either shape an agent uses. */
export function currentModel(result: AcpRecord): string | null {
  const models = asRecord(result.models);
  const fromModels = str(models?.currentModelId);
  if (fromModels) return fromModels;
  if (Array.isArray(result.configOptions)) {
    for (const o of result.configOptions) {
      const r = asRecord(o);
      if (r && (r.id === 'model' || r.category === 'model')) return str(r.currentValue);
    }
  }
  return null;
}

/** The agent's own word for "no level chosen": it is not a level to offer. */
const DEFAULT_LEVEL = 'default';

/** Config id opencode gives its thinking-level option. */
const EFFORT_CONFIG_ID = 'effort';

/** Values of an option, flat or grouped (`options` is either, in the protocol). */
function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const values: string[] = [];
  for (const item of options) {
    const r = asRecord(item);
    if (!r) continue;
    const value = str(r.value);
    if (value) values.push(value);
    else values.push(...optionValues(r.options));
  }
  return values;
}

/**
 * The thinking levels the session offers for the model it runs now: its
 * `thought_level` config option (the category the protocol reserves for it),
 * without the agent's own "default". `null` = this model has none — opencode
 * leaves the option out for a model with no variants.
 */
export function thoughtLevels(result: AcpRecord): { id: string; levels: string[] } | null {
  if (!Array.isArray(result.configOptions)) return null;
  for (const o of result.configOptions) {
    const r = asRecord(o);
    const id = r ? str(r.id) : null;
    if (!r || !id || r.category !== 'thought_level') continue;
    const levels = [...new Set(optionValues(r.options))].filter((v) => v !== DEFAULT_LEVEL);
    return levels.length > 0 ? { id, levels } : null;
  }
  return null;
}

/** The option that answers a decision. `once` on purpose: an Allow click grants
 *  this call, never a standing permission the user did not give; a Deny click
 *  refuses this call, not every future one. No matching option = `cancelled`. */
function optionFor(options: readonly AcpPermissionOption[], allow: boolean): AcpPermissionResponse {
  const kind = allow ? 'allow_once' : 'reject_once';
  // `allow-once` / `reject-once`: the ids Cursor documents, with the hyphen of its own style.
  const named = allow ? /^(allow|allow[-_]once|once)$/i : /^(deny|reject|reject[-_]once)$/i;
  const picked = options.find((o) => o.kind === kind) ?? options.find((o) => o.kind === '' && named.test(o.optionId));
  return picked ? { outcome: 'selected', optionId: picked.optionId } : { outcome: 'cancelled' };
}

/**
 * `session/new`; on `auth_required`, once, the method the provider declared if the agent announced it in `initialize`,
 * then `session/new` again. Any refusal of that detour leaves the original `auth_required` to report; a dead agent
 * surfaces as itself. Shared by the session driver and the model probe, so both sign in the same way.
 */
export async function newSessionAuthenticating(
  transport: AcpTransport, init: AcpRecord, params: { cwd: string; mcpServers: AcpMcpServer[] }, authenticateWith: string | undefined,
): Promise<{ sessionId: string; result: AcpRecord }> {
  try {
    return await transport.newSession(params);
  } catch (err) {
    const announced = authenticateWith !== undefined
      && (Array.isArray(init.authMethods) ? init.authMethods : []).some((m) => asRecord(m)?.id === authenticateWith);
    if (!(err instanceof AcpRpcError && err.code === RPC_AUTH_REQUIRED) || !announced) throw err;
    try {
      await transport.authenticate(authenticateWith, AUTHENTICATE_TIMEOUT_MS);
    } catch (authErr) {
      if (!(authErr instanceof AcpRpcError)) throw authErr;
      throw err;
    }
    return transport.newSession(params);
  }
}

export class AcpSessionDriver implements SessionDriver {
  private readonly transport: AcpTransport;
  private readonly mapper = new AcpEventMapper();
  private readonly opts: AcpDriverOptions;

  private sessionInfo: SessionInfo | null = null;
  private sessionId: string | null = null;
  private replaying = false;
  private systemSent = false;
  private turn: Turn | null = null;
  private pendingPermissions = 0;
  private stuck = false;
  private closed = false;

  constructor(opts: AcpDriverOptions) {
    this.opts = opts;
    this.transport = new AcpTransport({
      io: opts.io,
      onSessionUpdate: (params) => this.onUpdate(params),
      onPermissionRequest: (req, signal) => this.onPermission(req, signal),
      ...(opts.extensionRequests && Object.keys(opts.extensionRequests).length
        ? {
          extensionMethods: new Set(Object.keys(opts.extensionRequests)),
          onExtensionRequest: (method: string, params: unknown, signal: AbortSignal) => this.onExtension(method, params, signal),
        }
        : {}),
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      clientVersion: opts.clientVersion,
    });
  }

  get info(): SessionInfo | null {
    return this.sessionInfo;
  }

  /* ── Handshake ───────────────────────────────────────────────────────── */

  async start(): Promise<SessionInfo> {
    if (this.sessionInfo) return this.sessionInfo;
    try {
      const init = await this.transport.initialize();
      const capabilities = parseCapabilities(init, this.opts.permissionsByAgent);
      const servers = await this.opts.mcpServers();

      let sessionId: string | null = null;
      let result: AcpRecord = {};
      if (this.opts.resumeSession) {
        const reopened = await this.reopen(this.opts.resumeSession, capabilities, servers);
        if (reopened) {
          sessionId = this.opts.resumeSession;
          result = reopened;
        }
      }
      const resumed = sessionId !== null;
      if (sessionId === null) {
        try {
          const authenticateWith = this.opts.fenced?.() ? undefined : this.opts.authenticateWith;
          const created = await newSessionAuthenticating(this.transport, init, { cwd: this.opts.cwd, mcpServers: servers }, authenticateWith);
          sessionId = created.sessionId;
          result = created.result;
        } catch (err) {
          if (err instanceof AcpRpcError && err.code === RPC_AUTH_REQUIRED) {
            const advice = signInAdvice(this.opts.signIn, init.authMethods);
            throw new AcpTransportError('protocol', `the agent needs you to sign in first${authHint(init)}${advice ? ` — ${advice}` : ''}`);
          }
          throw err;
        }
      }
      this.sessionId = sessionId;
      await this.applyModel(sessionId, result);
      await this.applyEffort(sessionId, result);

      this.sessionInfo = { sessionId, capabilities, resumed };
      this.systemSent = resumed;
      const init0 = acpInitEvent(sessionId, this.opts.profileId);
      this.emit([capabilities.permissionsByAgent
        ? { ...init0, payload: { ...(init0.payload as AcpRecord), permissions_by_agent: true } }
        : init0]);
      return this.sessionInfo;
    } catch (err) {
      this.close();
      throw new Error(describe(err));
    }
  }

  /** Reopens a stored session. `null` = the agent cannot or will not, and the
   *  caller starts a fresh one: losing history must not lose the mission. */
  private async reopen(sessionId: string, caps: SessionCapabilities, servers: AcpMcpServer[]): Promise<AcpRecord | null> {
    const params = { sessionId, cwd: this.opts.cwd, mcpServers: servers };
    const ways: Array<() => Promise<AcpRecord>> = [];
    if (caps.resume) ways.push(() => this.transport.resumeSession(params));
    if (caps.loadSession) ways.push(() => this.transport.loadSession(params));
    for (const way of ways) {
      this.replaying = true;
      try {
        return await way();
      } catch (err) {
        // `-32601` (no such method) or "unknown session": try the next way, then
        // a fresh session. A dead agent is not that — it surfaces.
        if (!(err instanceof AcpRpcError)) throw err;
      } finally {
        this.replaying = false;
      }
    }
    return null;
  }

  private async applyModel(sessionId: string, result: AcpRecord): Promise<void> {
    const want = this.opts.model?.trim();
    if (!want || currentModel(result) === want) return;
    try {
      await this.transport.setModel(sessionId, want);
    } catch (err) {
      if (!(err instanceof AcpRpcError)) throw err;
      // The agent keeps the model it has; the mission goes on with it rather
      // than dying on a model id it does not know.
      console.warn(`[acp] ${this.opts.profileId}: model ${want} not applied (${clip(err.message)})`);
    }
  }

  /** After the model: a level belongs to the model that declares it, and the
   *  agent refuses one the model does not know. */
  private async applyEffort(sessionId: string, result: AcpRecord): Promise<void> {
    const want = this.opts.reasoningEffort?.trim();
    if (!want) return;
    const id = thoughtLevels(result)?.id ?? EFFORT_CONFIG_ID;
    try {
      await this.transport.setConfigOption(sessionId, id, want);
    } catch (err) {
      if (!(err instanceof AcpRpcError)) throw err;
      // The agent keeps the model's default level; the mission goes on with it.
      console.warn(`[acp] ${this.opts.profileId}: thinking level ${want} not applied (${clip(err.message)})`);
    }
  }

  /* ── Turns ───────────────────────────────────────────────────────────── */

  async prompt(text: string, images?: ImageAttachment[]): Promise<TurnOutcome> {
    if (!this.sessionInfo || this.sessionId === null) throw new Error('the session is not started');
    if (this.closed) throw new Error('the session is closed');
    if (this.stuck) throw new Error('the agent did not stop the cancelled turn: start a new session');
    if (this.turn) throw new Error('a turn is already running');

    const sessionId = this.sessionId;
    const blocks = this.buildPrompt(text, images);
    this.mapper.beginTurn();
    let force!: () => void;
    const forced = new Promise<'forced'>((resolve) => { force = () => resolve('forced'); });
    const turn: Turn = { cancelled: false, timedOut: false, idleTimer: null, graceTimer: null, force };
    this.turn = turn;
    this.armIdle();

    const reply = this.transport.prompt(sessionId, blocks, 0);
    // Whatever wins the race, a later rejection of the loser must not be unhandled.
    reply.catch(() => undefined);
    try {
      const won = await Promise.race([reply, forced]);
      if (won === 'forced') {
        this.stuck = true;
        this.emit(this.mapper.finishTurn({
          stopReason: 'cancelled',
          ...(turn.timedOut ? { error: this.timeoutMessage() } : {}),
        }));
        return { stopReason: 'cancelled' };
      }
      this.emit(this.mapper.finishTurn({
        stopReason: won.stopReason,
        usage: won.usage,
        ...(turn.timedOut ? { error: this.timeoutMessage() } : {}),
      }));
      return { stopReason: won.stopReason };
    } catch (err) {
      const message = describe(err);
      this.emit(this.mapper.finishTurn({ error: message }));
      // The agent answered with an error but is still there: the turn failed,
      // the session did not. A dead one is the runner's to handle.
      if (this.transport.alive) return { stopReason: 'error' };
      throw new Error(message);
    } finally {
      this.endTurn(turn);
    }
  }

  private timeoutMessage(): string {
    return 'the agent produced nothing for too long: the turn was stopped';
  }

  private buildPrompt(text: string, images?: ImageAttachment[]): AcpContentBlock[] {
    const blocks: AcpContentBlock[] = [];
    if (!this.systemSent) {
      this.systemSent = true;
      if (this.opts.systemPrompt.trim()) {
        blocks.push({ type: 'text', text: `<timon_instructions>\n${this.opts.systemPrompt}\n</timon_instructions>` });
      }
    }
    const sendImages = Boolean(images?.length) && this.sessionInfo?.capabilities.image === true;
    // The note about what could not be sent comes BEFORE the message: the
    // message is what the agent answers, so it stays the last thing it reads.
    if (images?.length && !sendImages) {
      blocks.push({ type: 'text', text: `[${images.length} image(s) not sent: this agent does not accept images]` });
    }
    if (text) blocks.push({ type: 'text', text });
    if (sendImages) {
      for (const img of images!) blocks.push({ type: 'image', data: img.data, mimeType: img.media_type });
    }
    return blocks;
  }

  async cancel(): Promise<void> {
    const turn = this.turn;
    if (!turn || this.sessionId === null || turn.cancelled) return;
    this.stop(turn);
  }

  /** Asks the agent to stop, and gives up waiting if it does not. */
  private stop(turn: Turn): void {
    turn.cancelled = true;
    if (this.sessionId === null) return;
    this.transport.cancel(this.sessionId);
    if (!turn.graceTimer) {
      turn.graceTimer = setTimeout(() => turn.force(), this.opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
      turn.graceTimer.unref?.();
    }
  }

  private endTurn(turn: Turn): void {
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    if (this.turn === turn) this.turn = null;
  }

  /** Restarts the silence timer. Paused while a card waits on a human: that is
   *  the user's time, not the agent's. */
  private armIdle(): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.idleTimer) { clearTimeout(turn.idleTimer); turn.idleTimer = null; }
    const limit = this.opts.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_MS;
    if (limit <= 0 || this.pendingPermissions > 0 || turn.cancelled) return;
    turn.idleTimer = setTimeout(() => {
      turn.timedOut = true;
      this.stop(turn);
    }, limit);
    turn.idleTimer.unref?.();
  }

  async setModel(model: string): Promise<boolean> {
    if (this.turn || this.sessionId === null || this.closed) return false;
    try {
      await this.transport.setModel(this.sessionId, model);
      return true;
    } catch {
      return false;
    }
  }

  /* ── From the agent ──────────────────────────────────────────────────── */

  private onUpdate(params: AcpRecord): void {
    // History the agent replays while a session reopens is not conversation.
    if (this.replaying) return;
    const sid = acpUpdateSessionId(params);
    if (sid && this.sessionId && sid !== this.sessionId) return;
    this.armIdle();
    this.emit(this.mapper.update(params));
  }

  private async onPermission(req: AcpPermissionRequest, signal: AbortSignal): Promise<AcpPermissionResponse> {
    if (this.sessionId !== null && req.sessionId !== this.sessionId) return { outcome: 'cancelled' };
    this.pendingPermissions += 1;
    this.armIdle();
    try {
      const decision = await this.decide(this.toRequest(req), signal);
      return optionFor(req.options, decision.allow);
    } finally {
      this.pendingPermissions -= 1;
      this.armIdle();
    }
  }

  /**
   * One of the agent's own blocking requests, answered by the provider's handler with the cards the
   * host lends. Like a permission card, the wait is the person's time (the silence timer pauses) and
   * has the same ceiling, after which the handler is told the agent stopped waiting.
   */
  private async onExtension(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const handler = this.opts.extensionRequests?.[method];
    if (!handler) throw new Error('no handler');
    const named = asRecord(params)?.sessionId;
    const wait = new AbortController();
    const stop = (): void => wait.abort();
    if (signal.aborted || (typeof named === 'string' && this.sessionId !== null && named !== this.sessionId)) wait.abort();
    signal.addEventListener('abort', stop, { once: true });
    const ceiling = setTimeout(stop, this.opts.permissionWaitMs ?? DEFAULT_PERMISSION_WAIT_MS);
    ceiling.unref?.();
    this.pendingPermissions += 1;
    this.armIdle();
    try {
      return await handler(params, acpExtensionCards(this.opts.host.ask?.bind(this.opts.host), wait.signal));
    } finally {
      clearTimeout(ceiling);
      signal.removeEventListener('abort', stop);
      this.pendingPermissions -= 1;
      this.armIdle();
    }
  }

  private toRequest(req: AcpPermissionRequest): PermissionRequest {
    const call = req.toolCall;
    const title = str(call.title);
    return {
      toolCallId: str(call.toolCallId),
      tool: toolName({ kind: str(call.kind), title, rawInput: call.rawInput }),
      title,
      input: call.rawInput ?? {},
    };
  }

  /** The host's answer, or a denial: a host that rejects (headless, no card
   *  channel), a wait that outlasts the ceiling, a cancelled turn. In every
   *  case the agent is answered now rather than left blocked. */
  private async decide(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    const deny: PermissionDecision = { allow: false };
    if (signal.aborted) return deny;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const ceiling = new Promise<PermissionDecision>((resolve) => {
      timer = setTimeout(() => resolve(deny), this.opts.permissionWaitMs ?? DEFAULT_PERMISSION_WAIT_MS);
      timer.unref?.();
      onAbort = () => resolve(deny);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const asked = Promise.resolve()
        .then(() => this.opts.host.requestPermission(req))
        .catch((): PermissionDecision => deny);
      return await Promise.race([asked, ceiling]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private emit(events: NormalizedEvent[]): void {
    for (const ev of events) {
      try {
        this.opts.host.emit(ev);
      } catch {
        // A persistence hiccup on one line must not tear the session down.
      }
    }
  }

  /* ── End of life ─────────────────────────────────────────────────────── */

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const turn = this.turn;
    if (turn) this.endTurn(turn);
    this.transport.dispose();
    this.opts.onClose?.();
  }
}
