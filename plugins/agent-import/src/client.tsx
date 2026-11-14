/**
 * Agent import — browser half: the import assistant (source → preview →
 * result), shown in the plugin's own settings category, and opened in a
 * dialog from the Agents and Bots pages and from onboarding.
 *
 * Every place that shows the assistant opens the `agentimport.source` socket
 * inside its provider, so a source adapter reads `useAgentImport()` wherever
 * it is painted. The staging token lives in the provider only: no state, no
 * hook value and no prop carries it.
 */
import React from 'react';
import type { ComponentType, ReactNode } from 'react';
import * as ui from '@timon/ui';
import type { ClientContext } from '@timon-ai/sdk';
import {
  agentImportContext, SOURCE_SLOT, type AgentImportSource, type AgentImportState, type AgentImportValue,
} from './hooks.js';
import {
  IMPORT_ELEMENTS, type AgentChoice, type ApplyResponse, type HermesDetectResponse, type ImportElement,
  type ImportResultStatus, type PreviewAgent, type PreviewResponse, type StageResponse,
} from './contract.js';
import {
  IMPORT_ROLES, applySummary, failureOf, fileFailure, importOptions, mergeChoices, requestBody, shownChoice,
  type ImportFailure,
} from './assistant-state.js';
import { ExportAgentMenuItem, ExportEntry } from './export-dialog.js';
import messages from './messages.json';
import { OpenBotSource } from './sources/openbot-client.js';
import { HermesSource } from './sources/hermes-client.js';

const t = ui.createTranslator(messages);

// The SDK leaves React out of its types; narrowed at this boundary.
type Children = { children?: ReactNode };
const Slot = ui.Slot as ComponentType<{ name: string }>;
const Button = ui.Button as ComponentType<Children & {
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary' | 'link';
  size?: 'sm' | 'default';
  className?: string;
}>;
const TooltipProvider = ui.TooltipProvider as ComponentType<Children & { delayDuration?: number }>;
const Tooltip = ui.Tooltip as ComponentType<Children>;
const TooltipTrigger = ui.TooltipTrigger as ComponentType<Children & { asChild?: boolean }>;
const TooltipContent = ui.TooltipContent as ComponentType<Children & { side?: 'top' | 'bottom' | 'left' | 'right'; sideOffset?: number; className?: string }>;
const Input = ui.Input as ComponentType<{
  id?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
  'aria-invalid'?: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}>;
const Label = ui.Label as ComponentType<Children & { htmlFor?: string; className?: string }>;
const Switch = ui.Switch as ComponentType<{
  id?: string;
  checked: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  onCheckedChange: (checked: boolean) => void;
}>;
const Select = ui.Select as ComponentType<Children & { value: string; disabled?: boolean; onValueChange: (value: string) => void }>;
const SelectTrigger = ui.SelectTrigger as ComponentType<Children & { id?: string; className?: string; 'aria-label'?: string }>;
const SelectValue = ui.SelectValue as ComponentType<Record<string, never>>;
const SelectContent = ui.SelectContent as ComponentType<Children>;
const SelectItem = ui.SelectItem as ComponentType<Children & { value: string }>;
const Dialog = ui.Dialog as ComponentType<Children & { open: boolean; onOpenChange: (open: boolean) => void }>;
const DialogContent = ui.DialogContent as ComponentType<Children & { className?: string; style?: React.CSSProperties }>;
const DialogHeader = ui.DialogHeader as ComponentType<Children>;
const DialogTitle = ui.DialogTitle as ComponentType<Children>;
const DialogDescription = ui.DialogDescription as ComponentType<Children>;

type Api = ClientContext['api'];

/** The source the assistant offers itself: the engine's own format, an export from another Timon. */
const TIMON_SOURCE: AgentImportSource = {
  id: 'timon',
  label: t('timonSource.label'),
  description: t('timonSource.description'),
  accepts: ['zip'],
};

const INITIAL: AgentImportState = {
  step: 'source', staged: null, warnings: [], sourceId: null, preview: null, ready: false,
  choices: {}, result: null, busy: false, error: null,
};

function say(failure: ImportFailure): string {
  return 'text' in failure ? failure.text : t(failure.key, failure.vars);
}

class CallFailure extends Error {
  constructor(readonly failure: ImportFailure) {
    super('agent import call failed');
    this.name = 'CallFailure';
  }
}

const networkFailure: ImportFailure = { key: 'errors.network' };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

/**
 * The one place a zip leaves the browser for `stage`. The app relays the
 * body as bytes, streamed and bounded to 50 MiB (TODO #804, `PluginApiBinaryBody`).
 * The type is forced to `application/zip`: Windows names a zip
 * `application/x-zip-compressed`, and a picked file may carry no type at all.
 */
async function sendArchive(api: Api, file: Blob): Promise<StageResponse> {
  let response: Response;
  try {
    // The type the browser guesses is not trusted: the daemon reads the bytes.
    response = await api('stage', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file });
  } catch {
    throw new CallFailure(networkFailure);
  }
  const json = await readJson(response);
  if (!response.ok) throw new CallFailure(failureOf('stage', response.status, json));
  return json as StageResponse;
}

/** `GET hermes`: `null` when the daemon cannot say, which hides the Hermes card rather than failing. */
async function detectHermes(api: Api): Promise<HermesDetectResponse | null> {
  try {
    const response = await api('hermes', { method: 'GET' });
    return response.ok ? await readJson(response) as HermesDetectResponse | null : null;
  } catch {
    return null;
  }
}

/** `POST hermes/stage`: the daemon reads the profiles from its own disk and stages them like an archive. */
async function stageHermes(api: Api, profiles: string[]): Promise<StageResponse> {
  let response: Response;
  try {
    response = await api('hermes/stage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profiles }),
    });
  } catch {
    throw new CallFailure(networkFailure);
  }
  const json = await readJson(response);
  if (!response.ok) throw new CallFailure(failureOf('hermes/stage', response.status, json));
  return json as StageResponse;
}

/** The assistant's own controls, next to the public hook value; not shared with adapters. */
type Controls = {
  setChoice(sourceRef: string, patch: Partial<AgentChoice>): void;
  refresh(): Promise<void>;
  apply(): Promise<void>;
  reset(): void;
  /** The user changed a choice since the last preview. */
  dirty: boolean;
};

const ControlsContext = React.createContext<Controls | null>(null);

function AgentImportProvider({ api, children }: { api: Api; children: ReactNode }) {
  const [state, setState] = React.useState<AgentImportState>(INITIAL);
  const [sources, setSources] = React.useState<readonly AgentImportSource[]>([TIMON_SOURCE]);
  const [dirty, setDirty] = React.useState(false);
  const token = React.useRef<string | null>(null);
  const latest = React.useRef(state);
  latest.current = state;

  const post = React.useCallback(async (path: 'preview' | 'apply' | 'discard', body: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new CallFailure(networkFailure);
    }
    const json = await readJson(response);
    if (!response.ok) throw new CallFailure(failureOf(path, response.status, json));
    return json;
  }, [api]);

  /** Drops the staged archive on the daemon; a failure only leaves it to expire. */
  const discard = React.useCallback(() => {
    const held = token.current;
    token.current = null;
    if (held) post('discard', { token: held }).catch(() => undefined);
  }, [post]);

  React.useEffect(() => discard, [discard]);

  const fail = React.useCallback((err: unknown) => {
    const failure = err instanceof CallFailure ? err.failure : networkFailure;
    setState((current) => ({ ...current, busy: false, error: say(failure) }));
  }, []);

  const addWarning = React.useCallback((text: string) => {
    setState((current) => ({ ...current, warnings: [...current.warnings, text] }));
  }, []);

  const registerSource = React.useCallback((source: AgentImportSource) => {
    setSources((current) => [...current.filter((s) => s.id !== source.id), source]);
    return () => setSources((current) => current.filter((s) => s !== source));
  }, []);

  const submitStaged = React.useCallback(async (sourceId: string, stage: () => Promise<StageResponse>) => {
    discard();
    setDirty(false);
    setState({ ...INITIAL, sourceId, busy: true });
    try {
      const staged = await stage();
      token.current = staged.token;
      const archive = { sha256: staged.sha256, size: staged.size, expiresAt: staged.expiresAt };
      setState((current) => ({ ...current, staged: archive }));
      const answer = await post('preview', { token: staged.token }) as PreviewResponse;
      setState((current) => ({
        ...current,
        step: 'preview',
        busy: false,
        staged: answer.archive,
        preview: answer.preview,
        ready: answer.ready,
        choices: mergeChoices({}, answer.preview),
      }));
    } catch (err) {
      discard();
      fail(err);
    }
  }, [discard, fail, post]);

  const submitFile = React.useCallback(async (sourceId: string, file: Blob) => {
    const refused = fileFailure(file);
    if (refused) {
      setState((current) => ({ ...current, error: say(refused) }));
      return;
    }
    await submitStaged(sourceId, () => sendArchive(api, file));
  }, [api, submitStaged]);

  const setChoice = React.useCallback((sourceRef: string, patch: Partial<AgentChoice>) => {
    setDirty(true);
    setState((current) => {
      const before = current.choices[sourceRef] ?? { sourceRef };
      return { ...current, choices: { ...current.choices, [sourceRef]: { ...before, ...patch, sourceRef } } };
    });
  }, []);

  const refresh = React.useCallback(async () => {
    const held = token.current;
    const now = latest.current;
    if (!held || !now.preview) return;
    setState((current) => ({ ...current, busy: true, error: null }));
    try {
      const body = requestBody(held, now.ready, importOptions(now.sourceId, now.preview, now.choices));
      const answer = await post('preview', body) as PreviewResponse;
      setDirty(false);
      setState((current) => ({
        ...current,
        busy: false,
        staged: answer.archive,
        preview: answer.preview,
        ready: answer.ready,
        choices: mergeChoices(current.choices, answer.preview),
      }));
    } catch (err) {
      fail(err);
    }
  }, [fail, post]);

  const apply = React.useCallback(async () => {
    const held = token.current;
    const now = latest.current;
    if (!held || !now.preview || !now.ready) return;
    const { included, updated } = applySummary(now.preview, now.choices);
    if (included === 0) return;
    const description = updated > 0
      ? `${t('confirm.body')} ${t('confirm.bodyUpdate', { updated })}`
      : t('confirm.body');
    const yes = await ui.confirmAction({
      title: t('confirm.title', { count: included }),
      description,
      confirmLabel: t('confirm.yes'),
    });
    if (!yes) return;
    setState((current) => ({ ...current, busy: true, error: null }));
    // `apply` spends the token whatever comes back: never sent twice.
    token.current = null;
    try {
      const result = await post('apply', requestBody(held, now.ready, importOptions(now.sourceId, now.preview, now.choices))) as ApplyResponse;
      setState((current) => ({ ...current, step: 'result', busy: false, staged: null, result }));
    } catch (err) {
      setState((current) => ({ ...INITIAL, sourceId: current.sourceId }));
      fail(err);
    }
  }, [fail, post]);

  const reset = React.useCallback(() => {
    discard();
    setDirty(false);
    setState(INITIAL);
  }, [discard]);

  const value = React.useMemo<AgentImportValue>(
    () => ({ ...state, sources, addWarning, registerSource, submitFile, submitStaged }),
    [state, sources, addWarning, registerSource, submitFile, submitStaged],
  );
  const controls = React.useMemo<Controls>(
    () => ({ setChoice, refresh, apply, reset, dirty }),
    [setChoice, refresh, apply, reset, dirty],
  );
  const Context = agentImportContext();
  return (
    <Context.Provider value={value}>
      <ControlsContext.Provider value={controls}>{children}</ControlsContext.Provider>
    </Context.Provider>
  );
}

function useImport(): { value: AgentImportValue; controls: Controls } {
  const value = React.useContext(agentImportContext());
  const controls = React.useContext(ControlsContext);
  if (!value || !controls) throw new Error('The import assistant is rendered outside of its provider.');
  return { value, controls };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(ui.getLocale(), { hour: '2-digit', minute: '2-digit' });
}

function Notice({ tone = 'muted', children }: { tone?: 'muted' | 'warning' | 'error'; children: ReactNode }) {
  const toneClass = tone === 'error'
    ? 'bg-destructive/10 text-destructive'
    : tone === 'warning' ? 'bg-amber-500/10 text-foreground' : 'bg-muted/40 text-muted-foreground';
  return (
    <div role={tone === 'error' ? 'alert' : undefined} className={ui.cn('rounded-md p-3 text-sm', toneClass)}>
      {children}
    </div>
  );
}

function WarningList({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
      {items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}
    </ul>
  );
}

function SourceCard({ source }: { source: AgentImportSource }) {
  const { value } = useImport();
  const picker = React.useRef<HTMLInputElement | null>(null);
  const takesZip = source.accepts.includes('zip');
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/40 p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{source.label}</span>
        {source.description && <span className="text-xs text-muted-foreground">{source.description}</span>}
      </div>
      {/* The card's own action sits above the file button: it is the step that comes first. */}
      <div className="flex flex-col items-stretch gap-2">
      {source.action && (
        <Button size="sm" variant="outline" disabled={value.busy} onClick={() => void source.action?.run()}>
          {source.action.label}
        </Button>
      )}
      {takesZip && (
        <>
          <input
            ref={picker}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void value.submitFile(source.id, file);
            }}
          />
          <Button size="sm" variant="outline" disabled={value.busy} onClick={() => picker.current?.click()}>
            {t('pickZip')}
          </Button>
        </>
      )}
      </div>
    </li>
  );
}

function SourceStep() {
  const { value } = useImport();
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{t('sources')}</h3>
      {value.sources.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {value.sources.map((source) => <SourceCard key={source.id} source={source} />)}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noSource')}</p>
      )}
      {/* An adapter may paint more than its card here: a detected folder, a hint. */}
      <Slot name={SOURCE_SLOT} />
      {value.busy && <p role="status" className="text-sm text-muted-foreground">{value.staged ? t('previewing') : t('staging')}</p>}
    </div>
  );
}

const ACTION_CLASS: Record<PreviewAgent['action'], string> = {
  create: 'bg-primary/15 text-foreground',
  update: 'bg-amber-500/15 text-foreground',
  skip: 'bg-muted text-muted-foreground',
};

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return <span className={ui.cn('shrink-0 rounded-full px-2 py-0.5 text-xs', className)}>{children}</span>;
}

function ElementToggle({ element, count, on, disabled, onToggle }: {
  element: ImportElement;
  count: number;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const label = t(`element.${element}`);
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onToggle}
      className={ui.cn(
        'rounded-full px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
        on ? 'bg-primary/15 text-foreground hover:bg-primary/25' : 'bg-muted/60 text-muted-foreground line-through hover:bg-muted',
      )}
    >
      {count > 0 ? t('elementCount', { label, count }) : label}
    </button>
  );
}

function AgentCard({ agent }: { agent: PreviewAgent }) {
  const { value, controls } = useImport();
  const choice = value.choices[agent.sourceRef];
  const shown = shownChoice(agent, choice);
  const id = React.useId();
  const included = shown.include;
  const locked = value.busy || !included;
  const elements = IMPORT_ELEMENTS.filter((element) => agent.elements?.[element] !== undefined);
  return (
    <li className={ui.cn('flex flex-col gap-3 rounded-lg bg-muted/40 p-3', !included && 'opacity-70')}>
      <div className="flex items-center gap-3">
        <Switch
          checked={included}
          disabled={value.busy || shown.lockedOut}
          aria-label={t('agent.include')}
          onCheckedChange={(checked) => controls.setChoice(agent.sourceRef, { include: checked })}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{shown.name || agent.displayName}</span>
          <span className="truncate text-xs text-muted-foreground">{t('agent.from', { name: agent.displayName })}</span>
        </div>
        <Chip className={ACTION_CLASS[agent.action]}>{t(`action.${agent.action}`)}</Chip>
      </div>

      {included && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`} className="text-xs">{t('agent.name')}</Label>
            <Input
              id={`${id}-name`}
              value={shown.name}
              maxLength={100}
              disabled={locked}
              onChange={(event) => controls.setChoice(agent.sourceRef, { name: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-role`} className="text-xs">{t('agent.role')}</Label>
            <Select
              value={shown.role}
              disabled={locked}
              onValueChange={(role) => controls.setChoice(agent.sourceRef, { role })}
            >
              <SelectTrigger id={`${id}-role`} aria-label={t('agent.role')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {IMPORT_ROLES.map((role) => <SelectItem key={role} value={role}>{t(`role.${role}`)}</SelectItem>)}
                {/* A role of the source this list does not name (a custom role of another Timon) stays choosable. */}
                {!(IMPORT_ROLES as readonly string[]).includes(shown.role) && <SelectItem value={shown.role}>{shown.role}</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-project`} className="text-xs">{t('agent.project')}</Label>
            <Input
              id={`${id}-project`}
              value={shown.project ?? ''}
              placeholder={t('agent.projectNone')}
              maxLength={64}
              disabled={locked}
              onChange={(event) => controls.setChoice(agent.sourceRef, { project: event.target.value.trim() || null })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-cwd`} className="text-xs">{t('agent.cwd')}</Label>
            <Input
              id={`${id}-cwd`}
              value={shown.cwd ?? ''}
              placeholder={t('agent.cwdNone')}
              maxLength={1024}
              disabled={locked}
              aria-invalid={agent.cwdMissing === true}
              onChange={(event) => controls.setChoice(agent.sourceRef, { cwd: event.target.value })}
            />
          </div>
        </div>
      )}

      {included && agent.cwdMissing && <Notice tone="warning">{t('agent.cwdMissing')}</Notice>}

      {included && agent.cwdSuggestion && !shown.cwd && (
        <Notice tone="warning">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all">{t('agent.cwdSuggested', { path: agent.cwdSuggestion })}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => controls.setChoice(agent.sourceRef, { cwd: agent.cwdSuggestion ?? null })}
            >
              {t('agent.cwdUse')}
            </Button>
          </div>
        </Notice>
      )}

      {included && elements.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">{t('agent.elements')}</span>
          <div className="flex flex-wrap gap-1.5">
            {elements.map((element) => {
              const on = shown.elements[element] ?? true;
              return (
                <ElementToggle
                  key={element}
                  element={element}
                  count={agent.elements?.[element]?.count ?? 0}
                  on={on}
                  disabled={locked}
                  onToggle={() => controls.setChoice(agent.sourceRef, { elements: { ...choice?.elements, [element]: !on } })}
                />
              );
            })}
          </div>
        </div>
      )}

      {included && (agent.activeRoutines ?? 0) > 0 && shown.elements.routines === true && (
        <div className="flex items-start gap-3">
          <Switch
            id={`${id}-routines`}
            checked={shown.keepRoutinesActive}
            disabled={locked}
            onCheckedChange={(checked) => controls.setChoice(agent.sourceRef, { keepRoutinesActive: checked })}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <Label htmlFor={`${id}-routines`} className="text-xs">
              {t('agent.routinesActive', { count: agent.activeRoutines ?? 0 })}
            </Label>
            <span className="text-xs text-muted-foreground">{t('agent.routinesActiveHint')}</span>
          </div>
        </div>
      )}

      <WarningList items={agent.warnings} />
    </li>
  );
}

function PreviewStep() {
  const { value, controls } = useImport();
  const preview = value.preview;
  const { included } = applySummary(preview, value.choices);
  const warnings = [...value.warnings, ...(preview?.warnings ?? [])];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t('preview.title')}</h3>
        {value.staged && (
          <p className="text-xs text-muted-foreground">
            {t('preview.archive', { size: formatSize(value.staged.size), time: formatTime(value.staged.expiresAt) })}
          </p>
        )}
      </div>

      {!value.ready && <Notice tone="warning">{t('preview.notReady')}</Notice>}
      {value.ready && preview && preview.agents.length === 0 && <Notice>{t('preview.empty')}</Notice>}

      {warnings.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md bg-amber-500/10 p-3">
          <span className="text-sm font-medium">{t('preview.warnings')}</span>
          <WarningList items={warnings} />
        </div>
      )}

      {preview && preview.agents.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">{t('preview.count', { count: preview.agents.length })}</p>
          <ul className="flex flex-col gap-3">
            {preview.agents.map((agent) => <AgentCard key={agent.sourceRef} agent={agent} />)}
          </ul>
        </>
      )}

      {value.busy && <p role="status" className="text-sm text-muted-foreground">{t('previewing')}</p>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" disabled={value.busy} onClick={controls.reset}>{t('preview.back')}</Button>
        {value.ready && controls.dirty && (
          <Button variant="outline" disabled={value.busy} onClick={() => void controls.refresh()}>{t('preview.refresh')}</Button>
        )}
        {/* What is imported is what the preview shows: a changed choice is previewed first. */}
        <Button disabled={value.busy || !value.ready || controls.dirty || included === 0} onClick={() => void controls.apply()}>
          {t('preview.apply', { count: included })}
        </Button>
      </div>
    </div>
  );
}

const STATUS_CLASS: Record<ImportResultStatus, string> = {
  created: 'bg-primary/15 text-foreground',
  updated: 'bg-primary/15 text-foreground',
  skipped: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/15 text-destructive',
};

function ResultStep({ onDone }: { onDone?: () => void }) {
  const { value, controls } = useImport();
  const result = value.result;
  if (!result) return null;
  const ok = result.agents.filter((agent) => agent.status === 'created' || agent.status === 'updated').length;
  const failed = result.agents.filter((agent) => agent.status === 'failed').length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t('result.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('result.summary', { ok, failed })}</p>
      </div>
      <WarningList items={result.warnings} />
      <ul className="flex flex-col gap-2">
        {result.agents.map((agent) => (
          <li key={agent.sourceRef} className="flex flex-col gap-1.5 rounded-lg bg-muted/40 p-3">
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.agent ?? agent.displayName}</span>
              <Chip className={STATUS_CLASS[agent.status]}>{t(`result.${agent.status}`)}</Chip>
            </div>
            {agent.error && <p className="text-xs text-destructive">{agent.error}</p>}
            <WarningList items={agent.warnings} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" onClick={controls.reset}>{t('result.again')}</Button>
        {onDone && <Button onClick={onDone}>{t('result.done')}</Button>}
      </div>
    </div>
  );
}

function Assistant({ onDone }: { onDone?: () => void }) {
  const { value } = useImport();
  return (
    <div className="flex flex-col gap-4">
      {value.error && <Notice tone="error">{value.error}</Notice>}
      {value.step === 'source' && <SourceStep />}
      {value.step === 'preview' && <PreviewStep />}
      {value.step === 'result' && <ResultStep onDone={onDone} />}
    </div>
  );
}

function AgentImportSettings({ api }: { api: Api }) {
  return (
    <AgentImportProvider api={api}>
      <section className="flex flex-col gap-5 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        <Assistant />
      </section>
    </AgentImportProvider>
  );
}

/** The dialog body: tells the dialog whether closing would drop an archive already sent. */
function DialogBody({ onPending, onDone }: { onPending: (pending: boolean) => void; onDone: () => void }) {
  const { value } = useImport();
  const pending = value.step === 'preview' || value.busy;
  React.useEffect(() => onPending(pending), [onPending, pending]);
  return <Assistant onDone={onDone} />;
}

function ImportDialog({ api, open, onOpenChange }: { api: Api; open: boolean; onOpenChange: (open: boolean) => void }) {
  const pending = React.useRef(false);
  const setPending = React.useCallback((value: boolean) => { pending.current = value; }, []);
  const close = React.useCallback(async (ask: boolean) => {
    if (ask && pending.current) {
      const yes = await ui.confirmAction({
        title: t('closeConfirm.title'),
        description: t('closeConfirm.body'),
        confirmLabel: t('closeConfirm.yes'),
        destructive: true,
      });
      if (!yes) return;
    }
    pending.current = false;
    onOpenChange(false);
  }, [onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) void close(true); }}>
      {/* Inline sizes: a plugin's arbitrary Tailwind values are not compiled by the product. */}
      <DialogContent style={{ maxWidth: 720, maxHeight: '85vh', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>
        {/* Mounted with the dialog: closing it unmounts the provider, which discards the archive. */}
        {open && (
          <AgentImportProvider api={api}>
            <DialogBody onPending={setPending} onDone={() => void close(false)} />
          </AgentImportProvider>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "Import agents" in the action bar of the Agents and Bots pages. */
function ToolbarEntry({ api }: { api: Api }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      {/* Same size, icon and gap as the bar's own entries ("New task", "Organization"). */}
      <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m7 10 5 5 5-5" />
          <path d="M12 15V3" />
        </svg>
        {t('open')}
      </Button>
      <ImportDialog api={api} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * The same import as a compact icon button, at the foot of the `/bots` rail
 * (`bots.rail.action`), beside the rail's own "New bot".
 */
function RailEntry({ api }: { api: Api }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      {/* Its own provider: the slot may be painted where no tooltip provider sits above. */}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('openIcon')}
              onClick={() => setOpen(true)}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="m7 10 5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
            </button>
          </TooltipTrigger>
          {/* Same look as the rail's own tooltips (`RAIL_TIP` in the bots rail). */}
          <TooltipContent side="top" sideOffset={6} className="rounded-md bg-popover px-2 py-1 text-[11.5px] font-medium text-popover-foreground shadow-elev-2">
            {t('openIcon')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <ImportDialog api={api} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** "I already have agents" under the onboarding's agent step. */
function OnboardingEntry({ api }: { api: Api }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        {t('openOnboarding')}
      </button>
      <ImportDialog api={api} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * The built-in source for other agent tools (Grok Bot, Hermes…), an occupant
 * of the socket like any third-party adapter. It reads the archive of the
 * `timon-export` skill, and the older export format those tools may hold.
 */
function OpenBotEntry({ api }: { api: Api }) {
  return (
    <OpenBotSource
      label={t('otherAgentSource.label')}
      description={t('otherAgentSource.description')}
      skillLabel={t('otherAgentSource.copySkill')}
      skillCopied={t('otherAgentSource.skillCopied')}
      skillFailed={t('otherAgentSource.copyFailed')}
      api={api}
    />
  );
}

/** Slots of the product the import adds an entry to. */
export const ENTRY_SLOTS = ['agents.toolbar', 'onboarding.agent'] as const;
/** The foot of the `/bots` rail (import) and the menu of one agent (export). */
export const RAIL_SLOT = 'bots.rail.action';
export const AGENT_MENU_SLOT = 'agent.menu.item';

export function apply(ctx: ClientContext): () => void {
  const api: Api = (path, init) => ctx.api(path, init);
  const Settings = () => <AgentImportSettings api={api} />;
  const Toolbar = () => <ToolbarEntry api={api} />;
  const Onboarding = () => <OnboardingEntry api={api} />;
  const Export = () => <ExportEntry api={api} />;
  const Rail = () => <RailEntry api={api} />;
  const ExportAgent = () => <ExportAgentMenuItem api={api} />;
  // Built once here: a new function per render would ask the daemon again at every paint.
  const detect = () => detectHermes(api);
  const stage = (profiles: string[]) => stageHermes(api, profiles);
  const HermesEntry = () => <HermesSource detect={detect} stage={stage} />;
  const OtherAgents = () => <OpenBotEntry api={api} />;
  const disposers = [
    ctx.slots.register({ slot: 'settings.section', children: { [SOURCE_SLOT]: 'list' } }, Settings),
    // After the section: the socket only exists while the section holds it open.
    ctx.slots.register({ slot: SOURCE_SLOT }, OtherAgents),
    ctx.slots.register({ slot: SOURCE_SLOT }, HermesEntry),
    ctx.slots.register({ slot: ENTRY_SLOTS[0] }, Toolbar),
    ctx.slots.register({ slot: ENTRY_SLOTS[0] }, Export),
    ctx.slots.register({ slot: ENTRY_SLOTS[1] }, Onboarding),
    ctx.slots.register({ slot: RAIL_SLOT }, Rail),
    ctx.slots.register({ slot: AGENT_MENU_SLOT }, ExportAgent),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
