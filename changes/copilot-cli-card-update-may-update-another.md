---
type: known-issue
---
Copilot CLI card: **Update** may update another copy than the one shown, or install a new one, when the CLI's path is pinned in **Settings › AI models › Providers › CLI binaries**, or when it was installed under an nvm pre-release of Node (such as `v21.0.0-rc.1`); run `copilot update` with the CLI's full path in a terminal instead.
