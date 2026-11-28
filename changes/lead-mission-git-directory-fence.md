---
type: fixed
---
A lead or merger mission on a project kept outside a `projects` folder can write to the repository's `.git` again, so `git fetch` no longer fails with "Permission denied", and the log now says when that access is not granted.
