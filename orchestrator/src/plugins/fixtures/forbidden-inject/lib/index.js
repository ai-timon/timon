/**
 * Fixture: a flawless manifest, an `inject` that asks for the database. The manifest
 * cannot catch it (`inject` lives here, not in `package.json`): the
 * loader must refuse, after the import but BEFORE `apply`.
 */
export const name = 'fixture-forbidden'
export const inject = ['db']

export function apply() {
  ;(globalThis.__timonFixtureTrace ??= []).push('forbidden:apply')
}
