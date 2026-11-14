'use client';

/**
 * Developer (mockup `agentDeveloperView`): the real knobs, in four tabs —
 * role and project, engine, permissions, tools. The engine is the product's
 * model picker (`ModelPickerPanel`, the `model.picker` slot: favourites,
 * accounts and search included), the skills and MCP servers the daemon's own
 * lists: none of them is written here. A backend that honours only some
 * permission modes (`supportedModes`) is offered only those, and a mode picked
 * before the engine changed says it runs as plan.
 */
import type { ReactElement } from 'react';
import { AlertTriangle, FolderOpen, GitBranch, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModelPickerPanel } from '@/components/model-picker';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { unsupportedModeRunsAs } from '@/lib/backends';
import {
  DEV_ROLES, DEV_TABS, PERMISSION_MODES, toggled,
  type AgentDraft, type ModelChoice,
} from '../agent-draft';
import type { CatalogItem } from '../agent-create';
import { Chip, SectionTitle, type UpdateDraft } from './parts';

export type SheetViewProps = {
  draft: AgentDraft;
  update: UpdateDraft;
  /** The model the agent runs on now: the picker shows it until another is picked. */
  shownModel: ModelChoice | null;
  skills: readonly CatalogItem[];
  mcp: readonly CatalogItem[];
  onPickFolder: () => void;
  /** The only permission modes the picked engine honours; null = every mode. */
  supportedModes?: readonly string[] | null;
};

function Radio({ on }: { on: boolean }): ReactElement {
  return (
    <span
      aria-hidden
      className={cn('mt-0.5 size-4 shrink-0 rounded-full transition-shadow', on ? 'shadow-[inset_0_0_0_5px_hsl(var(--foreground))]' : 'shadow-[inset_0_0_0_1.5px_hsl(var(--border))]')}
    />
  );
}

export function SheetView({ draft, update, shownModel, skills, mcp, onPickFolder, supportedModes = null }: SheetViewProps): ReactElement {
  const tab = draft.tab;
  const modes = supportedModes ? PERMISSION_MODES.filter((m) => supportedModes.includes(m)) : PERMISSION_MODES;
  const runsAs = unsupportedModeRunsAs(supportedModes, draft.permission);
  return (
    <div data-sheet>
      <div role="tablist" className="mb-[18px] flex gap-[3px] rounded-[13px] bg-card p-1">
        {DEV_TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`agent-sheet-tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`agent-sheet-panel-${k}`}
            data-tab={k}
            onClick={() => update((d) => ({ ...d, tab: k }))}
            className={cn('flex-1 rounded-[9px] px-2.5 py-2 text-[13px] font-semibold transition-colors', tab === k ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {t(`onboarding.agent.sheet.tab.${k}`)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`agent-sheet-panel-${tab}`} aria-labelledby={`agent-sheet-tab-${tab}`} className="flex flex-col gap-5">
        {tab === 'base' && (
          <>
            <section>
              <SectionTitle>{t('onboarding.agent.sheet.roleTitle')}</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {DEV_ROLES.map((r) => (
                  <Chip key={r} data-role={r} on={draft.role === r} onClick={() => update((d) => ({ ...d, role: r }))}>
                    {t(`onboarding.agent.sheet.role.${r}.title`)}
                  </Chip>
                ))}
              </div>
              <p className="mx-0.5 mt-[7px] text-xs text-muted-foreground">{t(`onboarding.agent.sheet.role.${draft.role}.description`)}</p>
              <p className="mx-0.5 mt-1 text-xs text-muted-foreground" data-role-hint>{t('onboarding.agent.sheet.roleHint')}</p>
            </section>
            <section>
              <SectionTitle>{t('onboarding.agent.sheet.project')}</SectionTitle>
              <div className="flex items-center gap-2.5 rounded-xl bg-card py-2 pl-3.5 pr-2 text-[13.5px]">
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span data-folder className={cn('min-w-0 flex-1 truncate', !draft.folder && 'text-muted-foreground')}>
                  {draft.folder || t('onboarding.agent.sheet.noFolder')}
                </span>
                <Button type="button" variant="secondary" size="sm" data-pick-folder onClick={onPickFolder}>{t('onboarding.agent.sheet.choose')}</Button>
              </div>
              <div className="mt-2 flex items-center gap-3 rounded-xl bg-card px-3 py-2.5">
                <GitBranch className="size-4 shrink-0 text-emerald-500" aria-hidden />
                <span className="flex flex-1 flex-col gap-0.5 text-[13.5px]">
                  <b className="font-semibold">{t('onboarding.agent.sheet.worktree')}</b>
                  <span className="text-xs text-muted-foreground">{t('onboarding.agent.sheet.worktreeDetail')}</span>
                </span>
              </div>
            </section>
          </>
        )}

        {tab === 'engine' && (
          <section>
            <SectionTitle>{t('onboarding.agent.sheet.engine')}</SectionTitle>
            <ModelPickerPanel
              value={shownModel ? { backend: shownModel.backend, model: shownModel.model } : null}
              onChange={(pick) => { if (pick) update((d) => ({ ...d, model: { backend: pick.backend, model: pick.model } })); }}
            />
          </section>
        )}

        {tab === 'perms' && (
          <section>
            <SectionTitle>{t('onboarding.agent.sheet.permissions')}</SectionTitle>
            <div className="flex flex-col gap-[5px]" role="radiogroup" aria-label={t('onboarding.agent.sheet.permissions')}>
              {modes.map((mode) => {
                const on = draft.permission === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-permission={mode}
                    onClick={() => update((d) => ({ ...d, permission: mode }))}
                    className={cn('flex items-start gap-[11px] rounded-xl px-3 py-2.5 text-left transition-colors', on ? 'bg-muted' : 'bg-card hover:bg-muted')}
                  >
                    <Radio on={on} />
                    <span className="flex flex-1 flex-col items-start gap-[3px]">
                      {/* code-font: the CLI's permission mode id, written as it is typed */}
                      <code className={cn('rounded bg-background px-1.5 py-px font-mono text-[12px]', mode === 'bypassPermissions' && 'text-destructive')}>{mode}</code>
                      <span className="text-[12.5px] text-muted-foreground">{t(`onboarding.agent.sheet.perm.${mode}`)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {draft.permission === 'bypassPermissions' && (
              <p role="alert" data-bypass-warning className="mx-0.5 mt-2 flex items-center gap-1.5 text-xs text-amber-500">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                {t('onboarding.agent.sheet.bypassWarning')}
              </p>
            )}
            {runsAs && (
              <p role="note" data-permission-runs-as={runsAs} className="mx-0.5 mt-2 flex items-center gap-1.5 text-xs text-amber-500">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                {t('editPage.permissionModeRunsAsPlan', { mode: draft.permission })}
              </p>
            )}
          </section>
        )}

        {tab === 'tools' && (
          <>
            <section>
              <SectionTitle>{t('onboarding.agent.sheet.skills')}</SectionTitle>
              {skills.length === 0
                ? <p className="text-[13px] text-muted-foreground">{t('onboarding.agent.sheet.noSkills')}</p>
                : (
                  <div className="flex max-h-[180px] flex-wrap gap-1.5 overflow-y-auto">
                    {skills.map((s) => (
                      <Chip key={s.id} data-skill={s.id} on={draft.skills.includes(s.id)} onClick={() => update((d) => ({ ...d, skills: toggled(d.skills, s.id) }))}>
                        {s.label}
                      </Chip>
                    ))}
                  </div>
                )}
            </section>
            <section>
              <SectionTitle>{t('onboarding.agent.sheet.mcp')}</SectionTitle>
              {mcp.length === 0
                ? <p className="text-[13px] text-muted-foreground">{t('onboarding.agent.sheet.noMcp')}</p>
                : (
                  <div className="flex flex-wrap gap-1.5">
                    {mcp.map((s) => (
                      <Chip key={s.id} data-mcp={s.id} on={draft.mcp.includes(s.id)} onClick={() => update((d) => ({ ...d, mcp: toggled(d.mcp, s.id) }))}>
                        <Plug className="size-3.5" aria-hidden />{s.label}
                      </Chip>
                    ))}
                  </div>
                )}
            </section>
            <section>
              <SectionTitle>{t('onboarding.agent.sheet.rules')}</SectionTitle>
              <textarea
                data-rules
                rows={3}
                maxLength={4000}
                value={draft.rules}
                onChange={(e) => { const rules = e.target.value; update((d) => ({ ...d, rules })); }}
                placeholder={t('onboarding.agent.sheet.rulesPlaceholder')}
                className="w-full resize-y rounded-xl bg-card px-3 py-2.5 text-[13.5px] outline-none ring-1 ring-inset ring-border focus:ring-foreground/55"
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
