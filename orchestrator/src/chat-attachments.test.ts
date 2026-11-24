import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.TIMON_HOME ??= mkdtempSync(join(tmpdir(), 'timon-attach-'));
const TIMON_HOME_DIR = process.env.TIMON_HOME;

const {
  composeChatTurn, discardChatAttachments, ensureChatAttachmentsDir, persistChatAttachments, purgeChatAttachments, safeAttachmentName,
  skippedAttachmentsField, MAX_ATTACHMENT_BYTES, MAX_TURN_BYTES,
} = await import('./chat-attachments.js');
import type { SkippedAttachment } from './chat-attachments.js';
const { resolveFence, fenceAccess } = await import('./host/isolation.js');
const { TimonConfigSchema } = await import('./config/schema.js');

test('a client-supplied name can never escape the turn directory', () => {
  for (const [raw, expected] of [
    ['../../etc/passwd', 'passwd'],
    ['/etc/shadow', 'shadow'],
    ['..', 'file'],
    ['C:\\Windows\\notes.txt', 'notes.txt'],
    ['', 'file'],
    [42, 'file'],
    ['rapport final (v2).pdf', 'rapport final (v2).pdf'],
  ] as const) {
    assert.equal(safeAttachmentName(raw), expected);
  }
  assert.equal(safeAttachmentName('x'.repeat(400)).length, 120);
});

test('any type is persisted verbatim and announced by its absolute path', () => {
  const files = persistChatAttachments('m-1', [
    { name: 'deck.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      data: Buffer.from('PK\u0003\u0004binary').toString('base64') },
    { name: 'notes.md', data: Buffer.from('# titre').toString('base64') },
  ]);
  assert.equal(files.length, 2);
  assert.equal(readFileSync(files[1]!.path, 'utf8'), '# titre');
  // The mission owns the folder — that is what lets the cleanup know whose
  // files these are instead of guessing from their age.
  assert.match(files[0]!.path, /[\\/]uploads[\\/]chat[\\/]m-1[\\/][0-9a-f-]{36}[\\/]deck\.pptx$/);
  // No whitelist: an unknown mime keeps its bytes, it does not lose the file.
  assert.equal(files[1]!.mime, 'application/octet-stream');
});

test('an oversized or empty payload is skipped, the rest of the turn goes out, and the skip is reported', () => {
  const skipped: SkippedAttachment[] = [];
  const files = persistChatAttachments('m-1', [
    { name: 'huge.bin', data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') },
    { name: 'empty.txt', data: '' },
    { name: 'ok.txt', data: Buffer.from('kept').toString('base64') },
  ], skipped);
  assert.deepEqual(files.map((f) => f.name), ['ok.txt']);
  assert.deepEqual(skipped, [{ name: 'huge.bin', reason: 'too_large' }, { name: 'empty.txt', reason: 'empty' }]);
  assert.deepEqual(skippedAttachmentsField(skipped).skipped_attachments, skipped);
  assert.deepEqual(skippedAttachmentsField([]), {});
});

test('the turn budget is what fits in the 25 MB JSON body once base64-encoded (TIM-0125)', () => {
  // base64 inflates by 4/3: the budget plus 1 MB of text must stay under the parser's cap.
  assert.ok(Math.ceil(MAX_TURN_BYTES / 3) * 4 + 1024 * 1024 <= 25 * 1024 * 1024);
  const skipped: SkippedAttachment[] = [];
  const half = Buffer.alloc(MAX_TURN_BYTES / 2 + 1).toString('base64');
  const files = persistChatAttachments('m-budget', [
    { name: 'a.bin', data: half },
    { name: 'b.bin', data: half },
  ], skipped);
  assert.deepEqual(files.map((f) => f.name), ['a.bin']);
  assert.deepEqual(skipped, [{ name: 'b.bin', reason: 'turn_limit' }]);
});

test('the composed turn re-concatenates into its own text, sections included', () => {
  const files = persistChatAttachments('m-1', [{ name: 'a.txt', data: Buffer.from('x').toString('base64') }]);
  const slash = { expanded: 'procedureRequest', presentation: { version: 1 as const, parts: [
    { kind: 'instruction' as const, text: 'procedure', label: 'skillInvoked' },
    { kind: 'text' as const, text: 'Request' },
  ] } };
  // Casing differs on purpose: the parts must be joined, never re-derived.
  const turn = composeChatTurn({ ...slash, expanded: 'procedureRequest' }, files);
  assert.equal(turn.presentation!.parts.map((p) => p.text).join(''), turn.text);
  assert.match(turn.text, /<attachments>/);
  assert.equal(turn.presentation!.parts.at(-1)!.label, 'attachments');

  // Nothing rewritten → nothing to fold.
  assert.deepEqual(composeChatTurn({ expanded: 'plain' }, []), { text: 'plain' });
});

test('a long paste travels inside the message, only its presentation folds', async () => {
  const { pastedParts, MAX_PASTED_CHARS } = await import('./chat-attachments.js');
  const turn = composeChatTurn({ expanded: 'Regarde ça' }, [], [ // french-ok: free-text sample data
    { name: 'Pasted', text: 'ligne\n'.repeat(3) },
    { name: '../evil', text: 'x' },
    { text: '' },
    'not an object',
  ]);
  const parts = turn.presentation!.parts;
  assert.equal(parts.map((p) => p.text).join(''), turn.text);
  // The text itself is in the sent message: an agent must never have to open
  // a file to read what the human believes they said.
  assert.match(turn.text, /Regarde ça[\s\S]*<pasted name="Pasted">/); // french-ok: free-text sample data
  // Two pastes fold as ONE block: composePrompt merges adjacent instructions,
  // so a title naming only the first would lie about what is inside.
  const fold = parts.find((p) => p.label === 'pastedTexts')!;
  assert.equal(fold.labelVars!.count, '2');
  assert.match(fold.text, /<pasted name="evil">/);
  assert.equal(pastedParts([{ text: 'Pasted', name: 'a' }])[0]!.label, 'pastedText');
  assert.equal(pastedParts([{ text: 'y'.repeat(MAX_PASTED_CHARS + 50) }])[0]!.text.length,
    MAX_PASTED_CHARS + '\n\n<pasted name="Pasted">\n\n</pasted>'.length);
});

test('a voice context travels inside the delegated turn, folded under its own label', async () => {
  const { voiceContextParts, MAX_VOICE_CONTEXT_CHARS } = await import('./chat-attachments.js');
  const turn = composeChatTurn({ expanded: 'Lance les tests' }, [], undefined, 'User: on parle du build\nVoice assistant: D’accord.');
  const parts = turn.presentation!.parts;
  assert.equal(parts.map((p) => p.text).join(''), turn.text);
  assert.equal(parts[0]!.text, 'Lance les tests');
  assert.equal(parts[1]!.label, 'voiceContext');
  assert.match(turn.text, /<voice_conversation>\nUser: on parle du build[\s\S]*<\/voice_conversation>\nThe user is talking to you by voice/);
  assert.deepEqual(voiceContextParts('   '), []);
  assert.deepEqual(voiceContextParts(42), []);
  assert.ok(voiceContextParts('z'.repeat(MAX_VOICE_CONTEXT_CHARS + 500))[0]!.text.includes('z'.repeat(MAX_VOICE_CONTEXT_CHARS) + '\n</voice'));
});

test('the cleanup spares a live mission at any age, and a recent one', () => {
  const day = 86_400_000;
  const now = Date.now();
  for (const id of ['live', 'resumed', 'recent', 'old']) {
    persistChatAttachments(id, [{ name: 'a.txt', data: Buffer.from('x').toString('base64') }]);
  }
  const lifetimes: Record<string, { live: boolean; endedAt: number | null }> = {
    // Finished a year ago on paper, but running again: a resume put it back
    // to `running` with a null ended_at, and it may re-read its files.
    live: { live: true, endedAt: now - 365 * day },
    resumed: { live: true, endedAt: null },
    recent: { live: false, endedAt: now - 2 * day },
    old: { live: false, endedAt: now - 40 * day },
  };
  const out = purgeChatAttachments((id) => lifetimes[id] ?? null, 30 * day, now);
  assert.deepEqual(out.removed, ['old']);
  assert.equal(out.keptLive, 2);
  // `>=`: the folders written by the tests above are young orphans, and are
  // legitimately kept too — the count covers the whole root.
  assert.equal(out.keptRecent >= 1, true);
  assert.equal(existsSync(join(TIMON_HOME_DIR, 'uploads', 'chat', 'live')), true);
  assert.equal(existsSync(join(TIMON_HOME_DIR, 'uploads', 'chat', 'old')), false);
});

test('an orphan folder falls back on its own date, never on a guess', () => {
  persistChatAttachments('orphan', [{ name: 'a.txt', data: Buffer.from('x').toString('base64') }]);
  // Unknown to the database (aborted spawn, reset db). Young → kept.
  assert.deepEqual(purgeChatAttachments(() => null, 86_400_000).removed, []);
  // Same folder, seen from far enough in the future → collected.
  const later = Date.now() + 2 * 86_400_000;
  assert.equal(purgeChatAttachments(() => null, 86_400_000, later).removed.includes('orphan'), true);
});

test('a cleanup with nothing to clean is not an error', () => {
  assert.deepEqual(purgeChatAttachments(() => null, 1, Date.now()).removed.length >= 0, true);
});

test('a turn that was not delivered leaves no file, and nothing outside the chat uploads is touched', () => {
  const saved = persistChatAttachments('discard-mission', [
    { name: 'notes.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') },
  ]);
  assert.equal(saved.length, 1);
  assert.ok(existsSync(saved[0].path));
  discardChatAttachments(saved);
  assert.ok(!existsSync(saved[0].path), 'the file is gone');
  assert.ok(!existsSync(join(saved[0].path, '..')), 'and so is the folder of the turn');

  // A path outside `uploads/chat/<mission>/<turn>` is never deleted.
  const stranger = join(TIMON_HOME_DIR, 'stranger');
  mkdirSync(stranger, { recursive: true });
  const file = join(stranger, 'keep.txt');
  writeFileSync(file, 'keep');
  discardChatAttachments([{ name: 'keep.txt', path: file, size: 4, mime: 'text/plain' }]);
  assert.ok(existsSync(file), 'a file outside the chat uploads survives');
});

test('the attachments folder exists before the first attachment, so a fence computed at launch already opens it', () => {
  const missionId = 'aaaaaaaa-0000-4000-8000-0000000000a1';
  const dir = ensureChatAttachmentsDir(missionId);
  assert.equal(dir, join(TIMON_HOME_DIR, 'uploads', 'chat', missionId));
  assert.deepEqual(readdirSync(dir), [], 'created empty');
  // Windows has no POSIX mode bits to compare.
  if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(ensureChatAttachmentsDir(missionId), dir, 'a second launch reuses it');

  // A persistent CLI keeps the rules it was launched with: the folder must be granted
  // while it is still empty, and the file a later turn saves must fall inside it.
  const config = TimonConfigSchema.parse({ host: { isolation: { filesystem: 'auto' } } });
  const policy = resolveFence(config, {
    timonHome: TIMON_HOME_DIR, platform: process.platform, missionId, timonRead: [dir],
  });
  assert.equal(policy.ignored.some((entry) => entry.path === dir), false, 'the empty folder is not dropped');
  const [saved] = persistChatAttachments(missionId, [{ name: 'later.txt', data: Buffer.from('x').toString('base64') }]);
  // Resolved: on macOS the temporary folder is reached through a link, and the fence grants its target.
  const savedPath = realpathSync(saved!.path);
  assert.equal(policy.enabled, true);
  assert.equal(fenceAccess(policy, savedPath).read, true, 'readable without a relaunch');
  assert.equal(fenceAccess(policy, savedPath).write, false);
  assert.equal(fenceAccess(policy, join(realpathSync(TIMON_HOME_DIR), 'uploads', 'chat', 'other-mission', 'a.txt')).read, false);

  // Discarding the turn leaves the mission's folder, empty again; the purge still takes it.
  discardChatAttachments([saved!]);
  assert.deepEqual(readdirSync(dir), []);
  const out = purgeChatAttachments((id) => (id === missionId ? { live: false, endedAt: 0 } : { live: true, endedAt: null }), 1);
  assert.deepEqual(out.removed, [missionId]);
  assert.equal(existsSync(dir), false);
});
