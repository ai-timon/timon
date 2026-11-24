---
type: fixed
---
An MCP server whose provider refuses the scopes it advertises can now be signed in: set `oauth_scope` on its transport and only those scopes are requested, when the client is registered and at sign-in.
