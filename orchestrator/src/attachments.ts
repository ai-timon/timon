/**
 * Files attached to a Kanban card: mockups, screenshots, specs. A card is a
 * task (`owner: 'task'`) or an idea of the TO DO notebook (`owner: 'todo'`);
 * both go through this one mechanism, rooted by owner.
 *
 * Stored under `$TIMON_HOME/uploads/<tasks|todos>/<owner-id>/<attachment-id>/<name>`.
 * The disk IS the record — no table: the name is the file's, the type follows
 * from its extension (never from what the client claimed), size and date from
 * `stat`. One folder per attachment, so two `mockup.png` never collide and the
 * name the agent reads stays the one the human gave.
 *
 * Lifetime = the owner's. `dbApi.deleteTask` publishes `task_deleted` for every
 * task it removes, `dbApi.deleteProjectTodo` publishes `todo_deleted`, and the
 * `kanban` module drops the folder on those events (`watchTaskDeletions`,
 * `watchTodoDeletions`); a boot sweep catches what was deleted while the
 * module was off (`purgeOrphanTaskAttachments`, `purgeOrphanTodoAttachments`).
 * A requeued task keeps its id, hence its files. An iteration (`[iter:N]`,
 * review) is a NEW task: it reads its verification root's files too
 * (`taskAttachmentsWithInherited`), so the mockup attached to the original
 * task still reaches the coder of iter:3. A task promoted from an idea gets
 * its own copy of the idea's files (`copyTodoAttachmentsToTask`): the idea may
 * be deleted afterwards, the task keeps what it was given.
 *
 * Unlike the chat (`chat-attachments.ts`), these bytes ARE served back over
 * HTTP — the dialogs show image thumbnails. Hence a type allowlist, a
 * signature check for what a browser renders inline, and sandboxing headers.
 */

import { copyFileSync, createReadStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, type ReadStream } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TIMON_HOME } from './paths.js';
import { bus, type BusEvent } from './bus.js';
import type { PromptPart } from './prompt-presentation.js';

/** Per file. The upload is JSON with base64 (as the chat composer sends it),
 *  inflated by 4/3 under the 25 MB body parser: 15 MB is 20 MB on the wire. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Per card, so a board cannot fill the disk one 15 MB file at a time. */
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_TASK_ATTACHMENT_BYTES = MAX_ATTACHMENT_BYTES;
export const MAX_TASK_ATTACHMENTS = MAX_ATTACHMENTS;
export const MAX_TASK_ATTACHMENTS_TOTAL_BYTES = MAX_ATTACHMENTS_TOTAL_BYTES;

export type AttachmentKind = 'image' | 'document';

type FileType = {
  mime: string;
  kind: AttachmentKind;
  /** Rendered by the browser itself (thumbnail, PDF viewer): never sandboxed
   *  away, so its bytes must be what the extension says. */
  inline: boolean;
  check: (bytes: Buffer) => boolean;
};

const startsWith = (bytes: Buffer, sig: readonly number[]): boolean =>
  bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
const latin1 = (bytes: Buffer, start: number, end: number): string => bytes.subarray(start, end).toString('latin1');

const PNG = (b: Buffer) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = (b: Buffer) => startsWith(b, [0xff, 0xd8, 0xff]);
const GIF = (b: Buffer) => b.length > 6 && (latin1(b, 0, 6) === 'GIF87a' || latin1(b, 0, 6) === 'GIF89a');
const WEBP = (b: Buffer) => b.length > 12 && latin1(b, 0, 4) === 'RIFF' && latin1(b, 8, 12) === 'WEBP';
const PDF = (b: Buffer) => latin1(b, 0, 5) === '%PDF-';
/** OOXML and OpenDocument are zip archives. */
const ZIP = (b: Buffer) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]);
/** Legacy Office (.doc, .xls, .ppt): OLE compound file. */
const OLE = (b: Buffer) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const RTF = (b: Buffer) => latin1(b, 0, 5) === '{\\rtf';
/** Text has no NUL byte: an executable renamed `.txt` does. */
const TEXT = (b: Buffer) => !b.subarray(0, 8192).includes(0);

/** Images and current documents. No SVG (it carries script), no HTML, no
 *  archive, no executable: whatever is not listed is refused. Source files
 *  and config (a tester's log, a repro script) are taken as INERT text:
 *  `text/plain`, never inline, so a browser neither runs nor renders them;
 *  `sh` and `html` stay out, they are what a click could run. */
const FILE_TYPES: Readonly<Record<string, FileType>> = {
  png: { mime: 'image/png', kind: 'image', inline: true, check: PNG },
  jpg: { mime: 'image/jpeg', kind: 'image', inline: true, check: JPEG },
  jpeg: { mime: 'image/jpeg', kind: 'image', inline: true, check: JPEG },
  gif: { mime: 'image/gif', kind: 'image', inline: true, check: GIF },
  webp: { mime: 'image/webp', kind: 'image', inline: true, check: WEBP },
  pdf: { mime: 'application/pdf', kind: 'document', inline: true, check: PDF },
  txt: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  md: { mime: 'text/markdown', kind: 'document', inline: false, check: TEXT },
  csv: { mime: 'text/csv', kind: 'document', inline: false, check: TEXT },
  tsv: { mime: 'text/tab-separated-values', kind: 'document', inline: false, check: TEXT },
  json: { mime: 'application/json', kind: 'document', inline: false, check: TEXT },
  yaml: { mime: 'application/yaml', kind: 'document', inline: false, check: TEXT },
  yml: { mime: 'application/yaml', kind: 'document', inline: false, check: TEXT },
  log: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  xml: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  toml: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  ini: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  css: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  js: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  cjs: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  mjs: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  ts: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  py: { mime: 'text/plain', kind: 'document', inline: false, check: TEXT },
  rtf: { mime: 'application/rtf', kind: 'document', inline: false, check: RTF },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document', inline: false, check: ZIP },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document', inline: false, check: ZIP },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'document', inline: false, check: ZIP },
  odt: { mime: 'application/vnd.oasis.opendocument.text', kind: 'document', inline: false, check: ZIP },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', kind: 'document', inline: false, check: ZIP },
  odp: { mime: 'application/vnd.oasis.opendocument.presentation', kind: 'document', inline: false, check: ZIP },
  doc: { mime: 'application/msword', kind: 'document', inline: false, check: OLE },
  xls: { mime: 'application/vnd.ms-excel', kind: 'document', inline: false, check: OLE },
  ppt: { mime: 'application/vnd.ms-powerpoint', kind: 'document', inline: false, check: OLE },
};

/** The extensions accepted, for the error message and the docs. */
export const ATTACHMENT_EXTENSIONS: readonly string[] = Object.keys(FILE_TYPES);
export const TASK_ATTACHMENT_EXTENSIONS = ATTACHMENT_EXTENSIONS;

/** Who a file belongs to. */
export type AttachmentOwner = 'task' | 'todo';

const OWNER_FOLDER: Readonly<Record<AttachmentOwner, string>> = { task: 'tasks', todo: 'todos' };
/** The owner in the refusals a person reads. */
const OWNER_NOUN: Readonly<Record<AttachmentOwner, string>> = { task: 'A task', todo: 'An idea' };
const OWNER_INVALID: Readonly<Record<AttachmentOwner, { code: string; message: string }>> = {
  task: { code: 'task_invalid', message: 'Invalid task identifier.' },
  todo: { code: 'todo_invalid', message: 'Invalid idea identifier.' },
};

/** Same shape as a task id elsewhere in the kanban routes (`DELETE /api/tasks/:id`). */
export const TaskIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/);
/**
 * An idea id as a path segment: digits only, no sign, no leading zero, so
 * `0x10`, `1e3` or ` 16` (which `Number()` would all accept) are refused
 * and the folder name is always `String(id)`.
 */
export const TodoIdParamSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)
  .refine((n) => Number.isSafeInteger(n));
export const AttachmentIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** Base64 of at most `MAX_ATTACHMENT_BYTES` (padding included). */
const MAX_BASE64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;

export const AttachmentUploadSchema = z.object({
  name: z.string().trim().min(1).max(255),
  /** base64 without a `data:` prefix, as the chat composer sends it. */
  data: z.string().min(1),
  /** Informative only: the type is decided by the extension and the bytes. */
  mime: z.string().max(255).optional(),
}).strict();
export const TaskAttachmentUploadSchema = AttachmentUploadSchema;
export type AttachmentUpload = z.infer<typeof AttachmentUploadSchema>;

type AttachmentFields = {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  created_at: number;
};

export type TaskAttachment = {
  id: string;
  /** Task the file belongs to: the verification root's for an inherited one. */
  task_id: string;
  name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  created_at: number;
};

export type TodoAttachment = {
  id: string;
  /** Idea of the TO DO notebook the file belongs to. */
  todo_id: number;
  name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  created_at: number;
};

/** On-disk view, for the daemon only (prompt, serving). Never sent over HTTP:
 *  the absolute path would expose the account's home. */
type StoredFields = { path: string; inline: boolean };
export type StoredTaskAttachment = TaskAttachment & StoredFields;
export type StoredTodoAttachment = TodoAttachment & StoredFields;
export type StoredAttachment = StoredTaskAttachment | StoredTodoAttachment;

export class AttachmentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
export const TaskAttachmentError = AttachmentError;

export function attachmentsRoot(owner: AttachmentOwner): string {
  return join(TIMON_HOME, 'uploads', OWNER_FOLDER[owner]);
}
export function taskAttachmentsRoot(): string {
  return attachmentsRoot('task');
}
export function todoAttachmentsRoot(): string {
  return attachmentsRoot('todo');
}

/** The folder name of an owner id, or `null` when the id is not one. */
function ownerKey(owner: AttachmentOwner, ownerId: string | number): string | null {
  if (owner === 'task') return typeof ownerId === 'string' && TaskIdSchema.safeParse(ownerId).success ? ownerId : null;
  if (typeof ownerId === 'number') return Number.isSafeInteger(ownerId) && ownerId > 0 ? String(ownerId) : null;
  const parsed = TodoIdParamSchema.safeParse(ownerId);
  return parsed.success ? String(parsed.data) : null;
}

/** `<root>/<ownerId>`, refused unless it is exactly one level under the root. */
function ownerDir(owner: AttachmentOwner, ownerId: string | number): string {
  const key = ownerKey(owner, ownerId);
  const invalid = OWNER_INVALID[owner];
  if (key === null) throw new AttachmentError(400, invalid.code, invalid.message);
  const root = resolve(attachmentsRoot(owner));
  const dir = resolve(root, key);
  const rel = relative(root, dir);
  if (rel !== key || isAbsolute(rel)) throw new AttachmentError(400, invalid.code, invalid.message);
  return dir;
}

function fileType(name: string): { ext: string; type: FileType } | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  const type = FILE_TYPES[ext];
  return type ? { ext, type } : null;
}

/** Device names Windows refuses as a file name, whatever the extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * A harmless basename that keeps its extension: letters, digits and
 * `. - _ ( ) space` only, so `..` and separators cannot survive, no trailing
 * dot or space, no Windows device name, at most 120 characters.
 */
export function safeAttachmentName(raw: string, ext: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const stem = base.slice(0, Math.max(0, base.length - ext.length - 1));
  let clean = stem.replace(/[^\w.() -]+/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!clean || WINDOWS_RESERVED.test(clean.split('.')[0] ?? '')) clean = `_${clean || 'file'}`;
  return `${clean.slice(0, 120 - ext.length - 1)}.${ext}`;
}
export const safeTaskAttachmentName = safeAttachmentName;

/** `mtime` unrounded: two files written in the same millisecond keep their order. */
type Entry = AttachmentFields & StoredFields & { mtime: number };

function readEntry(dir: string, id: string): Entry | null {
  if (!AttachmentIdSchema.safeParse(id).success) return null;
  const folder = join(dir, id);
  let files: string[];
  try { files = readdirSync(folder); } catch { return null; }
  const name = files.find((f) => !f.startsWith('.'));
  if (!name) return null;
  const typed = fileType(name);
  if (!typed) return null;
  const path = join(folder, name);
  let stat;
  try { stat = statSync(path); } catch { return null; }
  if (!stat.isFile()) return null;
  return {
    id, name, size: stat.size, mime: typed.type.mime, kind: typed.type.kind,
    created_at: Math.round(stat.mtimeMs), path, inline: typed.type.inline, mtime: stat.mtimeMs,
  };
}

const asTask = (taskId: string, f: AttachmentFields & StoredFields): StoredTaskAttachment => ({
  id: f.id, task_id: taskId, name: f.name, size: f.size, mime: f.mime, kind: f.kind,
  created_at: f.created_at, path: f.path, inline: f.inline,
});
const asTodo = (todoId: number, f: AttachmentFields & StoredFields): StoredTodoAttachment => ({
  id: f.id, todo_id: todoId, name: f.name, size: f.size, mime: f.mime, kind: f.kind,
  created_at: f.created_at, path: f.path, inline: f.inline,
});

/** The entries of one owner folder, oldest first. */
function listEntries(dir: string): Entry[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries
    .map((id) => readEntry(dir, id))
    .filter((a): a is Entry => a !== null)
    .sort((a, b) => a.mtime - b.mtime || a.id.localeCompare(b.id));
}

/** The task's own files, oldest first. An unknown or malformed id lists nothing. */
export function listTaskAttachments(taskId: string): StoredTaskAttachment[] {
  let dir: string;
  try { dir = ownerDir('task', taskId); } catch { return []; }
  return listEntries(dir).map((f) => asTask(taskId, f));
}

/** The idea's files, oldest first. An unknown or malformed id lists nothing. */
export function listTodoAttachments(todoId: number): StoredTodoAttachment[] {
  let dir: string;
  try { dir = ownerDir('todo', todoId); } catch { return []; }
  return listEntries(dir).map((f) => asTodo(todoId, f));
}

/**
 * What the agent of `task` works with: its own files, then those of its
 * verification root (an iteration or a review is a new task, the mockup was
 * attached to the original).
 */
export function taskAttachmentsWithInherited(
  task: { id: string; verification_root_id?: string | null },
): StoredTaskAttachment[] {
  const own = listTaskAttachments(task.id);
  const root = task.verification_root_id;
  if (!root || root === task.id) return own;
  return [...own, ...listTaskAttachments(root)];
}

/** The public shape: no path. */
export function publicTaskAttachment(a: StoredTaskAttachment): TaskAttachment {
  return { id: a.id, task_id: a.task_id, name: a.name, size: a.size, mime: a.mime, kind: a.kind, created_at: a.created_at };
}
export function publicTodoAttachment(a: StoredTodoAttachment): TodoAttachment {
  return { id: a.id, todo_id: a.todo_id, name: a.name, size: a.size, mime: a.mime, kind: a.kind, created_at: a.created_at };
}

/**
 * Number of files per task for a whole board, inherited ones included, in one
 * read of the root: a list of 2,500 tasks must not cost 2,500 `readdir`.
 */
export function countTaskAttachments(
  tasks: readonly { id: string; verification_root_id?: string | null }[],
): Map<string, number> {
  const out = new Map<string, number>();
  let withFiles: Set<string>;
  try { withFiles = new Set(readdirSync(taskAttachmentsRoot())); } catch { return out; }
  if (withFiles.size === 0) return out;
  const own = new Map<string, number>();
  const ownCount = (id: string): number => {
    if (!withFiles.has(id)) return 0;
    let n = own.get(id);
    if (n === undefined) { n = listTaskAttachments(id).length; own.set(id, n); }
    return n;
  };
  for (const t of tasks) {
    const root = t.verification_root_id && t.verification_root_id !== t.id ? t.verification_root_id : null;
    const n = ownCount(t.id) + (root ? ownCount(root) : 0);
    if (n > 0) out.set(t.id, n);
  }
  return out;
}

/** Number of files per idea, in one read of the root (same reason as for tasks). */
export function countTodoAttachments(todoIds: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (todoIds.length === 0) return out;
  let withFiles: Set<string>;
  try { withFiles = new Set(readdirSync(todoAttachmentsRoot())); } catch { return out; }
  if (withFiles.size === 0) return out;
  for (const id of todoIds) {
    if (!withFiles.has(String(id))) continue;
    const n = listTodoAttachments(id).length;
    if (n > 0) out.set(id, n);
  }
  return out;
}

/**
 * Checks one file against the allowlist, the bounds and the owner's quota,
 * then writes it. Refusals, before anything touches the disk: 415 for a type
 * outside the list or bytes that are not of that type, 413 past the per-file
 * bound or the per-card quota. Returns the folder and id written.
 */
function storeBytes(owner: AttachmentOwner, ownerId: string | number, rawName: string, bytes: Buffer): { dir: string; id: string } {
  const dir = ownerDir(owner, ownerId);
  const { base, typed } = acceptedName(rawName);
  if (bytes.length === 0) throw new AttachmentError(400, 'attachment_invalid', 'Empty file.');
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(413, 'attachment_too_large', `File too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB).`);
  }
  if (!typed.type.check(bytes)) {
    throw new AttachmentError(415, 'attachment_content_mismatch', `The file's content is not a valid .${typed.ext} file.`);
  }
  const existing = listEntries(dir);
  if (existing.length >= MAX_ATTACHMENTS) {
    throw new AttachmentError(413, 'attachment_quota', `${OWNER_NOUN[owner]} holds at most ${MAX_ATTACHMENTS} files.`);
  }
  const used = existing.reduce((sum, a) => sum + a.size, 0);
  if (used + bytes.length > MAX_ATTACHMENTS_TOTAL_BYTES) {
    throw new AttachmentError(413, 'attachment_quota',
      `${OWNER_NOUN[owner]} holds at most ${MAX_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)} MB of files.`);
  }
  const id = randomUUID();
  writeStaged(dir, id, safeAttachmentName(base, typed.ext), (target) => writeFileSync(target, bytes, { mode: 0o600 }));
  return { dir, id };
}

/** The basename and its type, or 415 for a type outside the list. */
function acceptedName(rawName: string): { base: string; typed: { ext: string; type: FileType } } {
  const base = rawName.split(/[\\/]/).pop() ?? '';
  const typed = fileType(base);
  if (!typed) {
    throw new AttachmentError(415, 'attachment_type_refused',
      `File type not accepted. Allowed: ${ATTACHMENT_EXTENSIONS.join(', ')}.`);
  }
  return { base, typed };
}

/**
 * Written in a hidden folder then renamed: a listing never sees half a file.
 * The file is dated after every file already there, since the listing's order
 * is the files' mtime: Windows stamps a file with a clock that moves in ticks
 * of up to 16 ms, so two files added together got the same date and came back
 * in the order of their random ids; and copying a file there keeps its source's
 * date.
 */
function writeStaged(dir: string, id: string, name: string, write: (target: string) => void): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const staging = join(dir, `.${id}.tmp`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const target = join(staging, name);
    write(target);
    const latest = listEntries(dir).reduce((max, e) => Math.max(max, e.mtime), -Infinity);
    if (statSync(target).mtimeMs <= latest) {
      // In seconds, unrounded: a Date would cut the millisecond and land on the same date again.
      const after = (latest + 1) / 1000;
      utimesSync(target, after, after);
    }
    renameSync(staging, join(dir, id));
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/** Decodes an upload, refusing what is not base64 or is over the bound before decoding it. */
function decodeUpload(input: AttachmentUpload): Buffer {
  if (input.data.length > MAX_BASE64_CHARS) {
    throw new AttachmentError(413, 'attachment_too_large', `File too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB).`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) {
    throw new AttachmentError(400, 'attachment_invalid', '`data` must be base64.');
  }
  return Buffer.from(input.data, 'base64');
}

/**
 * Writes one file for `taskId`. Refusals, before anything touches the disk:
 * 415 for a type outside the list or bytes that are not of that type, 413
 * past the per-file bound or the per-task quota, 400 for a payload that is not
 * base64. The caller has already checked that the task exists and is the
 * viewer's.
 */
export function saveTaskAttachment(taskId: string, input: AttachmentUpload): StoredTaskAttachment {
  ownerDir('task', taskId);
  acceptedName(input.name);
  const { dir, id } = storeBytes('task', taskId, input.name, decodeUpload(input));
  const entry = readEntry(dir, id);
  if (!entry) throw new AttachmentError(500, 'attachment_write_failed', 'The file could not be stored.');
  return asTask(taskId, entry);
}

/** Same as `saveTaskAttachment`, for an idea the caller already checked it may see. */
export function saveTodoAttachment(todoId: number, input: AttachmentUpload): StoredTodoAttachment {
  ownerDir('todo', todoId);
  acceptedName(input.name);
  return saveTodoAttachmentBytes(todoId, input.name, decodeUpload(input));
}

/** Raw bytes, for the plugin facade (no base64 round trip). Same refusals. */
export function saveTodoAttachmentBytes(todoId: number, name: string, bytes: Buffer): StoredTodoAttachment {
  const { dir, id } = storeBytes('todo', todoId, name, bytes);
  const entry = readEntry(dir, id);
  if (!entry) throw new AttachmentError(500, 'attachment_write_failed', 'The file could not be stored.');
  return asTodo(todoId, entry);
}

export function getTaskAttachment(taskId: string, attachmentId: string): StoredTaskAttachment | null {
  let dir: string;
  try { dir = ownerDir('task', taskId); } catch { return null; }
  const entry = readEntry(dir, attachmentId);
  return entry ? asTask(taskId, entry) : null;
}

export function getTodoAttachment(todoId: number, attachmentId: string): StoredTodoAttachment | null {
  let dir: string;
  try { dir = ownerDir('todo', todoId); } catch { return null; }
  const entry = readEntry(dir, attachmentId);
  return entry ? asTodo(todoId, entry) : null;
}

function deleteEntry(owner: AttachmentOwner, ownerId: string | number, attachmentId: string): boolean {
  let dir: string;
  try { dir = ownerDir(owner, ownerId); } catch { return false; }
  const found = readEntry(dir, attachmentId);
  if (!found) return false;
  rmSync(join(dir, found.id), { recursive: true, force: true });
  removeIfEmpty(dir);
  return true;
}

/** True when the file existed. */
export function deleteTaskAttachment(taskId: string, attachmentId: string): boolean {
  return deleteEntry('task', taskId, attachmentId);
}
export function deleteTodoAttachment(todoId: number, attachmentId: string): boolean {
  return deleteEntry('todo', todoId, attachmentId);
}

function removeIfEmpty(dir: string): void {
  try { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

function removeAll(owner: AttachmentOwner, ownerId: string | number): void {
  let dir: string;
  try { dir = ownerDir(owner, ownerId); } catch { return; }
  try { rmSync(dir, { recursive: true, force: true }); } catch (err) {
    console.warn(`[attachments] could not remove the files of ${owner} ${String(ownerId)}: ${(err as Error).message}`);
  }
}

/** Every file of a deleted task. Silent on a task that had none. */
export function removeTaskAttachments(taskId: string): void {
  removeAll('task', taskId);
}
/** Every file of a deleted idea. Silent on an idea that had none. */
export function removeTodoAttachments(todoId: number): void {
  removeAll('todo', todoId);
}

/**
 * The idea's files copied into the task promoted from it, oldest first. Best
 * effort: a file the task cannot take (quota, disk) is skipped and named in
 * the log, the promotion stands. Returns the number copied.
 */
export function copyTodoAttachmentsToTask(todoId: number, taskId: string): number {
  const files = listTodoAttachments(todoId);
  if (files.length === 0) return 0;
  const dir = ownerDir('task', taskId);
  let copied = 0;
  for (const f of files) {
    try {
      writeStaged(dir, randomUUID(), f.name, (target) => copyFileSync(f.path, target));
      copied++;
    } catch (err) {
      console.warn(`[attachments] idea #${todoId}: ${f.name} not copied to task ${taskId}: ${(err as Error).message}`);
    }
  }
  return copied;
}

/** Drops a task's files when it is deleted. Every deletion path goes through
 *  `dbApi.deleteTask`, which announces each removed task on the bus. */
export function watchTaskDeletions(): () => void {
  const onEvent = (ev: BusEvent): void => {
    if (ev.kind === 'task_deleted') removeTaskAttachments(ev.taskId);
  };
  bus.on('event', onEvent);
  return () => void bus.off('event', onEvent);
}

/** Drops an idea's files when it is deleted (`dbApi.deleteProjectTodo`
 *  publishes `todo_deleted`, whoever deletes: route, facade, MCP). */
export function watchTodoDeletions(): () => void {
  const onEvent = (ev: BusEvent): void => {
    if (ev.kind === 'todo_deleted') removeTodoAttachments(ev.todoId);
  };
  bus.on('event', onEvent);
  return () => void bus.off('event', onEvent);
}

/** Folders whose task no longer exists (deleted while the module was off, or
 *  an upload that raced a deletion). Returns the task ids it removed. */
export function purgeOrphanTaskAttachments(taskExists: (taskId: string) => boolean): string[] {
  let entries: string[];
  try { entries = readdirSync(taskAttachmentsRoot()); } catch { return []; }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!TaskIdSchema.safeParse(entry).success || taskExists(entry)) continue;
    removeTaskAttachments(entry);
    removed.push(entry);
  }
  return removed;
}

/** Same sweep for the ideas. Returns the idea ids it removed. */
export function purgeOrphanTodoAttachments(todoExists: (todoId: number) => boolean): number[] {
  let entries: string[];
  try { entries = readdirSync(todoAttachmentsRoot()); } catch { return []; }
  const removed: number[] = [];
  for (const entry of entries) {
    const parsed = TodoIdParamSchema.safeParse(entry);
    if (!parsed.success || String(parsed.data) !== entry || todoExists(parsed.data)) continue;
    removeTodoAttachments(parsed.data);
    removed.push(parsed.data);
  }
  return removed;
}

/** Response headers for a served file. An image or a PDF opens in the
 *  browser (thumbnail, viewer); anything else is a download, sandboxed in
 *  case it is opened in a tab anyway. */
export function attachmentHeaders(a: StoredAttachment, download: boolean): Record<string, string> {
  const inline = a.inline && !download;
  const asciiName = a.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return {
    'content-type': a.mime,
    'content-length': String(a.size),
    'x-content-type-options': 'nosniff',
    // Chromium's PDF viewer refuses to load under a sandbox; a PDF runs no
    // script in our origin, everything else gets the sandbox.
    ...(inline && a.mime === 'application/pdf' ? {} : { 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" }),
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, max-age=300',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
  };
}

export const taskAttachmentHeaders = attachmentHeaders;

export function attachmentStream(a: StoredAttachment): ReadStream {
  return createReadStream(a.path);
}
export const taskAttachmentStream = attachmentStream;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The block announced to the agent of a task: absolute paths it opens with
 *  its own reading tools. Collapsed in the bubble under the chat's label. */
export function taskAttachmentParts(files: readonly StoredTaskAttachment[]): PromptPart[] {
  if (files.length === 0) return [];
  const lines = files.map((f) => `- \`${f.path}\` (${f.name}, ${fmtBytes(f.size)}, ${f.mime})`);
  return [{
    kind: 'instruction',
    label: 'attachments',
    labelVars: { count: String(files.length) },
    text: [
      ``,
      ``,
      `<attachments>`,
      ...lines,
      `</attachments>`,
      `These files are attached to this task, on the host's disk. Open them with your reading tools when the work concerns them (images included).`,
    ].join('\n'),
  }];
}
