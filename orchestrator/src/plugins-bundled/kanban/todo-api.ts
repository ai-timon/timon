/**
 * The TO DO notebook as the other modules see it: read an idea, edit its core
 * fields, close it, and attach fields of their own to its PATCH.
 *
 * Served on the `kanban` service. Every write goes through `updateProjectTodo`,
 * so a closure publishes `todo_done` exactly as the checkbox does, and the
 * client is told the idea moved.
 *
 * `links` ties an idea to where it lives outside Timon (a Discord thread, a
 * GitHub issue…). A connector that receives a ticket creates its idea WITH the
 * ticket's link (`create(input, links)`): the lookup and the insert share one
 * transaction, and `UNIQUE(provider, ref)` backs it, so the same ticket
 * arriving twice lands on the same idea.
 *
 * `todoApi` is the unscoped service of the bundled modules. Third-party
 * plugins get `todosFor(scope)` instead, through `ctx.kanban.todos`: every
 * read and write is bounded by what the caller may see, the owner and the
 * plugin of a link come from the plugin context, and no message names an idea
 * the caller cannot see.
 */
import { z } from 'zod';
import {
  db, dbApi, type DbViewer, type ProjectTodoRow, type ProjectTodoEditableStatus, type ProjectTodoStatus, type TodoExternalRefRow,
} from '../../db.js';
import { publishPluginRealtime } from '../../plugins/realtime.js';
import {
  prepareTodoExtensions, registerTodoExtension, todoExtensionFields, TodoExtensionError, type TodoExtension,
} from '../../project-todo-extensions.js';
import { withTodoOrigin } from '../../todo-origin.js';
import { TODO_PROGRESSES, TODO_URGENCIES, type TodoProgress, type TodoUrgency } from '../../project-todo-tags.js';
import {
  AttachmentError, countTodoAttachments, deleteTodoAttachment, getTodoAttachment, listTodoAttachments,
  publicTodoAttachment, saveTodoAttachmentBytes, type StoredTodoAttachment, type TodoAttachment,
} from '../../attachments.js';
import { readFileSync } from 'node:fs';
import { aggregateTodoLandings, TODO_LANDING_STATES, type TodoLanding } from '../../todo-landing.js';

export type TodoCoreFields = {
  text?: string;
  project?: string | null;
  notes?: string | null;
  author?: string | null;
  status?: ProjectTodoEditableStatus;
  urgency?: TodoUrgency | null;
  progress?: TodoProgress;
};

/** A link as plugins write it. `url` must be http(s): the detail dialog opens it. */
export type TodoLinkInput = {
  provider: string;
  ref: string;
  url?: string | null;
  label?: string | null;
  /** Plugin writing the link, kept for the record. */
  pluginId?: string | null;
};

/** A link as it is read, on the API and on the items the routes return. */
export type TodoLink = Pick<TodoExternalRefRow, 'provider' | 'ref' | 'url' | 'label' | 'plugin_id' | 'created_at'>;

export type TodoCreateInput = {
  text: string;
  project?: string | null;
  notes?: string | null;
  author?: string | null;
  urgency?: TodoUrgency | null;
  progress?: TodoProgress;
  /** Account the idea belongs to. Absent = a system idea, which only a
   *  superadmin (or `project_todo:read:all`) sees — links included. */
  ownerUserId?: string | null;
};

/** `invalid` = the input; `not_found` = no such idea; `conflict` = the ticket
 *  is already tied to another idea; `forbidden` = an extension refused its
 *  field (outcomes switched off, for instance). */
export class TodoLinkError extends Error {
  /** `reason` refines a `forbidden`: `spawn_policy` = the operator has not approved this spawn yet (TODO #562). */
  constructor(message: string, readonly code: 'invalid' | 'not_found' | 'conflict' | 'forbidden', readonly reason?: string) { super(message); }
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

export const linkSchema = z.object({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'provider must be a lowercase slug'),
  ref: z.string().trim().min(1).max(256),
  url: z.string().trim().max(2048).refine(isHttpUrl, 'url must be an http(s) URL').nullish(),
  label: z.string().trim().max(200).nullish(),
  pluginId: z.string().trim().min(1).max(214).nullish(),
}).strict();

const createSchema = z.object({
  text: z.string().trim().min(1),
  project: z.string().trim().nullish(),
  notes: z.string().nullish(),
  author: z.string().trim().nullish(),
  urgency: z.enum(TODO_URGENCIES).nullish(),
  progress: z.enum(TODO_PROGRESSES).optional(),
  ownerUserId: z.string().nullish(),
}).strict();

/** The core fields of a plugin's PATCH, checked as the route checks them. */
const coreFieldsSchema = z.object({
  text: z.string().trim().min(1).optional(),
  project: z.string().nullable().optional().transform((v) => (v === undefined ? undefined : v?.trim() || null)),
  notes: z.string().nullable().optional(),
  author: z.string().nullable().optional().transform((v) => (v === undefined ? undefined : v?.trim() || null)),
  status: z.enum(['open', 'done']).optional(),
  urgency: z.enum(TODO_URGENCIES).nullable().optional(),
  progress: z.enum(TODO_PROGRESSES).optional(),
});
export const CORE_FIELDS: ReadonlySet<string> = new Set(Object.keys(coreFieldsSchema.shape));

type ParsedLink = { provider: string; ref: string; url: string | null; label: string | null; pluginId: string | null };

function parseLink(link: TodoLinkInput): ParsedLink {
  const r = linkSchema.safeParse(link);
  if (!r.success) throw new TodoLinkError(`invalid link: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, 'invalid');
  return {
    provider: r.data.provider, ref: r.data.ref, url: r.data.url || null,
    label: r.data.label || null, pluginId: r.data.pluginId ?? null,
  };
}

function toLink(row: TodoExternalRefRow): TodoLink {
  return { provider: row.provider, ref: row.ref, url: row.url, label: row.label, plugin_id: row.plugin_id, created_at: row.created_at };
}

/**
 * What the routes and the plugin facade add to an idea row. `landing` is
 * derived, read-only (`todo-landing.ts`): where the branch of its jobs stands,
 * null when no job of the idea has an integration branch.
 */
export type TodoExtras = { links: TodoLink[]; attachment_count: number; landing: TodoLanding | null };

/**
 * The ideas with their links, their number of attached files and their
 * landing: one query each and one read of the attachments root, whatever the
 * length of the list. The rows are already filtered for the caller, so the
 * links follow their visibility; the landing goes through the tasks `viewer`
 * may see (undefined = the unscoped service).
 */
export function withLinks<T extends ProjectTodoRow>(rows: readonly T[], viewer: DbViewer | null | undefined): Array<T & TodoExtras> {
  const ids = rows.map((t) => t.id);
  const byTodo = new Map<number, TodoLink[]>();
  for (const r of dbApi.listTodoExternalRefs(ids)) {
    const list = byTodo.get(r.todo_id);
    if (list) list.push(toLink(r)); else byTodo.set(r.todo_id, [toLink(r)]);
  }
  const files = countTodoAttachments(ids);
  const landings = aggregateTodoLandings(dbApi.listTodoIntegrations(ids, viewer));
  return rows.map((t) => ({
    ...t, links: byTodo.get(t.id) ?? [], attachment_count: files.get(t.id) ?? 0, landing: landings.get(t.id) ?? null,
  }));
}

export function withLinksOne<T extends ProjectTodoRow>(row: T, viewer: DbViewer | null | undefined): T & TodoExtras {
  return {
    ...row,
    links: dbApi.listTodoExternalRefs([row.id]).map(toLink),
    attachment_count: countTodoAttachments([row.id]).get(row.id) ?? 0,
    landing: aggregateTodoLandings(dbApi.listTodoIntegrations([row.id], viewer)).get(row.id) ?? null,
  };
}

export type TodoLinksApi = {
  list(todoId: number): TodoLink[];
  /** Ties the idea to a ticket, or refreshes url/label of that tie. Throws
   *  `TodoLinkError` (`conflict`) when the ticket belongs to another idea. */
  set(todoId: number, link: TodoLinkInput): TodoLink;
  remove(todoId: number, provider: string, ref: string): boolean;
  /** The idea a ticket points at. Unscoped: bundled modules only, never a
   *  route nor a third-party plugin (they get `todosFor`). */
  findByRef(provider: string, ref: string): ProjectTodoRow | undefined;
};

export type TodoApi = {
  get(id: number): ProjectTodoRow | undefined;
  /**
   * New idea with its links, in one transaction. When one of the links is
   * already tied to an idea, nothing is written and that idea comes back with
   * `created: false` — an incoming ticket never makes a duplicate.
   */
  create(input: TodoCreateInput, links?: readonly TodoLinkInput[]): { item: ProjectTodoRow; created: boolean };
  links: TodoLinksApi;
  update(id: number, fields: TodoCoreFields): ProjectTodoRow | undefined;
  /** Progress `done`, unless the idea was promoted (its chain closes it). */
  close(id: number): ProjectTodoRow | undefined;
  /** See `project-todo-extensions.ts`. Returns the disposer. */
  registerExtension(ext: TodoExtension): () => void;
};

export function publishTodoChanged(row: ProjectTodoRow): void {
  // System rows have no account to address; realtime never broadcasts them.
  if (!row.owner_user_id) return;
  publishPluginRealtime('@timon/kanban', 'project-todo.changed', { id: row.id }, { ownerUserId: row.owner_user_id });
}

function write(id: number, fields: TodoCoreFields): ProjectTodoRow | undefined {
  const row = dbApi.updateProjectTodo(id, fields);
  if (row) publishTodoChanged(row);
  return row;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** `viewer` set = a plugin call: an idea outside its view is never returned
 *  nor named. Absent = the unscoped service. */
type CallerScope = { viewer: DbViewer | null } | undefined;

function createWithLinks(
  input: TodoCreateInput,
  links: readonly TodoLinkInput[] = [],
  scope?: CallerScope,
): { item: ProjectTodoRow; created: boolean } {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new TodoLinkError(`invalid idea: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, 'invalid');
  const fields = parsed.data;
  const refs = links.map(parseLink);
  const run = db.transaction((): { item: ProjectTodoRow; created: boolean } => {
    const bound = new Set<number>();
    for (const l of refs) {
      const hit = dbApi.getTodoExternalRef(l.provider, l.ref);
      if (hit) bound.add(hit.todo_id);
    }
    if (bound.size > 1) {
      throw new TodoLinkError(scope
        ? 'these links are tied to different ideas'
        : `these links are tied to different ideas (#${[...bound].join(', #')})`, 'conflict');
    }
    const [existingId] = bound;
    if (existingId !== undefined) {
      // The ticket is another account's: a replay must not hand that idea
      // over, and a duplicate would break the one-ticket-one-idea rule.
      const item = dbApi.getProjectTodo(existingId, scope?.viewer);
      if (!item) throw new TodoLinkError('this link is already tied to another idea', 'conflict');
      return { item, created: false };
    }
    const item = dbApi.insertProjectTodo({
      text: fields.text,
      project: fields.project || null,
      notes: fields.notes ?? null,
      author: fields.author || null,
      urgency: fields.urgency ?? null,
      ...(fields.progress ? { progress: fields.progress } : {}),
      ownerUserId: fields.ownerUserId ?? null,
    });
    for (const l of refs) dbApi.putTodoExternalRef({ todoId: item.id, ...l });
    return { item, created: true };
  });
  let result: { item: ProjectTodoRow; created: boolean };
  try {
    result = run();
  } catch (err) {
    // Another connection tied the ticket between our lookup and our insert:
    // the transaction rolled back, the second run finds its idea.
    if (!isUniqueViolation(err)) throw err;
    result = run();
  }
  if (result.created) publishTodoChanged(result.item);
  return result;
}

function setLink(todoId: number, link: TodoLinkInput, scope?: CallerScope): TodoLink {
  const l = parseLink(link);
  const todo = dbApi.getProjectTodo(todoId, scope?.viewer);
  if (!todo) throw new TodoLinkError(`idea #${todoId} not found`, 'not_found');
  const row = db.transaction(() => {
    const hit = dbApi.getTodoExternalRef(l.provider, l.ref);
    if (hit && hit.todo_id !== todoId) {
      throw new TodoLinkError(scope
        ? `${l.provider}:${l.ref} is already tied to another idea`
        : `${l.provider}:${l.ref} is already tied to idea #${hit.todo_id}`, 'conflict');
    }
    return dbApi.putTodoExternalRef({ todoId, ...l });
  })();
  publishTodoChanged(todo);
  return toLink(row);
}

const linksApi: TodoLinksApi = {
  list: (todoId) => dbApi.listTodoExternalRefs([todoId]).map(toLink),
  set: (todoId, link) => setLink(todoId, link),
  remove(todoId, provider, ref) {
    const removed = dbApi.deleteTodoExternalRef(todoId, provider, ref.trim());
    const todo = removed ? dbApi.getProjectTodo(todoId) : undefined;
    if (todo) publishTodoChanged(todo);
    return removed;
  },
  findByRef(provider, ref) {
    const hit = dbApi.getTodoExternalRef(provider, ref.trim());
    return hit ? dbApi.getProjectTodo(hit.todo_id) : undefined;
  },
};

export const todoApi: TodoApi = {
  get: (id) => dbApi.getProjectTodo(id),
  create: createWithLinks,
  links: linksApi,
  update: write,
  close(id) {
    const row = dbApi.getProjectTodo(id);
    if (!row || row.status === 'promoted') return row;
    return write(id, { progress: 'done' });
  },
  registerExtension: registerTodoExtension,
};

/** An idea with its links and its number of files, as a plugin reads it. */
export type TodoWithLinks = ProjectTodoRow & TodoExtras;

/** Who calls, as the plugin context establishes it — never as the plugin says. */
export type TodoCallerScope = {
  /** `currentPluginViewer`: the request's caller, or `plugin:<id>` in a job. */
  viewer: DbViewer | null;
  /** `currentPluginOwnerUserId`: owner of the ideas this caller creates. */
  ownerUserId: string | null;
  /** Stamped on every link written, whatever the input carries. */
  pluginId: string;
};

/** What `list` filters on. `limit` is 200 at most (and by default). */
export type TodoListFilter = {
  status?: ProjectTodoStatus;
  project?: string;
  urgency?: TodoUrgency;
  progress?: TodoProgress;
  /** Ideas whose landing badge is this state (`open` = pull request open, `pending` = not created). */
  landing?: TodoLanding['state'];
  limit?: number;
};

const listFilterSchema = z.object({
  status: z.enum(['open', 'done', 'promoted']).optional(),
  project: z.string().trim().min(1).optional(),
  urgency: z.enum(TODO_URGENCIES).optional(),
  progress: z.enum(TODO_PROGRESSES).optional(),
  landing: z.enum(TODO_LANDING_STATES).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export type ScopedTodoApi = {
  get(id: number): TodoWithLinks | undefined;
  /** The ideas the caller sees, open first, with their links. */
  list(filter?: TodoListFilter): TodoWithLinks[];
  create(input: Omit<TodoCreateInput, 'ownerUserId'>, links?: readonly Omit<TodoLinkInput, 'pluginId'>[]): {
    item: TodoWithLinks; created: boolean;
  };
  links: {
    list(todoId: number): TodoLink[];
    set(todoId: number, link: Omit<TodoLinkInput, 'pluginId'>): TodoLink;
    remove(todoId: number, provider: string, ref: string): boolean;
    findByRef(provider: string, ref: string): TodoWithLinks | undefined;
  };
  /**
   * The PATCH of the route: core fields plus the fields registered extensions
   * own (an outcome goes through `@timon/todo-outcomes`, its rules and its
   * refusal when switched off). A key nobody owns is `invalid`.
   */
  update(id: number, patch: Readonly<Record<string, unknown>>): TodoWithLinks;
  /** Progress `done`; a promoted idea is returned as it is (its chain closes it). */
  close(id: number): TodoWithLinks;
  /** Deletes the idea and its links; `todo_deleted` follows, with the plugin as origin. */
  delete(id: number): void;
  /** The idea's files, bounded like the rest by what the caller sees. */
  attachments: {
    list(todoId: number): TodoAttachment[];
    add(todoId: number, file: { name: string; data: Uint8Array | string }): TodoAttachment;
    remove(todoId: number, attachmentId: string): boolean;
    read(todoId: number, attachmentId: string): Uint8Array;
  };
};

const attachmentInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  data: z.union([z.instanceof(Uint8Array), z.string().min(1)]),
}).strict();

/** Base64 of at most 15 MB, refused before decoding (same bound as the route). */
const MAX_FACADE_BASE64 = Math.ceil((15 * 1024 * 1024) / 3) * 4;

/** A refused file as the facade says it: `invalid`, the reason being the route's code. */
function attachmentRefusal(err: unknown): never {
  if (err instanceof AttachmentError) {
    throw new TodoLinkError(err.message, err.status === 404 ? 'not_found' : 'invalid', err.code);
  }
  throw err;
}

/**
 * The notebook bounded by a caller. An idea it cannot see answers exactly as
 * an idea that does not exist (`not_found`, `undefined`): the write right of
 * an idea is its visibility, as on `PATCH /api/project-todo/:id`.
 */
export function todosFor(scope: TodoCallerScope): ScopedTodoApi {
  const api = scopedTodos(scope);
  // Every write of the facade is the plugin's, whoever it serves: the events
  // it causes carry `plugin:<id>`, so the plugin can drop its own echo.
  const origin = { kind: 'plugin', id: scope.pluginId } as const;
  const asPlugin = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => withTodoOrigin(origin, () => fn(...args));
  return {
    ...api,
    create: asPlugin(api.create),
    update: asPlugin(api.update),
    close: asPlugin(api.close),
    delete: asPlugin(api.delete),
    links: { ...api.links, set: asPlugin(api.links.set), remove: asPlugin(api.links.remove) },
    attachments: { ...api.attachments, add: asPlugin(api.attachments.add), remove: asPlugin(api.attachments.remove) },
  };
}

function extensionRefusal(err: unknown): never {
  if (err instanceof TodoExtensionError) throw new TodoLinkError(err.message, err.status === 403 ? 'forbidden' : 'invalid');
  throw err;
}

function scopedTodos(scope: TodoCallerScope): ScopedTodoApi {
  const caller = { viewer: scope.viewer };
  const visible = (id: number) => dbApi.getProjectTodo(id, scope.viewer);
  const mustSee = (id: number): ProjectTodoRow => {
    const row = visible(id);
    if (!row) throw new TodoLinkError(`idea #${id} not found`, 'not_found');
    return row;
  };
  return {
    get(id) {
      const row = visible(id);
      return row ? withLinksOne(row, scope.viewer) : undefined;
    },
    list(filter = {}) {
      const parsed = listFilterSchema.safeParse(filter);
      if (!parsed.success) {
        throw new TodoLinkError(`invalid filter: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, 'invalid');
      }
      return withLinks(dbApi.listProjectTodo({ ...parsed.data, viewer: scope.viewer }), scope.viewer);
    },
    create(input, links = []) {
      // Spread first, context last: a plugin passing its own owner or plugin
      // id (plain JS ignores the types) is overridden, not obeyed.
      const r = createWithLinks(
        { ...input, ownerUserId: scope.ownerUserId },
        links.map((l) => ({ ...l, pluginId: scope.pluginId })),
        caller,
      );
      return { item: withLinksOne(r.item, scope.viewer), created: r.created };
    },
    links: {
      list(todoId) {
        mustSee(todoId);
        return linksApi.list(todoId);
      },
      set: (todoId, link) => setLink(todoId, { ...link, pluginId: scope.pluginId }, caller),
      remove(todoId, provider, ref) {
        mustSee(todoId);
        return linksApi.remove(todoId, provider, ref);
      },
      findByRef(provider, ref) {
        const hit = dbApi.getTodoExternalRef(provider, ref.trim());
        const row = hit ? visible(hit.todo_id) : undefined;
        return row ? withLinksOne(row, scope.viewer) : undefined;
      },
    },
    update(id, patch) {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new TodoLinkError('invalid idea patch: an object is expected', 'invalid');
      }
      const owned = todoExtensionFields();
      const unknown = Object.keys(patch).filter((k) => !CORE_FIELDS.has(k) && !owned.has(k));
      if (unknown.length) throw new TodoLinkError(`invalid idea patch: unknown field ${unknown.join(', ')}`, 'invalid');
      const core: Record<string, unknown> = {};
      for (const k of CORE_FIELDS) if (patch[k] !== undefined) core[k] = patch[k];
      const parsed = coreFieldsSchema.safeParse(core);
      if (!parsed.success) {
        throw new TodoLinkError(`invalid idea patch: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, 'invalid');
      }
      const fields: TodoCoreFields = {};
      for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) (fields as Record<string, unknown>)[k] = v;
      const existing = mustSee(id);
      let row: ProjectTodoRow | undefined;
      try { row = patchTodo(existing, fields, patch); } catch (err) { extensionRefusal(err); }
      if (!row) throw new TodoLinkError(`idea #${id} not found`, 'not_found');
      return withLinksOne(row, scope.viewer);
    },
    delete(id) {
      const existing = mustSee(id);
      if (!dbApi.deleteProjectTodo(id)) throw new TodoLinkError(`idea #${id} not found`, 'not_found');
      publishTodoChanged(existing);
    },
    close(id) {
      const existing = mustSee(id);
      if (existing.status === 'promoted') return withLinksOne(existing, scope.viewer);
      const row = patchTodo(existing, { progress: 'done' }, {});
      if (!row) throw new TodoLinkError(`idea #${id} not found`, 'not_found');
      return withLinksOne(row, scope.viewer);
    },
    attachments: {
      list(todoId) {
        mustSee(todoId);
        return listTodoAttachments(todoId).map(publicTodoAttachment);
      },
      add(todoId, file) {
        const existing = mustSee(todoId);
        const parsed = attachmentInputSchema.safeParse(file);
        if (!parsed.success) {
          throw new TodoLinkError('invalid attachment: expected { name, data } with data as bytes or base64', 'invalid', 'attachment_invalid');
        }
        const { name, data } = parsed.data;
        let bytes: Buffer;
        if (typeof data === 'string') {
          if (data.length > MAX_FACADE_BASE64) {
            throw new TodoLinkError('File too large (max 15 MB).', 'invalid', 'attachment_too_large');
          }
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
            throw new TodoLinkError('invalid attachment: `data` must be base64', 'invalid', 'attachment_invalid');
          }
          bytes = Buffer.from(data, 'base64');
        } else {
          bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        }
        let saved: StoredTodoAttachment;
        try { saved = saveTodoAttachmentBytes(todoId, name, bytes); } catch (err) { attachmentRefusal(err); }
        publishTodoChanged(existing);
        return publicTodoAttachment(saved);
      },
      remove(todoId, attachmentId) {
        const existing = mustSee(todoId);
        const removed = deleteTodoAttachment(todoId, attachmentId);
        if (removed) publishTodoChanged(existing);
        return removed;
      },
      read(todoId, attachmentId) {
        mustSee(todoId);
        const found = getTodoAttachment(todoId, attachmentId);
        if (!found) throw new TodoLinkError('attachment not found', 'not_found');
        return new Uint8Array(readFileSync(found.path));
      },
    },
  };
}

/**
 * One PATCH of an idea: its core `fields`, plus whatever of `body` the
 * registered extensions own. Throws `TodoExtensionError` before any write when
 * an extension refuses its part.
 */
export function patchTodo(
  existing: ProjectTodoRow,
  fields: TodoCoreFields,
  body: Readonly<Record<string, unknown>>,
): ProjectTodoRow | undefined {
  const plans = prepareTodoExtensions(existing, body, { progress: fields.progress, status: fields.status });
  const row = dbApi.updateProjectTodo(existing.id, fields, plans.length ? {
    close: plans.some((p) => p.close),
    afterWrite: (updated, before) => { for (const p of plans) p.commit(updated, before); },
  } : undefined);
  if (row) publishTodoChanged(row);
  return row;
}
