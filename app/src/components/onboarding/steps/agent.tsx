'use client';

/**
 * "Bring your agent to life" (mockup screen `agent`, docs/ONBOARDING-AGENT.md).
 * One shell for every profile: the identity card on the left, the profile's
 * view on the right, the button always in the same place under it. The view
 * follows the profile chosen just before (`agentViewFor`); a switcher in the
 * corner opens the two others, a star on the recommended one.
 *
 * The creation writes the main agent for real: its name (the seed is renamed
 * and recorded as the main agent), then its look, role, model, permission
 * mode, skills, MCP servers and directives in one config PATCH. "Discover Timon"
 * follows (`steps/discover.tsx`), then the TIMs page, where the agent, named,
 * opens its welcome conversation.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ArrowRight, Loader2, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDirectoryPicker } from '@/components/directory-browser';
import { isAgentLook, normalizeAgentLook } from '@/components/mascot/agent-look';
import { usePrefersReducedMotion } from '@/components/mascot/agent-mascot';
import { supportedPermissionModesFor, useBackendCatalog } from '@/lib/backends';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  AGENT_VIEWS, creationName, creationPatch, initialDraft, INTERVIEW_QUESTIONS, lookOf, missionsOf, namePool,
  randomName, readyToCreate, shownModel, TEMPLATES, type AgentDraft, type TemplateId,
} from '../agent-draft';
import { randomLook } from '@/components/mascot/random-look';
import {
  createMainAgent, loadMainAgent, loadSheetCatalogs, loadSheetSkills, repickedSkills, type MainAgentState, type SheetCatalogs,
} from '../agent-create';
import { IdentityCard } from '../agent/identity-card';
import { InterviewView, interviewAnswer, triggerLabel } from '../agent/interview-view';
import { LookStylerPanel } from '../agent/look-styler-panel';
import { Capabilities, SummaryRow, type UpdateDraft } from '../agent/parts';
import { SheetView } from '../agent/sheet-view';
import { TemplatesView } from '../agent/templates-view';
import { useOnboarding, useOnboardingBack } from '../onboarding-context';
import { agentViewFor, useOnboardingProfile, type AgentCreationView } from '../onboarding-profile';

/** Long enough to see the mascot land its jump before "Discover Timon" opens. */
const LEAVE_MS = 520;
/** Pause before a new folder's skills are read: a quick second pick sends one request, not two. */
const SKILLS_DEBOUNCE_MS = 250;

const SEED_NAMES = new Set(['_main', 'timon.main']);

export function AgentStep(): ReactElement {
  const { next } = useOnboarding();
  const { status, profile, reload } = useOnboardingProfile();
  const reduced = usePrefersReducedMotion();
  const catalog = useBackendCatalog();
  const directory = useDirectoryPicker();

  const [chosenView, setChosenView] = useState<AgentCreationView | null>(null);
  const recommended = agentViewFor(profile);
  const view = chosenView ?? recommended;
  const profileKnown = profile !== null || status === 'ready' || status === 'error';

  const [draft, setDraft] = useState<AgentDraft>(initialDraft);
  const update = useCallback<UpdateDraft>((change) => setDraft(change), []);
  const [agent, setAgent] = useState<MainAgentState | null>(null);
  const [catalogs, setCatalogs] = useState<SheetCatalogs | null>(null);
  const [styling, setStyling] = useState(false);
  const [jump, setJump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leaving = useRef<number | null>(null);
  const pool = namePool(t('onboarding.agent.names'));
  const poolRef = useRef(pool);
  poolRef.current = pool;

  // The agent as it stands: a name already given (a step back), a look already styled.
  useEffect(() => {
    let live = true;
    void loadMainAgent().then((state) => {
      if (!live) return;
      setAgent(state);
      setDraft((d) => {
        const named = state.named && state.name && !SEED_NAMES.has(state.name.toLowerCase()) ? state.name : null;
        const name = d.name || named || randomName(poolRef.current, '');
        return {
          ...d,
          name,
          nameAuto: d.name ? d.nameAuto : !named,
          customLook: d.customLook ?? (isAgentLook(state.look) ? normalizeAgentLook(state.look) : null),
        };
      });
    });
    return () => { live = false; };
  }, []);

  // The sheet's lists, read once it is shown; what the agent already had starts checked.
  useEffect(() => {
    if (view !== 'sheet' || catalogs) return;
    let live = true;
    void loadSheetCatalogs().then((lists) => { if (live) setCatalogs(lists); });
    return () => { live = false; };
  }, [view, catalogs]);
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !catalogs || !agent) return;
    seeded.current = true;
    setDraft((d) => ({
      ...d,
      skills: agent.skills.filter((id) => catalogs.skills.some((s) => s.id === id)),
      mcp: agent.mcpServers.filter((id) => catalogs.mcp.some((s) => s.id === id)),
    }));
  }, [catalogs, agent]);

  // A folder picked on the sheet brings its project's skills (`?cwd=`). Debounced,
  // and a newer folder cancels the read still on its way: only the last one lands.
  const [skillsFolder, setSkillsFolder] = useState('');
  const agentRef = useRef(agent);
  agentRef.current = agent;
  useEffect(() => {
    const folder = draft.folder.trim();
    if (view !== 'sheet' || !catalogs || folder === skillsFolder) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void loadSheetSkills(folder, fetch, abort.signal).then((skills) => {
        if (abort.signal.aborted || skills === null) return;
        setSkillsFolder(folder);
        setCatalogs({ ...catalogs, skills });
        setDraft((d) => ({ ...d, skills: repickedSkills(d.skills, catalogs.skills, skills, agentRef.current?.skills ?? []) }));
      });
    }, SKILLS_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [view, catalogs, draft.folder, skillsFolder]);

  useEffect(() => () => { if (leaving.current !== null) window.clearTimeout(leaving.current); }, []);

  // "Back" closes the panel first, then walks the interview back, then leaves the step.
  useOnboardingBack(() => {
    if (styling) { setStyling(false); return true; }
    if (view === 'interview' && draft.question > 1) { update((d) => ({ ...d, question: d.question - 1 })); return true; }
    return false;
  });

  const look = lookOf(view, draft);
  const model = shownModel(catalog, draft.model, agent ? { backend: agent.backend ?? undefined, model: agent.model ?? undefined } : null);
  const ready = readyToCreate(view, draft) && !busy;
  const bounce = (): void => setJump((n) => n + 1);

  const pickTemplate = (id: TemplateId): void => {
    setDraft((d) => (d.nameAuto || !d.name.trim()
      ? { ...d, template: id, name: randomName(pool, d.name), nameAuto: true }
      : { ...d, template: id }));
    bounce();
  };

  const pickFolder = async (): Promise<void> => {
    const picked = await directory.pick(draft.folder);
    if (picked.status === 'chosen') update((d) => ({ ...d, folder: picked.path }));
  };

  const create = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const name = creationName(draft, pool);
    // The button says whose life starts, a drawn name included.
    setDraft((d) => ({ ...d, name }));
    const patch = creationPatch(view, draft, {
      current: { skills: agent?.skills ?? [], mcp_servers: agent?.mcpServers ?? [] },
      shownSkills: catalogs?.skills.map((s) => s.id) ?? [],
      shownMcp: catalogs?.mcp.map((s) => s.id) ?? [],
    });
    const result = await createMainAgent(name, patch);
    if (!result.ok) {
      setError(result.stage === 'name' ? t(`mainAgentSetup.${result.error}`) : t('onboarding.agent.configFailed', { name }));
      setBusy(false);
      return;
    }
    setStyling(false);
    bounce();
    leaving.current = window.setTimeout(next, reduced ? 0 : LEAVE_MS);
  };

  const shownName = draft.name.trim();
  const roleLabel = view === 'templates'
    ? (draft.template ? { label: t(`onboarding.agent.templates.${draft.template}.title`) } : { label: t('onboarding.agent.templates.none'), empty: true })
    : view === 'interview'
      ? { label: [t('onboarding.agent.interview.role'), draft.missions[0] ? t(`onboarding.agent.mission.${draft.missions[0]}`) : null].filter(Boolean).join(' · ') }
      : { label: t(`onboarding.agent.sheet.role.${draft.role}.title`) };

  const right: ReactNode = !profileKnown
    ? (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />{t('onboarding.agent.loading')}
      </p>
    )
    : view === 'templates'
      ? <TemplatesView picked={draft.template} onPick={pickTemplate} />
      : view === 'interview'
        ? <InterviewView draft={draft} update={update} />
        : (
          <SheetView
            draft={draft}
            update={update}
            shownModel={model}
            catalog={catalog}
            skills={catalogs?.skills ?? []}
            mcp={catalogs?.mcp ?? []}
            onPickFolder={() => { void pickFolder(); }}
            supportedModes={supportedPermissionModesFor(catalog, model?.backend)}
          />
        );

  return (
    <section
      data-onboarding-step="agent"
      data-agent-view={view}
      className={cn(
        // Room around the content: the scroller clips what overflows it, and
        // without it the card's shadow was cut into a grey box.
        'flex max-h-full w-full max-w-[944px] flex-col overflow-y-auto px-8 pb-12',
      )}
    >
      <ViewSwitcher view={view} recommended={recommended} styling={styling} onPick={(v) => { setChosenView(v); setError(null); }} />
      <div className="grid w-full grid-cols-1 items-start gap-[30px] pt-2.5 md:grid-cols-[330px_minmax(0,500px)] md:justify-center">
        <IdentityCard
          look={look}
          name={draft.name}
          onName={(name) => update((d) => ({ ...d, name, nameAuto: false }))}
          onRollName={() => { update((d) => ({ ...d, name: randomName(pool, d.name), nameAuto: false })); bounce(); }}
          onRandomLook={() => { update((d) => ({ ...d, customLook: randomLook() })); bounce(); }}
          onCustomise={() => setStyling(true)}
          styling={styling}
          role={roleLabel}
          model={model}
          jump={jump}
          disabled={busy}
          summary={<Summary view={view} draft={draft} />}
        />
        {/* While customising, the configurator takes the form's place, beside the card. */}
        <div className={cn('min-w-0 flex-col text-left', styling ? 'hidden' : 'flex')}>
          <header className="mb-[18px] mt-0.5">
            <h1 className="text-[30px] font-bold leading-tight tracking-[-0.02em]">{t(`onboarding.agent.${view}.title`)}</h1>
            <p className="mt-1.5 text-[15px] leading-normal text-muted-foreground">{t(`onboarding.agent.${view}.subtitle`)}</p>
            {status === 'error' && profile === null && (
              <p data-profile-error className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                {t('onboarding.agent.profileError')}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={reload}>{t('onboarding.agent.retry')}</button>
              </p>
            )}
          </header>
          {right}
          <div className="sticky bottom-0 mt-1.5 bg-gradient-to-b from-transparent to-background to-45% pb-1.5 pt-[18px] text-center">
            <Button type="button" size="lg" className="w-full" data-create disabled={!ready} onClick={() => { void create(); }}>
              {busy
                ? <><Loader2 className="mr-2 size-4 animate-spin" aria-hidden />{t('onboarding.agent.creating', { name: shownName })}</>
                : <>{shownName ? t('onboarding.agent.create', { name: shownName }) : t('onboarding.agent.createNoName')}<ArrowRight className="ml-2 size-4" aria-hidden /></>}
            </Button>
            <p className={cn('mt-2 min-h-4 text-xs', error ? 'text-destructive' : 'text-muted-foreground')} role={error ? 'alert' : undefined} data-create-hint>
              {error ?? (readyToCreate(view, draft) ? '' : hintFor(view, draft))}
            </p>
          </div>
        </div>
        <LookStylerPanel
          open={styling}
          name={shownName || t('onboarding.agent.createNoName')}
          role={view === 'sheet' ? draft.role : null}
          look={look}
          onChange={(picked) => { update((d) => ({ ...d, customLook: picked })); }}
          onClose={() => setStyling(false)}
        />
      </div>
      {directory.dialog}
    </section>
  );
}

function hintFor(view: AgentCreationView, draft: AgentDraft): string {
  if (view === 'templates') return t('onboarding.agent.templates.hint');
  if (view === 'interview') {
    return t('onboarding.agent.interview.hint', { current: Math.min(draft.question, INTERVIEW_QUESTIONS), total: INTERVIEW_QUESTIONS });
  }
  return '';
}

function Summary({ view, draft }: { view: AgentCreationView; draft: AgentDraft }): ReactElement {
  if (view === 'templates') {
    return draft.template
      ? <Capabilities missions={[...TEMPLATES[draft.template]]} />
      : <p className="text-xs text-muted-foreground">{t('onboarding.agent.templates.empty')}</p>;
  }
  if (view === 'interview') {
    const missions = missionsOf(view, draft);
    return (
      <>
        {(missions.length > 0 || draft.other.trim()) && <Capabilities missions={missions} />}
        {draft.tools.length > 0 && <SummaryRow label={t('onboarding.agent.interview.sum.tools')}>{interviewAnswer(2, draft)}</SummaryRow>}
        <SummaryRow label={t('onboarding.agent.interview.sum.starts')}>{draft.triggers.map((tr) => triggerLabel(tr, draft.at)).join(', ')}</SummaryRow>
        {draft.question > 4 && <SummaryRow label={t('onboarding.agent.interview.sum.autonomy')}>{interviewAnswer(4, draft)}</SummaryRow>}
        {draft.question > 5 && <SummaryRow label={t('onboarding.agent.interview.sum.notifies')}>{interviewAnswer(5, draft)}</SummaryRow>}
      </>
    );
  }
  return (
    <>
      <SummaryRow label={t('onboarding.agent.sheet.sum.project')}>
        {draft.folder || <span className="font-normal text-muted-foreground">{t('onboarding.agent.sheet.sum.toChoose')}</span>}
      </SummaryRow>
      <SummaryRow label={t('onboarding.agent.sheet.sum.permissions')}>
        {/* code-font: the CLI's permission mode id */}
        <code className="font-mono text-[12px]">{draft.permission}</code>
      </SummaryRow>
      <SummaryRow label={t('onboarding.agent.sheet.sum.skills')}><span className="tabular-nums">{draft.skills.length}</span></SummaryRow>
      <SummaryRow label={t('onboarding.agent.sheet.sum.mcp')}>{draft.mcp.join(', ') || '—'}</SummaryRow>
    </>
  );
}

function ViewSwitcher({ view, recommended, styling, onPick }: {
  view: AgentCreationView; recommended: AgentCreationView; styling: boolean; onPick: (view: AgentCreationView) => void;
}): ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label={t('onboarding.agent.views.label')}
      data-view-switcher
      className={cn(
        // In the corner from tablets up; above the card on a phone, where the corner is "Back"'s row.
        'z-[25] mb-3 flex items-center gap-1 self-center rounded-xl bg-card p-1 md:fixed md:right-[calc(1rem+var(--timon-window-controls-w,0px))] md:top-3.5 md:mb-0 timon-window-band-centred-md',
      )}
    >
      <span className="pl-2 pr-1.5 text-[11.5px] text-muted-foreground">{t('onboarding.agent.views.label')}</span>
      {AGENT_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === view}
          data-view={v}
          data-recommended={v === recommended ? 'true' : undefined}
          title={v === recommended ? t('onboarding.agent.views.recommended') : undefined}
          onClick={() => onPick(v)}
          className={cn('inline-flex items-center gap-1 rounded-[9px] px-2.5 py-1.5 text-[12.5px] transition-colors', v === view ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {t(`onboarding.agent.views.${v}`)}
          {v === recommended && (
            <>
              <Star className="size-3 fill-current text-amber-400" aria-hidden />
              <span className="sr-only">{t('onboarding.agent.views.recommended')}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
