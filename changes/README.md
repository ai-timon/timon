# Unreleased changes

Each change a user can see, not yet released, is one file in this folder. When a
version is released, `scripts/bump-version.mjs` writes them into its section of
[`CHANGELOG.md`](../CHANGELOG.md) and deletes them. Two pull requests never edit
the same lines, so the changelog no longer puts them in conflict.

## Add one

Create `changes/<short-name>.md`, with a name of your choice in lowercase letters,
digits and dashes, unique in this folder:

```markdown
---
type: fixed
---
The notification list no longer stays empty after the computer wakes up.
```

- `type`: `added` (a capability users did not have), `fixed` (something broken
  that no longer is), `changed` (existing behaviour or availability changed), or
  `known-issue` (still broken, or working only under conditions).
- `tim`: optional, the tester reference of the bug (`tim: TIM-0034`); it opens
  the entry in bold.
- The text: one sentence usually, two if the bug needs it, in English, from the
  user's point of view: what they see now. No list, no heading, no internal
  cause. Only what someone who installed the app can see: a refactor, a test or
  an internal document gets no fragment.

## Known issues

A `known-issue` fragment is not deleted at a release: it is listed in every
version until it is fixed. The pull request that fixes it deletes the fragment
and adds a `fixed` one.

## Check

```bash
node scripts/changelog-fragments.mjs          # the next version's section, as it will read
node scripts/changelog-fragments.mjs --check  # validate every fragment
```
