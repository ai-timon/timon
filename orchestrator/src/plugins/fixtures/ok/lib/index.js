/**
 * Fixture: the nominal plugin. It does the minimum that proves something:
 * a route (checked to disappear on `disable`) and an effect (checked to
 * be undone on unload).
 *
 * The trace goes through `globalThis` and not an export: the loader imports this
 * file with a `?rev=` that busts the ESM cache, so the test and the loader do
 * NOT share the same module instance.
 */
export const name = 'fixture-ok'
export const inject = ['storage']

const trace = (globalThis.__timonFixtureTrace ??= [])

export function apply(ctx, config) {
  trace.push(`apply:${ctx.id}:${config.marker ?? ''}`)
  ctx.router().get('/ping', (_req, res) => res.json({ ok: true, id: ctx.id }))
  ctx.effect(() => {
    trace.push('effect')
    return () => trace.push('dispose')
  })
}
