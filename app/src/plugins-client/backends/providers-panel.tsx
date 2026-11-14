'use client';

/**
 * Settings → AI models → Providers: what a provider plugin may run on this
 * machine, and the agents of the official ACP registry.
 *
 * Superadmin only, and the daemon is what enforces it: this panel renders
 * nothing when the list is refused. Every program Timon is about to launch is
 * shown with the path the DAEMON resolved — never one typed here — and nothing
 * is allowed or downloaded before a click on a confirmation that names it.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Copy, Download, KeyRound, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConsentLines } from '@/components/provider-consent';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  acpAction, authorizeProvider, binaryAction, fetchAcpAuthMethods, fetchAcpRegistry, fetchProviders, installAcpAgent, needsAuthorization,
  orderAuthMethods, pathsToAuthorize, PROVIDER_PARAM, providerToAuthorize, removeAcpAgent,
  type AcpAgent, type AcpAuthMethod, type AcpRegistry, type ProviderPlugin,
} from '@/lib/providers';
import { sseOn } from '@/lib/sse-stream';
import { t } from '@/lib/i18n';

type Pending =
  | { kind: 'authorize'; provider: ProviderPlugin }
  | { kind: 'unverified'; agent: AcpAgent };

export function ProvidersPanel(): ReactElement | null {
  const [providers, setProviders] = useState<ProviderPlugin[] | null>(null);
  const [registry, setRegistry] = useState<AcpRegistry | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // Sign-in methods by agent, read on a click: asking starts the agent's program on the daemon.
  const [signIns, setSignIns] = useState<Record<string, AcpAuthMethod[]>>({});

  const loadProviders = useCallback(async () => {
    try { setProviders(await fetchProviders()); } catch { setProviders(null); }
  }, []);
  const loadRegistry = useCallback(async (refresh = false) => {
    setRegistryError(null);
    try { setRegistry(await fetchAcpRegistry(refresh)); } catch (err) { setRegistryError((err as Error).message); }
  }, []);

  useEffect(() => {
    // The registry is a third-party CDN: it is read when asked, never on open.
    void loadProviders();
    return sseOn('plugins_changed', () => { void loadProviders(); });
  }, [loadProviders]);

  // A refused launch's card (TODO #598) lands here with `?provider=<id>`: the authorization dialog opens on
  // what the daemon resolves NOW, and nothing is authorized before its confirm button.
  // Null outside the App Router (a test, a surface mounted elsewhere): nothing was requested.
  const requested = useSearchParams()?.get(PROVIDER_PARAM) ?? null;
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!requested || providers === null || handled.current === requested) return;
    handled.current = requested;
    const target = providerToAuthorize(providers, requested);
    if (target) setPending({ kind: 'authorize', provider: target });
    setHighlighted(requested);
    // Replaced, not pushed: Back closes Settings, it does not reopen the dialog. Next keeps
    // `useSearchParams` in step with `history` (`openSettingsFromAnywhere` relies on the same).
    const url = new URL(window.location.href);
    url.searchParams.delete(PROVIDER_PARAM);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [requested, providers]);

  const run = async (key: string, work: () => Promise<void>): Promise<void> => {
    setBusy(key);
    try { await work(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(null); }
  };

  const authorize = (provider: ProviderPlugin): Promise<void> => run(`authorize:${provider.id}`, async () => {
    await authorizeProvider(provider.id, pathsToAuthorize(provider.binaries));
    setPending(null);
    toast.success(t('providersSettings.plugins.authorized', { name: provider.label }));
    await loadProviders();
  });

  const install = (agent: AcpAgent, acceptUnverified: boolean): Promise<void> => run(`install:${agent.id}`, async () => {
    const wasInstalled = agent.installed !== null;
    await installAcpAgent(agent.id, acceptUnverified);
    setPending(null);
    toast.success(t(wasInstalled ? 'providersSettings.acp.updated' : 'providersSettings.acp.installed', { name: agent.name }));
    await loadRegistry();
  });

  const toggleSignIn = (agent: AcpAgent): Promise<void> => {
    if (signIns[agent.id]) {
      setSignIns(({ [agent.id]: _shown, ...rest }) => rest);
      return Promise.resolve();
    }
    return run(`auth:${agent.id}`, async () => {
      const methods = await fetchAcpAuthMethods(agent.id);
      setSignIns((current) => ({ ...current, [agent.id]: orderAuthMethods(methods) }));
    });
  };

  const remove = (agent: AcpAgent): Promise<void> => run(`remove:${agent.id}`, async () => {
    setSignIns(({ [agent.id]: _gone, ...rest }) => rest);
    await removeAcpAgent(agent.id);
    toast.success(t('providersSettings.acp.removed', { name: agent.name }));
    await loadRegistry();
  });

  // Not a superadmin, or an older daemon: nothing to offer.
  if (providers === null) return null;

  return (
    <section className="mt-8 max-w-3xl space-y-6" aria-labelledby="providers-title">
      <div className="space-y-1">
        <h3 id="providers-title" className="m-0 text-sm font-semibold">{t('providersSettings.title')}</h3>
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('providersSettings.description')}</p>
      </div>

      {providers !== null && (
        <div className="space-y-2">
          <h4 className="m-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('providersSettings.plugins.title')}</h4>
          {providers.length === 0
            ? <p className="m-0 text-xs text-muted-foreground">{t('providersSettings.plugins.none')}</p>
            : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {providers.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    highlighted={highlighted === provider.id}
                    busy={busy === `authorize:${provider.id}`}
                    onAuthorize={() => setPending({ kind: 'authorize', provider })}
                  />
                ))}
              </ul>
            )}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="m-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('providersSettings.acp.title')}</h4>
          {registry && (
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" disabled={busy !== null} onClick={() => void loadRegistry(true)}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              {t('providersSettings.acp.refresh')}
            </Button>
          )}
        </div>
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('providersSettings.acp.description')}</p>
        {!registry && !registryError && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy !== null} onClick={() => void loadRegistry()}>
            {t('providersSettings.acp.browse')}
          </Button>
        )}
        {registry?.stale && <p className="m-0 text-xs text-amber-700 dark:text-amber-300">{t('providersSettings.acp.stale')}</p>}
        {registryError && <p className="m-0 text-xs text-destructive" role="alert">{registryError}</p>}
        {registry && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {registry.agents.map((agent) => (
              <AcpRow
                key={agent.id}
                agent={agent}
                busy={busy}
                signIn={signIns[agent.id] ?? null}
                onInstall={() => (agent.integrity === 'none' ? setPending({ kind: 'unverified', agent }) : void install(agent, false))}
                onSignIn={() => void toggleSignIn(agent)}
                onRemove={() => void remove(agent)}
              />
            ))}
          </ul>
        )}
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open && busy === null) setPending(null); }}>
        <DialogContent className="sm:max-w-lg">
          {pending?.kind === 'authorize' && (
            <>
              <DialogHeader>
                <DialogTitle>{t('providersSettings.plugins.authorizeTitle', { name: pending.provider.label })}</DialogTitle>
                <DialogDescription>{t('providersSettings.plugins.authorizeBody')}</DialogDescription>
              </DialogHeader>
              <ConsentLines binaries={pathsToAuthorize(pending.provider.binaries)} osCredentials={pending.provider.osCredentials ?? []} credentialDirs={pending.provider.credentialDirs ?? []} />
              <DialogFooter>
                <Button variant="ghost" disabled={busy !== null} onClick={() => setPending(null)}>{t('providersSettings.cancel')}</Button>
                <Button disabled={busy !== null} onClick={() => void authorize(pending.provider)}>{t('providersSettings.plugins.authorizeConfirm')}</Button>
              </DialogFooter>
            </>
          )}
          {pending?.kind === 'unverified' && (
            <>
              <DialogHeader>
                <DialogTitle>{t('providersSettings.acp.confirmTitle', { name: pending.agent.name })}</DialogTitle>
                <DialogDescription>{t('providersSettings.acp.confirmBody')}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" disabled={busy !== null} onClick={() => setPending(null)}>{t('providersSettings.cancel')}</Button>
                <Button variant="destructive" disabled={busy !== null} onClick={() => void install(pending.agent, true)}>
                  {t('providersSettings.acp.confirmAction')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ProviderRow({
  provider, busy, highlighted, onAuthorize,
}: { provider: ProviderPlugin; busy: boolean; highlighted: boolean; onAuthorize: () => void }): ReactElement {
  const toAuthorize = needsAuthorization(provider);
  return (
    <li
      data-provider={provider.id}
      className={highlighted ? 'space-y-2 rounded-md bg-amber-500/10 px-3 py-2.5 ring-1 ring-amber-500/40' : 'space-y-2 rounded-md bg-muted/30 px-3 py-2.5'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">{provider.label}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{provider.version}</span>
        <Badge variant={provider.state === 'active' ? 'default' : 'outline'}>{t(`providersSettings.plugins.state.${provider.state}`)}</Badge>
        {provider.backends.length > 0 && (
          <span className="text-[11px] text-muted-foreground">{t('providersSettings.plugins.backends', { list: provider.backends.join(', ') })}</span>
        )}
        {toAuthorize && (
          <Button size="sm" className="ml-auto h-7 gap-1.5 text-xs" disabled={busy} onClick={onAuthorize}>
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            {t('providersSettings.plugins.authorize')}
          </Button>
        )}
      </div>
      {provider.error && provider.state !== 'active' && <p className="m-0 text-xs text-destructive">{provider.error}</p>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
        {provider.binaries.map((binary) => {
          const action = binaryAction(binary);
          return (
            <li key={binary.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-medium">{binary.name}</span>
              <span className="break-all text-muted-foreground">{binary.resolved ?? t('providersSettings.plugins.notFound')}</span>
              <span className={action === 'ready' ? 'text-emerald-700 dark:text-emerald-300' : action === 'refused' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'}>
                {t(`providersSettings.plugins.binary.${action}`)}
              </span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function AcpRow({
  agent, busy, signIn, onInstall, onSignIn, onRemove,
}: {
  agent: AcpAgent; busy: string | null; signIn: AcpAuthMethod[] | null; onInstall: () => void; onSignIn: () => void; onRemove: () => void;
}): ReactElement {
  const action = acpAction(agent);
  const working = busy === `install:${agent.id}`;
  const asking = busy === `auth:${agent.id}`;
  const runnable = agent.installed !== null && agent.installed.state === 'ok';
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/30 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="m-0 flex flex-wrap items-center gap-2 text-[13px] font-medium">
          {agent.name}
          <span className="text-[11px] font-normal tabular-nums text-muted-foreground">{agent.version}</span>
          {agent.supported && agent.integrity === 'sha256' && (
            <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-800 dark:text-emerald-300">
              <CheckCircle2 className="h-3 w-3" aria-hidden />{t('providersSettings.acp.verified')}
            </Badge>
          )}
          {agent.supported && agent.integrity === 'none' && (
            <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3" aria-hidden />{t('providersSettings.acp.noHash')}
            </Badge>
          )}
          {agent.installed && (
            <Badge variant={agent.installed.state === 'ok' ? 'default' : 'destructive'}>
              {t(`providersSettings.acp.state.${agent.installed.state}`, { version: agent.installed.version })}
            </Badge>
          )}
          {agent.installed?.integrity === 'unverified' && (
            <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3" aria-hidden />{t('providersSettings.acp.unverified')}
            </Badge>
          )}
        </p>
        <p className="m-0 truncate text-[11px] text-muted-foreground">
          {agent.supported ? agent.description ?? '' : t('providersSettings.acp.unsupported', { reason: agent.reason ?? '' })}
        </p>
      </div>
      {action !== 'none' && (
        <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={busy !== null} onClick={onInstall}>
          {action === 'verify' ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
          {working ? t('providersSettings.acp.installing') : t(`providersSettings.acp.${action}`)}
        </Button>
      )}
      {runnable && (
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" disabled={busy !== null} aria-expanded={signIn !== null} onClick={onSignIn}>
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          {asking
            ? t('providersSettings.acp.signIn.loading', { name: agent.name })
            : t(signIn ? 'providersSettings.acp.signIn.hide' : 'providersSettings.acp.signIn.show')}
        </Button>
      )}
      {agent.installed && (
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" disabled={busy !== null} onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          {t('providersSettings.acp.remove')}
        </Button>
      )}
      {action === 'verify' && agent.installed && (
        <p className="m-0 basis-full text-xs leading-relaxed text-amber-800 dark:text-amber-300">
          {t('providersSettings.acp.verifiedUpdate', { installed: agent.installed.version, version: agent.version })}
        </p>
      )}
      {signIn && <SignInMethods agentName={agent.name} methods={signIn} />}
    </li>
  );
}

/** What the agent said about its sign-in: the suggested method first, and every method billed per token marked. */
function SignInMethods({ agentName, methods }: { agentName: string; methods: AcpAuthMethod[] }): ReactElement {
  if (methods.length === 0) {
    return <p className="m-0 basis-full text-xs text-muted-foreground">{t('providersSettings.acp.signIn.none', { name: agentName })}</p>;
  }
  const anyBilled = methods.some((m) => m.billedPerToken);
  const allBilled = methods.every((m) => m.billedPerToken);
  const copy = (command: string): void => {
    void navigator.clipboard?.writeText(command).then(() => toast.success(t('providersSettings.acp.signIn.copied')), () => undefined);
  };
  return (
    <div className="basis-full space-y-2 pt-1">
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {methods.map((method) => (
          <li key={method.id} className="space-y-1 rounded-md bg-background/60 px-2.5 py-2 text-xs">
            <p className="m-0 flex flex-wrap items-center gap-2">
              <span className="font-medium">{method.name}</span>
              {method.recommended && (
                <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-800 dark:text-emerald-300">
                  <CheckCircle2 className="h-3 w-3" aria-hidden />{t('providersSettings.acp.signIn.recommended')}
                </Badge>
              )}
              {method.billedPerToken && (
                <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-3 w-3" aria-hidden />{t('providersSettings.acp.signIn.billed')}
                </Badge>
              )}
            </p>
            {method.description && <p className="m-0 text-muted-foreground">{method.description}</p>}
            {method.recommended && method.command && (
              <div className="space-y-1">
                <p className="m-0 text-muted-foreground">{t('providersSettings.acp.signIn.terminal')}</p>
                <div className="flex items-start gap-2">
                  {/* code-font: a command to copy into a terminal */}
                  <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-[11px]">{method.command}</code>
                  <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" onClick={() => copy(method.command ?? '')}>
                    <Copy className="h-3.5 w-3.5" aria-hidden />{t('providersSettings.acp.signIn.copy')}
                  </Button>
                </div>
              </div>
            )}
            {method.recommended && !method.command && (
              <p className="m-0 text-muted-foreground">{t('providersSettings.acp.signIn.agentStep', { name: agentName })}</p>
            )}
          </li>
        ))}
      </ul>
      {anyBilled && (
        <p className="m-0 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
          {t(allBilled ? 'providersSettings.acp.signIn.allBilled' : 'providersSettings.acp.signIn.billedNote', { name: agentName })}
        </p>
      )}
    </div>
  );
}
