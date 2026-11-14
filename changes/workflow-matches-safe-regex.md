---
type: changed
---
Workflow conditions and event filters using `matches` can no longer freeze Timon: patterns now run on the same safe regex engine as trigger filters. `matches` no longer accepts backreferences, lookarounds or named groups: a workflow using one is refused when saved, and an already published version fails its run with the reason until the pattern is rewritten.
