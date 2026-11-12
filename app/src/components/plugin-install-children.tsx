'use client';

/**
 * The plugins a bundle brings, on the install sheet: one group per entry of
 * `contains`, by id. What each one launches and where it sends the voice (TODO
 * #673), and the secrets and hosts it names (TODO #660). Each child has its own
 * boxes, off until ticked, never shared with another child nor with the bundle.
 * A child the sheet asks nothing for says why, rather than saying nothing.
 */
import type { ReactElement } from 'react';
import { VoiceDestinationLines } from '@/components/dictation/voice-destination-lines';
import { PluginVaultConsent } from '@/components/plugin-vault-consent';
import { ProviderInstallConsent } from '@/components/provider-install-consent';
import { declarationLines, readDictationDecl } from '@/lib/dictation/destination';
import {
  childAsksVault,
  childAuthorizable,
  childVaultTicks,
  signatureSummary,
  type BundleChildPreview,
  type VaultTicks,
} from '@/lib/plugin-install';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import { cn } from '@/lib/utils';

const TONE: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-800 dark:text-amber-300',
  danger: 'text-destructive',
};

export function PluginInstallChildren({ items, allowed, vaultTicks, busy, unsignedLoads, onAllow, onVaultTick }: {
  items: readonly BundleChildPreview[];
  allowed: Readonly<Record<string, boolean>>;
  vaultTicks: Readonly<Record<string, VaultTicks>>;
  busy: boolean;
  /** Developer mode as the daemon applies it now (`signatureSummary`). */
  unsignedLoads?: boolean;
  onAllow: (id: string, allow: boolean) => void;
  onVaultTick: (id: string, ticks: VaultTicks) => void;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="bundle-children-access">
      <p className="m-0 text-[12px] font-medium">{t('pluginsPage.install.childrenAccess.title')}</p>
      {items.map((child) => (
        <Child
          key={child.id}
          child={child}
          allow={allowed[child.id] === true}
          vaultTicks={vaultTicks}
          busy={busy}
          unsignedLoads={unsignedLoads}
          onAllow={onAllow}
          onVaultTick={onVaultTick}
        />
      ))}
    </div>
  );
}

function Child({ child, allow, vaultTicks, busy, unsignedLoads, onAllow, onVaultTick }: {
  child: BundleChildPreview;
  allow: boolean;
  vaultTicks: Readonly<Record<string, VaultTicks>>;
  busy: boolean;
  unsignedLoads?: boolean;
  onAllow: (id: string, allow: boolean) => void;
  onVaultTick: (id: string, ticks: VaultTicks) => void;
}): ReactElement {
  const lands = child.state === 'install';
  const tampered = child.signature?.state === 'tampered';
  const decl = lands ? readDictationDecl(child.dictation) : null;
  const voice = decl ? declarationLines(decl) : [];
  const signature = child.signature ? signatureSummary(child.signature, unsignedLoads) : null;
  const named = childAsksVault(child) && !tampered ? child : null;
  const ticks = named ? childVaultTicks(named, vaultTicks) : null;
  // The daemon's Node is too old for it (TODO #794): it lands, but asks nothing.
  const note = !lands ? child.state : tampered ? 'tampered' : child.engineError ? 'nodeEngine' : null;
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3" data-child={child.id}>
      <p className="m-0 text-[12px] tabular-nums">
        <span className="font-medium">{child.label ?? child.id}</span>
        {child.pkg !== null && <span className="text-muted-foreground">{` · ${child.pkg} · ${child.version ?? ''}`}</span>}
        {signature && <span className={cn('font-medium', TONE[signature.tone])}>{` · ${signature.text}`}</span>}
      </p>
      {lands && (
        <p className="m-0 text-[12px] text-muted-foreground" data-child-permissions>
          {t('pluginsPage.install.childrenAccess.permissions', {
            list: child.permissions.length > 0 ? child.permissions.join(', ') : t('pluginsPage.install.permissionsNone'),
          })}
        </p>
      )}
      {note && (
        <p className="m-0 text-[12px] text-muted-foreground" data-child-note={note}>
          {t(`pluginsPage.install.childrenAccess.state.${note}`, { settingsPath: settingsPath('models', 'backends'), reason: child.engineError ?? '' })}
        </p>
      )}
      <VoiceDestinationLines lines={voice} />
      {lands && child.provider && (
        <ProviderInstallConsent
          provider={child.provider}
          authorizable={childAuthorizable(child)}
          allow={allow}
          busy={busy}
          onAllow={(value) => onAllow(child.id, value)}
        />
      )}
      {named && ticks && (
        <PluginVaultConsent
          vault={named.vault}
          pluginId={named.id}
          ticks={ticks}
          busy={busy}
          onTick={(kind, key, value) => onVaultTick(named.id, { ...ticks, [kind]: { ...ticks[kind], [key]: value } })}
        />
      )}
    </div>
  );
}
