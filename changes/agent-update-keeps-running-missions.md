---
type: fixed
---
Changing an agent's settings with `timon agent update` or the agent editor no longer stops a mission that is working: it finishes its turn and uses the new settings from its next message, and `timon agent update --restart-missions` stops it at once when you need that.
