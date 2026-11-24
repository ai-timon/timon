export const name = 'forge-example'
export const inject = ['settings']

/** Statuses for the codes `ctx.forge` throws (`PluginForgeErrorCode`). */
const STATUS = { invalid: 400, not_found: 404, not_configured: 409, forbidden: 403, busy: 429, unavailable: 502 }

/**
 * The reply of a proposal is a template: it never quotes the issue, whose
 * title and body were written by someone else. A person still reads it, may
 * edit it, and publishes it from the "Publish on GitHub" window.
 */
export function thanksFor() {
  return 'Thanks for reporting this. We are tracking it, and will post here when a fix lands.'
}

/**
 * What an agent may be handed of an issue: bounded, and marked as text from
 * outside, never an instruction.
 */
export function asUntrusted(issue) {
  const data = JSON.stringify({ number: issue.number, title: issue.title.slice(0, 200), author: issue.author })
  return `<untrusted-data>${data.replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</untrusted-data>`
}

/** @param {import('@timon-ai/sdk').PluginContext} ctx */
export function apply(ctx) {
  const router = ctx.router()

  const answer = (handler) => async (request, response) => {
    if (!ctx.user()) { response.status(401).json({ error: 'sign_in_required' }); return }
    try {
      response.json(await handler(request))
    } catch (err) {
      if (err?.name === 'PluginCallerError') { response.status(403).json({ error: 'forbidden' }); return }
      const status = STATUS[err?.code]
      if (!status) throw err
      response.status(status).json({ error: err.code })
    }
  }

  // The open issues of a project that carry the label of the settings.
  router.get('/candidates', answer(async (request) => {
    const project = String(request.query.project ?? '')
    const label = String(ctx.settings.get('label') || 'accepted')
    const issues = await ctx.forge.issues.list(project, { label })
    return { issues: issues.map((issue) => ({ number: issue.number, title: issue.title, url: issue.url, brief: asUntrusted(issue) })) }
  }))

  // Proposes the thank-you comment once per issue: a second call returns the
  // same proposal. Nothing reaches GitHub here.
  router.post('/thanks', answer(async (request) => {
    const project = String(request.body?.project ?? '')
    const number = Number(request.body?.issue)
    const { proposal, created } = await ctx.forge.propose(project, {
      target: { type: 'issue', number },
      body: thanksFor(),
      key: `thanks:${number}`,
    })
    return { id: proposal.id, state: proposal.state, created }
  }))

  // Where this plugin's proposals stand: waiting, published (with the comment's address) or discarded.
  router.get('/proposals', answer(async (request) => {
    const proposals = await ctx.forge.proposals.list(String(request.query.project ?? ''))
    return { proposals: proposals.map((p) => ({ id: p.id, issue: p.target.number, state: p.state, url: p.url })) }
  }))
}
