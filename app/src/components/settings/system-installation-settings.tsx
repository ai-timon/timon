'use client';

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { AlertTriangle, ClipboardCopy, Download, FileText, FolderOpen, Info, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CommandToRun } from '@/components/command-to-run';
import { desktopBridge } from '@/lib/desktop';
import { t } from '@/lib/i18n';
import {
  diagnosticFileName, listenLabel, serviceState, sessionModeView, versionGap, type DiagnosticReport, type ServiceSessionMode, type SystemInfo,
} from '@/lib/system-info';
import { apiErrorMessage } from '@/lib/api-error';

/**
 * Settings › System › Installation (TODO #333): how this Timon runs on the
 * machine — versions, paths, daemon, service, export and import. Superadmin
 * only, on the tab (`settings-layout.ts`) and on the route. Read-only except
 * the two gestures the daemon already owns: the service install of the
 * onboarding, and the export.
 */
export function SystemInstallationSettings(): ReactElement {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/ui/system', { cache: 'no-store' });
    if (response.status === 401 || response.status === 403) { setState('forbidden'); return; }
    if (!response.ok) { setState('error'); return; }
    setInfo(await response.json() as SystemInfo);
    setState('ready');
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let active = true;
    desktopBridge()?.appInfo?.()
      .then((value) => { if (active) setDesktopVersion(value.version); })
      .catch(() => { /* an older desktop: the version stays unknown */ });
    return () => { active = false; };
  }, []);

  if (state === 'loading') return <section className="max-w-3xl" aria-busy="true" />;
  if (state === 'forbidden') return <Note>{t('systemSettings.forbidden')}</Note>;
  if (state === 'error' || !info) return <Note>{t('systemSettings.loadError')}</Note>;

  const inDesktop = desktopBridge() !== null;
  const gap = versionGap(info.version, desktopVersion);
  const listen = listenLabel(info.daemon.listen.address, info.daemon.listen.port);

  return (
    <section className="max-w-3xl space-y-6">
      <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">{t('systemSettings.description')}</p>

      <SupportGroup desktopVersion={desktopVersion} />

      <Group title={t('systemSettings.versionTitle')}>
        <Fact label={t('systemSettings.daemonVersion')}>{info.version}</Fact>
        {inDesktop && (
          <Fact label={t('systemSettings.desktopVersion')}>
            {desktopVersion ?? t('systemSettings.unknown')}
            {gap && (
              <>
                <Warning>{t('systemSettings.versionGap', { daemon: info.version, desktop: desktopVersion ?? '' })}</Warning>
                {info.service.installed && <CommandToRun command={info.service.command} />}
              </>
            )}
            {desktopBridge()?.openAbout && (
              <div className="pt-1">
                <Button size="sm" variant="outline" onClick={() => void desktopBridge()?.openAbout?.().catch(() => { /* refused only outside the Timon window, where this pane never runs */ })}>
                  <Info className="mr-2 size-4" aria-hidden />
                  {t('systemSettings.openAbout')}
                </Button>
              </div>
            )}
          </Fact>
        )}
        <Fact label={t('systemSettings.dataVersion')}>
          {info.dataVersion ?? t('systemSettings.unknown')}
          {/* Only a packaged daemon asks before updating the data; an unmarked one
              is already flagged under Daemon, a source checkout has no gate. */}
          {info.daemon.packaged && info.dataVersionOrder !== null && info.dataVersionOrder !== 0 && (
            <Warning>
              {t(info.dataVersionOrder < 0 ? 'systemSettings.dataBehind' : 'systemSettings.dataAhead', {
                data: info.dataVersion ?? '',
                version: info.version,
              })}
            </Warning>
          )}
        </Fact>
        <Fact label={t('systemSettings.license')}>
          {t('systemSettings.licenseValue', {
            edition: info.license.edition,
            plan: info.license.plan ?? '—',
            status: info.license.status === 'valid' ? t('systemSettings.licenseValid') : t('systemSettings.licenseNone'),
            channel: info.license.channel,
          })}
        </Fact>
        <Fact label={t('systemSettings.os')}>
          {[info.os.name, info.os.release, info.os.arch].filter(Boolean).join(' · ')}
        </Fact>
        <Fact label={t('systemSettings.runtime')}>
          {info.runtime.electron
            ? t('systemSettings.runtimeElectron', { node: info.runtime.node, electron: info.runtime.electron })
            : t('systemSettings.runtimeNode', { node: info.runtime.node })}
        </Fact>
      </Group>

      <Group title={t('systemSettings.daemonTitle')}>
        <Fact label={t('systemSettings.mode')}>
          {t(`systemSettings.modeValue.${info.daemon.mode}`)}
          {info.daemon.packagedRuntime && !info.daemon.packaged && <Warning>{t('systemSettings.unmarked')}</Warning>}
        </Fact>
        <Fact label={t('systemSettings.packaged')}>
          {t(info.daemon.packaged ? 'systemSettings.yes' : 'systemSettings.no')}
        </Fact>
        <Fact label={t('systemSettings.listen')}>
          {listen.address}
          {listen.everywhere && <Hint>{t('systemSettings.listenEverywhere')}</Hint>}
        </Fact>
        <Fact label={t('systemSettings.webApp')}>
          {info.daemon.app.servedByDaemon
            ? `${info.daemon.app.host}:${info.daemon.app.port}`
            : t('systemSettings.webAppExternal')}
        </Fact>
        <Fact label={t('systemSettings.pid')}>
          <span className="tabular-nums">{info.daemon.pid}</span>
        </Fact>
      </Group>

      <ServiceGroup info={info} onChanged={load} />

      <Group title={t('systemSettings.pathsTitle')}>
        <Fact label={t('systemSettings.installDir')}><Path value={info.paths.installDir} /></Fact>
        <Fact label={t('systemSettings.home')}><Path value={info.paths.home} /></Fact>
        <Fact label={t('systemSettings.configFile')}><Path value={info.paths.configFile} /></Fact>
        {info.paths.logs && (
          <Fact label={t('systemSettings.logsFolder')}>
            <Path value={info.paths.logs} />
            <Hint>{t('systemSettings.logsFolderHint')}</Hint>
          </Fact>
        )}
        <Fact label={t('systemSettings.log')}>
          {info.paths.log.kind === 'file' && <Path value={info.paths.log.path} />}
          {info.paths.log.kind === 'journal' && (
            <CommandToRun command={info.paths.log.command} label={t('systemSettings.logJournal')} />
          )}
          {info.paths.log.kind === 'console' && (
            <span>{t(info.daemon.mode === 'embedded' ? 'systemSettings.logEmbedded' : 'systemSettings.logConsole')}</span>
          )}
        </Fact>
      </Group>

      <DataGroup info={info} />
    </section>
  );
}

function ServiceGroup({ info, onChanged }: { info: SystemInfo; onChanged: () => Promise<void> }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean; command: string | null } | null>(null);
  const { service } = info;
  const current = serviceState(service);

  async function install(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/ui/system/service', { method: 'POST' });
      const answer = await response.json().catch(() => ({})) as {
        ok?: boolean; installed?: boolean; running?: boolean; reason?: string | null; error?: string; command?: string | null;
      };
      if (!response.ok) {
        setMessage({ text: answer.reason ?? apiErrorMessage(answer, t('systemSettings.serviceFailed')), ok: false, command: answer.command ?? null });
      } else if (answer.installed) {
        setMessage({ text: t(answer.running ? 'systemSettings.serviceInstalledRunning' : 'systemSettings.serviceInstalledNext'), ok: true, command: null });
      } else {
        setMessage({ text: answer.reason ?? t('systemSettings.serviceFailed'), ok: false, command: answer.command ?? null });
      }
      await onChanged();
    } catch (error) {
      setMessage({ text: (error as Error).message, ok: false, command: null });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group title={t('systemSettings.serviceTitle')}>
      <Fact label={t('systemSettings.serviceStatus')}>
        {t(`systemSettings.serviceState.${current}`)}
        {current === 'stopped' && info.daemon.mode === 'embedded' && <Hint>{t('systemSettings.serviceNextLaunch')}</Hint>}
        {service.reason && <Hint>{service.reason}</Hint>}
      </Fact>
      {service.name && service.supervisor && (
        <Fact label={t(`systemSettings.supervisor.${service.supervisor}`)}>{service.name}</Fact>
      )}
      {service.windows && (
        <Fact label={t('systemSettings.windowsRevision')}>
          <span className="tabular-nums">
            {t('systemSettings.windowsRevisionValue', {
              revision: service.windows.revision ?? '—',
              expected: service.windows.expected,
            })}
          </span>
          {service.windows.launcherMarked === false && <Hint>{t('systemSettings.windowsUnmarked')}</Hint>}
        </Fact>
      )}
      {service.installed && <SessionModeFact service={service} onChanged={onChanged} />}
      {service.action && (
        <div className="pt-2">
          <p className="mb-2 max-w-[65ch] text-[13px] leading-snug text-muted-foreground">
            {t(service.action === 'install' ? 'systemSettings.installWhy' : 'systemSettings.repairWhy')}
          </p>
          {service.actionHere ? (
            <Button size="sm" disabled={busy} onClick={() => void install()}>
              <Wrench className="mr-2 size-4" aria-hidden />
              {t(busy
                ? 'systemSettings.serviceBusy'
                : service.action === 'install' ? 'systemSettings.installService' : 'systemSettings.repairService')}
            </Button>
          ) : (
            <CommandToRun command={service.command} label={t('systemSettings.serviceFromTerminal')} />
          )}
        </div>
      )}
      {message && (
        <div role={message.ok ? 'status' : 'alert'} className="pt-2">
          <p className={message.ok ? 'text-[13px]' : 'text-[13px] text-destructive'}>{message.text}</p>
          {message.command && <CommandToRun command={message.command} />}
        </div>
      )}
    </Group>
  );
}

/**
 * Does the service keep running once the user logs out? The onboarding asked
 * (`steps/background.tsx`); this row shows what the machine does and offers
 * the one gesture that flips it. On Linux, stopping at logout turns lingering
 * off for the whole account: the row says so before the click and after it.
 */
function SessionModeFact({ service, onChanged }: { service: SystemInfo['service']; onChanged: () => Promise<void> }): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean; command: string | null } | null>(null);
  const view = sessionModeView(service);
  if (view.kind === 'hidden') return null;
  // Linux "stop at logout" is `loginctl disable-linger`, which is account-wide.
  const lingerGoesOff = service.supervisor === 'systemd-user' && view.next === 'session';

  async function change(mode: ServiceSessionMode): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/ui/system/service/session-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const answer = await response.json().catch(() => ({})) as { ok?: boolean; reason?: string | null; error?: string; command?: string | null };
      if (response.ok && answer.ok) {
        setMessage(answer.command
          ? { text: t('systemSettings.sessionModeTerminal'), ok: true, command: answer.command }
          : { text: t(lingerGoesOff && mode === 'session' ? 'systemSettings.sessionModeSavedLinger' : 'systemSettings.sessionModeSaved'), ok: true, command: null });
      } else {
        setMessage({ text: answer.reason ?? apiErrorMessage(answer, t('systemSettings.sessionModeFailed')), ok: false, command: null });
      }
      await onChanged();
    } catch (error) {
      setMessage({ text: (error as Error).message, ok: false, command: null });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Fact label={t('systemSettings.loggedOut')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          {t(view.keeps ? 'systemSettings.loggedOutKeeps' : 'systemSettings.loggedOutStops')}
          {view.pending && <Hint>{t('systemSettings.loggedOutPending')}</Hint>}
          {lingerGoesOff && !message && <Warning>{t('systemSettings.stopAtLogoutLinger')}</Warning>}
        </span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(view.next)}>
          {t(view.next === 'always' ? 'systemSettings.keepRunning' : 'systemSettings.stopAtLogout')}
        </Button>
      </div>
      {message && (
        <div role={message.ok ? 'status' : 'alert'} className="pt-1">
          <p className={message.ok ? 'text-[12px]' : 'text-[12px] text-destructive'}>{message.text}</p>
          {message.command && <CommandToRun command={message.command} />}
        </div>
      )}
    </Fact>
  );
}

/**
 * The support report (TODO #343): the same text as the desktop's error boxes
 * and `timon doctor --report`, fetched on demand — it runs the doctor, which
 * can take seconds. Logs in it are newest first; the files stay chronological.
 */
function SupportGroup({ desktopVersion }: { desktopVersion: string | null }): ReactElement {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const bridge = desktopBridge();

  async function load(): Promise<DiagnosticReport | null> {
    if (report) return report;
    setBusy(true);
    try {
      const query = desktopVersion ? `?app=${encodeURIComponent(desktopVersion)}` : '';
      const response = await fetch(`/api/ui/system/diagnostic${query}`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({})) as Partial<DiagnosticReport> & { error?: string };
      if (!response.ok || typeof body.text !== 'string') {
        setMessage({ text: apiErrorMessage(body, t('systemSettings.reportFailed')), ok: false });
        return null;
      }
      const loaded = { text: body.text, findings: body.findings ?? [] };
      setReport(loaded);
      return loaded;
    } catch (error) {
      setMessage({ text: (error as Error).message, ok: false });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    setMessage(null);
    const loaded = await load();
    if (!loaded) return;
    try {
      await navigator.clipboard.writeText(loaded.text);
      setMessage({ text: t('systemSettings.reportCopied'), ok: true });
    } catch {
      setShown(true);
      setMessage({ text: t('systemSettings.reportCopyFailed'), ok: false });
    }
  }

  async function save(): Promise<void> {
    setMessage(null);
    const loaded = await load();
    if (!loaded) return;
    const url = URL.createObjectURL(new Blob([loaded.text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = diagnosticFileName(new Date());
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setMessage({ text: t('systemSettings.reportSaved', { name: link.download }), ok: true });
  }

  async function show(): Promise<void> {
    if (shown) { setShown(false); return; }
    setMessage(null);
    if (await load()) setShown(true);
  }

  async function openLogs(): Promise<void> {
    setMessage(null);
    const failure = await bridge?.openLogsFolder?.().catch((error: Error) => error.message);
    if (failure) setMessage({ text: failure, ok: false });
  }

  return (
    <Group title={t('systemSettings.supportTitle')}>
      <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">{t('systemSettings.supportWhy')}</p>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" disabled={busy} onClick={() => void copy()}>
          <ClipboardCopy className="mr-2 size-4" aria-hidden />
          {t(busy ? 'systemSettings.reportPreparing' : 'systemSettings.copyReport')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void save()}>
          <Download className="mr-2 size-4" aria-hidden />
          {t('systemSettings.saveReport')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void show()}>
          <FileText className="mr-2 size-4" aria-hidden />
          {t(shown ? 'systemSettings.hideReport' : 'systemSettings.showReport')}
        </Button>
        {bridge?.openLogsFolder && (
          <Button size="sm" variant="outline" onClick={() => void openLogs()}>
            <FolderOpen className="mr-2 size-4" aria-hidden />
            {t('systemSettings.openLogs')}
          </Button>
        )}
      </div>
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-[13px]' : 'text-[13px] text-destructive'}>{message.text}</p>
      )}
      {report && (
        <div className="space-y-1 pt-1">
          <p className="text-[13px] font-medium">{t('systemSettings.findingsTitle')}</p>
          {report.findings.length
            ? report.findings.map((finding) => <Warning key={finding.id}>{finding.text}</Warning>)
            : <Hint>{t('systemSettings.findingsNone')}</Hint>}
        </div>
      )}
      {shown && report && (
        // code-font: raw report and log output, copied as is into a support request
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/70 p-3 font-mono text-[12px] leading-snug">
          {report.text}
        </pre>
      )}
    </Group>
  );
}

function DataGroup({ info }: { info: SystemInfo }): ReactElement {
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ text: string; ok: boolean } | null>(null);

  async function exportData(): Promise<void> {
    setExporting(true);
    setExported(null);
    try {
      const response = await fetch('/api/ui/export', { method: 'POST' });
      const result = await response.json().catch(() => ({})) as { ok?: boolean; out?: string; error?: string };
      setExported(response.ok && result.ok && result.out
        ? { text: t('systemSettings.exported', { path: result.out }), ok: true }
        : { text: apiErrorMessage(result, t('systemSettings.exportFailed')), ok: false });
    } catch (error) {
      setExported({ text: (error as Error).message, ok: false });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Group title={t('systemSettings.dataTitle')}>
      <div className="space-y-2">
        <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">{t('systemSettings.exportWhy')}</p>
        <Button size="sm" variant="outline" disabled={exporting} onClick={() => void exportData()}>
          <Download className="mr-2 size-4" aria-hidden />
          {t(exporting ? 'systemSettings.exporting' : 'systemSettings.export')}
        </Button>
        {exported && (
          <p role={exported.ok ? 'status' : 'alert'} className={exported.ok ? 'break-all text-[13px]' : 'text-[13px] text-destructive'}>
            {exported.text}
          </p>
        )}
      </div>
      <div className="space-y-1 pt-4">
        <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">
          {t(info.service.installed ? 'systemSettings.importWhy' : 'systemSettings.importWhyEmbedded')}
        </p>
        <ol className="space-y-1">
          {info.importCommands.map((command) => (
            <li key={command}><CommandToRun command={command} label={t('systemSettings.importStep')} /></li>
          ))}
        </ol>
      </div>
    </Group>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="rounded-xl bg-muted/40 px-4 py-3">
      <h3 className="mb-2 text-[14px] font-semibold tracking-[-0.01em]">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <dl className="grid gap-1 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-[13px]">{children}</dd>
    </dl>
  );
}

function Path({ value }: { value: string }): ReactElement {
  return <span className="break-all">{value}</span>;
}

function Hint({ children }: { children: ReactNode }): ReactElement {
  return <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">{children}</span>;
}

function Warning({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="mt-1 flex items-start gap-1.5 text-[12px] leading-snug text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </span>
  );
}

function Note({ children }: { children: ReactNode }): ReactElement {
  return <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">{children}</p>;
}
