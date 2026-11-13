'use client';

/**
 * One card of the plugin gallery (plan §10.12).
 *
 * Written against a PLAIN props object, never against `PluginPublic`. The
 * local gallery reads the loader, and the community marketplace (P4,
 * `GET /plugins/index.json`) will read a remote index whose entries have no
 * `state`, no `reason` and a remote cover URL. Making the DTO the contract
 * would leave the marketplace unable to reuse this card, and someone would
 * write a second one — exactly what the plan forbids. The mapping
 * `PluginPublic → PluginCardData` lives at the page, and P4 will write its own.
 *
 * The card is a summary. Clicking it opens the detail sheet (author, long
 * copy, slots, settings). The switch stays on the card so a scan-and-toggle
 * does not have to open anything.
 */
import { useState } from 'react';
import { Blocks } from 'lucide-react';
import { PluginDetailDialog } from '@/components/plugin-detail-dialog';
import { PluginKindBadge } from '@/components/plugin-kind-badge';
import { VoiceDestinationLines } from '@/components/dictation/voice-destination-lines';
import { Picto } from '@/components/picto';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type PluginCardData = {
  id: string;
  pkg: string;
  /** Displayed title. Falls back to the id when the manifest has no label. */
  label: string;
  description: string | null;
  author: string | null;
  /**
   * Third-party admission: `true` = signature we approved, `false` = not
   * approved. `null` for our own plugins, which carry no badge — the scope of
   * their id already says who wrote them.
   */
  signed: boolean | null;
  /**
   * Shipped with the product: the card says so instead of a signature
   * verdict — its trust is the release, and it can only be turned off.
   */
  builtin?: boolean;
  /** Resolved image URL, or `null` when the package ships none. */
  coverUrl: string | null;
  /**
   * Monochrome picto (`timon.icon`), drawn when there is no cover. Optional:
   * a marketplace index written before pictos has none.
   */
  iconUrl?: string | null;
  /** Extra stills for the detail sheet. Empty until a package ships them. */
  screenshots: string[];
  version: string | null;
  /** `widget`, `page`, `bundle`… — always a list, possibly empty. */
  kinds: string[];
  /** Where it plugs in: slot names, plus its route when it is a page. */
  slots: string[];
  route: string | null;
  declares: Record<string, 'single' | 'list' | 'keyed'>;
  /** What it changes without occupying it (a theme…). */
  modifies: string[];
  /** Ids a bundle installs with it. */
  contains: string[];
  settings: { key: string; type: string; label: string }[];
  /**
   * A dictation plugin: where its engines send the voice, one translated
   * line each. Empty or absent for any other plugin.
   */
  voice?: string[];
  source: 'bundled' | 'third-party';
  tier: 'core' | 'std' | 'dev' | 'opt' | null;
  /** Plugged in right now. `null` when the source doesn't know (marketplace). */
  enabled: boolean | null;
  /**
   * Why the toggle is out of reach — `skipped:unsigned`, `failed`… Rendered as
   * is, and disables the switch: a plugin the daemon refuses would flip back on
   * the next reconcile, which reads as a bug rather than as a refusal.
   */
  blockedReason: string | null;
  /**
   * Switch taken away by what the plugin IS, not by a failure: a `core` module.
   * Distinct from `blockedReason`, which is an incident and shouts in amber —
   * "the kernel is always on" is not an alert.
   */
  locked?: boolean;
  /**
   * A quiet line under the card: why the daemon is not running it, in its own
   * words. Never blocks the switch — the wish stays the user's to write.
   */
  note?: string | null;
  /**
   * On a remote machine: it runs there, but its browser half stays off here
   * until the same version and signature — for a built-in, the same version
   * with the same browser-half code — run here too
   * (`lib/plugin-host/remote-plugins.ts`).
   */
  awaitingApproval?: boolean;
};

export type PluginCardProps = {
  plugin: PluginCardData;
  /** Local catalogue, used by a bundle sheet to draw its `contains`. */
  catalog?: PluginCardData[];
  /** Absent → the card is read-only (marketplace listing, print). */
  onToggle?: (id: string, enabled: boolean) => void;
  busyId?: string | null;
};

export function PluginCard({ plugin, catalog, onToggle, busyId }: PluginCardProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const blocked = plugin.blockedReason !== null;
  const locked = plugin.locked === true;
  const busy = busyId === plugin.id;

  return (
    <>
      <article className="relative flex flex-col overflow-hidden rounded-lg border border-transparent bg-card transition-colors hover:border-border">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('pluginsPage.openDetails', { name: plugin.label })}
          className="flex flex-1 cursor-pointer flex-col text-left"
        >
          {/* `w-full`: Chromium 130 (Electron 33, the packaged app) does not stretch
              the children of a flex `<button>`, so the box shrank to the icon and
              sat at the left edge on every installed client. */}
          <div className="flex h-20 w-full items-center justify-center">
            {plugin.coverUrl
              // Plain <img>: the source is a plugin-supplied file served by the
              // daemon, which next/image would try to optimise through its own
              // loader — an indirection for nothing on a local asset.
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={plugin.coverUrl} alt="" className="h-full w-full object-cover" />
              : plugin.iconUrl
                ? <Picto icon={plugin.iconUrl} className="size-10 text-foreground/70" />
                : <Blocks className="h-8 w-8 text-muted-foreground/50" aria-hidden />}
          </div>
          <div className="flex w-full flex-1 flex-col gap-2 p-3.5 pr-14">
            <div className="min-w-0">
              <h3 className="m-0 truncate text-sm font-semibold">{plugin.label}</h3>
              <p className="m-0 truncate text-[11px] text-muted-foreground">
                {plugin.id}{plugin.version ? ` · ${plugin.version}` : ''}
              </p>
            </div>
            {plugin.description && (
              <p className="m-0 line-clamp-2 text-xs text-muted-foreground">{plugin.description}</p>
            )}
            {/* The note sits above the tags, so every card ends on its tag row
                and the rows line up across the grid. */}
            {plugin.note && (
              <p className="m-0 text-[11px] text-muted-foreground">{plugin.note}</p>
            )}
            <div className="mt-auto flex flex-wrap gap-1.5">
              {plugin.kinds.map((kind) => <PluginKindBadge key={kind} kind={kind} />)}
              {plugin.builtin ? (
                <span
                  className="rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                  title={t('pluginsPage.builtinHint')}
                >
                  {t('pluginsPage.builtin')}
                </span>
              ) : plugin.signed !== null && (
                <span
                  className={cn(
                    'rounded-md px-2 py-0.5 text-[11px] font-medium',
                    plugin.signed
                      ? 'bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-400'
                      : 'bg-foreground/[0.06] text-muted-foreground',
                  )}
                >
                  {t(plugin.signed ? 'pluginsPage.verified' : 'pluginsPage.unverified')}
                </span>
              )}
              {plugin.awaitingApproval && (
                <span
                  className="rounded-md bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-400"
                  title={t(plugin.builtin ? 'pluginsPage.awaitingApprovalBuiltinHint' : 'pluginsPage.awaitingApprovalHint')}
                >
                  {t('pluginsPage.awaitingApproval')}
                </span>
              )}
            </div>
            <VoiceDestinationLines lines={plugin.voice ?? []} compact />
            {blocked && (
              <p className="m-0 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                {plugin.blockedReason}
              </p>
            )}
          </div>
        </button>
        {onToggle && plugin.enabled !== null && (
          <div className="absolute right-3.5 top-[calc(5rem+14px)]">
            <Switch
              checked={plugin.enabled}
              disabled={blocked || locked || busy}
              onCheckedChange={(next) => onToggle(plugin.id, next)}
              aria-label={t(plugin.enabled ? 'pluginsPage.disable' : 'pluginsPage.enable', { name: plugin.label })}
            />
          </div>
        )}
      </article>
      <PluginDetailDialog
        plugin={plugin}
        catalog={catalog}
        open={open}
        onOpenChange={setOpen}
        onToggle={onToggle}
        busyId={busyId}
      />
    </>
  );
}
