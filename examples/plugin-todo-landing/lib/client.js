import React from 'react'
import { createTranslator, useTodoItem } from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: {
    branch: 'branch {branch}', pending: 'no pull request yet', open: '#{number} open', merged: '#{number} merged',
    closed: '#{number} closed', more: '{count, plural, one {and # other job} other {and # other jobs}}',
  },
  fr: {
    branch: 'branche {branch}', pending: 'pas encore de pull request', open: 'n° {number} ouverte', merged: 'n° {number} mergée',
    closed: 'n° {number} fermée', more: '{count, plural, one {et # autre chantier} other {et # autres chantiers}}',
  },
})

/** What one job says. `prNumber` is null until a pull request exists. */
function describe(job) {
  if (job.state === 'branch') return t('branch', { branch: job.branch })
  if (job.state === 'pending' || job.prNumber === null) return t('pending')
  return t(job.state, { number: job.prNumber })
}

/** Only an http(s) address becomes a link. */
function safeUrl(url) {
  try { return url && /^https?:$/.test(new URL(url).protocol) ? url : null } catch { return null }
}

/**
 * A replacement of the landing badge of a TO DO idea, as a plain line of text.
 *
 * `kanban.todo.landing` is a `single` slot declared at boot, whose default
 * occupant is the product's coloured chip (`fallback`). The component receives
 * no props: it reads the idea with `useTodoItem()`, `landing` included. What a
 * replacement must respect:
 *   - `landing` is read-only and may be `null` (no job on an integration
 *     branch): paint nothing then, or what your plugin knows instead;
 *   - the job shown first is the one furthest from landing; `jobs` lists all;
 *   - a link opens in a new tab: a click on it does not open the idea.
 */
function PlainLanding() {
  const item = useTodoItem()
  const landing = item && item.landing
  if (!landing) return null
  const href = safeUrl(landing.prUrl)
  const text = describe(landing)
  const others = landing.jobs.length - 1
  return React.createElement('span', { 'data-plain-landing': landing.state, className: 'text-[11px] text-muted-foreground' },
    href
      ? React.createElement('a', { href, target: '_blank', rel: 'noopener noreferrer', className: 'underline-offset-2 hover:underline' }, text)
      : text,
    others > 0 ? ` ${t('more', { count: others })}` : null)
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  return ctx.slots.register({ slot: 'kanban.todo.landing' }, PlainLanding)
}
