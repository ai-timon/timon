---
type: changed
---
A plugin can now write back an MCP server it read with `ctx.mcpServers.get`: the fields Timon fills in itself are ignored instead of refused, and a misspelt field is still refused.
