'use client';

/**
 * Subscription accounts of a provider (TODO #52), as the Connection section of
 * its page carries them (`provider-connection-section.tsx`).
 *
 * Lists the accounts the viewer may see, adds one, and signs it in from the
 * browser: the CLI runs on the daemon's machine, so the person opens the
 * provider's page here and either pastes back the code it shows (claude) or
 * types the device code Timon shows on that page (codex). A user signs in
 * their own accounts; the superadmin signs in anyone's, and adds accounts for
 * anyone or for the instance (missions nobody owns).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Check, Copy, ExternalLink, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ProviderSettingRow } from '@/components/provider-page/provider-section';
import { BrandMark } from '@/components/brand-mark';
import { useMe } from '@/hooks/use-me';
import { actingUser } from '@/lib/auth';
import { refreshBackendCatalog, useBackendCatalog, type BackendName } from '@/lib/backends';
import {
  accountStatus, cancelLogin, cleanPastedCode, createAccount, deleteAccount, fetchAccounts, isLoginOver,
  loginFailureText, readLogin, renameAccount, sendLoginCode, setAccountGrants, startLogin,
  type AccountLogin, type AccountStatus, type AccountsPage, type BackendAccount,
} from '@/lib/backend-accounts';
import { copyToClipboard } from '@/lib/clipboard';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

const POLL_MS = 1500;
const field = 'h-7 w-full rounded-md border border-border bg-background px-2 text-[12px]';

/** An account as the core's directory names it: never an e-mail. */
type UserOption = { id: string; name: string };

/** What is open under a row: one thing at a time. */
type Panel = { id: string; kind: 'login' | 'rename' | 'grants' };

const STATUS_TONE: Record<AccountStatus, string> = {
  connected: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  notConnected: 'bg-muted text-muted-foreground',
  reauth: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  cooldown: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
};

export function AccountStatusChip({ account }: { account: BackendAccount }): ReactElement {
  const status = accountStatus(account);
  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]', STATUS_TONE[status])}>
      {t(`backendAccounts.status.${status}`)}
    </span>
  );
}

/** The sign-in address in full, with a button that puts it on the clipboard. */
function LoginAddress({ url }: { url: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t('backendAccounts.login.copyFailed'));
    }
  };
  return (
    <div className="flex items-start gap-2">
      <a href={url} target="_blank" rel="noopener noreferrer"
        className="min-w-0 flex-1 select-all break-all text-[11px] leading-snug text-muted-foreground underline-offset-2 hover:underline">
        {url}
      </a>
      <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 gap-1 text-[12px]" onClick={() => void copy()}>
        {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
        {copied ? t('backendAccounts.login.copied') : t('backendAccounts.login.copy')}
      </Button>
    </div>
  );
}

/**
 * What the person has to do right now, for one flow. Stateless: the pane owns
 * the flow and the pasted text.
 */
export function AccountLoginPrompt({ login, code, busy, onCode, onSubmit, onRetry, onClose }: {
  login: AccountLogin | null;
  code: string;
  busy: boolean;
  onCode: (value: string) => void;
  onSubmit: () => void;
  onRetry: () => void;
  onClose: () => void;
}): ReactElement {
  if (!login || login.state === 'starting') {
    return <p className="text-[12px] text-muted-foreground">{t('backendAccounts.login.starting')}</p>;
  }
  if (login.state === 'failed') {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-[12px] text-destructive">{loginFailureText(login)}</p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" onClick={onRetry}>{t('backendAccounts.login.retry')}</Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onClose}>{t('backendAccounts.login.close')}</Button>
        </div>
      </div>
    );
  }
  if (login.state === 'connected') {
    return <p className="text-[12px] text-emerald-700 dark:text-emerald-300">{t('backendAccounts.login.connected', { identity: login.identity ?? '' })}</p>;
  }
  if (login.state === 'verifying' || login.codeSent) {
    return <p className="text-[12px] text-muted-foreground">{t('backendAccounts.login.verifying')}</p>;
  }
  const prompt = login.prompt;
  if (!prompt) return <p className="text-[12px] text-muted-foreground">{t('backendAccounts.login.starting')}</p>;
  const link = (
    <a href={prompt.url} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[12px] font-medium text-primary underline-offset-2 hover:underline">
      {t('backendAccounts.login.openPage')}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
  // Some desktops open nothing from a link: the address stays readable,
  // selectable and copyable so the person can paste it in any browser.
  const address = <LoginAddress url={prompt.url} />;
  if (prompt.kind === 'device-code') {
    return (
      <div className="space-y-2">
        <p className="text-[12px] leading-snug">{t('backendAccounts.login.deviceStep1')} {link}</p>
        {address}
        <p className="text-[12px] leading-snug">{t('backendAccounts.login.deviceStep2')}</p>
        {/* code-font: one-time code the person types on the provider's page */}
        <p className="select-all font-mono text-[18px] font-semibold tracking-widest">{prompt.code}</p>
        <p className="text-[11px] text-muted-foreground">{t('backendAccounts.login.deviceWaiting')}</p>
      </div>
    );
  }
  return (
    <form className="space-y-2" onSubmit={(event: FormEvent) => { event.preventDefault(); onSubmit(); }}>
      <p className="text-[12px] leading-snug">{t('backendAccounts.login.pasteStep1')} {link}</p>
      {address}
      <label className="block space-y-1">
        <span className="text-[12px]">{t('backendAccounts.login.pasteStep2')}</span>
        <input className={field} value={code} autoComplete="off" spellCheck={false} required
          placeholder={t('backendAccounts.login.pastePlaceholder')} onChange={(e) => onCode(e.target.value)} />
      </label>
      <Button type="submit" size="sm" className="h-7 text-[12px]" disabled={busy || cleanPastedCode(code) === ''}>
        {t('backendAccounts.login.submit')}
      </Button>
    </form>
  );
}

/** One flow, from its start to its verdict. Leaving the panel cancels it. */
function LoginPanel({ account, onFinished }: { account: BackendAccount; onFinished: () => void }): ReactElement {
  const [login, setLogin] = useState<AccountLogin | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef<AccountLogin | null>(null);
  latest.current = login;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await readLogin(account.id);
        if (!alive) return;
        setLogin(next);
        latest.current = next;
        if (next?.state === 'connected') {
          toast.success(t('backendAccounts.login.connected', { identity: next.identity ?? '' }));
          onFinished();
        }
        if (!isLoginOver(next)) timer = setTimeout(() => void poll(), POLL_MS);
      } catch (error) {
        if (alive) toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
      }
    };
    setLogin(null);
    setCode('');
    startLogin(account.id)
      .then((started) => {
        // Left before the daemon answered: the flow exists now, stop it.
        if (!alive) {
          if (!isLoginOver(started)) void cancelLogin(account.id).catch(() => {});
          return;
        }
        latest.current = started;
        setLogin(started);
        timer = setTimeout(() => void poll(), POLL_MS);
      })
      .catch((error: unknown) => {
        if (alive) toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
      });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      // A flow left open would hold the CLI until its TTL. Not started yet
      // (null): the start handler above cancels it when it lands.
      if (latest.current && !isLoginOver(latest.current)) void cancelLogin(account.id).catch(() => {});
    };
  }, [account.id, attempt, onFinished]);

  const submit = useCallback(async () => {
    setBusy(true);
    try {
      setLogin(await sendLoginCode(account.id, cleanPastedCode(code)));
      setCode('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
    } finally {
      setBusy(false);
    }
  }, [account.id, code]);

  return (
    <div className="space-y-3 rounded-md bg-background/60 p-3">
      <AccountLoginPrompt
        login={login}
        code={code}
        busy={busy}
        onCode={setCode}
        onSubmit={() => void submit()}
        onRetry={() => setAttempt((n) => n + 1)}
        onClose={onFinished}
      />
      {(login === null || !isLoginOver(login)) && (
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onFinished}>
          {t('backendAccounts.login.cancel')}
        </Button>
      )}
    </div>
  );
}

/** A gesture on an account's row. */
export type AccountGesture = 'connect' | 'reconnect' | 'rename' | 'assign' | 'delete';

/**
 * Which gesture a row shows and which wait in its "…" menu. Signing in is the
 * one visible action only when the account needs it; nothing at all while a
 * panel is open under the row, or for an account the viewer only uses.
 */
export function accountGestures(status: AccountStatus, options: { canManage: boolean; panelOpen: boolean; rename: boolean; assign: boolean }): {
  primary: AccountGesture | null;
  menu: AccountGesture[];
} {
  if (!options.canManage || options.panelOpen) return { primary: null, menu: [] };
  const signIn: AccountGesture = status === 'notConnected' ? 'connect' : 'reconnect';
  const needsSignIn = status === 'notConnected' || status === 'reauth';
  return {
    primary: needsSignIn ? signIn : null,
    menu: [
      ...(needsSignIn ? [] : [signIn]),
      ...(options.rename ? ['rename' as const] : []),
      ...(options.assign ? ['assign' as const] : []),
      'delete',
    ],
  };
}

export function AccountRow({ account, ownerName, canManage, panelOpen, icon, grantees, onSignIn, onRename, onAssign, onDelete, children }: {
  account: BackendAccount;
  ownerName: string | null;
  canManage: boolean;
  /** A panel is open under the row: its own buttons step aside. */
  panelOpen: boolean;
  icon: ReactElement;
  /** Names of the users it is assigned to; shown to the superadmin only. */
  grantees?: string[];
  onSignIn: () => void;
  onRename?: () => void;
  /** Present for the superadmin, who alone assigns an account. */
  onAssign?: () => void;
  onDelete: () => void;
  children?: ReactElement | null;
}): ReactElement {
  const status = accountStatus(account);
  const gestures = accountGestures(status, { canManage, panelOpen, rename: onRename !== undefined, assign: onAssign !== undefined });
  const details = [
    account.identity ? t('backendAccounts.signedInAs', { identity: account.identity }) : t('backendAccounts.notSignedIn'),
    ...(ownerName !== null ? [ownerName] : []),
    ...(grantees && grantees.length > 0 ? [t('backendAccounts.assignedTo', { names: grantees.join(', ') })] : []),
  ];
  const run: Record<AccountGesture, () => void> = {
    connect: onSignIn,
    reconnect: onSignIn,
    rename: () => onRename?.(),
    assign: () => onAssign?.(),
    delete: onDelete,
  };
  return (
    <ProviderSettingRow
      data-account-row={account.id}
      leading={icon}
      title={<><span className="truncate">{account.name}</span><AccountStatusChip account={account} /></>}
      status={<span className="block truncate">{details.join(' · ')}</span>}
      action={gestures.primary ? (
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={run[gestures.primary]}>{t(`backendAccounts.${gestures.primary}`)}</Button>
      ) : null}
      menuLabel={t('providerPage.connection.accountMore', { name: account.name })}
      menu={gestures.menu.length > 0 ? gestures.menu.map((gesture) => (
        <DropdownMenuItem key={gesture} onSelect={run[gesture]}
          className={gesture === 'delete' ? 'text-destructive focus:text-destructive' : undefined}>
          {t(`backendAccounts.${gesture}`)}
        </DropdownMenuItem>
      )) : null}
    >
      {children ?? null}
    </ProviderSettingRow>
  );
}

/** The account's display name, from its row. A taken name answers 409. */
export function RenamePanel({ account, onDone, onCancel }: {
  account: BackendAccount;
  onDone: () => void;
  onCancel: () => void;
}): ReactElement {
  const [name, setName] = useState(account.name);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await renameAccount(account.id, trimmed);
      toast.success(t('backendAccounts.renamed'));
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2 rounded-md bg-background/60 p-3 sm:flex-row sm:items-center">
      <input className={field} value={name} maxLength={60} required autoFocus
        aria-label={t('backendAccounts.renameLabel', { name: account.name })}
        onChange={(e) => setName(e.target.value)} />
      <div className="flex shrink-0 justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onCancel}>{t('backendAccounts.renameCancel')}</Button>
        <Button type="submit" size="sm" className="h-7 text-[12px]" disabled={busy || trimmed === '' || trimmed === account.name}>
          {t('backendAccounts.renameSave')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Who else may use the account (superadmin). The owner uses it anyway and is
 * not offered; what is saved replaces the previous list.
 */
export function GrantsPanel({ account, users, onDone, onCancel }: {
  account: BackendAccount;
  users: UserOption[];
  onDone: () => void;
  onCancel: () => void;
}): ReactElement {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(account.grantedTo ?? []));
  const [busy, setBusy] = useState(false);
  const candidates = users.filter((user) => user.id !== account.ownerUserId);
  const toggle = (id: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const save = async () => {
    setBusy(true);
    try {
      // The list replaces the previous one: a grantee this pane does not list
      // (a disabled account, say) stays as it was.
      await setAccountGrants(account.id, [...chosen].filter((id) => id !== account.ownerUserId));
      toast.success(t('backendAccounts.grants.saved'));
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-md bg-background/60 p-3">
      <div className="space-y-1">
        <p className="text-[12px] font-medium">{t('backendAccounts.grants.title')}</p>
        <p className="max-w-[65ch] text-[11px] leading-snug text-muted-foreground">{t('backendAccounts.grants.hint')}</p>
      </div>
      {candidates.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{t('backendAccounts.grants.empty')}</p>
      ) : (
        <div className="space-y-1">
          {candidates.map((user) => (
            <label key={user.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12px] hover:bg-muted/50">
              <input type="checkbox" className="size-3.5 accent-primary" checked={chosen.has(user.id)} onChange={() => toggle(user.id)} />
              <span className="truncate">{user.name || user.id}</span>
            </label>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onCancel}>{t('backendAccounts.grants.cancel')}</Button>
        <Button type="button" size="sm" className="h-7 text-[12px]" disabled={busy || candidates.length === 0} onClick={() => void save()}>
          {t('backendAccounts.grants.save')}
        </Button>
      </div>
    </div>
  );
}

function AddAccountForm({ backends, users, superadmin, onCreated, onCancel }: {
  backends: BackendName[];
  users: UserOption[];
  superadmin: boolean;
  onCreated: (account: BackendAccount) => void;
  onCancel: () => void;
}): ReactElement {
  const [backend, setBackend] = useState<BackendName>(backends[0] ?? '');
  const [name, setName] = useState('');
  // '' = the viewer, 'instance' = missions nobody owns, else a user id.
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const account = await createAccount({
        backend, name: name.trim(),
        ...(owner === '' ? {} : { ownerUserId: owner === 'instance' ? null : owner }),
      });
      onCreated(account);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 rounded-lg bg-background/60 p-3">
      {/* On a provider page there is often one backend only: nothing to choose. */}
      {backends.length > 1 && (
        <label className="block space-y-1">
          <span className="text-[12px] font-medium">{t('backendAccounts.form.backend')}</span>
          <select className={field} value={backend} onChange={(e) => setBackend(e.target.value)}>
            {backends.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-[12px] font-medium">{t('backendAccounts.form.name')}</span>
        <input className={field} value={name} maxLength={60} required placeholder={t('backendAccounts.form.namePlaceholder')}
          onChange={(e) => setName(e.target.value)} />
      </label>
      {superadmin && (
        <label className="block space-y-1">
          <span className="text-[12px] font-medium">{t('backendAccounts.form.owner')}</span>
          <select className={field} value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">{t('backendAccounts.form.ownerMe')}</option>
            <option value="instance">{t('backendAccounts.form.ownerInstance')}</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.name || user.id}</option>)}
          </select>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onCancel}>{t('backendAccounts.form.cancel')}</Button>
        <Button type="submit" size="sm" className="h-7 text-[12px]" disabled={busy || !backend || name.trim() === ''}>{t('backendAccounts.form.create')}</Button>
      </div>
    </form>
  );
}

/**
 * The accounts the viewer may see, with every gesture on them: add, sign in,
 * rename, assign, delete. `backends` narrows it to the accounts of these
 * backends, and what may be added to them (a provider page); `onChanged` is
 * called after any change it made, once the list is read again.
 */
export function BackendAccountsList({ backends, onChanged }: {
  backends?: readonly BackendName[];
  onChanged?: () => void;
} = {}): ReactElement {
  const me = useMe();
  const superadmin = actingUser(me)?.is_superadmin === true;
  const catalog = useBackendCatalog();
  const [page, setPage] = useState<AccountsPage | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);

  const load = useCallback(async () => {
    try {
      setPage(await fetchAccounts());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!superadmin) return;
    void fetch('/api/ui/users/directory', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { users: [] }))
      .then((body: { users?: UserOption[] }) => setUsers(body.users ?? []))
      .catch(() => setUsers([]));
  }, [superadmin]);

  const userNames = useMemo(() => new Map(users.map((user) => [user.id, user.name || user.id])), [users]);
  // A new array each render from a caller would restart the effects below: compare by content.
  const scopeKey = backends ? backends.join('\n') : null;
  const scoped = useMemo(() => {
    if (page === null || scopeKey === null) return page;
    const keep = new Set(scopeKey.split('\n'));
    return { accounts: page.accounts.filter((a) => keep.has(a.backend)), backends: page.backends.filter((id) => keep.has(id)) };
  }, [page, scopeKey]);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const finished = useCallback(() => {
    setPanel(null);
    void load().then(() => changed.current?.());
    // The selectors read account states from the catalogue.
    refreshBackendCatalog();
  }, [load]);

  const remove = async (account: BackendAccount) => {
    if (!(await confirmAction({ title: t('backendAccounts.deleteConfirm', { name: account.name }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return;
    try {
      await deleteAccount(account.id);
      toast.success(t('backendAccounts.deleted'));
      if (panel?.id === account.id) setPanel(null);
      await load();
      refreshBackendCatalog();
      changed.current?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
    }
  };

  const ownerLabel = (account: BackendAccount): string | null => {
    if (!superadmin || account.mine) return null;
    if (account.ownerUserId === null) return t('backendAccounts.ownerInstance');
    return userNames.get(account.ownerUserId) ?? account.ownerUserId;
  };

  const iconOf = (backend: BackendName): ReactElement => {
    const entry = catalog.backends.find((candidate) => candidate.id === backend);
    return <BrandMark icon={entry?.icon} brand={entry?.brand} className="size-4 shrink-0" />;
  };

  return (
    <>
      {scoped === null && <p className="m-0 px-3 py-2.5 text-xs text-muted-foreground">{t('backendAccounts.loading')}</p>}
      {scoped !== null && scoped.accounts.length === 0 && !adding && (
        <p className="m-0 px-3 py-2.5 text-xs text-muted-foreground">{t('backendAccounts.empty')}</p>
      )}
      {scoped?.accounts.map((account) => {
        const open = panel?.id === account.id ? panel.kind : null;
        return (
          <AccountRow
            key={account.id}
            account={account}
            ownerName={ownerLabel(account)}
            canManage={superadmin || account.mine}
            panelOpen={open !== null}
            icon={iconOf(account.backend)}
            grantees={superadmin ? (account.grantedTo ?? []).map((id) => userNames.get(id) ?? id) : undefined}
            onSignIn={() => setPanel({ id: account.id, kind: 'login' })}
            onRename={() => setPanel({ id: account.id, kind: 'rename' })}
            {...(superadmin ? { onAssign: () => setPanel({ id: account.id, kind: 'grants' }) } : {})}
            onDelete={() => void remove(account)}
          >
            {open === 'login' ? <LoginPanel account={account} onFinished={finished} />
              : open === 'rename' ? <RenamePanel account={account} onDone={finished} onCancel={() => setPanel(null)} />
              : open === 'grants' ? <GrantsPanel account={account} users={users} onDone={finished} onCancel={() => setPanel(null)} />
              : null}
          </AccountRow>
        );
      })}
      {scoped !== null && scoped.backends.length > 0 && (adding ? (
        <div className="px-1 py-1">
          <AddAccountForm
            backends={scoped.backends}
            users={users}
            superadmin={superadmin}
            onCancel={() => setAdding(false)}
            onCreated={(account) => {
              setAdding(false);
              void load().then(() => {
                setPanel({ id: account.id, kind: 'login' });
                changed.current?.();
              });
            }}
          />
        </div>
      ) : (
        <div className="px-1 py-0.5">
          <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 text-muted-foreground hover:text-foreground" onClick={() => setAdding(true)}>
            <Plus aria-hidden className="size-3.5" />
            {t('backendAccounts.add')}
          </Button>
        </div>
      ))}
    </>
  );
}
