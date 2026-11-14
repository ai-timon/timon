/**
 * The codex cut of a chat rewind (`SessionStrategy.rewind`, docs/specs/rewind.md).
 *
 * `codex exec` cannot drop turns from a thread, but `codex app-server` (stdio JSON-RPC, experimental,
 * measured on codex-cli 0.169.0) can fork one: `thread/fork { threadId, lastTurnId }` writes a new
 * thread holding the turns up to `lastTurnId`, beside the original, in the same CODEX_HOME. The next
 * turn then resumes the fork (`codex exec resume <fork id>`). No model call: ~590 ms on a 3.4 MB thread.
 *
 * The turn to keep is found by position (the chat's N-th kept message is the thread's N-th turn) and
 * checked by content: its user text must hold that message. Anything unexpected throws, and the
 * daemon falls back on a fresh thread seeded with a summary.
 */

/** Turns asked per page of `thread/turns/list`. */
const PAGE = 100;
/** A fork of a large thread takes well under a second; the daemon stops the process at this deadline. */
const DEADLINE_MS = 20_000;

function parse(payload) {
    try {
        return JSON.parse(payload);
    }
    catch {
        return null;
    }
}

/** The text of a `user` event Timon sent as a turn's prompt, or null for anything else (a tool result). */
function promptText(event) {
    if (event.type !== 'user')
        return null;
    const content = parse(event.payload)?.message?.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content) || content.length === 0 || content.some((b) => b?.type !== 'text' && b?.type !== 'image'))
        return null;
    return content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function startsSession(event, sessionId) {
    if (event.type !== 'system')
        return false;
    const payload = parse(event.payload);
    return payload?.subtype === 'init' && payload.session_id === sessionId;
}

/**
 * The prompts of the visible thread that thread `sessionId` received, in order: from the one that
 * opened it (the prompt just before its first `system:init`) on. Null when nothing at all is left
 * before the cut (a rewind to the first message: a fresh thread). Throws when the thread was opened
 * in the cut part while earlier messages remain: they live in another thread, the summary carries them.
 *
 * Exported for the test.
 */
export function sessionPrompts(events, sessionId) {
    const ordered = [...events].sort((a, b) => a.id - b.id);
    const start = ordered.findIndex((event) => startsSession(event, sessionId));
    const prompts = (from) => ordered.slice(from).map(promptText).filter((text) => text !== null);
    if (start === -1) {
        if (prompts(0).length === 0)
            return null;
        throw new Error(`thread ${sessionId} started after the cut, earlier messages belong to another thread`);
    }
    let opener = start;
    while (opener > 0 && promptText(ordered[opener]) === null)
        opener--;
    return prompts(opener);
}

/** The user text of a codex turn (`thread/turns/list`, items `full`). */
function turnUserText(turn) {
    return (turn?.items ?? [])
        .filter((item) => item?.type === 'userMessage')
        .flatMap((item) => item.content ?? [])
        .filter((input) => input?.type === 'text' && typeof input.text === 'string')
        .map((input) => input.text)
        .join('\n');
}

/**
 * JSON-RPC over the newline-delimited pipes of `codex app-server`. An error with no id (the reply to
 * an unknown method, `-32600 unknown variant`) and the end of the process fail every pending call.
 *
 * @param {import('@timon-ai/sdk/provider').ProviderConversation} conversation
 */
function rpcOver(conversation) {
    const pending = new Map();
    let nextId = 1;
    let buffer = '';
    const failAll = (error) => {
        for (const { reject } of pending.values())
            reject(error);
        pending.clear();
    };
    conversation.onData((chunk) => {
        buffer += Buffer.from(chunk).toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const message = parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (!message || typeof message !== 'object')
                continue;
            const waiting = message.id !== undefined ? pending.get(message.id) : undefined;
            if (message.error && !waiting) {
                failAll(new Error(`app-server: ${message.error.message ?? 'error'}`));
                continue;
            }
            if (!waiting)
                continue; // a notification
            pending.delete(message.id);
            if (message.error)
                waiting.reject(new Error(`app-server: ${message.error.message ?? 'error'}`));
            else
                waiting.resolve(message.result);
        }
    });
    void conversation.exited.then(({ code, signal }) => failAll(new Error(`app-server exited (${signal ?? code}): ${conversation.stderr().slice(-300)}`)));
    return {
        call(method, params) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                conversation.write(`${JSON.stringify({ id, method, params })}\n`);
            });
        },
        notify(method) {
            conversation.write(`${JSON.stringify({ method })}\n`);
        },
    };
}

/**
 * Cuts thread `ctx.sessionId` where the chat was rewound and resolves the thread the next turn resumes.
 *
 * @param {import('@timon-ai/sdk/provider').ProviderBinary} binary `ctx.provider.binary`
 * @param {{ sessionId: string, events: readonly { id: number, type: string, payload: string }[], scratch: string | null }} ctx
 * @returns {Promise<{ resume: string | null }>}
 */
export async function rewindCodexThread(binary, ctx) {
    const prompts = sessionPrompts(ctx.events, ctx.sessionId);
    if (prompts === null)
        return { resume: null };
    const expected = prompts.at(-1)?.trim();
    if (!expected)
        throw new Error('the last kept message has no text to check the thread against');
    if (!ctx.scratch)
        throw new Error('the mission has no CODEX_HOME left');
    const conversation = await binary.converse('codex', ['app-server'], { env: { CODEX_HOME: ctx.scratch }, timeoutMs: DEADLINE_MS });
    try {
        const rpc = rpcOver(conversation);
        await rpc.call('initialize', { clientInfo: { name: 'timon', version: '0' } });
        rpc.notify('initialized');
        const turns = [];
        let cursor = null;
        do {
            const page = await rpc.call('thread/turns/list', {
                threadId: ctx.sessionId, sortDirection: 'asc', itemsView: 'full', limit: PAGE, cursor,
            });
            if (!Array.isArray(page?.data))
                throw new Error('thread/turns/list answered without `data`');
            turns.push(...page.data);
            cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
        } while (cursor && turns.length < prompts.length);
        const keep = turns[prompts.length - 1];
        if (!keep || typeof keep.id !== 'string')
            throw new Error(`the thread has ${turns.length} turns, the chat kept ${prompts.length} messages`);
        if (!turnUserText(keep).includes(expected))
            throw new Error(`turn ${prompts.length} of the thread does not hold the last kept message`);
        const forked = await rpc.call('thread/fork', { threadId: ctx.sessionId, lastTurnId: keep.id });
        const id = forked?.thread?.id;
        if (typeof id !== 'string' || !id)
            throw new Error('thread/fork answered without a thread id');
        return { resume: id };
    }
    finally {
        await conversation.stop();
    }
}
