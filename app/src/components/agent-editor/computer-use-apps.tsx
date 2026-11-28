'use client';

/**
 * The applications an agent may control while computer use is on, each in its own mode (foreground:
 * pixels, mouse and keyboard; background: accessibility only). The list is explicit: an empty one lets
 * the agent do nothing, which the card says. "Add from open windows" offers the open applications and
 * reads the accessibility tree of the one picked, to pre-fill its mode.
 */
import React, { useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { fetchComputerWindows, modeForVerdict, probeComputerApp, type AllowedApp, type AppVerdict, type ComputerAppMode } from '@/lib/computer-use';

/** A window to offer: the application and the id of one of its windows, which the probe reads. */
export interface AppOffer { app: string; windowId: string }

/** Distinct applications of the open windows, in the order the system lists them, minus those already allowed. */
export function appsToOffer(windows: readonly { app: string; id?: string }[], allowed: readonly (string | AllowedApp)[]): AppOffer[] {
  const known = new Set(allowed.map((entry) => (typeof entry === 'string' ? entry : entry.app).trim().toLowerCase()));
  const offered: AppOffer[] = [];
  for (const { app, id } of windows) {
    const name = app.trim();
    const key = name.toLowerCase();
    if (!name || known.has(key)) continue;
    known.add(key);
    offered.push({ app: name, windowId: id ?? '' });
  }
  return offered;
}

/** What is known of an application's accessibility: a verdict, or `unchecked` for one added by name. */
type Known = AppVerdict | 'unchecked';

const VERDICT_TEXT: Record<Known, string> = {
  rich: 'editPage.computerAppsVerdictRich',
  poor: 'editPage.computerAppsVerdictPoor',
  empty: 'editPage.computerAppsVerdictEmpty',
  unchecked: 'editPage.computerAppsVerdictUnchecked',
};

const MODES: { value: ComputerAppMode; label: string }[] = [
  { value: 'foreground', label: 'editPage.computerAppsForeground' },
  { value: 'background', label: 'editPage.computerAppsBackground' },
];

export function ComputerUseApps({
  values, onChange, defaultMode = 'foreground', allApps = false, load = fetchComputerWindows, probe = probeComputerApp,
}: {
  values: AllowedApp[];
  onChange: (next: AllowedApp[]) => void;
  /** The mode of an application added by name: the agent's setting. */
  defaultMode?: ComputerAppMode;
  /** "All applications" is on: an empty list no longer means the agent can do nothing. */
  allApps?: boolean;
  /** The open windows; injected by tests. */
  load?: typeof fetchComputerWindows;
  /** The eligibility probe of an open window; injected by tests. */
  probe?: typeof probeComputerApp;
}): React.ReactElement {
  const [text, setText] = useState('');
  const [offer, setOffer] = useState<AppOffer[] | null>(null);
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState(false);
  // What the probe said about the applications added during this session, by lower-case name.
  const [known, setKnown] = useState<Record<string, Known>>({});

  const has = (name: string) => values.some((v) => v.app.toLowerCase() === name.toLowerCase());
  const add = (app: string, mode: ComputerAppMode, verdict: Known) => {
    const name = app.trim();
    if (!name || has(name)) return;
    setKnown((prev) => ({ ...prev, [name.toLowerCase()]: verdict }));
    onChange([...values, { app: name, mode }]);
  };

  const fromWindows = async () => {
    setBusy(true);
    const windows = await load();
    setBusy(false);
    setNone(windows === null || windows.length === 0);
    setOffer(windows ? appsToOffer(windows, values) : []);
  };

  // An application from the open windows is read first: its mode follows what its tree allows.
  const addOpen = async (entry: AppOffer) => {
    setOffer((current) => (current ? current.filter((o) => o.app !== entry.app) : current));
    const verdict = entry.windowId ? await probe(entry.windowId) : null;
    add(entry.app, verdict ? modeForVerdict(verdict) : defaultMode, verdict ?? 'unchecked');
  };

  const setMode = (app: string, mode: ComputerAppMode) => onChange(values.map((v) => (v.app === app ? { ...v, mode } : v)));

  return (
    <div data-computer-use-apps className="mt-2 rounded-lg bg-muted/30 px-3.5 py-3">
      <div className="text-[13px] font-medium">{t('editPage.computerApps')}</div>
      <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t('editPage.computerAppsHint')}</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {values.map(({ app, mode }) => {
          const verdict = known[app.toLowerCase()];
          return (
            <li key={app} data-computer-app data-computer-app-mode={mode} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-background/60 px-2.5 py-1.5">
              <span className="min-w-[8rem] flex-1 text-[12.5px] [overflow-wrap:anywhere]">{app}</span>
              <span role="radiogroup" aria-label={app} className="inline-flex gap-0.5 rounded-md bg-muted p-0.5">
                {MODES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={mode === option.value}
                    data-computer-app-mode-option={option.value}
                    onClick={() => setMode(app, option.value)}
                    className={`rounded px-2 py-0.5 text-[11.5px] ${mode === option.value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </span>
              <button
                type="button"
                onClick={() => onChange(values.filter((v) => v.app !== app))}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('editPage.computerAppsRemove', { app })}
              >
                <X className="size-3" />
              </button>
              {verdict && <span data-computer-app-verdict={verdict} className="basis-full text-[11.5px] text-muted-foreground">{t(VERDICT_TEXT[verdict])}</span>}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 rounded-lg bg-background/60 p-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(text, defaultMode, 'unchecked'); setText(''); }
            else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
          }}
          placeholder={t('editPage.computerAppsAdd')}
          aria-label={t('editPage.computerApps')}
          className="w-full border-0 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      {values.length === 0 && !allApps && (
        <p role="note" data-computer-use-apps-empty className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-900 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t('editPage.computerAppsEmptyWarning')}</span>
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void fromWindows()} data-computer-use-apps-load>
          {t('editPage.computerAppsFromWindows')}
        </Button>
      </div>
      {offer !== null && offer.length > 0 && (
        <div data-computer-use-apps-offer className="mt-2">
          <p className="text-[11.5px] text-muted-foreground">{t('editPage.computerAppsFromWindowsHint')}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {offer.map((entry) => (
              <button
                key={entry.app}
                type="button"
                data-computer-app-offer
                onClick={() => void addOpen(entry)}
                className="rounded-md bg-muted px-2 py-1 text-[12px] hover:bg-accent"
              >
                {entry.app}
              </button>
            ))}
          </div>
        </div>
      )}
      {offer !== null && offer.length === 0 && (
        <p data-computer-use-apps-none className="mt-2 text-[11.5px] text-muted-foreground">
          {t(none ? 'editPage.computerAppsNoWindows' : 'editPage.computerAppsAllListed')}
        </p>
      )}
      <p className="mt-2 text-[11.5px] text-muted-foreground">{t('editPage.computerAppsModesHint')}</p>
    </div>
  );
}
