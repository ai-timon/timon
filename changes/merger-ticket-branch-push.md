---
type: added
---
A merger agent can push a ticket branch (`SELP-123_short-description`) to the remote without an approval card: the daemon makes the push after checking the remote, the destination, the source branch and the agent's role, and never forces it.
