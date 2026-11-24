/** Fixture: the plugin that breaks. The daemon must survive, and its neighbours too. */
export const name = 'fixture-throws'

export function apply() {
  throw new Error('boum à l\'application') // french-ok: the error text the loader and route tests match
}
