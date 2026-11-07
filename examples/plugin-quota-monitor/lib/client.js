/**
 * Browser half of the quota monitor.
 *
 * Written the way a third party must write it: plain ESM, no build step, one
 * React (imported from the platform), components from `@timon/ui`, data from
 * the plugin's own routes (`ctx.api`) — and nothing else. Two surfaces from
 * a single identity: one widget — its rings in a compact zone (side by side on
 * the top bar's line, stacked in a sidebar), the detail opening on click; a
 * tile in a wide zone — and its own settings category.
 */
import React from 'react'
import {
  Tile, BrandMark, Input, Switch, AnchoredPopover,
  cn, createTranslator,
} from '@timon/ui'

const t = createTranslator({
  en: {
    title: 'LLM quotas',
    open: 'Open LLM quotas',
    refresh: 'Refresh',
    loading: 'Loading…',
    loadFailed: 'Usage unavailable',
    unknown: 'unknown',
    unsupported: 'no probe for this provider',
    unavailable: 'probe temporarily unavailable',
    notSignedIn: 'Not signed in',
    connectClaude: 'Sign in to Claude Code from the CLI: run claude, then /login.',
    connectGrok: 'Sign in to Grok from the CLI: run grok login.',
    connectCopilot: 'Sign in to GitHub Copilot from the CLI: run copilot login.',
    connectCodex: 'Sign in to Codex from the CLI: run codex login.',
    connect: 'Sign in from this provider’s CLI.',
    stale: 'Last known usage — refresh unavailable',
    errorDetail: '{message}',
    percentUsed: '{value}% used',
    providersAvailable: '{value} providers measured',
    history: 'Trend',
    lastSevenDays: 'last 7 days',
    historyLabel: 'Usage over the last seven days',
    extraCredits: 'Extra credits',
    resetUnknown: 'reset unknown',
    providers: 'Providers',
    providersHint: 'Hidden providers disappear from the ring, the tile and the trend.',
    thresholds: 'Thresholds',
    thresholdsHint: 'Below the warning threshold the ring stays neutral; above the critical one it turns red.',
    warning: 'Warning (%)',
    critical: 'Critical (%)',
    saveFailed: 'Could not save the setting',
    windows: 'window',
  },
  fr: {
    title: 'Quotas LLM',
    open: 'Ouvrir les quotas LLM',
    refresh: 'Rafraîchir',
    loading: 'Chargement…',
    loadFailed: 'Usage indisponible',
    unknown: 'inconnu',
    unsupported: 'aucune sonde pour ce fournisseur',
    unavailable: 'sonde momentanément indisponible',
    notSignedIn: 'Non connecté',
    connectClaude: 'Connectez-vous à Claude Code depuis le CLI : lancez claude, puis /login.',
    connectGrok: 'Connectez-vous à Grok depuis le CLI : lancez grok login.',
    connectCopilot: 'Connectez-vous à GitHub Copilot depuis le CLI : lancez copilot login.',
    connectCodex: 'Connectez-vous à Codex depuis le CLI : lancez codex login.',
    connect: 'Connectez-vous depuis le CLI de ce fournisseur.',
    stale: 'Dernier usage connu — rafraîchissement indisponible',
    errorDetail: '{message}',
    percentUsed: '{value} % utilisés',
    providersAvailable: '{value} fournisseurs mesurés',
    history: 'Tendance',
    lastSevenDays: '7 derniers jours',
    historyLabel: 'Usage sur les sept derniers jours',
    extraCredits: 'Crédits additionnels',
    resetUnknown: 'réinitialisation inconnue',
    providers: 'Fournisseurs',
    providersHint: "Un fournisseur masqué disparaît de l'anneau, de la tuile et de la tendance.",
    thresholds: 'Seuils',
    thresholdsHint: "Sous le seuil d'avertissement l'anneau reste neutre ; au-delà du critique il passe au rouge.",
    warning: 'Avertissement (%)',
    critical: 'Critique (%)',
    saveFailed: 'Réglage non enregistré',
    windows: 'fenêtre',
  },
})

// Same drawing as `icon.svg` (the gallery picto): the widget window shows it.
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8" stroke-opacity=".35"/><path d="M12 4a8 8 0 0 1 7.2 11.5"/><path d="M12 8.5V12l2.5 1.5"/></svg>'
const ACTIVE_REFRESH_MS = 2 * 60_000
const BACKGROUND_REFRESH_MS = 5 * 60_000
const h = React.createElement

/* Small sizes go through `style`: an arbitrary Tailwind value (`text-[10px]`)
   written in a plugin is never compiled — the product scans only its own
   sources. See "No arbitrary Tailwind value" in docs/PLUGINS.md. */
const SMALL = { fontSize: 10 }
const LABEL = { fontSize: 11 }
const PROSE = { maxWidth: '65ch' }

function riskColor(value, warning, critical) {
  if (value === null || value === undefined) return 'hsl(var(--muted-foreground))'
  if (value >= critical) return 'hsl(var(--destructive))'
  if (value >= warning) return 'hsl(var(--warning, 38 92% 50%))'
  return 'hsl(var(--success, 142 71% 45%))'
}

function clamp(value) {
  return Math.max(0, Math.min(100, value))
}

function quotaRings(entry) {
  const windows = (entry.usage && entry.usage.windows) || {}
  const short = windows.five_hour || windows.daily || null
  const long = windows.seven_day || windows.weekly || null
  if (short && long) {
    return { value: short.utilization, outerValue: long.utilization }
  }
  const only = short || long || Object.values(windows).find(Boolean) || null
  return { value: only ? only.utilization : entry.risk, outerValue: null }
}

/** Quotas measure the Claude product, not its parent company. Other providers
 * keep the brand declared by the runtime catalogue. */
function quotaBrand(brand) {
  return brand === 'anthropic' ? 'claude' : brand
}

/**
 * One store per plugin instance feeds every surface. Topbar and cockpit mount
 * independently, but must never start two polling loops or two simultaneous
 * quota requests for the same account.
 */
function createQuotaStore(ctx) {
  /** @type {{ data: any, history: any, loading: boolean, failed: string | null }} */
  let snapshot = { data: null, history: null, loading: true, failed: null }
  let request = null
  // A ↻ pressed while a poll is in flight: that poll read the cache, so the
  // forced reading runs right after it instead of being swallowed.
  let forceQueued = false
  let timer = null
  const listeners = new Set()

  const emit = (patch) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }

  /** `force` is the ↻ button's: the daemon then skips the probes' cache. Never the polling loop's. */
  const refresh = (force = false) => {
    // Strictly `true`: a handler wired as `onClick: refresh` would hand an event over.
    const forced = force === true
    if (request) {
      if (forced) forceQueued = true
      return request
    }
    request = (async () => {
      try {
        const response = await ctx.api(forced ? 'all?refresh=1' : 'all')
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(body && body.error ? body.error : `usage ${response.status}`)
        }
        const data = await response.json()
        const historyResponse = await ctx.api('history')
        const history = historyResponse.ok ? await historyResponse.json() : snapshot.history
        emit({ data, history, loading: false, failed: null })
      } catch (error) {
        emit({ loading: false, failed: error && error.message ? error.message : t('loadFailed') })
      } finally {
        request = null
        if (forceQueued) {
          forceQueued = false
          void refresh(true)
        } else {
          schedule()
        }
      }
    })()
    return request
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    if (!listeners.size) return
    const entries = (snapshot.data && snapshot.data.entries) || []
    // Same rule as quotaShouldKeepPolling in the host half: a missing CLI
    // session will not appear by retrying, even when another backend is
    // only unsupported. Manual refresh and tab focus still re-check.
    if (entries.length && entries.some((entry) => entry.state === 'disconnected')) return
    timer = setTimeout(() => { void refresh() }, document.visibilityState === 'visible' ? ACTIVE_REFRESH_MS : BACKGROUND_REFRESH_MS)
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void refresh()
    else schedule()
  }
  const subscribe = (listener) => {
    listeners.add(listener)
    if (listeners.size === 1) {
      document.addEventListener('visibilitychange', onVisibility)
      void refresh()
    }
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        document.removeEventListener('visibilitychange', onVisibility)
        if (timer) clearTimeout(timer)
        timer = null
      }
    }
  }
  const getSnapshot = () => snapshot

  return {
    refresh,
    useQuota() {
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    },
  }
}

/**
 * Risk ring, in SVG.
 *
 * SVG and not a conic gradient in a Tailwind class: the product compiles its
 * CSS from `app/src/**` ONLY, so a class with an arbitrary value written in a
 * plugin (`bg-[conic-gradient(…)]`) never exists in the shipped stylesheet —
 * the ring was invisible, only the number remained. General rule in
 * `docs/PLUGINS.md`: in a plugin, no arbitrary Tailwind value; inline `style`
 * or SVG.
 *
 * The brand logo sits in the centre; the percentage reads next to the ring,
 * not inside it — at 28 px, a number centred under a logo is unreadable.
 */
function QuotaRing({ value, outerValue = null, size = 34, brand, stale = false, warning = 70, critical = 90 }) {
  const hasOuter = outerValue !== null && outerValue !== undefined
  const stroke = hasOuter ? 3 : Math.max(3, Math.round(size / 8))
  const outerRadius = (size - stroke) / 2
  const innerRadius = hasOuter ? outerRadius - stroke - 1 : outerRadius
  const ring = (ringValue, radius) => {
    const circumference = 2 * Math.PI * radius
    const known = ringValue !== null && ringValue !== undefined
    return h(React.Fragment, null,
      h('circle', {
        cx: size / 2, cy: size / 2, r: radius, fill: 'none',
        stroke: 'hsl(var(--muted))', strokeWidth: stroke,
      }),
      known ? h('circle', {
        cx: size / 2, cy: size / 2, r: radius, fill: 'none',
        stroke: riskColor(ringValue, warning, critical), strokeWidth: stroke, strokeLinecap: 'round',
        strokeDasharray: `${circumference} ${circumference}`,
        strokeDashoffset: circumference * (1 - clamp(ringValue) / 100),
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
        style: { transition: 'stroke-dashoffset 300ms ease' },
      }) : null)
  }
  const knownValues = [value, outerValue].filter((item) => item !== null && item !== undefined)
  const risk = knownValues.length ? Math.max(...knownValues) : null
  return h('span', {
    className: 'relative grid shrink-0 place-items-center',
    style: { width: size, height: size },
    role: 'img',
    'aria-label': risk === null ? t('unknown') : t('percentUsed', { value: Math.round(risk) }),
  },
  h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
    hasOuter ? ring(outerValue, outerRadius) : null,
    ring(value, innerRadius)),
  h('span', { className: 'absolute grid place-items-center', style: { width: size * (hasOuter ? 0.36 : 0.44), height: size * (hasOuter ? 0.36 : 0.44) } },
    h(BrandMark, { brand: quotaBrand(brand), className: 'size-full' })),
  stale ? h('span', {
    className: 'absolute -bottom-0.5 -right-0.5 grid size-3 place-items-center rounded-full bg-background',
    style: { color: 'hsl(var(--warning, 38 92% 50%))' },
    title: t('stale'),
    'aria-label': t('stale'),
  }, h(RefreshIcon)) : null)
}

function resetLabel(iso) {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return t('resetUnknown')
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date)
}

// The usage endpoint reports credits in minor units (900 = 9.00 EUR).
function money(minorUnits, currency) {
  const value = minorUnits / 100
  const whole = Number.isInteger(value)
  return new Intl.NumberFormat(undefined, {
    style: 'currency', currency: currency || 'USD',
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  }).format(value)
}

function Bar({ value, warning, critical }) {
  return h('div', { className: 'h-1 overflow-hidden rounded-full bg-muted' },
    h('div', {
      className: 'h-full rounded-full motion-reduce:transition-none',
      style: {
        width: `${clamp(value)}%`,
        backgroundColor: riskColor(value, warning, critical),
        transition: 'width 200ms ease',
      },
    }))
}

function QuotaRows({ entries, compact = false, warning = 70, critical = 90 }) {
  return h('div', { className: 'flex flex-col gap-1' }, entries.map((entry) => {
    const windows = Object.entries((entry.usage && entry.usage.windows) || {}).filter(([, w]) => w)
    const extra = entry.usage && entry.usage.extra
    const measured = (entry.state === 'available' || entry.state === 'stale')
      && (windows.length > 0 || (extra && extra.is_enabled))
    const rings = quotaRings(entry)
    return h('div', { key: entry.backend, className: cn('flex gap-3 py-3', compact && 'py-2.5') },
      h(QuotaRing, { ...rings, size: compact ? 32 : 38, brand: entry.brand, stale: entry.stale, warning, critical }),
      h('div', { className: 'min-w-0 flex-1' },
        h('div', { className: 'flex items-baseline justify-between gap-3' },
          h('span', { className: 'truncate text-xs font-semibold text-foreground' }, entry.label),
          h('span', { className: 'tabular-nums text-muted-foreground', style: SMALL },
            entry.risk === null ? t('unknown') : `${Math.round(entry.risk)}%`)),
        measured
          ? h('div', { className: 'mt-1.5 space-y-1.5' },
            windows.map(([windowName, window]) => h('div', { key: windowName },
              h('div', { className: 'mb-0.5 flex justify-between gap-2 text-muted-foreground', style: SMALL },
                // The window vocabulary belongs to the provider (`five_hour`,
                // `seven_day`, …): show it as it comes rather than translate a
                // list we do not control.
                h('span', null, windowName.replace(/_/g, ' ')),
                h('span', null, resetLabel(window.resets_at))),
              h(Bar, { value: window.utilization, warning, critical }))),
            extra && extra.is_enabled
              ? h('div', null,
                h('div', { className: 'mb-0.5 flex justify-between gap-2 text-muted-foreground', style: SMALL },
                  h('span', null, t('extraCredits')),
                  h('span', { className: 'tabular-nums' },
                    `${money(extra.used_credits, extra.currency)} / ${money(extra.monthly_limit, extra.currency)}`)),
                h(Bar, { value: extra.utilization, warning, critical }))
              : null)
          // No numbers rather than a zero gauge: an absent probe and an empty
          // quota must never look alike. A missing CLI session is idle, not
          // an error — no destructive colour, no retry copy.
          : h('div', { className: 'mt-1 text-muted-foreground', style: SMALL },
            entry.state === 'disconnected'
              ? h('div', { role: 'status' },
                h('p', null, t('notSignedIn')),
                h('p', { className: 'mt-0.5' }, entry.backend === 'grok' ? t('connectGrok')
                  : entry.backend === 'copilot' ? t('connectCopilot')
                  : entry.backend === 'codex' ? t('connectCodex')
                  : entry.backend === 'claude' ? t('connectClaude') : t('connect')))
              : h('p', null, entry.state === 'unsupported' ? t('unsupported') : t('unavailable')),
            entry.error && entry.state !== 'disconnected'
              ? h('p', { className: 'mt-0.5 break-words text-destructive' },
                t('errorDetail', { message: entry.error }))
              : null)))
  }))
}

function QuotaHistory({ history, visibleBackends }) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60_000
  const points = ((history && history.points) || []).filter((p) => p.at >= cutoff && visibleBackends.has(p.backend))
  if (points.length < 2) return null
  const minAt = Math.min(...points.map((p) => p.at))
  const maxAt = Math.max(...points.map((p) => p.at))
  const span = Math.max(1, maxAt - minAt)
  const grouped = new Map()
  for (const point of points) grouped.set(point.backend, [...(grouped.get(point.backend) || []), point])

  return h('section', { className: 'mt-4' },
    h('div', { className: 'mb-2 flex items-baseline justify-between gap-3' },
      h('span', { className: 'font-medium', style: LABEL }, t('history')),
      h('span', { className: 'text-muted-foreground', style: SMALL }, t('lastSevenDays'))),
    h('svg', {
      viewBox: '0 0 300 64', role: 'img', 'aria-label': t('historyLabel'),
      className: 'h-16 w-full overflow-visible',
    },
    h('path', { d: 'M0 32H300', stroke: 'currentColor', strokeOpacity: 0.12, strokeDasharray: '3 4' }),
    [...grouped.entries()].map(([backend, values], index) => h('path', {
      key: backend,
      d: values.map((point, pointIndex) => {
        const x = ((point.at - minAt) / span) * 300
        const y = 62 - clamp(point.risk) * 0.6
        return `${pointIndex === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
      }).join(' '),
      fill: 'none',
      stroke: index === 0 ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
      strokeOpacity: index === 0 ? 0.9 : Math.max(0.3, 0.7 - index * 0.1),
      strokeWidth: '2',
      vectorEffect: 'non-scaling-stroke',
    }))))
}

/** Circular arrow, inline: a plugin ships its own icons rather than reaching
 *  into the product's icon set, which is not part of the contract. */
function RefreshIcon() {
  return h('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round', strokeLinejoin: 'round', className: 'size-3.5', 'aria-hidden': 'true',
  }, h('path', { d: 'M21 12a9 9 0 1 1-3-6.7L21 8' }), h('path', { d: 'M21 3v5h-5' }))
}

/**
 * The rings, in a compact zone: side by side on the top bar's line, stacked in
 * a sidebar. A click opens the detail in the platform's anchored popover —
 * under the rings on the line, beside them in a column — which keeps it inside
 * the window, phone included.
 */
function makeCompact(store) {
  return function QuotaCompact({ vertical = false }) {
    const { data, history, failed } = store.useQuota()
    const [open, setOpen] = React.useState(false)
    const anchor = React.useRef(null)
    const panelId = React.useId()
    const entries = (data && data.entries) || []
    const risk = (data && data.highestRisk && data.highestRisk.utilization) ?? null
    const thresholds = (data && data.thresholds) || { warning: 70, critical: 90 }
    return h(React.Fragment, null,
      h('button', {
        ref: anchor,
        type: 'button',
        'aria-label': t('open'),
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
        onClick: () => setOpen((value) => !value),
        className: cn(
          'flex items-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          vertical ? 'flex-col p-0.5' : 'h-9 px-1.5',
          open && 'text-foreground',
        ),
      },
      h('span', { 'data-quota-rings': vertical ? 'vertical' : 'horizontal', className: cn('flex items-center gap-1', vertical && 'flex-col') },
        entries.map((entry) => h(QuotaRing, {
          key: entry.backend,
          ...quotaRings(entry),
          size: 34,
          brand: entry.brand,
          stale: entry.stale,
          warning: thresholds.warning,
          critical: thresholds.critical,
        }))),
      // A column has no width for the figure; the rings carry it.
      vertical ? null : h('span', { className: 'hidden font-semibold tabular-nums lg:inline', style: LABEL },
        risk === null ? '—' : `${Math.round(risk)}%`)),
      h(AnchoredPopover, {
        open,
        onClose: () => setOpen(false),
        anchorRef: anchor,
        placement: vertical ? 'beside' : 'below',
        id: panelId,
        label: t('title'),
        className: 'p-3',
      },
        h('div', { className: 'mb-1 flex items-center justify-between gap-3' },
          h('span', { className: 'text-sm font-semibold' }, t('title')),
          h('button', {
            type: 'button',
            onClick: () => void store.refresh(true),
            className: 'rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'aria-label': t('refresh'),
          }, h(RefreshIcon)),
        ),
        failed && !data
          ? h('div', { className: 'py-5 text-center text-xs' },
            h('p', { className: 'text-muted-foreground' }, t('loadFailed')),
            h('p', { className: 'mt-1 break-words text-destructive' }, failed))
          : h(QuotaRows, { entries, compact: true, warning: thresholds.warning, critical: thresholds.critical }),
        h(QuotaHistory, { history, visibleBackends: new Set(entries.map((entry) => entry.backend)) })))
  }
}

function makeWidget(store) {
  const QuotaCompact = makeCompact(store)
  /** @param {Record<string, never> | import('@timon-ai/sdk').WidgetChromeProps} props */
  return function QuotaWidget({ poignee, className, orientation, compact }) {
    const { data, history, loading, failed } = store.useQuota()
    // In a compact zone the widget is its rings and their popover (the host
    // lays them out on a line or in a column, the grip following); in a wide
    // zone it is the tile. Same store, so both forms show the same reading.
    if (compact || orientation === 'horizontal') {
      return h(React.Fragment, null, h(QuotaCompact, { vertical: orientation !== 'horizontal' }), poignee)
    }
    const entries = (data && data.entries) || []
    const measured = entries.filter((entry) => entry.state === 'available').length
    const thresholds = (data && data.thresholds) || { warning: 70, critical: 90 }
    return h(Tile, {
      title: t('title'),
      subtitle: loading ? t('loading') : t('providersAvailable', { value: measured }),
      className,
      actions: h(React.Fragment, null,
        h('button', {
          type: 'button',
          onClick: () => void store.refresh(true),
          className: 'rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'aria-label': t('refresh'),
        }, h(RefreshIcon)),
        poignee),
    }, failed && !data
      ? h('div', { className: 'm-auto px-3 text-center text-xs' },
        h('p', { className: 'text-muted-foreground' }, t('loadFailed')),
        h('p', { className: 'mt-1 break-words text-destructive' }, failed))
      : h(React.Fragment, null,
        h(QuotaRows, { entries, warning: thresholds.warning, critical: thresholds.critical }),
        h(QuotaHistory, { history, visibleBackends: new Set(entries.map((entry) => entry.backend)) })))
  }
}

function makeSettings(ctx) {
  return function QuotaSettings() {
    const [state, setState] = React.useState(null)
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState(false)

    const load = React.useCallback(async () => {
      const response = await ctx.api('providers')
      if (response.ok) setState(await response.json())
    }, [])
    React.useEffect(() => { void load() }, [load])

    const save = React.useCallback(async (key, value) => {
      setSaving(true)
      const response = await ctx.settings.set(key, value)
      setSaving(false)
      setError(!response.ok)
      if (response.ok) await load()
    }, [load])

    if (!state) return h('p', { className: 'py-6 text-sm text-muted-foreground' }, t('loading'))
    const hidden = state.settings.hiddenBackends

    return h('div', { className: 'flex flex-col gap-2' },
      h('section', { className: 'py-4' },
        h('h3', { className: 'text-sm font-medium' }, t('providers')),
        h('p', { className: 'mt-1 text-xs text-muted-foreground', style: PROSE }, t('providersHint')),
        h('div', { className: 'mt-3 space-y-1' }, state.providers.map((provider) => h('label', {
          key: provider.id,
          className: 'flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50',
        },
        h(Switch, {
          checked: !hidden.includes(provider.id),
          disabled: saving,
          onCheckedChange: (checked) => void save('hiddenBackends', (checked
            ? hidden.filter((id) => id !== provider.id)
            : [...hidden, provider.id]).join(',')),
        }),
        h('span', { className: 'min-w-0 flex-1 text-sm' }, provider.label),
        provider.measurable
          ? null
          : h('span', { className: 'text-xs text-muted-foreground' }, t('unsupported')))))),
      h('section', { className: 'py-4' },
        h('h3', { className: 'text-sm font-medium' }, t('thresholds')),
        h('p', { className: 'mt-1 text-xs text-muted-foreground', style: PROSE }, t('thresholdsHint')),
        h('div', { className: 'mt-3 flex max-w-sm gap-4' },
          h('label', { className: 'flex-1 text-xs text-muted-foreground' }, t('warning'),
            h(Input, {
              type: 'number', min: 1, max: 99, defaultValue: state.settings.warningAt, className: 'mt-1',
              onBlur: (event) => void save('warningAt', Number(event.target.value)),
            })),
          h('label', { className: 'flex-1 text-xs text-muted-foreground' }, t('critical'),
            h(Input, {
              type: 'number', min: 2, max: 100, defaultValue: state.settings.criticalAt, className: 'mt-1',
              onBlur: (event) => void save('criticalAt', Number(event.target.value)),
            }))),
        error ? h('p', { className: 'mt-2 text-xs text-destructive' }, t('saveFailed')) : null))
  }
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  const store = createQuotaStore(ctx)
  const disposeWidget = ctx.slots.register(
    // ONE widget, shaped by its zone (`compact`, `orientation`): the rings on
    // the top bar's line or stacked in a sidebar, the tile in a wide zone. `frame: 'none'`: it paints its
    // own frame, so it receives the drag handle and the rail's classes.
    // `bar`: admitted on the top bar's line. `placedByDefault`: it starts there
    // on every view, where the ring always was, even in a layout saved before.
    // `key: 'quota'` + `formerKeys: ['']`: the old tile was registered without
    // a key (`plugin:quota-monitor`) and sits in the palette of most saved
    // layouts; a new id keeps the ring from inheriting that removal, and `''`
    // hands down the tile's place to whoever had put it on screen.
    {
      slot: 'cockpit.widget',
      key: 'quota',
      widget: {
        title: t('title'), zone: 'topbar.widget', height: 260, minHeight: 160, frame: 'none',
        bar: true, placedByDefault: true, formerKeys: [''], icon: ICON,
      },
    },
    makeWidget(store),
  )
  const disposeSettings = ctx.slots.register({ slot: 'settings.section' }, makeSettings(ctx))
  return () => {
    disposeSettings()
    disposeWidget()
  }
}
