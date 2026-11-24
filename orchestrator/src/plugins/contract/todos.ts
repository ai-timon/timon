/**
 * `ctx.kanban.todos`: the TO DO notebook as a plugin sees it.
 *
 * Extracted verbatim from `plugins/context.ts`, which re-exports it: the public
 * contract lives in leaf modules so `@timon-ai/sdk` can name it without the
 * implementation (TODO #512, option B).
 */
import type { WriteOrigin as TodoOrigin } from './origin.js';

// Spelled out from the constant of `project-todo-tags.ts`, which proves at compilation that both agree (TODO #512, volet 3).
export type TodoUrgency = 'critical' | 'bug' | 'minor' | 'idea';
export type TodoProgress = 'todo' | 'analyzed' | 'partial' | 'to_test' | 'done';

/** An idea of the TO DO notebook, as `ctx.kanban.todos` returns it. */
export type PluginTodo = {
  id: number;
  text: string;
  project: string | null;
  author: string | null;
  /** `open`, `done` or `promoted` (a task was made from it). */
  status: string;
  notes: string | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
  promoted_task_id: string | null;
  urgency: TodoUrgency | null;
  progress: TodoProgress | null;
  /** Account the idea belongs to; `plugin:<id>` when a plugin job created it. */
  owner_user_id: string | null;
  links: PluginTodoLink[];
  /** Number of files attached to the idea (`attachments.list` gives them). API 15. */
  attachment_count: number;
  /** Where the branch of the idea's jobs stands, read-only: `null` when no job
   *  of the idea has an integration branch. Absent from an older host. */
  landing?: PluginTodoLanding | null;
};

/** State of one job's branch: `branch` (embargo, no pull request expected),
 *  `pending` (pull request not created), `open`, `merged`, `closed` (without a merge). */
export type PluginTodoLandingState = 'branch' | 'pending' | 'open' | 'merged' | 'closed';

/** One job (integration branch) of an idea. */
export type PluginTodoLandingJob = {
  /** Id of the job, the same in `/api/kanban/landings/:id`. Absent from an
   *  older host. */
  jobId?: string;
  state: PluginTodoLandingState;
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
};

/** An idea's landing: its job furthest from landing on top (`closed`, then
 *  `pending`, `branch`, `open`, `merged`), every job in `jobs`, oldest first. */
export type PluginTodoLanding = PluginTodoLandingJob & { jobs: PluginTodoLandingJob[] };

/** A file attached to an idea, as `ctx.kanban.todos.attachments` returns it.
 *  Never a path: the bytes are read through `attachments.read`. API 15. */
export type PluginTodoAttachment = {
  /** UUID of the attachment. */
  id: string;
  todo_id: number;
  /** File name as stored: separators, `..` and odd characters neutralised. */
  name: string;
  size: number;
  /** Decided by the daemon from the extension, never by the caller. */
  mime: string;
  kind: 'image' | 'document';
  created_at: number;
};

/**
 * A file to attach. `data` is the bytes, or their base64. Accepted: images
 * (png, jpg, gif, webp), PDF, text and config files (txt, md, log, csv, json,
 * yaml, xml, toml, ini, and source files, kept as inert text), Office and
 * OpenDocument files. At most 15 MB per file, 20 files and 100 MB per idea.
 */
export type PluginTodoAttachmentInput = {
  name: string;
  data: Uint8Array | string;
};

/** Where an idea lives outside Timon (a GitHub issue, a Discord thread…). */
export type PluginTodoLink = {
  provider: string;
  ref: string;
  url: string | null;
  label: string | null;
  /** Plugin that wrote the link — set by the daemon, never by the caller. */
  plugin_id: string | null;
  created_at: number;
};

/** `provider` is a lowercase slug, `ref` the ticket's id in that system
 *  (≤ 256), `url` http(s) only, `label` ≤ 200. */
export type PluginTodoLinkInput = {
  provider: string;
  ref: string;
  url?: string | null;
  label?: string | null;
};

/** A new idea. Its owner is the caller (`plugin:<id>` in a job), never a field. */
export type PluginTodoInput = {
  text: string;
  project?: string | null;
  notes?: string | null;
  author?: string | null;
  urgency?: TodoUrgency | null;
  progress?: TodoProgress;
};

/** Filter of `ctx.kanban.todos.list`. `limit` is 200 at most, and 200 by default. */
export type PluginTodoListFilter = {
  status?: 'open' | 'done' | 'promoted';
  project?: string;
  urgency?: TodoUrgency;
  progress?: TodoProgress;
  /** Ideas whose `landing.state` is this one. Ignored by an older host. */
  landing?: PluginTodoLandingState;
  limit?: number;
};

/**
 * What a plugin asks of a promotion: who runs the task, and a few of the knobs
 * of `POST /api/project-todo/:id/promote`. Nothing about the LLM or the
 * permission level, and the task's project is the idea's own.
 */
export type PluginTodoPromoteInput = {
  agent: string;
  type?: string;
  priority?: number;
  /** Starting branch of a `code` task's worktree. */
  base?: string | null;
  pipeline?: 'full' | 'code-self' | 'code-group' | null;
};

/** `code` of the error the TO DO facade throws on a refused input.
 *  `forbidden`: an extension refused its field (outcomes switched off), or —
 *  with `reason: 'spawn_policy'` — a promotion with nobody in front (a job, a
 *  webhook delivery, an event handler) that the operator has not approved.
 *  A refused attachment is `invalid` with `reason` set to
 *  `attachment_type_refused`, `attachment_content_mismatch`,
 *  `attachment_too_large`, `attachment_quota` or `attachment_invalid`. */
export type PluginTodoErrorCode = 'invalid' | 'not_found' | 'conflict' | 'forbidden';

/**
 * An edit of an idea, as `PATCH /api/project-todo/:id` takes it: the core
 * fields below, plus the fields of the plugins extending the notebook — e.g.
 * `resolution`, `public_note`, `duplicate_of` of `@timon/todo-outcomes`. A key
 * no one owns is refused (`invalid`).
 */
export type PluginTodoPatch = {
  text?: string;
  project?: string | null;
  notes?: string | null;
  author?: string | null;
  /** `promoted` is not settable: an idea is promoted with its task. */
  status?: 'open' | 'done';
  urgency?: TodoUrgency | null;
  progress?: TodoProgress;
  [extensionField: string]: unknown;
};

/** `ctx.kanban.todos`: the notebook as the CALLER sees it (see `PluginContext`). */
export type PluginTodos = {
  get(id: number): Promise<PluginTodo | undefined>;
  /** The ideas the caller sees (in a job: the ones this plugin created), open
   *  first, with their links. */
  list(filter?: PluginTodoListFilter): Promise<PluginTodo[]>;
  /** New idea with its links, in one transaction. A link already tied to an
   *  idea the caller sees returns that idea with `created: false`; tied to an
   *  idea it cannot see, `conflict`. */
  create(input: PluginTodoInput, links?: readonly PluginTodoLinkInput[]): Promise<{ item: PluginTodo; created: boolean }>;
  links: {
    list(todoId: number): Promise<PluginTodoLink[]>;
    /** Ties the idea to a ticket, or refreshes url/label of that tie. */
    set(todoId: number, link: PluginTodoLinkInput): Promise<PluginTodoLink>;
    remove(todoId: number, provider: string, ref: string): Promise<boolean>;
    /** The idea a ticket points at, `undefined` when none or not visible. */
    findByRef(provider: string, ref: string): Promise<PluginTodo | undefined>;
  };
  /** Edits the idea through the same path as the PATCH route, extensions
   *  included. The events it causes carry `origin: { kind: 'plugin', id }`. */
  update(id: number, patch: PluginTodoPatch): Promise<PluginTodo>;
  /** Progress `done`. A promoted idea comes back unchanged: its chain closes it. */
  close(id: number): Promise<PluginTodo>;
  /**
   * Turns the idea into a `PENDING` task and marks it promoted, as the TO DO
   * detail does. Needs `todos:write` AND `kanban:write`: a promotion spawns
   * work for an agent. The task carries the idea, so its chain closes it.
   * `conflict` when the idea was promoted already, `invalid` on a refused
   * input (`base`, `pipeline`, `type`, a project that no longer exists).
   * With nobody in front (a job, a webhook delivery, an event handler) the
   * task that runs is a spawn: `forbidden` with `reason: 'spawn_policy'` until
   * the operator approves the plugin in `pluginPolicy.spawn` (TODO #562).
   */
  promote(id: number, input: PluginTodoPromoteInput): Promise<{ task: unknown; item: PluginTodo }>;
  /** Deletes the idea and its links. `todo_deleted` follows, with this plugin
   *  as `origin`. `not_found` when the caller does not see it. */
  delete(id: number): Promise<void>;
  /**
   * The files attached to an idea the caller sees (`not_found` otherwise):
   * `list` and `read` need `todos:read`, `add` and `remove` `todos:write`. They
   * go with the idea when it is deleted, and a promotion copies them into the
   * task. API 15.
   */
  attachments: {
    /** Oldest first. */
    list(todoId: number): Promise<PluginTodoAttachment[]>;
    add(todoId: number, file: PluginTodoAttachmentInput): Promise<PluginTodoAttachment>;
    /** `false` when there was no such file. */
    remove(todoId: number, attachmentId: string): Promise<boolean>;
    /** The file's bytes; `not_found` when there is no such file. */
    read(todoId: number, attachmentId: string): Promise<Uint8Array>;
  };
};

export type PluginTodoEventKind = 'todo_done' | 'todo_resolved' | 'todo_deleted';

/** Who wrote: `kind: 'plugin', id: ctx.id` is this plugin's own write. */
export type PluginTodoOrigin = TodoOrigin;

/** A link as the event carries it (the idea's links at the time of the write). */
export type PluginTodoEventLink = Readonly<{
  provider: string;
  ref: string;
  url: string | null;
  label: string | null;
  plugin_id: string | null;
  created_at: number;
}>;

export type PluginTodoDoneEvent = Readonly<{
  kind: 'todo_done';
  todoId: number;
  previousProgress: string | null;
  todo: Readonly<{
    id: number; text: string; project: string | null; owner_user_id: string | null;
    progress: string | null; urgency: string | null; done_at: number | null;
    links: readonly PluginTodoEventLink[];
  }>;
  origin: PluginTodoOrigin;
}>;

export type PluginTodoResolvedEvent = Readonly<{
  kind: 'todo_resolved';
  todoId: number;
  previousResolution: string | null;
  todo: Readonly<{
    id: number; text: string; project: string | null; owner_user_id: string | null;
    /** `fixed`, `declined`, `duplicate`, `needs_info`, `in_progress` or `planned`. */
    resolution: string; public_note: string | null; duplicate_of: string | null;
    links: readonly PluginTodoEventLink[];
  }>;
  origin: PluginTodoOrigin;
}>;

export type PluginTodoDeletedEvent = Readonly<{
  kind: 'todo_deleted';
  todoId: number;
  /** Taken before the delete: the idea and its links no longer exist. */
  todo: Readonly<{
    id: number; text: string; project: string | null; owner_user_id: string | null;
    links: readonly PluginTodoEventLink[];
  }>;
  origin: PluginTodoOrigin;
}>;

export type PluginTodoEvent = PluginTodoDoneEvent | PluginTodoResolvedEvent | PluginTodoDeletedEvent;

export type PluginTodoEventMap = {
  todo_done: PluginTodoDoneEvent;
  todo_resolved: PluginTodoResolvedEvent;
  todo_deleted: PluginTodoDeletedEvent;
};

export type PluginTodoEventHandler = (ev: PluginTodoEvent) => void | Promise<void>;
