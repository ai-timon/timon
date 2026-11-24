import React from 'react'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, createTranslator, usePublishDialog } from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: {
    title: 'Publish on GitHub', onPull: 'Comment on pull request #{number}', onIssue: 'Comment on issue #{number}',
    as: 'as {account}', noAccount: 'No account is set for this project: publishing is off.', text: 'Text to publish',
    publish: 'Publish', save: 'Save for later', discard: 'Do not publish', close: 'Close',
    published: 'Published.', discarded: 'Not published.', publishing: 'Being published.',
    empty: 'The text is empty.', tooLong: 'The text is too long.', control: 'The text holds a control character.', marker: 'The text holds a reserved marker.',
  },
  fr: {
    title: 'Publier sur GitHub', onPull: 'Commentaire sur la pull request n° {number}', onIssue: 'Commentaire sur l’issue n° {number}',
    as: 'en tant que {account}', noAccount: 'Aucun compte pour ce projet : la publication est coupée.', text: 'Texte à publier',
    publish: 'Publier', save: 'Garder pour plus tard', discard: 'Ne pas publier', close: 'Fermer',
    published: 'Publié.', discarded: 'Non publié.', publishing: 'Publication en cours.',
    empty: 'Le texte est vide.', tooLong: 'Le texte est trop long.', control: 'Le texte contient un caractère de contrôle.', marker: 'Le texte contient un marqueur réservé.',
  },
})

/**
 * A replacement of the "Publish on GitHub" window, as a plain dialog.
 *
 * `forge.publish.dialog` is a `single` slot declared at boot, whose default
 * occupant is the product's window (`fallback`). The component receives no
 * props: it reads its host with `usePublishDialog()` and draws the whole
 * window with `Dialog`. What a replacement must respect:
 *   - show the exact text that would leave, where it goes and the account;
 *   - offer one main action, `publish()`: nothing reaches GitHub before it;
 *   - reach nothing itself: `publish`, `save` and `discard` are the host's
 *     gestures, sent through the signed-in person's session, and each
 *     resolves `false` on a refusal, then `error` says why;
 *   - call `close()` when the window is dismissed;
 *   - leave `body` alone when `editable` is false (a branch update: the
 *     host wrote its text, and publishes it as is).
 */
function PlainPublishDialog() {
  const host = usePublishDialog()
  if (!host) return null
  const { proposal, target, account, body, problem, busy, error, loading, editable } = host
  const waiting = proposal === null || proposal.state === 'draft' || proposal.state === 'failed'
  const canPublish = waiting && !loading && !problem && account !== null && busy === null
  const where = t(target.type === 'pull' ? 'onPull' : 'onIssue', { number: target.number })

  return React.createElement(Dialog, { open: true, onOpenChange: (open) => { if (!open) host.close() } },
    React.createElement(DialogContent, { className: 'flex max-w-[640px] flex-col gap-3' },
      React.createElement(DialogTitle, null, t('title')),
      React.createElement(DialogDescription, null,
        account ? `${where} · ${t('as', { account })}` : `${where} · ${t('noAccount')}`),
      waiting && editable
        ? React.createElement('textarea', {
          'aria-label': t('text'), value: body, rows: 12, disabled: busy !== null,
          onChange: (e) => host.setBody(e.target.value),
          className: 'min-h-[12rem] rounded-md bg-muted/40 px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
        })
        : waiting
          ? React.createElement('p', { className: 'whitespace-pre-wrap text-[13px]' }, body)
          : React.createElement('p', { className: 'text-[13px] text-muted-foreground' }, t(proposal.state)),
      (problem && waiting) || error
        ? React.createElement('p', { role: 'alert', className: 'text-[12px] text-destructive' }, error ?? t(problem ?? ''))
        : null,
      React.createElement('div', { className: 'flex items-center justify-end gap-2' },
        waiting
          ? React.createElement(React.Fragment, null,
            React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: busy !== null, onClick: () => { void host.discard() } }, t('discard')),
            editable
              ? React.createElement(Button, { type: 'button', variant: 'secondary', size: 'sm', disabled: busy !== null || problem !== null, onClick: () => { void host.save() } }, t('save'))
              : null,
            React.createElement(Button, { type: 'button', size: 'sm', disabled: !canPublish, onClick: () => { void host.publish() }, 'data-plain-publish': '' }, t('publish')))
          : React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: host.close }, t('close')))))
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  return ctx.slots.register({ slot: 'forge.publish.dialog' }, PlainPublishDialog)
}
