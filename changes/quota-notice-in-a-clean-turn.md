---
type: fixed
---
A backend that reports its exhausted quota as the plain answer of a turn, without failing it (Antigravity's "Individual quota reached… Resets in 29m"), is now recognised as out of quota: the task waits for the announced reopening or leaves on its fallback backend, instead of stalling and closing with no work done.
