'use client';

/**
 * The mascot configurator (mockup `#styler`), shared by every screen that
 * dresses an agent: a live preview with states to try, then the skull, fur,
 * eyes and accessory grids — each cell is the agent itself wearing that
 * choice — and "Surprise me".
 *
 * - `ProductLookStyler` is the product's configurator, the default occupant
 *   of the `agent.lookstyler` slot. It reads `useLookStyler()`.
 * - `LookStylerHost` is what a screen mounts: it normalises the request, hands
 *   it to the occupant, and paints the product's configurator itself while no
 *   occupant is registered (module off, a page before the plugins load).
 *
 * The container (the onboarding's side panel, the editor's Avatar tab) is the
 * screen's: a screen never paints its own grids, or a change made here would
 * not reach it (TODO #880).
 *
 * The layout follows the container's width, not the screen's: a wide one (the
 * Avatar tab) puts the preview in a column of its own on the left and denser
 * grids on the right, so that every choice fits without scrolling; a narrow
 * one (the onboarding's panel) keeps the stack.
 *
 * A screen may hand the configurator a `header` (the Avatar tab's mode
 * switch): the product's configurator paints it above its choices, and the
 * host paints it above a plugin's replacement, which never has to know.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { Ban, Pipette, Shuffle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentMascotHost } from '@/components/mascot/agent-mascot';
import {
  CUSTOM_FUR_RE, accessoryLabelKey, defaultLookFor, eyesLabelKey, furLabelKey, isMascotAccessory, isMascotEyes, isMascotShape,
  lookFurHex, normalizeAgentLook, shapeLabelKey, type AgentLook,
} from '@/components/mascot/agent-look';
import { furOf } from '@/components/mascot/mascot-geometry';
import { mascotPacks, mascotPartName, useMascotPartsVersion } from '@/components/mascot/mascot-parts';
import type { MascotPartType } from '@/lib/mascot/parts-contract';
import { stateLabelKey, type MascotState } from '@/components/mascot/mascot-states';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { AGENT_LOOK_STYLER_SLOT } from '@/lib/plugin-host/slots';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { lookChoices, randomLook } from '@/components/mascot/random-look';
import { LookStylerProvider, useLookStyler, type LookStylerValue } from './look-styler-context';

/** The states the preview offers to try. */
export const TRY_STATES: readonly MascotState[] = ['happy', 'thinking', 'working', 'waiting', 'celebrate', 'sleeping'];

/** From this container width on, the preview and the grids sit side by side. */
export const LOOK_STYLER_COLUMNS_MIN_WIDTH = 600;

export type LookStylerLayout = 'columns' | 'stack';

/**
 * The layout the container's width allows. The root is measured, not a child:
 * its width comes from the screen's container, so switching layouts never
 * changes it and the two cannot chase each other. Without `ResizeObserver`
 * (a test, an old engine) the stack stays, as it always looked.
 */
export function useContainerLayout(root: RefObject<HTMLElement | null>): LookStylerLayout {
  const [layout, setLayout] = useState<LookStylerLayout>('stack');
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const apply = (width: number): void => setLayout(width >= LOOK_STYLER_COLUMNS_MIN_WIDTH ? 'columns' : 'stack');
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) apply(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);
  return layout;
}

/** A cell's name: the product's translated label, or the pack part's own. */
function cellLabel(type: MascotPartType, id: string): string {
  if (type === 'shape' && isMascotShape(id)) return t(shapeLabelKey(id));
  if (type === 'eyes' && isMascotEyes(id)) return t(eyesLabelKey(id));
  if (type === 'acc' && isMascotAccessory(id)) return t(accessoryLabelKey(id));
  if (type === 'color' && id.startsWith('#')) return t(furLabelKey(id));
  return mascotPartName(id) ?? id;
}

/** The ids of `list` a pack does not hold: the product's, painted first under the grid's title. */
function productOnly<T extends string>(list: readonly T[], packs: LookStylerValue['packs']): T[] {
  const packed = new Set<string>(packs.flatMap((pack) => pack.parts.map((part) => part.id)));
  return list.filter((id) => !packed.has(id));
}

/**
 * The screen's own controls above the choices, read by the product's
 * configurator only: product-internal, never part of the slot's contract.
 */
const LookStylerHeaderContext = createContext<ReactNode>(null);

const pickClass = (on: boolean): string => cn(
  'flex flex-col items-center gap-0.5 rounded-[14px] p-[5px] transition-[background-color,transform] hover:-translate-y-0.5 hover:bg-muted',
  on ? 'bg-muted ring-[1.5px] ring-inset ring-foreground/55' : 'bg-card',
);

function Pick({ on, label, onClick, children, ...rest }: {
  on: boolean; label: string; onClick: () => void; children: ReactNode;
} & Record<`data-${string}`, string>): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={pickClass(on)}
      {...rest}
    >
      {children}
    </button>
  );
}

/** What the colour picker opens on before anyone has mixed a fur. */
const CUSTOM_FUR_START = '#6b8cff';

/**
 * The fur grid's last cell: the browser's colour picker, for a fur the lists
 * do not name. It shows the agent in the fur mixed last, and is selected
 * while the look wears a colour off the presets. The picker reports while
 * the user drags: each report is a change of the draft, saved with it.
 */
function CustomFurPick({ look, presets, size, onPick }: {
  look: AgentLook; presets: readonly string[]; size: number; onPick: (color: AgentLook['color']) => void;
}): ReactElement {
  const on = CUSTOM_FUR_RE.test(look.color) && !presets.includes(look.color);
  const [mixed, setMixed] = useState(on ? look.color : CUSTOM_FUR_START);
  useEffect(() => { if (on) setMixed(look.color); }, [on, look.color]);
  const label = t('mascot.fur.custom');
  return (
    <label data-fur-custom title={label} className={cn(pickClass(on), 'relative cursor-pointer focus-within:ring-2 focus-within:ring-ring')}>
      <input
        type="color"
        aria-label={label}
        value={mixed}
        onChange={(event) => {
          const color = event.target.value.toLowerCase() as AgentLook['color'];
          setMixed(color);
          onPick(color);
        }}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
      <AgentMascotHost look={{ ...look, color: mixed as AgentLook['color'], acc: 'none' }} size={size} shadow={false} fit />
      <span aria-hidden className="pointer-events-none absolute bottom-1 right-1 grid size-4 place-items-center rounded-full bg-background text-foreground shadow-sm">
        <Pipette className="size-2.5" />
      </span>
    </label>
  );
}

/** The width of a cell: roomy in the onboarding's narrow panel, denser beside the preview. */
const cellsClass = (dense: boolean): string =>
  cn('grid gap-1.5', dense ? 'grid-cols-[repeat(auto-fill,minmax(50px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(62px,1fr))]');

const Grid = ({ title, dense, children }: { title: string; dense: boolean; children: ReactNode }): ReactElement => (
  <section>
    <h4 className={cn('mx-0.5 text-xs font-semibold text-muted-foreground', dense ? 'mb-1.5 mt-3' : 'mb-2 mt-4')}>{title}</h4>
    <div className={cellsClass(dense)}>{children}</div>
  </section>
);

/**
 * The cells a grid shows: the product's, then each pack's under its name. A
 * pack is a group of its own so that it reads as something installed, and
 * goes as a whole when its plugin leaves.
 */
function Cells({ type, ids, packs, dense, cell, after = null }: {
  type: MascotPartType;
  ids: readonly string[];
  packs: LookStylerValue['packs'];
  dense: boolean;
  cell: (id: string) => ReactElement;
  /** A cell of the product's after its list, before the packs' groups (the fur's colour picker). */
  after?: ReactNode;
}): ReactElement {
  const listed = new Set(ids);
  const groups = packs
    .map((pack) => ({ pack, parts: pack.parts.filter((part) => part.type === type && listed.has(part.id)) }))
    .filter((group) => group.parts.length > 0);
  return (
    <>
      {productOnly(ids, packs).map(cell)}
      {after}
      {groups.map(({ pack, parts }) => (
        <div key={pack.pluginId} className="col-span-full" data-mascot-pack={pack.pluginId}>
          <h5 className="mx-0.5 mb-1.5 mt-2 text-[11.5px] font-medium text-muted-foreground">{pack.label}</h5>
          <div className={cellsClass(dense)}>{parts.map((part) => cell(part.id))}</div>
        </div>
      ))}
    </>
  );
}

/** The default occupant of `agent.lookstyler`: the product's configurator, from the host's request. */
export function ProductLookStyler(): ReactElement | null {
  const v = useLookStyler();
  if (!v) return null;
  return <LookStylerFromValue value={v} />;
}

function LookStylerFromValue({ value: v }: { value: LookStylerValue }): ReactElement {
  const [tried, setTried] = useState<MascotState | null>(null);
  const { look, name } = v;
  const set = (change: Partial<AgentLook>): void => { setTried(null); v.onChange({ ...look, ...change }); };

  const root = useRef<HTMLDivElement>(null);
  const layout = useContainerLayout(root);
  const columns = layout === 'columns';
  const header = useContext(LookStylerHeaderContext);
  // Beside the preview the cells shrink and lose their caption (the name stays
  // in the tooltip and the accessible label): every grid fits on screen.
  const cellSize = columns ? 40 : 52;
  const caption = (type: MascotPartType, id: string): ReactNode => (columns
    ? null
    : <span className="max-w-full truncate text-[11.5px] text-muted-foreground">{cellLabel(type, id)}</span>);

  return (
    <div
      ref={root}
      className={cn('flex min-h-0 flex-1', columns ? 'flex-row gap-4' : 'flex-col')}
      data-look-styler-content
      data-look-styler-layout={layout}
    >
      <div
        data-look-styler-preview
        className={cn(
          'relative grid shrink-0 place-items-center overflow-hidden rounded-[18px] bg-background px-2.5 pb-3 pt-3.5',
          // Its own column beside the grids: it stays in view while choosing.
          columns && 'w-[300px] self-start py-6',
        )}
      >
        <div aria-hidden className="absolute inset-0 opacity-35 transition-[background] duration-500" style={{ background: `radial-gradient(220px 160px at 50% 40%, ${furOf(lookFurHex(look.color))}, transparent 70%)` }} />
        <div className="relative flex flex-col items-center">
          <AgentMascotHost look={look} size={columns ? 200 : 150} live state={tried} label={name} />
          <div className="mt-2.5 flex flex-wrap justify-center gap-1.5" role="group" aria-label={t('onboarding.agent.style.try')}>
            {v.states.map((state) => (
              <button
                key={state}
                type="button"
                data-try={state}
                aria-pressed={tried === state}
                onClick={() => setTried(state)}
                className={cn('h-7 rounded-full px-3 text-xs transition-colors', tried === state ? 'bg-foreground text-background' : 'bg-muted hover:bg-accent')}
              >
                {t(stateLabelKey(state))}
              </button>
            ))}
          </div>
          <Button type="button" variant="ghost" size="sm" className="mt-1.5" data-surprise onClick={() => { setTried(null); v.onChange(v.random()); }}>
            <Shuffle className="mr-1.5 size-4" aria-hidden />{t('onboarding.agent.style.random')}
          </Button>
        </div>
      </div>
      <div
        data-look-styler-choices
        className={cn('min-h-0 min-w-0 flex-1 overflow-auto pb-1', columns ? 'pr-1 [&>section:first-of-type>h4]:mt-0' : 'pt-1')}
      >
        {header && <div className="mb-3" data-look-styler-header>{header}</div>}
        <Grid title={t('onboarding.agent.style.skull')} dense={columns}>
          <Cells type="shape" ids={v.choices.shapes} packs={v.packs} dense={columns} cell={(shape) => (
            <Pick key={shape} data-shape={shape} on={look.shape === shape} label={cellLabel('shape', shape)} onClick={() => set({ shape: shape as AgentLook['shape'] })}>
              <AgentMascotHost look={{ ...look, shape: shape as AgentLook['shape'], acc: 'none' }} size={cellSize} shadow={false} fit />
              {caption('shape', shape)}
            </Pick>
          )} />
        </Grid>
        <Grid title={t('onboarding.agent.style.fur')} dense={columns}>
          <Cells type="color" ids={v.choices.colors} packs={v.packs} dense={columns} cell={(color) => (
            <Pick key={color} data-fur={color} on={look.color === color} label={cellLabel('color', color)} onClick={() => set({ color: color as AgentLook['color'] })}>
              <AgentMascotHost look={{ ...look, color: color as AgentLook['color'], acc: 'none' }} size={cellSize} shadow={false} fit />
            </Pick>
          )} after={<CustomFurPick look={look} presets={v.choices.colors} size={cellSize} onPick={(color) => set({ color })} />} />
        </Grid>
        <Grid title={t('onboarding.agent.style.eyes')} dense={columns}>
          <Cells type="eyes" ids={v.choices.eyes} packs={v.packs} dense={columns} cell={(eyes) => (
            <Pick key={eyes} data-eyes={eyes} on={look.eyes === eyes} label={cellLabel('eyes', eyes)} onClick={() => set({ eyes: eyes as AgentLook['eyes'] })}>
              {/* The screen alone: the whole head would leave the eyes a few pixels wide. */}
              <AgentMascotHost look={{ ...look, eyes: eyes as AgentLook['eyes'], acc: 'none' }} size={cellSize} shadow={false} part="screen" />
            </Pick>
          )} />
        </Grid>
        <Grid title={t('onboarding.agent.style.accessory')} dense={columns}>
          <Cells type="acc" ids={v.choices.accessories} packs={v.packs} dense={columns} cell={(acc) => (
            <Pick key={acc} data-acc={acc} on={look.acc === acc} label={cellLabel('acc', acc)} onClick={() => set({ acc: acc as AgentLook['acc'] })}>
              {acc === 'none'
                ? <span className="grid place-items-center text-muted-foreground" style={{ width: cellSize, height: cellSize }}><Ban className="size-1/2" aria-hidden /></span>
                // In 2D the tool alone, enlarged (on the flat head it is a few pixels in a corner); in 3D the head wearing it.
                : <AgentMascotHost look={{ ...look, acc: acc as AgentLook['acc'] }} size={cellSize} shadow={false} part="acc" />}
              {caption('acc', acc)}
            </Pick>
          )} />
        </Grid>
      </div>
    </div>
  );
}

export type LookStylerHostProps = {
  /** The look being edited; `null`: the role's default look. Any value: checked field by field. */
  look: Partial<AgentLook> | null;
  onChange: (look: AgentLook) => void;
  name: string;
  role?: string | null;
  /** The screen's controls painted above the choices (the Avatar tab's mode switch). */
  header?: ReactNode;
};

/**
 * One agent's configurator, painted by the `agent.lookstyler` occupant — a
 * plugin's replacement, or the product's. The onboarding and the agent editor
 * mount this, never the grids themselves.
 */
export function LookStylerHost({ look, onChange, name, role = null, header = null }: LookStylerHostProps): ReactElement {
  const occupant = useSlotEntries(AGENT_LOOK_STYLER_SLOT)[0];
  // The product's configurator paints the header among its choices; a
  // plugin's replacement gets it painted above, untouched by the contract.
  const product = !occupant || occupant.Component === ProductLookStyler;
  const base = useMemo(() => defaultLookFor(role ?? ''), [role]);
  const shape = look?.shape;
  const color = look?.color;
  const eyes = look?.eyes;
  const acc = look?.acc;
  const partsVersion = useMascotPartsVersion();
  const current = useMemo(() => normalizeAgentLook({ shape, color, eyes, acc }, base), [shape, color, eyes, acc, base, partsVersion]);
  // A replacement hands back whatever it likes: what is off the lists keeps
  // the current value, so the daemon never sees a look it would refuse.
  const change = useCallback((next: AgentLook) => onChange(normalizeAgentLook(next, current)), [onChange, current]);
  const value = useMemo<LookStylerValue>(() => {
    const choices = lookChoices();
    const packs = mascotPacks().map((pack) => ({
      pluginId: pack.pluginId,
      label: pack.label,
      parts: pack.parts.map(({ id, type, label }) => ({ id, type, label })),
    }));
    return {
      look: current,
      onChange: change,
      name,
      role: role || null,
      states: TRY_STATES,
      choices,
      packs,
      random: () => randomLook(Math.random, choices),
    };
  }, [current, change, name, role, partsVersion]);
  return (
    <LookStylerProvider value={value}>
      <LookStylerHeaderContext.Provider value={product ? header : null}>
        {!product && header && <div className="mb-3" data-look-styler-header>{header}</div>}
        {occupant ? <SlotSingle name={AGENT_LOOK_STYLER_SLOT} /> : <LookStylerFromValue value={value} />}
      </LookStylerHeaderContext.Provider>
    </LookStylerProvider>
  );
}
