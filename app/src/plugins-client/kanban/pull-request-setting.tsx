'use client';

/**
 * The project's row "Pull requests", under "Integrations" in the project's
 * window (`project.settings`): whether the project's Kanban jobs merge
 * locally or land through a pull request, and where it goes
 * (`project-integration.ts`). One action, "Set up" / "Configure", opens the
 * fields in a dialog; checking gh's sign-in and going back to the local merge
 * live in the "…" menu.
 *
 * The setting names a folder of this machine and the account the daemon
 * pushes as, so the daemon answers it only to `projects:manage`: without it
 * the row stays, says so, and greys its action with the reason.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { MoreHorizontal, PlugZap, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useProjectSettings } from '@/components/project-settings-slot';
import { useAccess } from '@/hooks/use-me';
import type { GitRemoteEntry } from '@/lib/git-store';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  announceIntegrationChanged, checkIntegration, createFork, listRemotes, readIntegration, resetIntegration, saveIntegration,
  type IntegrationAccess, type IntegrationCheck, type IntegrationPatch, type IntegrationRead, type RepositoryRights,
} from './project-integration-api';

type Notice = { tone: 'ok' | 'warn'; text: string };

/** One sentence for gh's answer, the draft's account or the stored one. */
export function checkNotice(check: IntegrationCheck): Notice {
  if (check.code) {
    const text = t(`prSetting.check.code.${check.code}`);
    return { tone: 'warn', text: check.code === 'gh_failed' && check.reason ? `${text} ${check.reason}` : text };
  }
  if (!check.login) return { tone: 'warn', text: t('prSetting.check.code.unexpected_answer') };
  if (!check.expected) return { tone: 'warn', text: t('prSetting.check.noAccount', { login: check.login }) };
  if (check.ok) return { tone: 'ok', text: t('prSetting.check.matches', { login: check.login }) };
  return { tone: 'warn', text: t('prSetting.check.mismatch', { login: check.login, account: check.expected }) };
}

function NoticeLine({ notice, attr }: { notice: Notice; attr: string }): ReactElement {
  return (
    <p
      role="status"
      {...{ [attr]: notice.tone }}
      className={cn('text-[11.5px]', notice.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}
    >
      {notice.text}
    </p>
  );
}

/** What the account may push to, in one sentence each, and whether a fork is
 *  worth offering: the target refuses the account's push and no usable fork exists. */
export function accessNotices(access: IntegrationAccess): { lines: Notice[]; offerFork: boolean } {
  const lines: Notice[] = [];
  const t0 = access.target;
  if ('unreadable' in t0) return { lines: [{ tone: 'warn', text: t('prSetting.fork.unreadable', { repo: t0.repository }) }], offerFork: false };
  if (t0.canPush) return { lines: [{ tone: 'ok', text: t('prSetting.fork.targetPush', { repo: t0.repository }) }], offerFork: false };
  lines.push({ tone: 'warn', text: t('prSetting.fork.targetNoPush', { repo: t0.repository }) });
  const f: RepositoryRights | null = access.fork;
  if (f && 'unreadable' in f) {
    lines.push({ tone: 'warn', text: t('prSetting.fork.unreadable', { repo: f.repository }) });
    return { lines, offerFork: false };
  }
  if (f && f.exists && f.canPush) {
    lines.push({ tone: 'ok', text: t('prSetting.fork.forkPush', { repo: f.repository }) });
    return { lines, offerFork: false };
  }
  if (f && f.exists) {
    lines.push({ tone: 'warn', text: t('prSetting.fork.forkNoPush', { repo: f.repository }) });
    return { lines, offerFork: false };
  }
  if (f) lines.push({ tone: 'warn', text: t('prSetting.fork.forkMissing', { repo: f.repository }) });
  return { lines, offerFork: true };
}

function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11.5px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const pushUrlOf = (r: GitRemoteEntry | undefined): string => r?.push_url ?? r?.url ?? '';

/** The fields of the setting, in their own dialog: the row's "Set up", and the
 *  Git stack's shortcut while a project merges its jobs locally (`local-landing.tsx`). */
export function PullRequestSetupDialog({ project, current, onClose, onSaved }: {
  project: string;
  current: IntegrationRead;
  onClose: () => void;
  onSaved: (read: IntegrationRead) => void;
}): ReactElement {
  const i = current.integration;
  const [remote, setRemote] = useState(i.remote);
  const [remoteUrl, setRemoteUrl] = useState(i.remote_url ?? '');
  const [target, setTarget] = useState(i.target);
  const [account, setAccount] = useState(i.account ?? '');
  const [ghDir, setGhDir] = useState(i.gh_config_dir ?? '');
  const [prefix, setPrefix] = useState(i.branch_prefix);
  const [remotes, setRemotes] = useState<GitRemoteEntry[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Notice | null>(null);
  const [forkUrl, setForkUrl] = useState(i.push_remote_url ?? '');
  const [access, setAccess] = useState<IntegrationAccess | null>(null);
  const [accessNote, setAccessNote] = useState<Notice | null>(null);
  const [reading, setReading] = useState(false);
  // The fork is created on GitHub: only after the person said so, here.
  const [confirmingFork, setConfirmingFork] = useState(false);
  const [forking, setForking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void listRemotes(project).then((out) => {
      if (!alive || !out.ok) return;
      setRemotes(out.value);
      // A first set-up borrows the URL the chosen remote already pushes to.
      if (!i.remote_url) setRemoteUrl((typed) => typed || pushUrlOf(out.value.find((r) => r.name === i.remote)));
    });
    return () => { alive = false; };
  }, [project, i.remote, i.remote_url]);

  const pickRemote = (name: string) => {
    const before = pushUrlOf(remotes?.find((r) => r.name === remote));
    setRemote(name);
    // Follows the remote while the URL is still the one it suggested.
    if (!remoteUrl || remoteUrl === before) setRemoteUrl(pushUrlOf(remotes?.find((r) => r.name === name)));
  };

  const draft = (): IntegrationPatch => ({
    mode: 'pr',
    remote: remote.trim(),
    target: target.trim(),
    account: account.trim() || null,
    gh_config_dir: ghDir.trim() || null,
    branch_prefix: prefix.trim(),
    remote_url: remoteUrl.trim() || null,
    push_remote_url: forkUrl.trim() || null,
  });

  // The rights are read for the stored setting: save the account and the URL first.
  const stored = current.configured && i.mode === 'pr' && !!i.remote_url && !!i.account;
  // The rights are read for the stored setting, not for the form: while a field
  // differs from what is stored, the check would answer for another setting.
  const d = draft();
  const dirty = d.remote !== i.remote || d.target !== i.target || d.account !== (i.account ?? null)
    || d.gh_config_dir !== (i.gh_config_dir ?? null) || d.branch_prefix !== i.branch_prefix
    || d.remote_url !== (i.remote_url ?? null) || d.push_remote_url !== (i.push_remote_url ?? null);

  const readAccess = async () => {
    setReading(true);
    setAccess(null);
    setAccessNote(null);
    setConfirmingFork(false);
    const out = await checkIntegration(project);
    setReading(false);
    if (!out.ok) setAccessNote({ tone: 'warn', text: out.message });
    else if (out.value.access) setAccess(out.value.access);
    else setAccessNote(checkNotice(out.value));
  };

  const makeFork = async () => {
    setForking(true);
    setError(null);
    const out = await createFork(project);
    setForking(false);
    setConfirmingFork(false);
    if (out.ok) {
      setForkUrl(out.value.integration.push_remote_url ?? '');
      setAccess(null);
      setAccessNote({ tone: 'ok', text: t('prSetting.fork.created', { repo: out.value.fork }) });
      announceIntegrationChanged(project);
    } else setError(out.message);
  };

  const runCheck = async () => {
    setChecking(true);
    setCheck(null);
    const d = draft();
    const out = await checkIntegration(project, { account: d.account, gh_config_dir: d.gh_config_dir });
    setChecking(false);
    setCheck(out.ok ? checkNotice(out.value) : { tone: 'warn', text: out.message });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const out = await saveIntegration(project, draft());
    setSaving(false);
    if (out.ok) onSaved(out.value);
    else setError(out.message);
  };

  const listed = remotes !== null && remotes.length > 0;
  const enabling = i.mode !== 'pr' || !current.configured;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-pr-setting-dialog="" className="max-w-[480px]">
        <DialogTitle className="text-sm">{t('prSetting.dialogTitle', { project })}</DialogTitle>
        <DialogDescription className="sr-only">{t('prSetting.title')}</DialogDescription>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('prSetting.field.remote')}>
            {listed ? (
              <select
                data-pr-setting-remote=""
                value={remote}
                onChange={(e) => pickRemote(e.target.value)}
                className="h-9 w-full min-w-0 rounded-md border border-input bg-muted/40 px-2 text-base md:text-sm"
              >
                {!remotes.some((r) => r.name === remote) && <option value={remote}>{remote}</option>}
                {remotes.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select>
            ) : (
              <Input data-pr-setting-remote="" value={remote} onChange={(e) => setRemote(e.target.value)} />
            )}
          </Field>
          <Field label={t('prSetting.field.target')}>
            <Input data-pr-setting-target="" value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <div className="col-span-2">
            <Field label={t('prSetting.field.remoteUrl')}>
              <Input
                data-pr-setting-remote-url=""
                value={remoteUrl}
                // i18n-exempt: sample remote URL, the same in every language
                placeholder="git@github.com:owner/repo.git"
                onChange={(e) => setRemoteUrl(e.target.value)}
              />
            </Field>
          </div>
          <Field label={t('prSetting.field.account')}>
            <Input data-pr-setting-account="" value={account} placeholder={t('prSetting.field.accountPlaceholder')} onChange={(e) => setAccount(e.target.value)} />
          </Field>
          <Field label={t('prSetting.field.branchPrefix')}>
            <Input data-pr-setting-prefix="" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </Field>
          <div className="col-span-2">
            <Field label={t('prSetting.field.forkUrl')}>
              <Input
                data-pr-setting-fork-url=""
                value={forkUrl}
                // i18n-exempt: sample remote URL, the same in every language
                placeholder="git@github.com:you/repo.git"
                onChange={(e) => setForkUrl(e.target.value)}
              />
            </Field>
            <p className="mt-1 text-[11px] text-muted-foreground">{t('prSetting.field.forkUrlHint')}</p>
          </div>
          <div className="col-span-2">
            <Field label={t('prSetting.field.ghConfigDir')}>
              <Input
                data-pr-setting-gh-dir=""
                value={ghDir}
                placeholder={t('prSetting.field.ghConfigDirPlaceholder')}
                onChange={(e) => setGhDir(e.target.value)}
              />
            </Field>
          </div>
        </div>
        {check && <NoticeLine notice={check} attr="data-pr-setting-check" />}
        {stored && (
          <div data-pr-setting-fork="" className="flex flex-col gap-1.5 rounded-md bg-muted/40 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[11.5px] font-medium text-muted-foreground">{t('prSetting.fork.title')}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => { void readAccess(); }} disabled={reading || forking || dirty}
                title={dirty ? t('prSetting.fork.checkSaveFirst') : undefined}>
                <span data-pr-setting-access-run="">{reading ? t('prSetting.checking') : t('prSetting.fork.check')}</span>
              </Button>
            </div>
            {access && accessNotices(access).lines.map((line, n) => <NoticeLine key={n} notice={line} attr="data-pr-setting-access" />)}
            {accessNote && <NoticeLine notice={accessNote} attr="data-pr-setting-access-note" />}
            {access && accessNotices(access).offerFork && !confirmingFork && (
              <div>
                <Button type="button" size="sm" onClick={() => setConfirmingFork(true)} disabled={forking}>
                  <span data-pr-setting-fork-offer="">{t('prSetting.fork.offer')}</span>
                </Button>
              </div>
            )}
            {confirmingFork && (
              <div data-pr-setting-fork-confirm="" className="flex flex-col gap-2">
                <p className="text-[11.5px] text-foreground">
                  {t('prSetting.fork.confirm', { account: i.account ?? '', repo: access?.target.repository ?? '' })}
                </p>
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" onClick={() => { void makeFork(); }} disabled={forking}>
                    <span data-pr-setting-fork-create="">{forking ? t('prSetting.fork.creating') : t('prSetting.fork.create')}</span>
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingFork(false)} disabled={forking}>
                    {t('prSetting.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {error && <p data-pr-setting-error="" className="text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => { void runCheck(); }} disabled={checking}>
            <span data-pr-setting-check-run="">{checking ? t('prSetting.checking') : t('prSetting.check.run')}</span>
          </Button>
          <div className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('prSetting.cancel')}</Button>
          <Button type="button" size="sm" onClick={() => { void save(); }} disabled={saving || !account.trim()}>
            <span data-pr-setting-save="">{saving ? t('prSetting.saving') : enabling ? t('prSetting.enable') : t('prSetting.save')}</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function statusOf(read: IntegrationRead): { key: string; text: string; title?: string } {
  if (read.invalid) return { key: 'invalid', text: t('prSetting.status.invalid'), title: read.invalid };
  const i = read.integration;
  if (i.mode !== 'pr') return { key: 'local', text: t('prSetting.status.local') };
  const base = `${i.remote}/${i.target}`;
  return {
    key: 'pr',
    text: i.account ? t('prSetting.status.pr', { base, account: i.account }) : t('prSetting.status.prNoAccount', { base }),
  };
}

export function PullRequestSetting(): ReactElement | null {
  const settings = useProjectSettings();
  const project = settings?.project ?? null;
  const manage = useAccess('projects:manage');
  const [read, setRead] = useState<IntegrationRead | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setRead(null);
    setLoadError(null);
    if (!project || !manage.allowed) return;
    const out = await readIntegration(project);
    if (out.ok) setRead(out.value);
    else setLoadError(out.message);
  }, [project, manage.allowed]);

  useEffect(() => { void reload(); }, [reload]);

  const applied = (next: IntegrationRead) => {
    setRead(next);
    if (project) announceIntegrationChanged(project);
  };

  const verify = async () => {
    if (!project) return;
    setBusy(true);
    setNotice(null);
    const out = await checkIntegration(project);
    setBusy(false);
    setNotice(out.ok ? checkNotice(out.value) : { tone: 'warn', text: out.message });
  };

  const backToLocal = async () => {
    if (!project) return;
    setBusy(true);
    setNotice(null);
    const out = await resetIntegration(project);
    setBusy(false);
    if (out.ok) applied(out.value);
    else setNotice({ tone: 'warn', text: out.message });
  };

  // Nothing until the account is known: a flash of a greyed row would mislead.
  if (!project || (!manage.allowed && !manage.denied)) return null;

  const status = manage.denied
    ? { key: 'restricted', text: t('prSetting.status.restricted'), title: manage.denied }
    : loadError
      ? { key: 'error', text: loadError, title: loadError }
      : read ? statusOf(read) : { key: 'loading', text: t('prSetting.status.loading') };
  const enabled = read?.integration.mode === 'pr' && !read.invalid;
  const menu = !!read && read.configured;

  return (
    <div data-pr-setting={project} className="flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-foreground">{t('prSetting.title')}</div>
        <div data-pr-setting-status={status.key} title={status.title} className="truncate text-[11px] text-muted-foreground">{status.text}</div>
        {notice && <NoticeLine notice={notice} attr="data-pr-setting-notice" />}
      </div>
      {/* A disabled button takes no pointer events: the wrapper carries the reason's tooltip. */}
      <span title={manage.denied ?? undefined} data-pr-setting-reason={manage.denied ? '' : undefined} className="shrink-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          disabled={!read || busy}
          aria-describedby={manage.denied ? `pr-setting-reason-${project}` : undefined}
        >
          <span data-pr-setting-configure="">{enabled ? t('prSetting.configure') : t('prSetting.setUp')}</span>
        </Button>
        {manage.denied && <span id={`pr-setting-reason-${project}`} className="sr-only">{manage.denied}</span>}
      </span>
      {menu && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0 text-muted-foreground"
              aria-label={t('prSetting.more')}
              title={t('prSetting.more')}
              disabled={busy}
              data-pr-setting-menu=""
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {enabled && (
              <DropdownMenuItem data-pr-setting-verify="" onSelect={() => { void verify(); }}>
                <PlugZap aria-hidden />
                {t('prSetting.verify')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem data-pr-setting-local="" onSelect={() => { void backToLocal(); }}>
              <Undo2 aria-hidden />
              {t('prSetting.backToLocal')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {editing && read && (
        <PullRequestSetupDialog
          project={project}
          current={read}
          onClose={() => setEditing(false)}
          onSaved={(next) => { applied(next); setNotice(null); setEditing(false); }}
        />
      )}
    </div>
  );
}
