---
type: known-issue
---
A Kanban task that depends on a `code` task which never gets a merge (no changes to review, or no reviewer) waits indefinitely; remove that dependency to release it.
