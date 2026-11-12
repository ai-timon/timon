'use client';

/**
 * The sheet shown BEFORE a third-party plugin is installed (TODO #332).
 *
 * Everything on it comes from the daemon's preview: the manifest (name,
 * version, author, kinds, what it asks for and where it plugs in) and the
 * signature verdict. Nothing of the package has run to produce it, and
 * nothing installs until "Install" is clicked — the disclaimer sits right
 * above that button so it is read at the moment it matters.
 *
 * When the manifest names its secrets and hosts (`preview.vault`, TODO #599),
 * the sheet asks for them by name and the confirmation sends back every line
 * as shown; otherwise it falls back to what the permissions open. A bundle also
 * shows each of its children, by id: what it launches, where it sends the voice
 * (TODO #673), and the secrets and hosts it names, with boxes of its own (TODO #660).
 *
 * Unsigned code (the package, or a child the bundle installs) is said twice:
 * with developer mode off, the sheet says why it will not load and how to turn
 * the mode on; and Install always asks first, mode on or off, since a package
 * installed while the mode is off starts the moment the mode goes on. Developer
 * mode is read live, not from the preview, whose verdict was judged at staging.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Blocks, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import { Picto } from '@/components/picto';
import { PluginKindBadge } from '@/components/plugin-kind-badge';
import { ProviderInstallConsent } from '@/components/provider-install-consent';
import { PluginInstallChildren } from '@/components/plugin-install-children';
import { PluginVaultConsent } from '@/components/plugin-vault-consent';
import { PluginInstallDeveloperMode } from '@/components/plugin-install-developer-mode';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { VoiceDestinationLines } from '@/components/dictation/voice-destination-lines';
import { declarationLines, readDictationDecl } from '@/lib/dictation/destination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  childExecConsent,
  childVaultConsent,
  initialVaultTicks,
  previewImage,
  signatureSummary,
  vaultConsent,
  vaultConsentLines,
  type ChildExecConsent,
  type ChildVaultConsent,
  type PluginPreview,
  type VaultConsent,
  type VaultTicks,
} from '@/lib/plugin-install';
import { pathsToAuthorize } from '@/lib/providers';
import { useCapabilities } from '@/lib/capabilities';
import {
  DEVELOPER_MODE_TARGET, fetchDeveloperMode, previewHasUnsignedCode, setDeveloperMode, type DeveloperModeState,
} from '@/lib/developer-mode';
import { openSettingsFromAnywhere } from '@/lib/settings-navigation';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const TONE: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
};

export function PluginInstallDialog({
  preview,
  open,
  busy,
  notice,
  onOpenChange,
  onInstall,
}: {
  preview: PluginPreview | null;
  open: boolean;
  busy: boolean;
  /** Why the sheet was shown again (the daemon found it stale at the click). */
  notice?: string | null;
  onOpenChange: (open: boolean) => void;
  onInstall: (preview: PluginPreview, authorizeExec?: string[], vault?: VaultConsent, execChildren?: ChildExecConsent[], vaultChildren?: ChildVaultConsent[]) => void;
}): React.ReactElement | null {
  // Accepting a provider's programs is its own act, off until the person ticks it.
  const [allow, setAllow] = useState(false);
  // Tied to the token: a refreshed preview starts again from its own defaults, never from stale boxes.
  const [vaultTicks, setVaultTicks] = useState<{ token: string; ticks: VaultTicks } | null>(null);
  // Same for the boxes of a bundle's providers, one per child, never shared.
  const [childAllow, setChildAllow] = useState<{ token: string; ids: Record<string, boolean> } | null>(null);
  // And for each child's secrets and hosts, by id.
  const [childTicks, setChildTicks] = useState<{ token: string; ids: Record<string, VaultTicks> } | null>(null);
  const token = preview?.token;
  useEffect(() => { setAllow(false); }, [token]);
  const caps = useCapabilities();
  // Developer mode as the daemon applies it now, read when the sheet shows unsigned code.
  const [developer, setDeveloper] = useState<DeveloperModeState | null>(null);
  const [switching, setSwitching] = useState(false);
  const unsignedCode = preview ? previewHasUnsignedCode(preview) : false;
  useEffect(() => {
    if (!open || !unsignedCode) return;
    let live = true;
    fetchDeveloperMode().then((state) => { if (live) setDeveloper(state); }).catch(() => { /* the link to Settings stays */ });
    return () => { live = false; };
  }, [open, unsignedCode, token]);
  if (!preview) return null;
  const named = preview.vault ?? null;
  const ticks = named ? (vaultTicks?.token === preview.token ? vaultTicks.ticks : initialVaultTicks(named)) : null;
  const tick = (kind: 'secrets' | 'hosts', key: string, value: boolean): void => {
    if (!ticks) return;
    setVaultTicks({ token: preview.token, ticks: { ...ticks, [kind]: { ...ticks[kind], [key]: value } } });
  };
  const children = preview.children ?? [];
  const allowedChildren = childAllow?.token === preview.token ? childAllow.ids : {};
  const tickedChildren = childTicks?.token === preview.token ? childTicks.ids : {};
  const provider = preview.provider;
  const authorizable = provider ? pathsToAuthorize(provider.binaries) : [];
  const cover = previewImage(preview.cover);
  const icon = previewImage(preview.icon);
  const title = preview.label ?? preview.pkg;
  const unsignedLoads = developer?.effective ?? caps?.developer.unsignedPlugins;
  const signature = signatureSummary(preview.signature, unsignedLoads);
  const rootLoads = preview.signature.state === 'unsigned' && preview.signature.loads;
  const unsignedWillLoad = unsignedCode && (unsignedLoads ?? rootLoads);
  const enableDeveloperMode = async (): Promise<void> => {
    setSwitching(true);
    try {
      setDeveloper(await setDeveloperMode(true));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  };
  const openDeveloperSettings = (): void => {
    onOpenChange(false);
    openSettingsFromAnywhere(DEVELOPER_MODE_TARGET);
  };
  const confirmInstall = async (): Promise<void> => {
    // Nothing installs without an explicit yes: Escape, a click outside or no
    // confirmation host on the page all answer no.
    if (unsignedCode && !(await confirmAction({
      title: t('pluginsPage.install.unsignedConfirm.title', { name: title }),
      description: t(unsignedWillLoad ? 'pluginsPage.install.unsignedConfirm.body' : 'pluginsPage.install.unsignedConfirm.bodyOff'),
      confirmLabel: t('pluginsPage.install.unsignedConfirm.confirm'),
      cancelLabel: t('pluginsPage.install.cancel'),
      destructive: true,
    }))) return;
    onInstall(preview, provider && allow ? authorizable : undefined, named && ticks ? vaultConsent(named, ticks) : undefined, childExecConsent(children, allowedChildren), childVaultConsent(children, tickedChildren));
  };
  const SignatureIcon = signature.tone === 'ok' ? ShieldCheck : signature.tone === 'danger' ? ShieldX : ShieldAlert;
  const inserts = [...preview.slots, ...(preview.route ? [preview.route] : [])];
  const declares = Object.entries(preview.declares).map(([name, mode]) => `${name} (${mode})`);
  const dictation = preview.kind.includes('dictation') ? readDictationDecl(preview.dictation) : null;
  const voice = dictation ? declarationLines(dictation) : [];
  const vault = vaultConsentLines(preview.permissions, named);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-h-[min(90vh,820px)] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <div className="flex h-36 items-center justify-center overflow-hidden bg-muted/50">
          {cover
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={cover} alt="" className="h-full w-full object-cover" />
            : icon
              ? <Picto icon={icon} className="size-14 text-foreground/70" />
              : <Blocks className="h-12 w-12 text-muted-foreground/50" aria-hidden />}
        </div>

        <ScrollArea className="max-h-[min(55vh,520px)]">
          <div className="flex flex-col gap-4 p-6 pt-5">
            <DialogHeader className="space-y-3 text-left">
              <div className="min-w-0">
                <DialogTitle className="text-base">{title}</DialogTitle>
                <p className="m-0 mt-1 text-[12px] tabular-nums text-muted-foreground">
                  {preview.pkg}
                  {` · ${preview.version}`}
                  {' · '}
                  {t('pluginsPage.by', { name: preview.author ?? t('pluginsPage.authorUnknown') })}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {preview.kind.map((kind) => <PluginKindBadge key={kind} kind={kind} />)}
                <Badge variant="outline" className={cn('gap-1 border font-medium shadow-none', TONE[signature.tone])}>
                  <SignatureIcon className="h-3 w-3" aria-hidden />
                  {signature.text}
                </Badge>
              </div>
              <DialogDescription className={preview.description ? 'text-sm leading-relaxed text-muted-foreground' : 'sr-only'}>
                {preview.description ?? title}
              </DialogDescription>
            </DialogHeader>

            {preview.manifestError && (
              <p className="m-0 rounded bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive" role="alert">
                {t('pluginsPage.install.manifestRefused', { reason: preview.manifestError })}
              </p>
            )}
            {preview.engineError && (
              <p className="m-0 rounded bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive" role="alert">
                {t('pluginsPage.install.nodeEngineRefused', { reason: preview.engineError })}
              </p>
            )}
            {preview.signature.state === 'tampered' && (
              <p className="m-0 rounded bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive" role="alert">
                {t('pluginsPage.install.tamperedHint')}
              </p>
            )}
            {unsignedCode && !unsignedWillLoad && (
              <PluginInstallDeveloperMode
                state={developer}
                busy={busy || switching}
                onEnable={() => { void enableDeveloperMode(); }}
                onOpenSettings={openDeveloperSettings}
              />
            )}

            <VoiceDestinationLines lines={voice} />

            <dl className="m-0 space-y-2 text-[12px]">
              <Row label={t('pluginsPage.install.permissions')} values={preview.permissions} empty={t('pluginsPage.install.permissionsNone')} />
              {inserts.length > 0 && <Row label={t('pluginsPage.inserts')} values={inserts} />}
              {declares.length > 0 && <Row label={t('pluginsPage.declares')} values={declares} />}
              {preview.contains.length > 0 && <Row label={t('pluginsPage.contains')} values={preview.contains} />}
              {preview.modifies.length > 0 && <Row label={t('pluginsPage.modifies')} values={preview.modifies} />}
              {preview.settings.length > 0 && <Row label={t('pluginsPage.settings')} values={preview.settings} />}
              {preview.webhooks.length > 0 && <Row label={t('pluginsPage.install.webhooks')} values={preview.webhooks} />}
              <Row label={t('pluginsPage.install.source')} values={[t(`pluginsPage.install.origin.${preview.origin}`)]} />
            </dl>

            {notice && (
              <p className="m-0 rounded bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-900 dark:text-amber-200" role="alert">
                {notice}
              </p>
            )}

            {named && ticks && (named.secrets.length > 0 || named.hosts.length > 0) && (
              <PluginVaultConsent vault={named} pluginId={preview.id ?? ''} ticks={ticks} busy={busy} onTick={tick} />
            )}

            {vault.length > 0 && (
              <div className="space-y-1 text-[12px] leading-relaxed" data-testid="vault-consent">
                {!named && <p className="m-0 font-medium">{t('pluginsPage.install.vault.title')}</p>}
                {vault.map((line) => (
                  <p key={line.key} className={cn('m-0', line.warn ? 'text-destructive' : 'text-muted-foreground')}>
                    {t(line.key)}
                  </p>
                ))}
              </div>
            )}

            {preview.installed && (
              <p className="m-0 text-[12px] text-muted-foreground">
                {t('pluginsPage.install.alreadyInstalled', { version: preview.installed.version })}
              </p>
            )}
            {preview.replaces && (
              <p className="m-0 text-[12px] text-destructive" data-testid="replaces-package">
                {t('pluginsPage.install.replacesPackage', { pkg: preview.replaces })}
              </p>
            )}
            {preview.updatesUnsigned && (
              <p className="m-0 text-[12px] text-muted-foreground" data-testid="updates-unsigned">
                {t('pluginsPage.install.updatesUnsigned')}
              </p>
            )}
            {children.map((child) => child.state === 'install' && child.replaces && (
              <p key={child.id} className="m-0 text-[12px] text-destructive" data-testid="child-replaces-package" data-replaced-child={child.id}>
                {t('pluginsPage.install.childReplacesPackage', { id: child.label ?? child.id, pkg: child.replaces })}
              </p>
            ))}
            {preview.licenseRequired && (
              <p className="m-0 text-[12px] text-muted-foreground">{t('pluginsPage.install.licenseRequired')}</p>
            )}

            {provider && <ProviderInstallConsent provider={provider} authorizable={authorizable} allow={allow} busy={busy} onAllow={setAllow} />}

            <PluginInstallChildren
              items={children}
              allowed={allowedChildren}
              vaultTicks={tickedChildren}
              busy={busy}
              unsignedLoads={unsignedLoads}
              onAllow={(id, value) => setChildAllow({ token: preview.token, ids: { ...allowedChildren, [id]: value } })}
              onVaultTick={(id, next) => setChildTicks({ token: preview.token, ids: { ...tickedChildren, [id]: next } })}
            />

            <div className="flex gap-2.5 rounded-md bg-amber-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div className="space-y-1">
                <p className="m-0 font-semibold">{t('pluginsPage.install.disclaimerTitle')}</p>
                <p className="m-0">{t('pluginsPage.install.disclaimer')}</p>
              </div>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="gap-2 px-6 pb-5 pt-3 sm:gap-0">
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('pluginsPage.install.cancel')}
          </Button>
          <Button disabled={!preview.installable || busy || switching} onClick={() => { void confirmInstall(); }}>
            {busy
              ? t('pluginsPage.install.installing')
              : preview.installed ? t('pluginsPage.install.reinstall') : t('pluginsPage.install.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, values, empty }: { label: string; values: string[]; empty?: string }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <dt className="m-0 w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 flex flex-wrap gap-1">
        {values.length > 0
          ? values.map((value) => (
            <span key={value} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{value}</span>
          ))
          : <span className="text-muted-foreground/70">{empty}</span>}
      </dd>
    </div>
  );
}
