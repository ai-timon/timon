---
type: added
---
A project can integrate finished task branches through a GitHub pull request instead of a local merge. `timon project update SLUG --integration pull-request` makes coding tasks push a branch and open the pull request, and the merge task merges it on the forge once checks are green. `code-group` is not supported in that mode.
