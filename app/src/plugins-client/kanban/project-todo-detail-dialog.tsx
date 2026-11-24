'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Eye, FolderGit2, Pencil, Send } from 'lucide-react';
import { AttachmentsField, pastedFiles } from '@/components/attachments-field';
import { DetailShell } from '@/components/detail-shell';
import { useAttachmentItems } from '@/components/use-attachment-items';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { mdToSafeHtml } from '@/lib/markdown';
import { formatDateTime } from '@/lib/intl';
import type { ProjectTodo } from './project-todo-types';
import { ExternalLink } from './project-todo-links';
import { t } from '@/lib/i18n';
import { effectiveProgress, type TodoProgress, type TodoUrgency } from '@/lib/project-todo-tags';
import { AuthorBadge, MetaBadge, ProgressMenu, UrgencyMenu } from './project-todo-tag-chips';
import { TodoBadgeSlot } from './todo-badge-slot';
import { TodoLandingSlot } from './todo-landing-slot';
import { TodoOriginChips } from './todo-issue-chips';
import { TodoDetailSlot } from './todo-detail-slot';
import { RailGroup, TodoFormClose } from './todo-form-parts';
import { useTodoForm, type TodoFormValue } from './todo-form-context';

/** A date and its time in the interface language, or "—" when absent (the `done_at` of an open idea). */
function when(ts: number | null): string {
  return ts ? formatDateTime(ts, { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

type LinkedTask = { id: string; title: string; type: string; status: string };

/**
 * The full detail of a notebook idea, the product's `todo.form` in edition
 * (TODO #837), laid out on `DetailShell` inside the host's `DetailFrame`. The
 * body is what one comes to read (the description in markdown); the rail is
 * what surrounds the idea — external references, linked tasks, plugin blocks
 * (`kanban.todo.detail`), dates. Urgency and progress each fit in one chip
 * that opens its vocabulary, not two rows of chips.
 *
 * The edition is only sent on "Save": an idea is written in several passes,
 * and an auto-save on every keystroke would churn `updated_at` and make the
 * list behind the popup flicker. Every call goes through the host
 * (`useTodoForm()`), like a replacement's.
 */
export function ProjectTodoDetail(): ReactElement | null {
  const host = useTodoForm();
  if (!host?.item) return null;
  return <Detail host={host} item={host.item} />;
}

function Detail({ host, item }: { host: TodoFormValue; item: ProjectTodo }): ReactElement {
  const [titre, setTitre] = useState(item.text);
  const [projet, setProjet] = useState(item.project ?? '');
  const [description, setDescription] = useState(item.notes ?? '');
  const [editionMd, setEditionMd] = useState(!item.notes);
  const [urgency, setUrgency] = useState<TodoUrgency | null>(item.urgency);
  const [progress, setProgress] = useState<TodoProgress>(effectiveProgress(item.progress));
  const [enCours, setEnCours] = useState(false);
  const [linked, setLinked] = useState<LinkedTask[]>([]);
  const titreRef = useRef<HTMLTextAreaElement | null>(null);
  // Sent at once, apart from "Save": a file is not a draft.
  const files = useAttachmentItems(item.id, host.attachments, 'todo');

  // The drafts follow the idea the screen reads again after a save. Keyed on
  // what they show, not on the object: a file added here makes the daemon
  // announce a change and the screen re-read the list, and a new object with
  // the same text must not wipe an edition in progress.
  useEffect(() => {
    setTitre(item.text);
    setProjet(item.project ?? '');
    setDescription(item.notes ?? '');
    setEditionMd(!item.notes);
    setUrgency(item.urgency);
    setProgress(effectiveProgress(item.progress));
  }, [item.id, item.text, item.project, item.notes, item.urgency, item.progress]);

  // The title wraps on as many lines as it needs: a clipped title is a title
  // nobody can read in full.
  useEffect(() => {
    const el = titreRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // `scrollHeight` leaves the border out: without it the box is two pixels
    // short and a scrollbar shows on a single line.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [titre, item]);

  // Tasks carrying this idea (`todo_id`): they are what will close it. A failed
  // read just hides the field — the popup stays usable.
  const itemId = item.id;
  useEffect(() => {
    setLinked([]);
    let alive = true;
    fetch(`/api/ui/tasks?todo_id=${itemId}`)
      .then((r) => (r.ok ? r.json() : { tasks: [] }))
      .then((j: { tasks?: LinkedTask[] }) => { if (alive) setLinked(j.tasks ?? []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [itemId]);

  const modifie =
    titre.trim() !== item.text ||
    (projet.trim() || null) !== item.project ||
    (description || null) !== (item.notes ?? null) ||
    urgency !== item.urgency ||
    progress !== effectiveProgress(item.progress);

  const enregistrer = async () => {
    const text = titre.trim();
    if (!text) {
      toast.error(t('projectTodo.detail.emptyTitle'));
      return;
    }
    setEnCours(true);
    try {
      const result = await host.submit({
        text,
        project: projet.trim() || null,
        notes: description || null,
        urgency,
        progress,
      });
      if (!result.ok) {
        toast.error(t('projectTodo.detail.saveError'), { description: result.error });
        return;
      }
      await host.refresh();
      toast.success(t('projectTodo.detail.saved'));
    } finally {
      setEnCours(false);
    }
  };

  const handoff = host.handoff;
  const renvoyer = async () => {
    if (!handoff) return;
    setEnCours(true);
    try {
      const result = await handoff();
      if (!result.ok) {
        toast.error(t('projectTodo.detail.handoffError'), { description: result.error });
        return;
      }
      toast.success(t('projectTodo.detail.handoffSent', { agent: result.agent }), {
        description: t('projectTodo.detail.handoffSentHint'),
      });
      host.close();
    } finally {
      setEnCours(false);
    }
  };

  const statut = item.promoted_task_id
    ? t('projectTodo.detail.statusPromoted', { task: item.promoted_task_id.slice(0, 8) })
    : item.status === 'done' ? t('projectTodo.detail.statusDone') : t('projectTodo.detail.statusOpen');

  const header = (
    <>
      <h2 id={host.titleId} className="sr-only">{t('projectTodo.detail.title', { id: item.id })}</h2>
      <div className="flex items-start gap-3">
        <textarea
          ref={titreRef}
          rows={1}
          value={titre}
          onChange={(e) => setTitre(e.target.value.replace(/\n/g, ' '))}
          aria-label={t('projectTodo.detail.titleLabel')}
          placeholder={t('projectTodo.detail.titleLabel')}
          className="-mx-2 min-w-0 flex-1 resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-2 py-1 text-[17px] font-medium leading-snug text-foreground outline-none transition-colors hover:bg-muted/40 focus-visible:border-input focus-visible:bg-background"
        />
        <TodoFormClose onClose={host.close} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <MetaBadge>#{item.id}</MetaBadge>
        <UrgencyMenu value={urgency} onChange={setUrgency} />
        <ProgressMenu value={progress} onChange={setProgress} />
        <label className="inline-flex items-center gap-1 text-muted-foreground">
          <FolderGit2 className="size-3.5" aria-hidden />
          <Input
            value={projet}
            onChange={(e) => setProjet(e.target.value)}
            aria-label={t('projectTodo.detail.projectLabel')}
            placeholder={t('projectTodo.detail.projectPlaceholder')}
            className="h-6 w-32 border-transparent bg-transparent px-1.5 text-[12px] hover:bg-muted/40 focus-visible:border-input"
          />
        </label>
        {item.author ? (
          <AuthorBadge author={item.author} links={item.links} />
        ) : (
          <span className="text-[11.5px] text-muted-foreground/60">{t('projectTodo.authorUnknown')}</span>
        )}
        <TodoOriginChips item={item} />
        <TodoLandingSlot item={item} />
        <TodoBadgeSlot item={item} />
      </div>
    </>
  );

  const rail = (
    <>
      {(item.links?.length ?? 0) > 0 && (
        <RailGroup label={t('projectTodo.fieldExternalLinks')} hint={t('projectTodo.externalLinksHint')}>
          <ul className="flex flex-col gap-0.5">
            {item.links!.map((link) => <ExternalLink key={`${link.provider}:${link.ref}`} link={link} />)}
          </ul>
        </RailGroup>
      )}

      {linked.length > 0 && (
        <RailGroup label={t('projectTodo.fieldLinkedTasks')} hint={t('projectTodo.linkedTasksHint')}>
          <ul className="flex flex-col gap-1.5">
            {linked.map((task) => (
              <li key={task.id} className="flex flex-col text-[12.5px]">
                <span className="text-[11px] text-muted-foreground" title={task.id}>
                  {task.type} · {task.status}
                </span>
                <span className="line-clamp-2">{task.title}</span>
              </li>
            ))}
          </ul>
        </RailGroup>
      )}

      <TodoDetailSlot item={item} saved={host.refresh} />

      {/* A promoted idea carries its task's id: the answer to "where does
          this task come from?", read from the idea. */}
      <ul className="mt-auto flex flex-col gap-0.5 text-[11.5px] tabular-nums text-muted-foreground">
        <li title={item.promoted_task_id ?? undefined}>{statut}</li>
        <li>{t('projectTodo.detail.created', { date: when(item.created_at) })}</li>
        <li>
          {item.status === 'done'
            ? t('projectTodo.detail.doneAt', { date: when(item.done_at) })
            : t('projectTodo.detail.modified', { date: when(item.updated_at) })}
        </li>
      </ul>
    </>
  );

  const footer = (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={enCours || !handoff}
        title={handoff ? undefined : t('projectTodo.detail.handoffNeedsProject')}
        onClick={() => void renvoyer()}
      >
        <Send className="mr-1.5 size-3.5" />
        {t('projectTodo.detail.handoff')}
      </Button>
      <Button type="button" disabled={enCours || !modifie} onClick={() => void enregistrer()}>
        {t('projectTodo.detail.save')}
      </Button>
    </>
  );

  const attachments = (
    <AttachmentsField
      items={files.items}
      errors={files.errors}
      url={host.attachments.url}
      onAdd={files.add}
      onRemove={files.remove}
      onDismissErrors={files.dismissErrors}
    />
  );

  // A pasted screenshot is attached wherever the focus is; a paste of text
  // carries no file and goes to its field.
  return (
    <div
      className="contents"
      onPaste={(e) => {
        const pasted = pastedFiles(e);
        if (pasted.length === 0) return;
        e.preventDefault();
        files.add(pasted);
      }}
    >
      <DetailShell
        header={header}
        rail={rail}
        footer={footer}
        attachments={attachments}
        attachmentsLabel={t('taskForm.attachments.label')}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-medium text-muted-foreground">{t('projectTodo.detail.description')}</h3>
          <button
            type="button"
            onClick={() => setEditionMd((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            {editionMd ? <Eye className="size-3" aria-hidden /> : <Pencil className="size-3" aria-hidden />}
            {editionMd ? t('projectTodo.detail.preview') : t('projectTodo.detail.edit')}
          </button>
        </div>
        {editionMd ? (
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={16}
            placeholder={t('projectTodo.detail.descriptionPlaceholder')}
            // code-font: markdown source being edited
            className="min-h-[16rem] flex-1 font-mono text-[12px]"
          />
        ) : (
          // `chat-bubble` carries the typography of rendered markdown
          // (globals.css): reusing it avoids a second set of styles that would
          // drift from the chat's.
          <div
            className="chat-bubble min-h-[6rem] text-[13px]"
            dangerouslySetInnerHTML={{ __html: mdToSafeHtml(description) }}
          />
        )}
      </DetailShell>
    </div>
  );
}
